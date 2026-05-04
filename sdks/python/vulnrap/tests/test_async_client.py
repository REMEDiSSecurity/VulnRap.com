"""Smoke tests for the VulnRap Python async SDK.

Uses ``httpx.MockTransport`` to simulate HTTP responses without touching
the network. Each test mocks one method end-to-end.
"""

from __future__ import annotations

import asyncio
import json
from typing import Callable

import httpx
import pytest

from vulnrap import (
    APIError,
    AsyncClient,
    CheckResult,
    ContentMode,
    DEFAULT_BASE_URL,
    PlatformStats,
    Recommendation,
    ReportAnalysis,
    __version__,
)


BASE = "https://test.vulnrap.local/api"


def _mock_client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _run(coro):
    return asyncio.run(coro)


def test_async_client_init_defaults() -> None:
    c = AsyncClient()
    try:
        assert c.base_url == DEFAULT_BASE_URL.rstrip("/")
        assert "vulnrap-python/" in c.user_agent
        assert __version__ in c.user_agent
    finally:
        _run(c.aclose())


def test_async_client_init_custom() -> None:
    async def go() -> None:
        async with AsyncClient(base_url="https://example.com/api/", user_agent="acme/1.0") as c:
            assert c.base_url == "https://example.com/api"
            assert c.user_agent == "acme/1.0"

    _run(go())


def test_async_score_report_validates() -> None:
    async def go() -> None:
        async with AsyncClient(base_url=BASE) as c:
            with pytest.raises(ValueError, match="one of raw_text"):
                await c.score_report()
            with pytest.raises(ValueError, match="only one of"):
                await c.score_report(raw_text="hi", report_url="https://example.com/r.md")

    _run(go())


def test_async_lookup_validates_id() -> None:
    async def go() -> None:
        async with AsyncClient(base_url=BASE) as c:
            with pytest.raises(ValueError, match="positive int"):
                await c.lookup_report(0)

    _run(go())


def test_async_score_report_round_trip() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["content_type"] = request.headers.get("content-type", "")
        captured["body"] = request.content.decode("utf-8", errors="replace")
        return httpx.Response(
            201,
            json={
                "id": 99,
                "deleteToken": "tok-async",
                "contentHash": "hash-async",
                "contentMode": "full",
                "slopScore": 12,
                "slopTier": "looks human",
                "qualityScore": 88,
                "confidence": 0.77,
                "breakdown": {"linguistic": 1, "factual": 2, "template": 3, "quality": 88},
                "evidence": [],
                "similarityMatches": [],
                "sectionMatches": [],
                "redactionSummary": {"totalRedactions": 0, "categories": {}},
                "feedback": [],
                "llmEnhanced": False,
                "fileSize": 0,
                "createdAt": "2026-05-03T12:00:00Z",
            },
        )

    async def go() -> ReportAnalysis:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.score_report(raw_text="path traversal in /api/files", show_in_feed=True)

    res = _run(go())

    assert isinstance(res, ReportAnalysis)
    assert res.id == 99
    assert res.delete_token == "tok-async"
    assert res.slop_score == 12
    assert res.content_mode is ContentMode.FULL
    assert res.created_at is not None and res.created_at.year == 2026

    assert captured["method"] == "POST"
    assert captured["url"] == f"{BASE}/reports"
    body = captured["body"]
    assert "rawText" in body and ("path+traversal" in body or "path traversal" in body)
    assert "contentMode" in body and "full" in body
    assert "showInFeed" in body and "true" in body
    assert "skipLlm" in body and "skipRedaction" in body


def test_async_lookup_report() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert str(request.url) == f"{BASE}/reports/7"
        return httpx.Response(
            200,
            json={"id": 7, "contentMode": "full", "slopScore": 3, "slopTier": "great"},
        )

    async def go() -> ReportAnalysis:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.lookup_report(7)

    res = _run(go())
    assert res.id == 7
    assert res.slop_score == 3


