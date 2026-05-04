"""Smoke tests for the VulnRap Python SDK.

Tests use ``pytest-httpx`` to mock HTTP responses so no network access is
required.
"""

from __future__ import annotations

import pytest

from vulnrap import (
    APIError,
    CheckResult,
    Client,
    ContentMode,
    DEFAULT_BASE_URL,
    PlatformStats,
    Recommendation,
    ReportAnalysis,
    __version__,
)


BASE = "https://test.vulnrap.local/api"


def test_client_init_defaults() -> None:
    c = Client()
    try:
        assert c.base_url == DEFAULT_BASE_URL.rstrip("/")
        assert "vulnrap-python/" in c.user_agent
        assert __version__ in c.user_agent
    finally:
        c.close()


def test_client_init_custom() -> None:
    with Client(base_url="https://example.com/api/", user_agent="acme/1.0") as c:
        assert c.base_url == "https://example.com/api"
        assert c.user_agent == "acme/1.0"


def test_score_report_validation_no_source() -> None:
    with Client(base_url=BASE) as c:
        with pytest.raises(ValueError, match="one of raw_text"):
            c.score_report()


def test_score_report_validation_multiple_sources() -> None:
    with Client(base_url=BASE) as c:
        with pytest.raises(ValueError, match="only one of"):
            c.score_report(raw_text="hi", report_url="https://example.com/r.md")


def test_lookup_report_validates_id() -> None:
    with Client(base_url=BASE) as c:
        with pytest.raises(ValueError, match="positive int"):
            c.lookup_report(0)


def test_score_report_round_trip(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports",
        json={
            "id": 42,
            "deleteToken": "secret-token",
            "contentHash": "abc123",
            "contentMode": "full",
            "slopScore": 18,
            "slopTier": "looks human",
            "qualityScore": 82,
            "confidence": 0.91,
            "breakdown": {"linguistic": 4, "factual": 3, "template": 2, "quality": 9, "llm": 5},
            "evidence": [
                {"type": "ai_phrase", "description": "delve detected", "weight": 5}
            ],
            "similarityMatches": [
                {"reportId": 7, "similarity": 64, "matchType": "section"}
            ],
            "sectionMatches": [],
            "redactionSummary": {"totalRedactions": 2, "categories": {"email": 1, "ip": 1}},
            "feedback": ["Looks well-formed"],
            "llmEnhanced": True,
            "fileSize": 0,
            "createdAt": "2026-05-03T12:34:56Z",
            "vulnrap": {
                "compositeScore": 22,
                "label": "looks legit",
                "engines": [
                    {"engine": "ai_authorship", "score": 18, "verdict": "human", "confidence": "high"}
                ],
                "overridesApplied": [],
            },
        },
        status_code=201,
    )

    with Client(base_url=BASE) as c:
        res = c.score_report(raw_text="Found a path traversal...", show_in_feed=True)

    assert isinstance(res, ReportAnalysis)
    assert res.id == 42
    assert res.delete_token == "secret-token"
    assert res.slop_score == 18
    assert res.slop_tier == "looks human"
    assert res.content_mode is ContentMode.FULL
    assert res.confidence == pytest.approx(0.91)
    assert res.breakdown.linguistic == 4
    assert res.breakdown.llm == 5
    assert len(res.evidence) == 1
    assert res.evidence[0].type == "ai_phrase"
    assert res.similarity_matches[0].report_id == 7
    assert res.redaction_summary.total_redactions == 2
    assert res.redaction_summary.categories["email"] == 1
    assert res.vulnrap is not None
    assert res.vulnrap.composite_score == 22
    assert res.vulnrap.engines[0].engine == "ai_authorship"
    assert res.created_at is not None
    assert res.created_at.year == 2026
    assert res.raw["deleteToken"] == "secret-token"

    request = httpx_mock.get_request()
    assert request is not None
    body = request.content.decode("utf-8", errors="replace")
    assert "rawText" in body
    assert "Found+a+path+traversal" in body or "Found a path traversal" in body
    assert "contentMode" in body and "full" in body
    assert "showInFeed" in body and "true" in body
    assert "skipLlm" in body
    assert "skipRedaction" in body


def test_lookup_report_get(httpx_mock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/reports/42",
        json={"id": 42, "contentMode": "full", "slopScore": 5, "slopTier": "great"},
    )
    with Client(base_url=BASE) as c:
        res = c.lookup_report(42)
    assert res.id == 42
    assert res.slop_score == 5


