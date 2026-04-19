// Sprint 9: Engines 1, 2, 3 + composite scoring with override rules.
// Each engine is fully independent (no shared state) per spec §Architecture.

import type { ExtractedSignals } from "./extractors";
import { CWE_FINGERPRINTS, HIGH_REJECTION_CWES } from "./cwe-fingerprints";

export type Verdict = "GREEN" | "YELLOW" | "RED" | "GREY";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface TriggeredIndicator {
  signal: string;
  value: string | number | boolean;
  threshold?: number;
  strength: "HIGH" | "MEDIUM" | "LOW";
  explanation: string;
}

export interface EngineResult {
  engine: string;
  score: number;
  verdict: Verdict;
  confidence: Confidence;
  triggeredIndicators: TriggeredIndicator[];
  signalBreakdown: Record<string, { score: number; weight: number } | string[] | Record<string, number>>;
  note: string;
}

export interface CompositeResult {
  overallScore: number;
  label: string;
  compositeBreakdown: {
    weightedSum: number;
    totalWeight: number;
    beforeOverride: number;
    afterOverride: number;
  };
  engineResults: EngineResult[];
  engineCount: number;
  overridesApplied: string[];
  warnings: string[];
}

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const norm = (n: number) => clamp(n * 100, 0, 100);

// =============================================================================
// Engine 1 — AI Authorship Detector (5% in Phase 1, informational)
// =============================================================================

function computeStructural(s: ExtractedSignals): number {
  const summaryComponent = (s.hasExecutiveSummary ? 100 : 0) * 0.40;
  const completenessComponent =
    (s.completenessScore >= 5 && !s.hasDepthIndicators ? 80 : s.completenessScore >= 5 ? 30 : 15) * 0.25;
  // Use H1 10K normalization: 1.51 headers/report
  const headerComponent = norm(s.sectionHeaderCount / 6) * 0.15;
  // AI mean=26.8 wpm; normalize so 26.8 => 1.0
  const sentenceComponent = norm(s.avgSentenceLength / 26.8) * 0.12;
  const placeholderComponent = norm(s.placeholderUrlCount / 4) * 0.05;
  const salutationComponent = (s.hasFormalSalutation ? 60 : 0) * 0.03;
  return clamp(summaryComponent + completenessComponent + headerComponent + sentenceComponent + placeholderComponent + salutationComponent);
}

function computeLexical(s: ExtractedSignals): number {
  const wordsPer1k = s.wordCount > 0 ? 1000 / s.wordCount : 1;
  const hedgeRate = s.hedgingPhraseCount * wordsPer1k;
  const fillerRate = s.fillerPhraseCount * wordsPer1k;
  const remediationRate = s.genericRemediationCount;
  const overClaimRate = s.overClaimCount;

  return clamp(
    norm(hedgeRate / 8) * 0.15 +
    norm(fillerRate / 5) * 0.15 +
    norm(remediationRate / 3) * 0.35 +
    norm(overClaimRate / 3) * 0.25 +
    (1 - norm(s.vocabularyRichness / 0.756) / 100) * 100 * 0.10
  );
}

function computeUniformity(s: ExtractedSignals): number {
  // Calibrated against expert reports. AI CV ~ 0.711, expert ~ 0.895
  const cv = s.sentenceLengthCV;
  const cvScore =
    cv < 0.711 ? 100 * (1 - cv / 0.711) :
    cv > 0.895 ? 0 :
    100 * (0.895 - cv) / (0.895 - 0.711);

  const paraScore = s.paragraphLengthCV < 0.30 ? 60 : s.paragraphLengthCV < 0.50 ? 30 : 0;
  const burstinessScore = s.burstinessScore;
  return clamp(cvScore * 0.60 + paraScore * 0.25 + burstinessScore * 0.15);
}

function computeBehavioral(s: ExtractedSignals): number {
  const hallucination =
    s.functionCallReferences > 20 && s.filePathCount < 2 ? 60 : 0;
  const pocMismatch =
    s.claimsPoCPresent && s.codeBlockCount === 0 && s.realUrlCount < 1 ? 80 : 0;
  return clamp(
    Math.max(pocMismatch, hallucination) * 0.35 +
    (100 - norm(s.realUrlCount / 8.54)) * 0.30 +
    (100 - norm(s.codeBlockCount / 2.81)) * 0.20 +
    (100 - norm(s.filePathCount / 13.91)) * 0.15
  );
}

