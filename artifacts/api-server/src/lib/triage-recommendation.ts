import { createHash } from "crypto";
import type { VerificationResult, VerificationCheck } from "./active-verification";
import type { EvidenceItem } from "./score-fusion";
import type { CompositeResult } from "./engines";

export type TriageAction =
  | "AUTO_CLOSE"
  | "MANUAL_REVIEW"
  | "CHALLENGE_REPORTER"
  | "PRIORITIZE"
  | "STANDARD_TRIAGE";

export interface TriageRecommendation {
  action: TriageAction;
  reason: string;
  note: string;
  challengeQuestions: ChallengeQuestion[];
  temporalSignals: TemporalSignal[];
  templateMatch: TemplateMatchResult | null;
  revision: RevisionResult | null;
  // v3.6.0 §4: The matrix inputs that drove the decision. Surfaced in the
  // triage UI so reviewers can spot when the matrix is operating near a band
  // boundary. Null when the report predates v3.6.0 composite scoring (i.e. the
  // caller passed no TriageDecisionContext).
  matrixInputs: TriageMatrixInputs | null;
}

export interface TriageMatrixInputs {
  compositeScore: number;
  engine2Score: number;
  verificationRatio: number;
  strongEvidenceCount: number;
}

export interface ChallengeQuestion {
  category: string;
  question: string;
  context: string;
}

export interface TemporalSignal {
  cveId: string;
  publishedDate: string;
  hoursSincePublication: number;
  signal: "suspiciously_fast" | "fast_turnaround" | "normal";
  weight: number;
}

export interface TemplateMatchResult {
  templateHash: string;
  matchedReportIds: number[];
  weight: number;
}

export interface RevisionResult {
  originalReportId: number;
  originalScore: number;
  similarity: number;
  scoreChange: number;
  direction: "improved" | "worsened" | "unchanged";
  changeSummary?: string;
}

// v3.6.0 §4: Optional decision context for matrix-based triage. When provided,
// the triage decision uses a richer matrix (composite × engine2 × verification
// ratio × strong-evidence count) instead of the legacy slop-only thresholds.
// Callers without v3.6.0 context still get the v3.5.0 behavior.
export interface TriageDecisionContext {
  compositeScore?: number;       // 0..100, higher=better
  engine2Score?: number;          // 0..100, technical substance
  strongEvidenceCount?: number;   // # of CRASH_OUTPUT/STACK_TRACE/CODE_DIFF/etc.
  suspiciousAddressCount?: number;
  // Verification ratio: verified / (verified + notFound) over `referenced_in_report` checks only.
  verificationRatio?: number;     // 0..1
  // Sprint 11 AVRI: number of family-specific gold signals (sanitizer trace,
  // injection payload, etc.) that matched. When ≥1, the triage matrix
  // applies a more permissive PRIORITIZE/MANUAL_REVIEW band because gold
  // signals are extremely difficult to fabricate.
  goldHitCount?: number;
  avriFamily?: string;
}

