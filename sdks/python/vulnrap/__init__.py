"""Official Python client for the VulnRap API (https://vulnrap.com).

The VulnRap API runs the same multi-engine consensus pipeline that powers
vulnrap.com -- sloppiness scoring, similarity matching, and PII
auto-redaction -- over plain HTTP. No API key is required.

Basic usage::

    from vulnrap import Client

    c = Client()
    res = c.score_report(raw_text="Found a path traversal in /api/files...")
    print(res.slop_score, res.slop_tier)

All endpoints are free, anonymous, rate-limited per IP.
"""

from .client import Client, DEFAULT_BASE_URL, __version__
from .types import (
    APIError,
    CheckResult,
    ContentMode,
    EvidenceItem,
    PlatformStats,
    RedactionSummary,
    ReportAnalysis,
    ReportsByMode,
    ScoreBreakdown,
    SectionMatchItem,
    SimilarityMatch,
    VulnrapComposite,
    VulnrapEngineResult,
)

__all__ = [
    "APIError",
    "CheckResult",
    "Client",
    "ContentMode",
    "DEFAULT_BASE_URL",
    "EvidenceItem",
    "PlatformStats",
    "RedactionSummary",
    "ReportAnalysis",
    "ReportsByMode",
    "ScoreBreakdown",
    "SectionMatchItem",
    "SimilarityMatch",
    "VulnrapComposite",
    "VulnrapEngineResult",
    "__version__",
]