export function runEngine1(s: ExtractedSignals): EngineResult {
  const structural = computeStructural(s);
  const lexical = computeLexical(s);
  const uniformity = computeUniformity(s);
  const behavioral = computeBehavioral(s);

  const score = Math.round(
    structural * 0.25 + lexical * 0.30 + uniformity * 0.25 + behavioral * 0.20
  );

  const verdict: Verdict = score <= 25 ? "GREEN" : score <= 74 ? "YELLOW" : "RED";

  const indicators: TriggeredIndicator[] = [];
  if (s.hasExecutiveSummary) {
    indicators.push({
      signal: "EXECUTIVE_SUMMARY", value: true, strength: "HIGH",
      explanation: "Report includes executive summary; rare in human reports (15.2% AI vs 0% expert).",
    });
  }
  if (s.completenessScore >= 5 && !s.hasDepthIndicators) {
    indicators.push({
      signal: "OVER_COMPLETE_NO_DEPTH", value: s.completenessScore, threshold: 5, strength: "MEDIUM",
      explanation: `Hit ${s.completenessScore}/6 sections without depth indicators (debugger output, asm, syscalls).`,
    });
  }
  if (s.sentenceLengthCV < 0.711) {
    indicators.push({
      signal: "SENTENCE_LENGTH_CV", value: Number(s.sentenceLengthCV.toFixed(2)), threshold: 0.84, strength: "MEDIUM",
      explanation: `Sentence length CV ${s.sentenceLengthCV.toFixed(2)} (AI ~0.71 vs expert ~0.90); suggests uniform pacing.`,
    });
  }
  if (s.genericRemediationCount >= 2) {
    indicators.push({
      signal: "GENERIC_REMEDIATION", value: s.genericRemediationCount, threshold: 1, strength: "HIGH",
      explanation: `${s.genericRemediationCount} generic remediation phrases detected (AI ~22%, expert ~1%).`,
    });
  }
  if (s.claimsPoCPresent && s.codeBlockCount === 0) {
    indicators.push({
      signal: "POC_MISMATCH", value: "Claims PoC; 0 code blocks", strength: "HIGH",
      explanation: "Report claims proof-of-concept but contains zero code blocks; strong AI slop indicator.",
    });
  }
  if (s.functionCallReferences > 20 && s.filePathCount < 2) {
    indicators.push({
      signal: "HALLUCINATION_DENSITY", value: s.functionCallReferences, threshold: 20, strength: "HIGH",
      explanation: `${s.functionCallReferences} function references but only ${s.filePathCount} file paths — likely fabricated.`,
    });
  }

  const confidence: Confidence =
    indicators.filter(i => i.strength === "HIGH").length >= 2 ? "HIGH" :
    indicators.length >= 2 ? "MEDIUM" : "LOW";

  return {
    engine: "AI Authorship Detector",
    score,
    verdict,
    confidence,
    triggeredIndicators: indicators,
    signalBreakdown: {
      structural: { score: Math.round(structural), weight: 0.25 },
      lexical: { score: Math.round(lexical), weight: 0.30 },
      uniformity: { score: Math.round(uniformity), weight: 0.25 },
      behavioral: { score: Math.round(behavioral), weight: 0.20 },
    },
    note: "AI authorship is informational, not disqualifying. Cross-reference with Substance and CWE Coherence.",
  };
}

// =============================================================================
// Engine 2 — Technical Substance Analyzer (55% in Phase 1)
// =============================================================================

function computeCodeEvidenceScore(s: ExtractedSignals): number {
  let score = 0;
  score += Math.min(15, s.codeBlockCount * 5.4);
  score += s.codeBlockLanguageSpecificRatio * 10;
  score += Math.min(12, s.inlineCodeReferenceCount * 1.7);
  if (s.hasActualCommandOutput) score += 8;
  if (s.hasShellPromptIndicators) score += 4;
  if (s.hasRealErrorMessages) score += 3;
  if (s.hasSpecificMemoryAddresses) score += 8;
  // No ecosystem-matching in Phase 1; treat presence of file paths as proxy
  if (s.filePathCount >= 2) score += 8;
  if (s.variableNamesAreGeneric) score -= 8;
  return Math.max(0, Math.min(75, score));
}