export function generateTriageRecommendation(
  slopScore: number,
  confidence: number,
  verification: VerificationResult | null,
  evidence: EvidenceItem[],
  context?: TriageDecisionContext,
): Omit<TriageRecommendation, "temporalSignals" | "templateMatch" | "revision"> {
  const matrixInputs: TriageMatrixInputs | null = context
    ? {
        compositeScore: context.compositeScore ?? 50,
        engine2Score: context.engine2Score ?? 50,
        verificationRatio: context.verificationRatio
          ?? (((verification?.checks ?? []).filter(c => c.source === "referenced_in_report" && c.result === "verified").length)
            / Math.max(1, (verification?.checks ?? []).filter(c => c.source === "referenced_in_report" && (c.result === "verified" || c.result === "not_found")).length)),
        strongEvidenceCount: context.strongEvidenceCount ?? 0,
      }
    : null;
  // v3.6.0 §2/§4: Only count notFound/verified from explicit referenced_in_report
  // sources when computing the triage decision. Checks with undefined source
  // (e.g. NVD CVE lookups) or search_fallback origin must not influence the
  // verification ratio, so a search-fallback miss never escalates to
  // CHALLENGE_REPORTER.
  const referencedChecks = (verification?.checks ?? []).filter(
    (c) => c.source === "referenced_in_report",
  );
  const notFoundCount = referencedChecks.filter(c => c.result === "not_found").length;
  const verifiedCount = referencedChecks.filter(c => c.result === "verified").length;
  const warningCount = verification?.summary.warnings ?? 0;
  const refTotal = notFoundCount + verifiedCount;
  const verificationRatio = context?.verificationRatio
    ?? (refTotal > 0 ? verifiedCount / refTotal : 0);
  const strongEvidence = context?.strongEvidenceCount ?? 0;

  let action: TriageAction;
  let reason: string;
  let note: string;

  // v3.6.0 §4: Matrix-based triage. Composite + engine 2 default to a neutral
  // 50/50 baseline when the caller has no v3.6.0 context (e.g. legacy stored
  // reports analyzed before the new composite existed). The legacy single-axis
  // slop-only branch was removed in v3.6.0 §4 — every call site now flows
  // through this matrix.
  {
    const comp = context?.compositeScore ?? 50;
    const e2 = context?.engine2Score ?? 50;

    // Sprint 11 §8 — AVRI matrix v2. Gold signals are extremely hard to
    // fabricate, so when ≥2 are present we only need a moderate composite to
    // PRIORITIZE, and a single gold signal is enough to skip CHALLENGE.
    const goldHits = context?.goldHitCount ?? 0;
    if (goldHits >= 2 && comp >= 40) {
      action = "PRIORITIZE";
      reason = `Composite ${comp} with ${goldHits} AVRI gold signal(s) for ${context?.avriFamily ?? "the classified family"} — high-quality report.`;
      note = "Strong family-specific evidence (sanitizer trace, payload, KAT, etc.). Prioritize for senior reviewer.";
    } else if (comp >= 70 && e2 >= 60 && (verificationRatio >= 0.5 || strongEvidence >= 2)) {
      action = "PRIORITIZE";
      reason = `Composite ${comp} with substance ${e2} and ${strongEvidence} strong evidence signal(s) — high-quality report.`;
      note = "Strong evidence with coherent technical substance. Prioritize for senior reviewer.";
    } else if (comp >= 60 && e2 >= 50) {
      action = "STANDARD_TRIAGE";
      reason = `Composite ${comp} with substance ${e2} — within legitimate range.`;
      note = "Process through standard triage workflow.";
    } else if (comp >= 45) {
      // Mid-range — only escalate to CHALLENGE if NOT enough strong evidence.
      if (strongEvidence >= 3) {
        action = "STANDARD_TRIAGE";
        reason = `Composite ${comp} but ${strongEvidence} strong evidence signals (crash/diff/stack) — skip challenge.`;
        note = "Mid composite, but the report carries hard-to-fabricate evidence. Standard triage.";
      } else if (notFoundCount >= 2 && verificationRatio < 0.3) {
        action = "CHALLENGE_REPORTER";
        reason = `${notFoundCount} referenced items could not be verified (verification ratio ${(verificationRatio * 100).toFixed(0)}%).`;
        note = "Send the generated challenge questions below. A legitimate researcher can substantiate specifics within 48 hours.";
      } else {
        action = "MANUAL_REVIEW";
        reason = `Composite ${comp}, substance ${e2}, ${strongEvidence} strong signal(s) — needs human eyes.`;
        note = "Assign to a senior triager for manual assessment.";
      }
    } else if (comp >= 30) {
      // Low-mid composite — manual review unless we have enough strong evidence
      // OR the report is clearly slop.
      if (strongEvidence >= 3) {
        action = "MANUAL_REVIEW";
        reason = `Low composite ${comp} but ${strongEvidence} strong evidence signal(s) — ambiguous.`;
        note = "Substance disagrees with composite; review manually before any escalation.";
      } else if (notFoundCount >= 2) {
        action = "CHALLENGE_REPORTER";
        reason = `Composite ${comp} with ${notFoundCount} unverifiable references.`;
        note = "Send challenge questions; set a 48-hour response deadline.";
      } else {
        action = "MANUAL_REVIEW";
        reason = `Low composite ${comp} — needs manual review.`;
        note = "Assign to a senior triager.";
      }
    } else {
      // composite < 30
      action = "AUTO_CLOSE";
      reason = `Very low composite (${comp}) with substance ${e2} — strong AI-generation / low-effort signals.`;
      note = "Consider auto-closing with a template response requesting original research.";
    }

    // Override safety: never CHALLENGE_REPORTER if the report has 3+ strong
    // evidence signals (CRASH_OUTPUT, STACK_TRACE, CODE_DIFF, SHELL_COMMAND, etc.).
    if (action === "CHALLENGE_REPORTER" && strongEvidence >= 3) {
      action = "MANUAL_REVIEW";
      reason += ` Override: ${strongEvidence} strong evidence signals present — escalate to manual review instead of challenge.`;
    }
  }

  if (warningCount > 0 && action !== "CHALLENGE_REPORTER") {
    note += ` Note: ${warningCount} verification warning(s) detected — review the verification panel for details.`;
  }

  const challengeQuestions = generateChallengeQuestions(verification, evidence);

  return { action, reason, note, challengeQuestions, matrixInputs };
}