def test_async_query_stats() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"{BASE}/stats"
        return httpx.Response(
            200,
            json={
                "totalReports": 50,
                "duplicatesDetected": 3,
                "avgSlopScore": 27.5,
                "reportsByMode": {"full": 40, "similarity_only": 10},
                "reportsToday": 1,
                "reportsThisWeek": 12,
            },
        )

    async def go() -> PlatformStats:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.query_stats()

    stats = _run(go())
    assert isinstance(stats, PlatformStats)
    assert stats.total_reports == 50
    assert stats.reports_by_mode.full == 40
    assert stats.reports_by_mode.similarity_only == 10
    assert stats.avg_slop_score == pytest.approx(27.5)


def test_async_test_yourself() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.content.decode("utf-8", errors="replace")
        return httpx.Response(
            200,
            json={
                "slopScore": 91,
                "slopTier": "very ai-slop",
                "breakdown": {"linguistic": 30, "factual": 25, "template": 20, "quality": 16},
                "similarityMatches": [],
                "redactionSummary": {"totalRedactions": 0, "categories": {}},
            },
        )

    async def go() -> CheckResult:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.test_yourself(raw_text="As an AI language model ...")

    res = _run(go())
    assert res.slop_score == 91
    assert res.slop_tier == "very ai-slop"
    assert captured["url"] == f"{BASE}/reports/check"
    # /reports/check must NOT include contentMode
    assert "contentMode" not in captured["body"]
    assert "skipLlm" in captured["body"]


def test_async_test_yourself_recommendation_present() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "slopScore": 18,
                "slopTier": "MEDIUM",
                "breakdown": {"linguistic": 5, "factual": 4, "template": 4, "quality": 55},
                "similarityMatches": [],
                "redactionSummary": {"totalRedactions": 0, "categories": {}},
                "recommendation": {
                    "action": "CHALLENGE_REPORTER",
                    "reason": "low composite, suspect phrasing",
                    "challengeQuestions": ["Provide a PoC.", "Which version?"],
                },
            },
        )

    async def go() -> CheckResult:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.test_yourself(raw_text="suspicious report")

    res = _run(go())
    assert res.recommendation is not None
    assert isinstance(res.recommendation, Recommendation)
    assert res.recommendation.action == "CHALLENGE_REPORTER"
    assert res.recommendation.reason == "low composite, suspect phrasing"
    assert len(res.recommendation.challenge_questions) == 2


def test_async_score_report_recommendation_absent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "id": 55,
                "contentHash": "abc",
                "contentMode": "full",
                "slopScore": 10,
                "slopTier": "LOW",
                "qualityScore": 88,
                "confidence": 0.85,
                "breakdown": {"linguistic": 2, "factual": 1, "template": 1, "quality": 88},
                "evidence": [],
                "similarityMatches": [],
                "sectionMatches": [],
                "redactionSummary": {"totalRedactions": 0, "categories": {}},
                "feedback": [],
                "llmEnhanced": False,
                "fileSize": 0,
                "createdAt": "2026-05-04T00:00:00Z",
            },
        )

    async def go() -> ReportAnalysis:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.score_report(raw_text="solid human report")

    res = _run(go())
    assert isinstance(res, ReportAnalysis)
    assert res.recommendation is None


def test_async_test_yourself_recommendation_absent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "slopScore": 3,
                "slopTier": "LOW",
                "breakdown": {"linguistic": 0, "factual": 0, "template": 0, "quality": 95},
                "similarityMatches": [],
                "redactionSummary": {"totalRedactions": 0, "categories": {}},
            },
        )

    async def go() -> CheckResult:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            return await c.test_yourself(raw_text="solid report with evidence")

    res = _run(go())
    assert res.recommendation is None


def test_async_api_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            content=json.dumps({"error": "rate limit exceeded"}).encode("utf-8"),
            headers={"content-type": "application/json"},
        )

    async def go() -> None:
        async with AsyncClient(base_url=BASE, http_client=_mock_client(handler)) as c:
            with pytest.raises(APIError) as exc_info:
                await c.query_stats()
            err = exc_info.value
            assert err.status_code == 429
            assert err.message == "rate limit exceeded"
            assert "429" in str(err)

    _run(go())