function computeReferenceScore(s: ExtractedSignals): number {
  let score = 0;
  score += Math.min(15, s.specificEndpointCount * 3.7);
  score += Math.min(15, s.lineNumberCount * 1.76);
  score += Math.min(12, s.filePathCount * 0.86);
  score += Math.min(8, Math.min(3, s.versionMentionCount) * 2.7);
  score += Math.min(10, s.externalCveReferences * 1.43);
  // Hallucination penalty: many functions, few file paths
  const ratio = s.filePathCount > 0 ? s.functionCallReferences / s.filePathCount : s.functionCallReferences;
  if (ratio > 10) {
    score -= Math.min(15, (ratio - 10) * 1.5);
  }
  return Math.max(0, Math.min(60, score));
}

function computeReproducibilityScore(s: ExtractedSignals): number {
  let score = 0;
  if (s.hasStepsToReproduce) score += 8;
  if (s.hasEnvironmentSpec) score += 10;
  if (s.hasScreenshotReference) score += 8;
  score += Math.min(15, s.realUrlCount * 1.76);
  score -= Math.min(10, s.placeholderUrlCount * 3.3);
  if (s.specificVulnerableCodeContext) score += 6;
  score += s.vulnerabilityReproducibilityScore * 7;
  return Math.max(0, Math.min(60, score));
}

function computePocIntegrity(s: ExtractedSignals): number {
  // Returns -20..+20 → mapped to 0..100 by caller
  if (s.claimsPoCPresent && s.codeBlockCount === 0 && s.placeholderUrlCount > 0) return -20;
  if (s.claimsPoCPresent && s.codeBlockCount === 0 && s.realUrlCount < 1) return -15;
  if (s.claimsPoCPresent && s.codeBlockCount > 0 && s.placeholderUrlCount === 0) {
    if (s.codeBlockLanguageSpecificRatio > 0.5 && s.specificVulnerableCodeContext) return 20;
    if (s.codeBlockLanguageSpecificRatio > 0.5) return 12;
    return 8;
  }
  if (!s.claimsPoCPresent) return 0;
  return 5;
}

function analyzeClaimEvidenceRatio(s: ExtractedSignals): { ratio: number; ratioScore: number } {
  const ratio = s.claimEvidenceRatio;
  // Reports with low or zero claim density and substantive evidence are healthy.
  // Penalize only when claims dominate evidence (ratio above expert ~0.27).
  let ratioScore: number;
  if (s.claimCount === 0 && s.evidenceCount >= 3) {
    ratioScore = 100;
  } else if (ratio <= 0.27) {
    ratioScore = clamp(100 - (0.27 - ratio) * 60);
  } else {
    ratioScore = clamp(100 - (ratio - 0.27) * 200);
  }
  return { ratio, ratioScore };
}

