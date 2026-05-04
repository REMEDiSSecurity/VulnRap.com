"""Typed response models for the VulnRap API.

Every model is a frozen-ish dataclass with a ``from_dict`` constructor that is
forgiving of unknown fields -- the server is allowed to add new keys without
breaking older SDK installs. The parsed payload is also stashed on
``raw`` so callers can reach experimental fields without waiting for an SDK
release.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional


class ContentMode(str, Enum):
    """Server-side storage mode for a submitted report."""

    FULL = "full"
    SIMILARITY_ONLY = "similarity_only"


def _opt_int(value: Any) -> Optional[int]:
    return int(value) if isinstance(value, (int, float)) else None


def _opt_str(value: Any) -> Optional[str]:
    return str(value) if isinstance(value, str) and value else None


def _list(value: Any) -> List[Any]:
    return list(value) if isinstance(value, list) else []


def _dict(value: Any) -> Dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


@dataclass
class ScoreBreakdown:
    """Per-dimension breakdown of a slop score."""

    linguistic: int = 0
    factual: int = 0
    template: int = 0
    quality: int = 0
    llm: Optional[int] = None
    verification: Optional[int] = None
    substance_score: Optional[int] = None
    coherence_score: Optional[int] = None
    poc_validity: Optional[int] = None
    domain_coherence: Optional[int] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ScoreBreakdown":
        return cls(
            linguistic=int(data.get("linguistic", 0) or 0),
            factual=int(data.get("factual", 0) or 0),
            template=int(data.get("template", 0) or 0),
            quality=int(data.get("quality", 0) or 0),
            llm=_opt_int(data.get("llm")),
            verification=_opt_int(data.get("verification")),
            substance_score=_opt_int(data.get("substanceScore")),
            coherence_score=_opt_int(data.get("coherenceScore")),
            poc_validity=_opt_int(data.get("pocValidity")),
            domain_coherence=_opt_int(data.get("domainCoherence")),
        )


@dataclass
class EvidenceItem:
    """One signal that fired during analysis."""

    type: str
    description: str
    weight: int
    matched: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EvidenceItem":
        return cls(
            type=str(data.get("type", "")),
            description=str(data.get("description", "")),
            weight=int(data.get("weight", 0) or 0),
            matched=_opt_str(data.get("matched")),
        )


@dataclass
class SimilarityMatch:
    """A previously seen report that resembles the submitted one."""

    report_id: int
    similarity: int
    match_type: str

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SimilarityMatch":
        return cls(
            report_id=int(data.get("reportId", 0) or 0),
            similarity=int(data.get("similarity", 0) or 0),
            match_type=str(data.get("matchType", "")),
        )


@dataclass
class SectionMatchItem:
    """A section-level similarity match."""

    section_title: str
    matched_report_id: int
    matched_section_title: str
    similarity: int

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "SectionMatchItem":
        return cls(
            section_title=str(data.get("sectionTitle", "")),
            matched_report_id=int(data.get("matchedReportId", 0) or 0),
            matched_section_title=str(data.get("matchedSectionTitle", "")),
            similarity=int(data.get("similarity", 0) or 0),
        )


@dataclass
class RedactionSummary:
    """Summary of what auto-redaction stripped from the report."""

    total_redactions: int = 0
    categories: Dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "RedactionSummary":
        cats = data.get("categories") or {}
        return cls(
            total_redactions=int(data.get("totalRedactions", 0) or 0),
            categories={str(k): int(v) for k, v in (cats.items() if isinstance(cats, Mapping) else [])},
        )


@dataclass
class Recommendation:
    """Triage recommendation returned by the server.

    ``action`` is one of ``PRIORITIZE``, ``MANUAL_REVIEW``,
    ``STANDARD_TRIAGE``, ``CHALLENGE_REPORTER``, or ``AUTO_CLOSE``.
    ``reason`` is a one-liner explaining the matrix decision.
    ``challenge_questions`` is only populated when ``action`` is
    ``CHALLENGE_REPORTER``.
    """

    action: str = ""
    reason: str = ""
    challenge_questions: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "Recommendation":
        return cls(
            action=str(data.get("action", "") or ""),
            reason=str(data.get("reason", "") or ""),
            challenge_questions=[str(q) for q in _list(data.get("challengeQuestions"))],
        )


@dataclass
class VulnrapEngineResult:
    """One engine's score in the multi-engine composite."""

    engine: str
    score: int
    verdict: str
    confidence: str
    note: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "VulnrapEngineResult":
        return cls(
            engine=str(data.get("engine", "")),
            score=int(data.get("score", 0) or 0),
            verdict=str(data.get("verdict", "")),
            confidence=str(data.get("confidence", "")),
            note=str(data.get("note", "") or ""),
        )