def test_query_stats(httpx_mock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/stats",
        json={
            "totalReports": 100,
            "duplicatesDetected": 7,
            "avgSlopScore": 31.4,
            "reportsByMode": {"full": 80, "similarity_only": 20},
            "reportsToday": 3,
            "reportsThisWeek": 25,
        },
    )
    with Client(base_url=BASE) as c:
        stats = c.query_stats()
    assert isinstance(stats, PlatformStats)
    assert stats.total_reports == 100
    assert stats.reports_by_mode.full == 80
    assert stats.reports_by_mode.similarity_only == 20
    assert stats.avg_slop_score == pytest.approx(31.4)


def test_test_yourself(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports/check",
        json={
            "slopScore": 88,
            "slopTier": "very ai-slop",
            "breakdown": {"linguistic": 30, "factual": 20, "template": 18, "quality": 20},
            "similarityMatches": [],
            "redactionSummary": {"totalRedactions": 0, "categories": {}},
        },
    )
    with Client(base_url=BASE) as c:
        res = c.test_yourself(raw_text="As an AI language model, I can confirm ...")

    assert res.slop_score == 88
    assert res.slop_tier == "very ai-slop"
    request = httpx_mock.get_request()
    body = request.content.decode("utf-8", errors="replace")
    # /reports/check should NOT include contentMode
    assert "contentMode" not in body
    assert "skipLlm" in body


def test_test_yourself_recommendation_present(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports/check",
        json={
            "slopScore": 20,
            "slopTier": "MEDIUM",
            "breakdown": {"linguistic": 5, "factual": 5, "template": 5, "quality": 50},
            "similarityMatches": [],
            "redactionSummary": {"totalRedactions": 0, "categories": {}},
            "recommendation": {
                "action": "CHALLENGE_REPORTER",
                "reason": "low composite, suspect phrasing",
                "challengeQuestions": ["Can you share a PoC?", "What version is affected?"],
            },
        },
    )
    with Client(base_url=BASE) as c:
        res = c.test_yourself(raw_text="suspicious content")

    assert isinstance(res, CheckResult)
    assert res.recommendation is not None
    assert isinstance(res.recommendation, Recommendation)
    assert res.recommendation.action == "CHALLENGE_REPORTER"
    assert res.recommendation.reason == "low composite, suspect phrasing"
    assert res.recommendation.challenge_questions == ["Can you share a PoC?", "What version is affected?"]


def test_test_yourself_recommendation_absent(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports/check",
        json={
            "slopScore": 5,
            "slopTier": "LOW",
            "breakdown": {"linguistic": 0, "factual": 0, "template": 0, "quality": 90},
            "similarityMatches": [],
            "redactionSummary": {"totalRedactions": 0, "categories": {}},
        },
    )
    with Client(base_url=BASE) as c:
        res = c.test_yourself(raw_text="good report")

    assert isinstance(res, CheckResult)
    assert res.recommendation is None


def test_score_report_recommendation_present(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports",
        json={
            "id": 77,
            "contentHash": "xyz",
            "contentMode": "full",
            "slopScore": 82,
            "slopTier": "HIGH",
            "qualityScore": 15,
            "confidence": 0.95,
            "breakdown": {"linguistic": 25, "factual": 20, "template": 22, "quality": 15},
            "evidence": [],
            "similarityMatches": [],
            "sectionMatches": [],
            "redactionSummary": {"totalRedactions": 0, "categories": {}},
            "feedback": [],
            "llmEnhanced": False,
            "fileSize": 0,
            "createdAt": "2026-05-04T00:00:00Z",
            "recommendation": {
                "action": "AUTO_CLOSE",
                "reason": "composite below threshold",
            },
        },
        status_code=201,
    )
    with Client(base_url=BASE) as c:
        res = c.score_report(raw_text="as an AI language model...")

    assert isinstance(res, ReportAnalysis)
    assert res.recommendation is not None
    assert res.recommendation.action == "AUTO_CLOSE"
    assert res.recommendation.reason == "composite below threshold"
    assert res.recommendation.challenge_questions == []


def test_score_report_recommendation_absent(httpx_mock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/reports",
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
        status_code=201,
    )
    with Client(base_url=BASE) as c:
        res = c.score_report(raw_text="solid human report")

    assert isinstance(res, ReportAnalysis)
    assert res.recommendation is None


def test_api_error_parses_message(httpx_mock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/reports/999",
        status_code=404,
        json={"error": "report not found"},
    )
    with Client(base_url=BASE) as c:
        with pytest.raises(APIError) as exc_info:
            c.lookup_report(999)
    err = exc_info.value
    assert err.status_code == 404
    assert err.message == "report not found"
    assert "404" in str(err) and "report not found" in str(err)