export function runEngine2(s: ExtractedSignals): EngineResult {
  const codeScore = computeCodeEvidenceScore(s);
  const refScore = computeReferenceScore(s);
  const reproScore = computeReproducibilityScore(s);
  const pocRaw = computePocIntegrity(s);
  const pocScore = clamp(50 + pocRaw * 2.5);
  const ce = analyzeClaimEvidenceRatio(s);

  // Calibration note: each subcomponent's own internal cap (75 / 60 / 60) is
  // the *theoretical* ceiling assuming every signal is present. We divide by a
  // smaller "calibrated maximum" (50 / 40 / 35) reflecting what real
  // expert-quality reports actually accumulate, then clamp the final composite
  // to [0, 100]. This gives well-evidenced reports a fair chance to reach
  // GREEN without requiring every conceivable signal.
  const baseScore = clamp(
    (codeScore / 50 * 100) * 0.35 +
    (refScore / 40 * 100) * 0.30 +
    (reproScore / 35 * 100) * 0.20 +
    pocScore * 0.10 +
    ce.ratioScore * 0.05
  );

  let finalScore = baseScore;
  // OVERRIDE: extreme claim:evidence ratios force low scores
  let extremeFlag = false;
  if (ce.ratio > 1.0) {
    finalScore = Math.min(finalScore, 25);
    extremeFlag = true;
  }
  if (ce.ratio < 0.01 && s.claimCount > 5) {
    finalScore = Math.min(finalScore, 20);
    extremeFlag = true;
  }
  finalScore = clamp(Math.round(finalScore));

  const verdict: Verdict =
    finalScore >= 61 ? "GREEN" :
    finalScore >= 41 ? "YELLOW" :
    "RED";

  const indicators: TriggeredIndicator[] = [];
  if (s.claimsPoCPresent && s.codeBlockCount === 0) {
    indicators.push({
      signal: "POC_MISMATCH", value: "Claims PoC; 0 code blocks", strength: "HIGH",
      explanation: "Report claims proof-of-concept but contains zero code blocks.",
    });
  }
  if (s.placeholderUrlCount > 0 && s.realUrlCount === 0) {
    indicators.push({
      signal: "PLACEHOLDER_URLS", value: s.placeholderUrlCount, threshold: 0, strength: "HIGH",
      explanation: `Contains ${s.placeholderUrlCount} placeholder URL(s) and 0 real working URLs.`,
    });
  }
  if (s.filePathCount === 0) {
    indicators.push({
      signal: "FILE_PATHS", value: 0, threshold: 13.91, strength: "MEDIUM",
      explanation: "No specific file paths found; expert reports average 13.91 (4.1x slop ratio).",
    });
  }
  if (s.lineNumberCount === 0) {
    indicators.push({
      signal: "LINE_NUMBERS", value: 0, threshold: 8.5, strength: "MEDIUM",
      explanation: "No line number references; expert reports average 8.5 (6.0x slop ratio).",
    });
  }
  if (extremeFlag || ce.ratio > 1.0 || (ce.ratio < 0.01 && s.claimCount > 5)) {
    indicators.push({
      signal: "CLAIM_EVIDENCE_EXTREME", value: Number(ce.ratio.toFixed(2)),
      threshold: 0.27, strength: "HIGH",
      explanation: `Claim:evidence ratio ${ce.ratio.toFixed(2)} vs expert 0.27; many claims with minimal evidence.`,
    });
  } else {
    indicators.push({
      signal: "CLAIM_EVIDENCE_RATIO", value: Number(ce.ratio.toFixed(2)),
      threshold: 0.27, strength: ce.ratioScore < 30 ? "HIGH" : ce.ratioScore < 60 ? "MEDIUM" : "LOW",
      explanation: `Claim:evidence ratio ${ce.ratio.toFixed(2)} (expert=0.27, slop=0.03).`,
    });
  }
  if (s.specificEndpointCount === 0) {
    indicators.push({
      signal: "SPECIFIC_ENDPOINTS", value: 0, threshold: 4.08, strength: "MEDIUM",
      explanation: "No specific endpoints referenced; expert reports average 4.08 (8.9x slop ratio).",
    });
  }

  return {
    engine: "Technical Substance Analyzer",
    score: finalScore,
    verdict,
    confidence: "HIGH",
    triggeredIndicators: indicators,
    signalBreakdown: {
      codeEvidence: { score: Math.round(codeScore / 75 * 100), weight: 0.35 },
      references: { score: Math.round(refScore / 60 * 100), weight: 0.30 },
      reproducibility: { score: Math.round(reproScore / 60 * 100), weight: 0.20 },
      pocIntegrity: { score: Math.round(pocScore), weight: 0.10 },
      claimEvidence: { score: Math.round(ce.ratioScore), weight: 0.05 },
    },
    note: `Substance is the strongest predictor of report quality. Claim:evidence ratio ${ce.ratio.toFixed(2)} (expert=0.27, slop=0.03).`,
  };
}

// =============================================================================
// Engine 3 — CWE Coherence Checker (40% in Phase 1)
// =============================================================================

function intersectionCount(haystack: Set<string>, needles: string[]): number {
  let c = 0;
  for (const n of needles) {
    const lower = n.toLowerCase();
    if (haystack.has(lower)) { c++; continue; }
    // Also check substring for multi-word terms
    if (lower.includes(" ") || lower.includes("-")) {
      // do nothing; handled by phrase match below
    }
  }
  return c;
}

function phraseMatchCount(text: string, phrases: string[]): number {
  let c = 0;
  const lowered = text.toLowerCase();
  for (const p of phrases) {
    if (lowered.includes(p.toLowerCase())) c++;
  }
  return c;
}

