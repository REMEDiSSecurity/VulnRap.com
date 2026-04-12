import { createHash } from "crypto";
import type { VerificationResult, VerificationCheck } from "./active-verification";
import type { EvidenceItem } from "./score-fusion";

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
}

export function generateTriageRecommendation(
  slopScore: number,
  confidence: number,
  verification: VerificationResult | null,
  evidence: EvidenceItem[],
): Omit<TriageRecommendation, "temporalSignals" | "templateMatch" | "revision"> {
  const notFoundCount = verification?.summary.notFound ?? 0;
  const verifiedCount = verification?.summary.verified ?? 0;
  const warningCount = verification?.summary.warnings ?? 0;

  let action: TriageAction;
  let reason: string;
  let note: string;

  if (slopScore >= 75 && confidence >= 0.7) {
    action = "AUTO_CLOSE";
    reason = `High slop score (${slopScore}) with high confidence (${(confidence * 100).toFixed(0)}%) — strong AI-generation indicators across multiple axes.`;
    note = "This report exhibits overwhelming AI-generation signals. Consider auto-closing with a template response requesting original research. If your policy requires manual review of all closures, escalate to a senior triager.";
  } else if (slopScore >= 55) {
    action = "MANUAL_REVIEW";
    reason = `Moderate slop score (${slopScore}) — some AI-generation indicators present but not conclusive.`;
    note = "Assign to a senior triager for manual assessment. Check for concrete reproduction steps, unique observations, and domain-specific details that AI typically cannot fabricate.";
  } else if (notFoundCount >= 2) {
    action = "CHALLENGE_REPORTER";
    reason = `${notFoundCount} referenced items could not be verified — the reporter may be fabricating technical details.`;
    note = "Send the generated challenge questions below. A legitimate researcher will be able to answer specifics about their environment, exact reproduction steps, and how they discovered the issue. Set a 48-hour response deadline.";
  } else if (slopScore <= 25 && verifiedCount >= 2) {
    action = "PRIORITIZE";
    reason = `Low slop score (${slopScore}) with ${verifiedCount} verified references — strong indicators of legitimate, well-researched report.`;
    note = "This report shows hallmarks of genuine security research: verified file paths, confirmed function names, and natural writing style. Prioritize for technical review.";
  } else {
    action = "STANDARD_TRIAGE";
    reason = `Score (${slopScore}) and signals are within normal range — no strong indicators either way.`;
    note = "Process through standard triage workflow. No automated action recommended.";
  }

  if (warningCount > 0 && action !== "CHALLENGE_REPORTER") {
    note += ` Note: ${warningCount} verification warning(s) detected — review the verification panel for details.`;
  }

  const challengeQuestions = generateChallengeQuestions(verification, evidence);

  return { action, reason, note, challengeQuestions };
}

function generateChallengeQuestions(
  verification: VerificationResult | null,
  evidence: EvidenceItem[],
): ChallengeQuestion[] {
  const questions: ChallengeQuestion[] = [];

  if (verification) {
    const missingFiles = verification.checks.filter(
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

    const missingFunctions = verification.checks.filter(
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

    const plagiarism = verification.checks.filter(
      (c) => c.type === "nvd_plagiarism"
    );
    if (plagiarism.length > 0) {
      questions.push({
        category: "nvd_plagiarism",
        question: "Your vulnerability description closely mirrors the NVD advisory text. Can you describe in your own words how you independently discovered this issue, including your testing methodology and the specific behavior you observed?",
        context: plagiarism[0].detail,
      });
    }

    const invalidCves = verification.checks.filter(
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

  return {
    originalReportId: matchedReport.id,
    originalScore: matchedReport.slopScore,
    similarity: matchedReport.similarity,
    scoreChange,
    direction,
  };
}