function generateChallengeQuestions(
  verification: VerificationResult | null,
  evidence: EvidenceItem[],
): ChallengeQuestion[] {
  const questions: ChallengeQuestion[] = [];

  if (verification) {
    // v3.6.0 §2: Skip checks done against guessed/search-fallback repos.
    const trustedChecks = verification.checks.filter(
      (c) => c.source !== "search_fallback",
    );
    const missingFiles = trustedChecks.filter(
      (c) => c.type === "github_file_missing"
    );
    for (const check of missingFiles.slice(0, 2)) {
      const target = check.target.split(":")[1] || check.target;
      questions.push({
        category: "missing_file",
        question: `You referenced the file path "${target}" but it does not exist in the repository. Can you provide the exact branch, tag, or commit hash where this file exists?`,
        context: check.detail,
      });
    }

    const missingFunctions = trustedChecks.filter(
      (c) => c.type === "github_function_missing"
    );
    for (const check of missingFunctions.slice(0, 2)) {
      const target = check.target.split(":")[1] || check.target;
      questions.push({
        category: "missing_function",
        question: `The function/symbol "${target}" was not found in the repository code. Can you specify the exact source file, line number, and version where this function is defined?`,
        context: check.detail,
      });
    }

    const plagiarism = trustedChecks.filter(
      (c) => c.type === "nvd_plagiarism"
    );
    if (plagiarism.length > 0) {
      questions.push({
        category: "nvd_plagiarism",
        question: "Your vulnerability description closely mirrors the NVD advisory text. Can you describe in your own words how you independently discovered this issue, including your testing methodology and the specific behavior you observed?",
        context: plagiarism[0].detail,
      });
    }

    const invalidCves = trustedChecks.filter(
      (c) => c.type === "cve_not_in_nvd" || c.type === "invalid_cve_year"
    );
    for (const check of invalidCves.slice(0, 1)) {
      questions.push({
        category: "invalid_cve",
        question: `The CVE ID "${check.target}" could not be verified in NVD. Can you provide the CVE assignment source, the CNA that assigned it, or an alternative reference for this vulnerability?`,
        context: check.detail,
      });
    }
  }

  const placeholderPocs = evidence.filter(
    (e) => e.type === "placeholder_url" || e.type === "generic_path"
  );
  if (placeholderPocs.length > 0) {
    questions.push({
      category: "placeholder_poc",
      question: "Your proof-of-concept uses placeholder URLs or generic paths (e.g., example.com, target.com). Can you provide the actual HTTP request/response from your testing environment, including real headers and response bodies?",
      context: `Detected ${placeholderPocs.length} placeholder/generic reference(s) in the PoC.`,
    });
  }

  const severityInflation = evidence.filter(
    (e) => e.type === "severity_inflation"
  );
  if (severityInflation.length > 0) {
    questions.push({
      category: "severity_inflation",
      question: "The claimed severity appears inflated relative to the described impact. Can you provide specific evidence of the impact you're claiming, such as a demonstration of remote code execution, authentication bypass, or data exfiltration?",
      context: severityInflation[0].description,
    });
  }

  const fabricatedOutput = evidence.filter(
    (e) => e.type === "fake_asan" || e.type === "fake_registers" || e.type === "repeating_stack"
  );
  if (fabricatedOutput.length > 0) {
    questions.push({
      category: "fabricated_output",
      question: "The debug output in your report appears unusual. Can you provide the exact build flags, compiler version, and sanitizer configuration used, along with the full unedited crash log?",
      context: `Detected ${fabricatedOutput.length} potentially fabricated debug output(s).`,
    });
  }

  return questions.slice(0, 4);
}