export function runEngine3(s: ExtractedSignals, fullText: string): EngineResult {
  const claimedCwes = s.claimedCwes;
  if (!claimedCwes || claimedCwes.length === 0) {
    return {
      engine: "CWE Coherence Checker",
      score: 50, verdict: "GREY", confidence: "LOW",
      triggeredIndicators: [{
        signal: "NO_CWE_CLAIMED", value: false, strength: "LOW",
        explanation: "No CWE claimed in the report; coherence cannot be evaluated.",
      }],
      signalBreakdown: { claimedCWEs: [] },
      note: "No CWE claimed; unable to validate coherence. Score is neutral (50).",
    };
  }

  const tokenSet = new Set(s.termTokens);
  const perCWEScores: Record<string, number> = {};
  const indicators: TriggeredIndicator[] = [];

  for (const cwe of claimedCwes) {
    const fp = CWE_FINGERPRINTS[cwe];
    if (!fp) {
      perCWEScores[cwe] = 50;
      indicators.push({
        signal: "UNKNOWN_CWE", value: cwe, strength: "LOW",
        explanation: `${cwe} is not in the Phase 1 fingerprint library; using neutral score.`,
      });
      continue;
    }

    // Required-term check (single-word OR phrase, OR aliases)
    const reqHits = phraseMatchCount(fullText, [...fp.requiredTerms, ...fp.knownAliases]);
    const requiredOverlap = fp.requiredTerms.length === 0 ? 100 : (reqHits > 0 ? 100 : 0);

    // Expected-term overlap
    const expHits = phraseMatchCount(fullText, fp.expectedTerms);
    const expectedScore = fp.expectedTerms.length > 0 ? (expHits / fp.expectedTerms.length) * 100 : 50;

    // Negative term penalty
    const negHits = phraseMatchCount(fullText, fp.negativeTerms);
    const negativePenalty = Math.min(80, negHits * 15);

    // Density: relevant tokens out of all tokens
    const allRelevant = [...fp.requiredTerms, ...fp.expectedTerms, ...fp.knownAliases];
    const relHits = phraseMatchCount(fullText, allRelevant);
    const density = (s.wordCount > 0 ? (relHits / s.wordCount) : 0);
    const minDensity = fp.minTermDensity / 10; // calibrate to per-word fraction
    const densityScore = density >= minDensity ? 100 : (density / Math.max(0.0001, minDensity)) * 100;

    // Rejection-rate adjustment
    const rejectionAdjustment = fp.rejectionRate > 1.5 ? (1 / fp.rejectionRate) * 100 : 100;

    let cweScore = clamp(
      requiredOverlap * 0.15 +
      expectedScore * 0.40 -
      negativePenalty * 0.20 +
      densityScore * 0.20 +
      rejectionAdjustment * 0.05
    );
    // Coherent-fit bonus: required terms hit, no contradicting terms, and
    // expected coverage above half the fingerprint.
    if (requiredOverlap === 100 && negativePenalty === 0 && expectedScore >= 50) {
      cweScore = clamp(cweScore + 10);
    }
    perCWEScores[cwe] = Math.round(cweScore);

    if (cweScore < 30) {
      indicators.push({
        signal: "TYPE_SWAP", value: cwe, threshold: 30, strength: "HIGH",
        explanation: `Claimed ${cwe} (${fp.name}) but report terms don't match the expected fingerprint; possible mis-classification.`,
      });
    } else if (cweScore < 50) {
      indicators.push({
        signal: "UNDERSPECIFIED", value: cwe, threshold: 50, strength: "MEDIUM",
        explanation: `Report content for ${cwe} is underspecified; insufficient evidence to confirm coherence.`,
      });
    }

    if (HIGH_REJECTION_CWES[cwe]) {
      indicators.push({
        signal: "HIGH_REJECTION_PRIOR", value: cwe, strength: "MEDIUM",
        explanation: `${cwe} has historically high rejection rate (${HIGH_REJECTION_CWES[cwe]}x); elevated scrutiny.`,
      });
    }
  }

  const avg = Object.values(perCWEScores).reduce((a, b) => a + b, 0) / claimedCwes.length;
  const score = Math.round(avg);
  const verdict: Verdict =
    score >= 71 ? "GREEN" : score >= 41 ? "YELLOW" : "RED";

  return {
    engine: "CWE Coherence Checker",
    score,
    verdict,
    confidence: indicators.some(i => i.strength === "HIGH") ? "HIGH" : "MEDIUM",
    triggeredIndicators: indicators,
    signalBreakdown: {
      claimedCWEs: claimedCwes,
      perCWEScores,
    },
    note: `CWE coherence analysis for ${claimedCwes.join(", ")}. Per-CWE scores: ${Object.entries(perCWEScores).map(([c, v]) => `${c}=${v}`).join(", ")}.`,
  };
}