@dataclass
class VulnrapComposite:
    """Multi-engine consensus score."""

    composite_score: int
    label: str
    engines: List[VulnrapEngineResult] = field(default_factory=list)
    overrides_applied: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    engine_count: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "VulnrapComposite":
        return cls(
            composite_score=int(data.get("compositeScore", 0) or 0),
            label=str(data.get("label", "")),
            engines=[VulnrapEngineResult.from_dict(e) for e in _list(data.get("engines"))],
            overrides_applied=[str(s) for s in _list(data.get("overridesApplied"))],
            warnings=[str(s) for s in _list(data.get("warnings"))],
            engine_count=int(data.get("engineCount", 0) or 0),
        )


def _parse_created_at(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    s = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


@dataclass
class ReportAnalysis:
    """Response from ``score_report`` and ``lookup_report``.

    ``raw`` holds the unparsed server payload so callers can reach
    fields not surfaced as typed attributes.
    """

    id: int = 0
    delete_token: Optional[str] = None
    content_hash: str = ""
    content_mode: ContentMode = ContentMode.FULL
    slop_score: int = 0
    slop_tier: str = ""
    quality_score: int = 0
    confidence: float = 0.0
    breakdown: ScoreBreakdown = field(default_factory=ScoreBreakdown)
    evidence: List[EvidenceItem] = field(default_factory=list)
    similarity_matches: List[SimilarityMatch] = field(default_factory=list)
    section_matches: List[SectionMatchItem] = field(default_factory=list)
    section_hashes: Dict[str, str] = field(default_factory=dict)
    redacted_text: Optional[str] = None
    redaction_summary: RedactionSummary = field(default_factory=RedactionSummary)
    feedback: List[str] = field(default_factory=list)
    llm_slop_score: Optional[int] = None
    llm_feedback: List[str] = field(default_factory=list)
    authenticity_score: Optional[int] = None
    validity_score: Optional[int] = None
    quadrant: Optional[str] = None
    archetype: Optional[str] = None
    analysis_mode: Optional[str] = None
    llm_enhanced: bool = False
    llm_failed: bool = False
    llm_used: bool = False
    redaction_applied: bool = False
    vulnrap: Optional[VulnrapComposite] = None
    recommendation: Optional[Recommendation] = None
    avri_family: Optional[str] = None
    file_name: Optional[str] = None
    file_size: int = 0
    created_at: Optional[datetime] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ReportAnalysis":
        mode_raw = data.get("contentMode") or "full"
        try:
            mode = ContentMode(mode_raw)
        except ValueError:
            mode = ContentMode.FULL
        vulnrap_raw = data.get("vulnrap")
        rec_raw = data.get("recommendation")
        section_hashes = data.get("sectionHashes") or {}
        return cls(
            id=int(data.get("id", 0) or 0),
            delete_token=_opt_str(data.get("deleteToken")),
            content_hash=str(data.get("contentHash", "") or ""),
            content_mode=mode,
            slop_score=int(data.get("slopScore", 0) or 0),
            slop_tier=str(data.get("slopTier", "") or ""),
            quality_score=int(data.get("qualityScore", 0) or 0),
            confidence=float(data.get("confidence", 0.0) or 0.0),
            breakdown=ScoreBreakdown.from_dict(_dict(data.get("breakdown"))),
            evidence=[EvidenceItem.from_dict(e) for e in _list(data.get("evidence"))],
            similarity_matches=[SimilarityMatch.from_dict(m) for m in _list(data.get("similarityMatches"))],
            section_matches=[SectionMatchItem.from_dict(m) for m in _list(data.get("sectionMatches"))],
            section_hashes={str(k): str(v) for k, v in (section_hashes.items() if isinstance(section_hashes, Mapping) else [])},
            redacted_text=_opt_str(data.get("redactedText")),
            redaction_summary=RedactionSummary.from_dict(_dict(data.get("redactionSummary"))),
            feedback=[str(s) for s in _list(data.get("feedback"))],
            llm_slop_score=_opt_int(data.get("llmSlopScore")),
            llm_feedback=[str(s) for s in _list(data.get("llmFeedback"))],
            authenticity_score=_opt_int(data.get("authenticityScore")),
            validity_score=_opt_int(data.get("validityScore")),
            quadrant=_opt_str(data.get("quadrant")),
            archetype=_opt_str(data.get("archetype")),
            analysis_mode=_opt_str(data.get("analysisMode")),
            llm_enhanced=bool(data.get("llmEnhanced", False)),
            llm_failed=bool(data.get("llmFailed", False)),
            llm_used=bool(data.get("llmUsed", False)),
            redaction_applied=bool(data.get("redactionApplied", False)),
            vulnrap=VulnrapComposite.from_dict(vulnrap_raw) if isinstance(vulnrap_raw, Mapping) else None,
            recommendation=Recommendation.from_dict(rec_raw) if isinstance(rec_raw, Mapping) else None,
            avri_family=_opt_str(data.get("avriFamily")),
            file_name=_opt_str(data.get("fileName")),
            file_size=int(data.get("fileSize", 0) or 0),
            created_at=_parse_created_at(data.get("createdAt")),
            raw=dict(data),
        )


@dataclass
class CheckResult:
    """Response from ``test_yourself`` (POST /reports/check).

    Mirrors :class:`ReportAnalysis` but omits storage-only fields (id,
    delete_token, created_at) since the server does not persist anything.
    """

    slop_score: int = 0
    slop_tier: str = ""
    quality_score: int = 0
    confidence: float = 0.0
    breakdown: ScoreBreakdown = field(default_factory=ScoreBreakdown)
    evidence: List[EvidenceItem] = field(default_factory=list)
    similarity_matches: List[SimilarityMatch] = field(default_factory=list)
    section_matches: List[SectionMatchItem] = field(default_factory=list)
    section_hashes: Dict[str, str] = field(default_factory=dict)
    redaction_summary: RedactionSummary = field(default_factory=RedactionSummary)
    feedback: List[str] = field(default_factory=list)
    llm_slop_score: Optional[int] = None
    llm_feedback: List[str] = field(default_factory=list)
    vulnrap: Optional[VulnrapComposite] = None
    recommendation: Optional[Recommendation] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CheckResult":
        vulnrap_raw = data.get("vulnrap")
        rec_raw = data.get("recommendation")
        section_hashes = data.get("sectionHashes") or {}
        return cls(
            slop_score=int(data.get("slopScore", 0) or 0),
            slop_tier=str(data.get("slopTier", "") or ""),
            quality_score=int(data.get("qualityScore", 0) or 0),
            confidence=float(data.get("confidence", 0.0) or 0.0),
            breakdown=ScoreBreakdown.from_dict(_dict(data.get("breakdown"))),
            evidence=[EvidenceItem.from_dict(e) for e in _list(data.get("evidence"))],
            similarity_matches=[SimilarityMatch.from_dict(m) for m in _list(data.get("similarityMatches"))],
            section_matches=[SectionMatchItem.from_dict(m) for m in _list(data.get("sectionMatches"))],
            section_hashes={str(k): str(v) for k, v in (section_hashes.items() if isinstance(section_hashes, Mapping) else [])},
            redaction_summary=RedactionSummary.from_dict(_dict(data.get("redactionSummary"))),
            feedback=[str(s) for s in _list(data.get("feedback"))],
            llm_slop_score=_opt_int(data.get("llmSlopScore")),
            llm_feedback=[str(s) for s in _list(data.get("llmFeedback"))],
            vulnrap=VulnrapComposite.from_dict(vulnrap_raw) if isinstance(vulnrap_raw, Mapping) else None,
            recommendation=Recommendation.from_dict(rec_raw) if isinstance(rec_raw, Mapping) else None,
            raw=dict(data),
        )


@dataclass
class ReportsByMode:
    """Counts of reports grouped by privacy mode."""

    full: int = 0
    similarity_only: int = 0

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "ReportsByMode":
        return cls(
            full=int(data.get("full", 0) or 0),
            similarity_only=int(data.get("similarity_only", 0) or 0),
        )


@dataclass
class PlatformStats:
    """Response from ``query_stats`` (GET /stats)."""

    total_reports: int = 0
    duplicates_detected: int = 0
    avg_slop_score: float = 0.0
    reports_by_mode: ReportsByMode = field(default_factory=ReportsByMode)
    reports_today: int = 0
    reports_this_week: int = 0
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "PlatformStats":
        return cls(
            total_reports=int(data.get("totalReports", 0) or 0),
            duplicates_detected=int(data.get("duplicatesDetected", 0) or 0),
            avg_slop_score=float(data.get("avgSlopScore", 0.0) or 0.0),
            reports_by_mode=ReportsByMode.from_dict(_dict(data.get("reportsByMode"))),
            reports_today=int(data.get("reportsToday", 0) or 0),
            reports_this_week=int(data.get("reportsThisWeek", 0) or 0),
            raw=dict(data),
        )


class APIError(Exception):
    """Raised when the server responds with a non-2xx status code."""

    def __init__(self, status_code: int, message: str = "", body: bytes = b"") -> None:
        self.status_code = status_code
        self.message = message
        self.body = body
        if message:
            super().__init__(f"vulnrap: HTTP {status_code}: {message}")
        else:
            super().__init__(f"vulnrap: HTTP {status_code}")
