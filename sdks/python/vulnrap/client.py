"""HTTP client for the VulnRap API.

The client uses ``httpx`` under the hood -- a single, well-known dependency
with built-in connection pooling, timeouts, and a simple sync API. Tests can
inject a custom ``httpx.Client`` to mock HTTP exchanges without touching the
network.
"""

from __future__ import annotations

import json
import platform
from typing import IO, Any, Mapping, Optional, Tuple, Union

import httpx

from .types import (
    APIError,
    CheckResult,
    ContentMode,
    PlatformStats,
    ReportAnalysis,
)

__version__ = "0.1.0"

DEFAULT_BASE_URL = "https://vulnrap.com/api"
DEFAULT_TIMEOUT_SECONDS = 60.0


FileLike = Union[bytes, IO[bytes]]


def _bool_field(value: bool) -> str:
    return "true" if value else "false"


def _join_url(base: str, path: str) -> str:
    if not path:
        return base
    if not path.startswith("/"):
        path = "/" + path
    return base.rstrip("/") + path


class Client:
    """Synchronous HTTP client for the VulnRap API.

    Parameters
    ----------
    base_url:
        API root. Defaults to the production VulnRap deployment.
    timeout:
        Per-request timeout in seconds.
    user_agent:
        Override the ``User-Agent`` header sent on every request.
    http_client:
        Inject an existing ``httpx.Client``. The SDK will not close clients
        it did not create. Useful for retries, custom transports, and tests.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        user_agent: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent or (
            f"vulnrap-python/{__version__} "
            f"({platform.system().lower()}; {platform.machine() or 'unknown'})"
        )
        self._owns_client = http_client is None
        self._http: httpx.Client = http_client or httpx.Client(timeout=timeout)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP client (only if the SDK created it)."""
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    # ------------------------------------------------------------------
    # Public methods
    # ------------------------------------------------------------------

    def score_report(
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
        """Submit a vulnerability report for analysis and store it server-side.

        Exactly one of ``raw_text``, ``report_url``, or ``file`` must be
        provided. The returned :class:`~vulnrap.types.ReportAnalysis` contains
        a ``delete_token`` that is only surfaced once -- keep it if you might
        want to delete the row later.
        """
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
        payload = self._do(
            "POST",
            "/reports",
            files=files,
            data=data,
        )
        return ReportAnalysis.from_dict(payload)

    def lookup_report(self, report_id: int) -> ReportAnalysis:
        """Fetch a previously submitted report by its numeric ID."""
        if not isinstance(report_id, int) or report_id <= 0:
            raise ValueError(f"vulnrap: lookup_report: id must be a positive int, got {report_id!r}")
        payload = self._do("GET", f"/reports/{report_id}")
        return ReportAnalysis.from_dict(payload)

    def query_stats(self) -> PlatformStats:
        """Fetch aggregate platform statistics."""
        payload = self._do("GET", "/stats")
        return PlatformStats.from_dict(payload)

    def test_yourself(
        self,
        *,
        raw_text: Optional[str] = None,
        report_url: Optional[str] = None,
        file: Optional[FileLike] = None,
        file_name: Optional[str] = None,
        skip_llm: bool = False,
        skip_redaction: bool = False,
    ) -> CheckResult:
        """Run the full analysis pipeline without storing anything server-side.

        Ideal for PSIRT teams validating incoming reports before triage.
        Exactly one of ``raw_text``, ``report_url``, or ``file`` must be set.
        """
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
        payload = self._do("POST", "/reports/check", files=files, data=data)
        return CheckResult.from_dict(payload)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _do(
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
            response = self._http.request(
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


def _build_report_form(
    *,
    raw_text: Optional[str],
    report_url: Optional[str],
    file: Optional[FileLike],
    file_name: Optional[str],
    content_mode: ContentMode,
    include_content_mode: bool = True,
    include_show_in_feed: bool = False,
    show_in_feed: bool = False,
    include_storage_flags: bool = False,
    skip_llm: bool = False,
    skip_redaction: bool = False,
) -> Tuple[dict, dict]:
    sources = sum(bool(x) for x in (raw_text, report_url, file))
    if sources == 0:
        raise ValueError("vulnrap: one of raw_text, report_url, or file is required")
    if sources > 1:
        raise ValueError("vulnrap: only one of raw_text, report_url, or file may be set")
    if file is not None and not file_name:
        raise ValueError("vulnrap: file_name is required when file is set")

    data: dict = {}
    files: dict = {}

    if raw_text:
        data["rawText"] = raw_text
    elif report_url:
        data["reportUrl"] = report_url
    elif file is not None:
        files["file"] = (file_name, file)

    if include_content_mode:
        data["contentMode"] = content_mode.value if isinstance(content_mode, ContentMode) else str(content_mode)
    if include_show_in_feed:
        data["showInFeed"] = _bool_field(show_in_feed)
    if include_storage_flags:
        data["skipLlm"] = _bool_field(skip_llm)
        data["skipRedaction"] = _bool_field(skip_redaction)

    return files, data