const CVE_DATE_CACHE = new Map<string, Date>();

export function registerCvePublicationDate(cveId: string, publishedDate: string): void {
  try {
    const date = new Date(publishedDate);
    if (!isNaN(date.getTime())) {
      CVE_DATE_CACHE.set(cveId, date);
    }
  } catch {}
}

export function computeTemporalSignals(
  verification: VerificationResult | null,
  submissionTime: Date = new Date(),
): TemporalSignal[] {
  if (!verification) return [];

  const signals: TemporalSignal[] = [];

  for (const check of verification.checks) {
    if (check.type !== "verified_cve" && check.type !== "nvd_plagiarism") continue;

    const cveId = check.target;
    const pubDate = CVE_DATE_CACHE.get(cveId);
    if (!pubDate) continue;

    const hoursSince = (submissionTime.getTime() - pubDate.getTime()) / (1000 * 60 * 60);

    if (hoursSince < 0) continue;

    if (hoursSince < 2) {
      signals.push({
        cveId,
        publishedDate: pubDate.toISOString(),
        hoursSincePublication: Math.round(hoursSince * 10) / 10,
        signal: "suspiciously_fast",
        weight: 12,
      });
    } else if (hoursSince < 24) {
      signals.push({
        cveId,
        publishedDate: pubDate.toISOString(),
        hoursSincePublication: Math.round(hoursSince * 10) / 10,
        signal: "fast_turnaround",
        weight: 5,
      });
    } else {
      signals.push({
        cveId,
        publishedDate: pubDate.toISOString(),
        hoursSincePublication: Math.round(hoursSince),
        signal: "normal",
        weight: 0,
      });
    }
  }

  return signals;
}

const TEMPLATE_PLACEHOLDER_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /CVE-\d{4}-\d{4,}/gi, replacement: "{{CVE}}" },
  { re: /https?:\/\/[^\s"'<>)}\]]+/gi, replacement: "{{URL}}" },
  { re: /\b\d+\.\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?\b/g, replacement: "{{VERSION}}" },
  { re: /\b(?:CVSS[:\s]*)?[0-9]+\.[0-9]\b/gi, replacement: "{{SCORE}}" },
  { re: /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,3}\b/g, replacement: "{{NAME}}" },
  { re: /\b[0-9a-f]{7,40}\b/gi, replacement: "{{HASH}}" },
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "{{IP}}" },
];

export function computeTemplateHash(text: string): string {
  let normalized = text.trim();

  for (const { re, replacement } of TEMPLATE_PLACEHOLDER_PATTERNS) {
    normalized = normalized.replace(re, replacement);
  }

  normalized = normalized.toLowerCase().replace(/\s+/g, " ").trim();

  return createHash("sha256").update(normalized).digest("hex");
}

export function detectRevision(
  currentScore: number,
  matchedReport: { id: number; slopScore: number; similarity: number },
): RevisionResult {
  const scoreChange = currentScore - matchedReport.slopScore;
  let direction: RevisionResult["direction"] = "unchanged";
  if (scoreChange <= -5) direction = "improved";
  else if (scoreChange >= 5) direction = "worsened";

  const pctChanged = (100 - matchedReport.similarity).toFixed(0);
  let changeSummary: string;
  if (direction === "improved") {
    changeSummary = `Revision of report #${matchedReport.id} with ${pctChanged}% content changed. Slop score dropped ${Math.abs(scoreChange)} points (${matchedReport.slopScore} → ${currentScore}), suggesting the reporter addressed flagged issues.`;
  } else if (direction === "worsened") {
    changeSummary = `Revision of report #${matchedReport.id} with ${pctChanged}% content changed. Slop score increased ${scoreChange} points (${matchedReport.slopScore} → ${currentScore}), suggesting additional generated content was added.`;
  } else {
    changeSummary = `Revision of report #${matchedReport.id} with ${pctChanged}% content changed. Slop score remained similar (${matchedReport.slopScore} → ${currentScore}).`;
  }

  return {
    originalReportId: matchedReport.id,
    originalScore: matchedReport.slopScore,
    similarity: matchedReport.similarity,
    scoreChange,
    direction,
    changeSummary,
  };
}