// =============================================================================
// Composite scoring with override rules (§D)
// =============================================================================

const ENGINE_WEIGHTS_PHASE1: Record<string, number> = {
  "AI Authorship Detector": 0.05,
  "Technical Substance Analyzer": 0.55,
  "CWE Coherence Checker": 0.40,
};

function getCompositeLabel(score: number): string {
  if (score <= 20) return "LIKELY INVALID";
  if (score <= 35) return "HIGH RISK";
  if (score <= 50) return "NEEDS REVIEW";
  if (score <= 65) return "REASONABLE";
  if (score <= 80) return "PROMISING";
  return "STRONG";
}

function applyOverrideRules(
  composite: number,
  results: EngineResult[],
  applied: string[],
): number {
  let adjustment = 0;
  const ai = results.find(r => r.engine === "AI Authorship Detector");
  const sub = results.find(r => r.engine === "Technical Substance Analyzer");
  const cwe = results.find(r => r.engine === "CWE Coherence Checker");

  if (ai?.verdict === "RED" && sub?.verdict === "RED") {
    adjustment -= 20;
    applied.push("CONVERGENT_NEGATIVE: AI Authorship RED + Substance RED");
  }
  if (cwe?.triggeredIndicators?.some(i => i.signal === "TYPE_SWAP")) {
    adjustment -= 15;
    applied.push("CWE_TYPE_SWAP: Claimed CWE mismatch with content");
  }
  if (sub?.triggeredIndicators?.some(i => i.signal === "CLAIM_EVIDENCE_EXTREME")) {
    adjustment -= 25;
    applied.push("CLAIM_EVIDENCE_EXTREME: Many claims, minimal evidence");
  }
  if (cwe?.triggeredIndicators?.some(i => i.signal === "HIGH_REJECTION_PRIOR")) {
    adjustment -= 5;
    applied.push("HIGH_REJECTION_CWE_PRIOR: This CWE category has high rejection history");
  }
  if (sub && sub.score < 20 && ai && ai.score < 40) {
    adjustment -= 5;
    applied.push("THIN_LEGITIMATE_REPORT: Low substance but not AI-authored");
  }
  return composite + adjustment;
}

export function computeComposite(engineResults: EngineResult[]): CompositeResult {
  // Phase 1 always applies the fixed 5/55/40 weighting across all three
  // engines, regardless of per-engine confidence. Confidence is still surfaced
  // in the per-engine result so consumers can de-emphasize uncertain signals
  // in their UI, but the composite math itself is deterministic.
  let weightedSum = 0;
  let totalWeight = 0;
  for (const r of engineResults) {
    const w = ENGINE_WEIGHTS_PHASE1[r.engine] || 0;
    // Engine 1 is "AI authorship likelihood" (high = bad); other engines are
    // already validity-positive (high = good). Convert engine 1 to a quality
    // contribution by inverting it: quality = 100 - aiScore.
    const contribution = r.engine === "AI Authorship Detector" ? (100 - r.score) : r.score;
    weightedSum += contribution * w;
    totalWeight += w;
  }
  const beforeOverride = totalWeight > 0 ? weightedSum / totalWeight : 50;
  const applied: string[] = [];
  const afterOverride = applyOverrideRules(beforeOverride, engineResults, applied);
  const finalScore = Math.round(clamp(afterOverride));

  const warnings: string[] = [];
  for (const r of engineResults) {
    if (r.verdict === "RED" && r.confidence === "HIGH") {
      warnings.push(`${r.engine} returned RED with high confidence.`);
    }
  }

  return {
    overallScore: finalScore,
    label: getCompositeLabel(finalScore),
    compositeBreakdown: {
      weightedSum: Math.round(weightedSum * 10) / 10,
      totalWeight: Math.round(totalWeight * 100) / 100,
      beforeOverride: Math.round(beforeOverride),
      afterOverride: Math.round(afterOverride),
    },
    engineResults,
    engineCount: engineResults.length,
    overridesApplied: applied,
    warnings,
  };
}
