"""Async HTTP client for the VulnRap API.

Mirrors :class:`vulnrap.Client` one-for-one but returns awaitables and is
backed by ``httpx.AsyncClient``. Both clients share the same type
definitions in :mod:`vulnrap.types`, so a codebase mixing sync triage
scripts and async webhook handlers gets one set of result models.
"""

from __future__ import annotations

import json
import platform
from typing import Any, Mapping, Optional, Tuple

import httpx

from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_TIMEOUT_SECONDS,
    FileLike,
    _build_report_form,
    _join_url,
    __version__,
)
from .types import (
    APIError,
    CheckResult,
    ContentMode,
    PlatformStats,
    ReportAnalysis,
)


class AsyncClient:
    """Asynchronous HTTP client for the VulnRap API.

    The constructor signature matches :class:`vulnrap.Client` so callers
    can swap one for the other. ``http_client`` accepts an existing
    ``httpx.AsyncClient`` (handy for retries, custom transports, and
    ``httpx.MockTransport``-based tests).
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        user_agent: Optional[str] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent or (
            f"vulnrap-python/{__version__} "
            f"({platform.system().lower()}; {platform.machine() or 'unknown'})"
        )
        self._owns_client = http_client is None
        self._http: httpx.AsyncClient = http_client or httpx.AsyncClient(timeout=timeout)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def aclose(self) -> None:
        """Close the underlying HTTP client (only if the SDK created it)."""
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> "AsyncClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    async def score_report(
        self,
        *,
        raw_text: Optional[str] = None,
        report_url: Optional[str] = None,
        file: Optional[FileLike] = None,
        file_name: Optional[str] = None,
        content_mode: ContentMode = ContentMode.FULL,
        show_in_feed: bool = False,
        skip_llm: bool = False,
        skip_redaction: bool = False,
    ) -> ReportAnalysis:
        """Submit a vulnerability report for analysis and store it server-side."""
        files, data = _build_report_form(
            raw_text=raw_text,
            report_url=report_url,
            file=file,
            file_name=file_name,
            content_mode=content_mode,
            include_show_in_feed=True,
            show_in_feed=show_in_feed,
            include_storage_flags=True,
            skip_llm=skip_llm,
            skip_redaction=skip_redaction,
        )
        payload = await self._do("POST", "/reports", files=files, data=data)
        return ReportAnalysis.from_dict(payload)

    async def lookup_report(self, report_id: int) -> ReportAnalysis:
        """Fetch a previously submitted report by its numeric ID."""
        if not isinstance(report_id, int) or report_id <= 0:
            raise ValueError(
                f"vulnrap: lookup_report: id must be a positive int, got {report_id!r}"
            )
        payload = await self._do("GET", f"/reports/{report_id}")
        return ReportAnalysis.from_dict(payload)

    async def query_stats(self) -> PlatformStats:
        """Fetch aggregate platform statistics."""
        payload = await self._do("GET", "/stats")
        return PlatformStats.from_dict(payload)

    async def test_yourself(
        self,
        *,
        raw_text: Optional[str] = None,
        report_url: Optional[str] = None,
        file: Optional[FileLike] = None,
        file_name: Optional[str] = None,
        skip_llm: bool = False,
        skip_redaction: bool = False,
    ) -> CheckResult:
        """Run the full analysis pipeline without storing anything server-side."""
        files, data = _build_report_form(
            raw_text=raw_text,
            report_url=report_url,
            file=file,
            file_name=file_name,
            content_mode=ContentMode.FULL,
            include_content_mode=False,
            include_storage_flags=True,
            skip_llm=skip_llm,
            skip_redaction=skip_redaction,
        )
        payload = await self._do("POST", "/reports/check", files=files, data=data)
        return CheckResult.from_dict(payload)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _do(
        self,
        method: str,
        path: str,
        *,
        data: Optional[Mapping[str, str]] = None,
        files: Optional[Mapping[str, Tuple[str, FileLike]]] = None,
    ) -> Any:
        url = _join_url(self.base_url, path)
        headers = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        try:
            response = await self._http.request(
                method,
                url,
                headers=headers,
                data=data,
                files=files,
            )
        except httpx.HTTPError as e:
            raise APIError(0, f"transport error: {e}") from e

        body = response.content or b""
        if not (200 <= response.status_code < 300):
            message = ""
            try:
                parsed = json.loads(body.decode("utf-8") or "{}")
                if isinstance(parsed, Mapping):
                    err = parsed.get("error")
                    if isinstance(err, str):
                        message = err
            except (ValueError, UnicodeDecodeError):
                pass
            raise APIError(response.status_code, message, body)

        if not body:
            return {}
        try:
            return json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise APIError(response.status_code, f"decode response: {e}", body) from e