// v3.6.0 §4: Single source of truth for assembling the matrix-triage context.
// Every triage call site in the API server (live composite path, cached-report
// path, /reports/:id, /reports/:id/triage-report, calibration suggestion, and
// the test-fixture battery) routes through one of these two adapters so the
// composite × engine 2 × verification ratio × strong-evidence inputs are
// computed identically.

interface NormalizedEngineSource {
  compositeScore: number | null;
  engine2Score: number | null;
  strongEvidenceCount: number;
  goldHitCount?: number;
  avriFamily?: string;
}

function pickEngine2Fields(
  engines: ReadonlyArray<{
    engine: string;
    score?: number;
    signalBreakdown?: {
      evidenceStrength?: { strongCount?: number };
      avri?: { family?: string; goldHitCount?: number };
    } | unknown;
  }>,
): { engine2Score: number | null; strongEvidenceCount: number; goldHitCount: number; avriFamily: string | undefined } {
  const e2 = engines.find(e => e.engine === "Technical Substance Analyzer");
  const breakdown = (e2?.signalBreakdown ?? {}) as {
    evidenceStrength?: { strongCount?: number };
    avri?: { family?: string; goldHitCount?: number };
  };
  return {
    engine2Score: typeof e2?.score === "number" ? e2.score : null,
    strongEvidenceCount: breakdown.evidenceStrength?.strongCount ?? 0,
    goldHitCount: breakdown.avri?.goldHitCount ?? 0,
    avriFamily: breakdown.avri?.family,
  };
}

function computeReferencedVerificationRatio(
  verification: VerificationResult | null,
): number {
  const referenced = (verification?.checks ?? []).filter(
    c => c.source === "referenced_in_report",
  );
  const verified = referenced.filter(c => c.result === "verified").length;
  const notFound = referenced.filter(c => c.result === "not_found").length;
  const total = verified + notFound;
  return total > 0 ? verified / total : 0;
}

function buildContext(
  src: NormalizedEngineSource,
  verification: VerificationResult | null,
): TriageDecisionContext | undefined {
  if (src.compositeScore == null) return undefined;
  return {
    compositeScore: src.compositeScore,
    engine2Score: src.engine2Score ?? 50,
    strongEvidenceCount: src.strongEvidenceCount,
    verificationRatio: computeReferencedVerificationRatio(verification),
    goldHitCount: src.goldHitCount,
    avriFamily: src.avriFamily,
  };
}

/**
 * Build matrix-triage context from a stored report row (cached path,
 * /reports/:id, /reports/:id/triage-report). Returns undefined when the row
 * predates v3.6.0 composite scoring; the caller falls back to the matrix's
 * neutral 50/50 baseline inside generateTriageRecommendation.
 */
export function buildV36TriageContext(
  report: { vulnrapCompositeScore: number | null; vulnrapEngineResults: unknown },
  verification: VerificationResult | null,
): TriageDecisionContext | undefined {
  const stored = (report.vulnrapEngineResults ?? {}) as {
    engines?: Array<{
      engine: string;
      score?: number;
      signalBreakdown?: { evidenceStrength?: { strongCount?: number } };
    }>;
  };
  const { engine2Score, strongEvidenceCount, goldHitCount, avriFamily } = pickEngine2Fields(stored.engines ?? []);
  return buildContext(
    {
      compositeScore: report.vulnrapCompositeScore,
      engine2Score,
      strongEvidenceCount,
      goldHitCount,
      avriFamily,
    },
    verification,
  );
}

/**
 * Build matrix-triage context from a freshly-computed in-memory composite
 * (live POST /reports path, /reports/check live path, fixture battery).
 * Returns undefined when no composite was produced (e.g. engines disabled
 * via the VULNRAP_USE_NEW_COMPOSITE feature flag).
 */
export function buildV36TriageContextFromComposite(
  composite: CompositeResult | null,
  verification: VerificationResult | null,
): TriageDecisionContext | undefined {
  if (!composite) return undefined;
  const { engine2Score, strongEvidenceCount, goldHitCount, avriFamily } = pickEngine2Fields(composite.engineResults);
  return buildContext(
    {
      compositeScore: composite.overallScore ?? null,
      engine2Score,
      strongEvidenceCount,
      goldHitCount,
      avriFamily,
    },
    verification,
  );
}
