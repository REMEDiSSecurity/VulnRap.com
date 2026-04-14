import type { LinguisticResult } from "./linguistic-analysis";
import type { FactualResult } from "./factual-verification";
import type { LLMSlopResult } from "./llm-slop";
import { detectHumanIndicators, type HumanIndicator } from "./human-indicators";
import type { VerificationResult } from "./active-verification";
import { getCurrentConfig, getConfigVersion } from "./scoring-config";
import { computeSpectralScore, type SpectralResult } from "./spectral-analysis";
import { computeEvidenceQuality, type EvidenceQualityResult } from "./evidence-quality";
import { detectHallucinationSignals, type HallucinationResult } from "./hallucination-detector";
import { computeClaimSpecificity, type ClaimSpecificityResult } from "./claim-specificity";
import { computeInternalConsistency, type InternalConsistencyResult } from "./internal-consistency";

export interface ScoreBreakdown {
  linguistic: number;
  factual: number;
  template: number;
  llm: number | null;
  verification: number | null;
  quality: number;
  llmUsed?: boolean;
  redactionApplied?: boolean;
  scoringConfigVersion?: string;
  spectral?: number;
  evidenceQuality?: number;
  hallucinationDetector?: number;
  claimSpecificity?: number;
  internalConsistency?: number;
}

export interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

export type Quadrant = "AI_SLOP" | "AI_ASSISTED" | "WEAK_HUMAN" | "STRONG_HUMAN";

export type Archetype = "AUTO_CLOSE" | "PRIORITIZE_REVIEW" | "REQUEST_DETAILS" | "ACCEPT";

export interface TwoAxisResult {
  authenticityScore: number;
  validityScore: number;
  quadrant: Quadrant;
  archetype: Archetype;
}

export type AnalysisMode = "heuristic_only" | "llm_enhanced";

export interface FusionResult {
  slopScore: number;
  qualityScore: number;
  confidence: number;
  breakdown: ScoreBreakdown;
  evidence: EvidenceItem[];
  humanIndicators: HumanIndicator[];
  slopTier: string;
  authenticityScore: number;
  validityScore: number;
  quadrant: Quadrant;
  archetype: Archetype;
  analysisMode: AnalysisMode;
  confidenceNote: string | null;
}

export interface TierThresholds {
  low: number;
  high: number;
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  low: 20,
  high: 75,
};

const QUADRANT_THRESHOLD = 50;

export function classifyQuadrant(authenticityScore: number, validityScore: number): { quadrant: Quadrant; archetype: Archetype } {
  const highAuth = authenticityScore >= QUADRANT_THRESHOLD;
  const highValid = validityScore >= QUADRANT_THRESHOLD;

  if (highAuth && !highValid) {
    return { quadrant: "AI_SLOP", archetype: "AUTO_CLOSE" };
  }
  if (highAuth && highValid) {
    return { quadrant: "AI_ASSISTED", archetype: "PRIORITIZE_REVIEW" };
  }
  if (!highAuth && !highValid) {
    return { quadrant: "WEAK_HUMAN", archetype: "REQUEST_DETAILS" };
  }
  return { quadrant: "STRONG_HUMAN", archetype: "ACCEPT" };
}

export function loadScoringParams() {
  const config = getCurrentConfig();
  return {
    PRIOR: config.prior,
    FLOOR: config.floor,
    CEILING: config.ceiling,
    AXIS_THRESHOLDS: config.axisThresholds,
    FABRICATION_BOOST: config.fabricationBoost,
  };
}

export function loadThresholds(): TierThresholds {
  const config = getCurrentConfig();
  const envLow = parseInt(process.env.SLOP_THRESHOLD_LOW || "", 10);
  const envHigh = parseInt(process.env.SLOP_THRESHOLD_HIGH || "", 10);

  const low = !isNaN(envLow) && envLow >= 0 && envLow <= 100 ? envLow : config.tierThresholds.low;
  const high = !isNaN(envHigh) && envHigh >= 0 && envHigh <= 100 ? envHigh : config.tierThresholds.high;

  if (low >= high) {
    return { low: config.tierThresholds.low, high: config.tierThresholds.high };
  }

  return { low, high };
}

function computeAuthenticityScore(
  linguistic: LinguisticResult,
  _llm: LLMSlopResult | null,
  spectral: SpectralResult,
  humanResult: { totalReduction: number },
): number {
  const linguisticAxis = Math.round(
    linguistic.lexicalScore * 0.6 + linguistic.statisticalScore * 0.4
  );

  let auth = linguisticAxis * 0.40
    + linguistic.templateScore * 0.35
    + spectral.score * 0.25;

  if (linguisticAxis > 40 && linguistic.templateScore > 50) {
    const compoundBoost = Math.min(15, (linguisticAxis - 40) * 0.3 + (linguistic.templateScore - 50) * 0.1);
    auth += compoundBoost;
  }

  auth = Math.max(0, auth + humanResult.totalReduction);

  return Math.min(100, Math.max(0, Math.round(auth)));
}

function computeHeuristicValidity(
  factual: FactualResult,
  evidenceQuality: EvidenceQualityResult,
  hallucination: HallucinationResult,
  claimSpec: ClaimSpecificityResult,
  consistency: InternalConsistencyResult,
  verification: VerificationResult | null,
): number {
  const evidenceWeight = 0.25;
  const hallucinationWeight = 0.20;
  const claimWeight = 0.20;
  const consistencyWeight = 0.15;
  const factualWeight = 0.10;
  const verificationWeight = 0.10;

  const substanceLow = claimSpec.score < 10 && evidenceQuality.score < 10;
  const effectiveHallucination = substanceLow ? Math.min(hallucination.score, 40) : hallucination.score;
  const effectiveConsistency = substanceLow ? Math.min(consistency.score, 40) : consistency.score;

  let validity = evidenceQuality.score * evidenceWeight
    + effectiveHallucination * hallucinationWeight
    + claimSpec.score * claimWeight
    + effectiveConsistency * consistencyWeight
    + (100 - factual.score) * factualWeight;

  if (verification && verification.checks.length > 0) {
    const verifiedCount = verification.checks.filter(c => c.result === "verified").length;
    const verificationBonus = Math.min(100, verifiedCount * 20 + (100 - verification.score) * 0.5);
    validity += verificationBonus * verificationWeight;
  } else {
    validity += 50 * verificationWeight;
  }

  return Math.min(100, Math.max(0, Math.round(validity)));
}

function computeValidityScore(
  factual: FactualResult,
  llm: LLMSlopResult | null,
  evidenceQuality: EvidenceQualityResult,
  hallucination: HallucinationResult,
  claimSpec: ClaimSpecificityResult,
  consistency: InternalConsistencyResult,
  verification: VerificationResult | null,
): { final: number; heuristic: number; llmRaw: number | null } {
  const heuristic = computeHeuristicValidity(factual, evidenceQuality, hallucination, claimSpec, consistency, verification);

  if (llm && llm.llmBreakdown) {
    const llmRaw = llm.llmBreakdown.validityScore ?? 50;
    const final = Math.min(100, Math.max(0, Math.round(heuristic * 0.50 + llmRaw * 0.50)));
    return { final, heuristic, llmRaw };
  }

  return { final: heuristic, heuristic, llmRaw: null };
}

export function fuseScores(
  linguistic: LinguisticResult,
  factual: FactualResult,
  llm: LLMSlopResult | null,
  qualityScore: number,
  originalText: string,
  thresholds?: TierThresholds,
  verification?: VerificationResult | null,
): FusionResult {
  const thr = thresholds ?? loadThresholds();
  const params = loadScoringParams();

  const allEvidence: EvidenceItem[] = [
    ...linguistic.evidence,
    ...factual.evidence,
  ];

  if (llm) {
    if (llm.llmRedFlags) {
      for (const flag of llm.llmRedFlags) {
        allEvidence.push({
          type: "llm_red_flag",
          description: flag,
          weight: 8,
        });
      }
    }
    if (llm.llmFeedback) {
      for (const obs of llm.llmFeedback) {
        allEvidence.push({
          type: "llm_observation",
          description: obs,
          weight: 3,
        });
      }
    }
  }

  if (verification) {
    for (const check of verification.checks) {
      allEvidence.push({
        type: check.type,
        description: check.detail,
        weight: check.weight,
        matched: check.target,
      });
    }
  }

  const spectral = computeSpectralScore(originalText);
  const evidenceQuality = computeEvidenceQuality(originalText);
  const hallucination = detectHallucinationSignals(originalText);
  const claimSpec = computeClaimSpecificity(originalText);
  const consistency = computeInternalConsistency(originalText);

  for (const marker of spectral.markers) {
    allEvidence.push({ type: "spectral_" + marker.type, description: marker.description, weight: marker.weight });
  }
  for (const marker of evidenceQuality.markers) {
    allEvidence.push({ type: "evidence_" + marker.type, description: marker.description, weight: marker.weight });
  }
  for (const signal of hallucination.signals) {
    allEvidence.push({ type: "hallucination_" + signal.type, description: signal.description, weight: signal.weight });
  }
  for (const marker of claimSpec.markers) {
    allEvidence.push({ type: "claim_" + marker.type, description: marker.description || marker.type, weight: marker.weight });
  }
  for (const issue of consistency.issues) {
    allEvidence.push({ type: "consistency_" + issue.type, description: issue.description, weight: issue.weight });
  }

  const humanResult = detectHumanIndicators(originalText);

  const authenticityScore = computeAuthenticityScore(linguistic, llm, spectral, humanResult);
  const validityResult = computeValidityScore(
    factual, llm, evidenceQuality, hallucination, claimSpec, consistency, verification ?? null,
  );

  let scoreConflict: { conflict: boolean; heuristic: number; llm: number; difference: number } | null = null;
  let finalValidityScore = validityResult.final;
  if (validityResult.llmRaw !== null) {
    const diff = Math.abs(validityResult.heuristic - validityResult.llmRaw);
    if (diff > 30) {
      scoreConflict = { conflict: true, heuristic: validityResult.heuristic, llm: validityResult.llmRaw, difference: diff };
      finalValidityScore = Math.min(validityResult.heuristic, validityResult.llmRaw);
    }
  }

  const { quadrant, archetype } = classifyQuadrant(authenticityScore, finalValidityScore);

  let slopScore = Math.round(authenticityScore * 0.65 + (100 - finalValidityScore) * 0.35);

  const hasHallucinatedFunction = factual.evidence.some(
    e => e.type === "hallucinated_function" || e.type === "fabricated_cve"
  );
  const hasFutureCve = factual.evidence.some(e => e.type === "future_cve");
  const hasFakeAsan = factual.evidence.some(e => e.type === "fake_asan");
  const hasFabricationBoost = hasHallucinatedFunction || hasFutureCve || hasFakeAsan;

  if (hasFabricationBoost) {
    slopScore = Math.min(100, Math.round(slopScore * params.FABRICATION_BOOST));
  }

  if (verification) {
    const verifiedCount = verification.checks.filter(c => c.result === "verified").length;
    if (verifiedCount > 0) {
      const verifiedReduction = Math.min(verifiedCount * -3, -1);
      slopScore = Math.max(params.FLOOR, slopScore + verifiedReduction);
    }
  }

  slopScore = Math.min(100, Math.max(0, slopScore));

  const evidenceCount = allEvidence.filter(e => e.weight >= 5).length;
  let confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + (llm ? 0.2 : 0) + humanResult.indicators.length * 0.03 + (verification && verification.checks.length > 0 ? 0.1 : 0)
  );

  if (!llm) {
    confidence *= 0.85;
  }

  const totalMarkers = allEvidence.length + humanResult.indicators.length;
  if (totalMarkers < 3) {
    confidence *= 0.7;
  }

  for (const indicator of humanResult.indicators) {
    allEvidence.push({
      type: indicator.type,
      description: indicator.description,
      weight: indicator.weight,
      matched: indicator.matched,
    });
  }

  const templateScore = linguistic.templateScore;

  const breakdown: ScoreBreakdown = {
    linguistic: Math.round(linguistic.score),
    factual: Math.round(factual.score),
    template: Math.round(templateScore),
    llm: llm ? Math.round(llm.llmSlopScore) : null,
    verification: verification && verification.checks.length > 0 ? verification.score : null,
    quality: Math.round(qualityScore),
    scoringConfigVersion: getConfigVersion(),
    spectral: spectral.score,
    evidenceQuality: evidenceQuality.score,
    hallucinationDetector: hallucination.score,
    claimSpecificity: claimSpec.score,
    internalConsistency: consistency.score,
  };

  const analysisMode: AnalysisMode = llm ? "llm_enhanced" : "heuristic_only";
  const confidenceNote = !llm
    ? "Running in heuristic-only mode — confidence reduced by 15%. Enable LLM analysis for higher precision on borderline reports."
    : null;

  return {
    slopScore,
    qualityScore: Math.round(qualityScore),
    confidence: Math.round(confidence * 100) / 100,
    breakdown,
    evidence: allEvidence,
    humanIndicators: humanResult.indicators,
    slopTier: getSlopTier(slopScore, thr),
    authenticityScore,
    validityScore: finalValidityScore,
    quadrant,
    archetype,
    analysisMode,
    confidenceNote,
  };
}

export function recomputeSlopScoreWithoutLlm(
  breakdown: { linguistic: number; factual: number; template: number; verification?: number | null },
  evidenceItems: EvidenceItem[],
  originalText: string,
): { slopScore: number; confidence: number; slopTier: string; authenticityScore: number; validityScore: number; quadrant: Quadrant; archetype: Archetype } {
  const thr = loadThresholds();
  const params = loadScoringParams();

  const spectral = computeSpectralScore(originalText);
  const evidenceQuality = computeEvidenceQuality(originalText);
  const hallucination = detectHallucinationSignals(originalText);
  const claimSpec = computeClaimSpecificity(originalText);
  const consistency = computeInternalConsistency(originalText);
  const humanResult = detectHumanIndicators(originalText);

  const linguisticAxis = breakdown.linguistic;
  let auth = linguisticAxis * 0.40 + breakdown.template * 0.35 + spectral.score * 0.25;
  if (linguisticAxis > 40 && breakdown.template > 50) {
    const compoundBoost = Math.min(15, (linguisticAxis - 40) * 0.3 + (breakdown.template - 50) * 0.1);
    auth += compoundBoost;
  }
  auth = Math.max(0, auth + humanResult.totalReduction);
  const authenticityScore = Math.min(100, Math.max(0, Math.round(auth)));

  const substanceLow = claimSpec.score < 10 && evidenceQuality.score < 10;
  const effectiveHallucination = substanceLow ? Math.min(hallucination.score, 40) : hallucination.score;
  const effectiveConsistency = substanceLow ? Math.min(consistency.score, 40) : consistency.score;

  const factualInverse = 100 - breakdown.factual;
  let validity = evidenceQuality.score * 0.25
    + effectiveHallucination * 0.20
    + claimSpec.score * 0.20
    + effectiveConsistency * 0.15
    + factualInverse * 0.10;

  if (breakdown.verification != null) {
    validity += (100 - breakdown.verification) * 0.10;
  } else {
    validity += 50 * 0.10;
  }

  const validityScore = Math.min(100, Math.max(0, Math.round(validity)));
  const { quadrant, archetype } = classifyQuadrant(authenticityScore, validityScore);

  let slopScore = Math.round(authenticityScore * 0.65 + (100 - validityScore) * 0.35);

  const hasFabricationBoost = evidenceItems.some(
    e => e.type === "hallucinated_function" || e.type === "fabricated_cve" || e.type === "future_cve" || e.type === "fake_asan"
  );
  if (hasFabricationBoost) {
    slopScore = Math.min(100, Math.round(slopScore * params.FABRICATION_BOOST));
  }

  slopScore = Math.min(100, Math.max(0, slopScore));

  const nonLlmEvidence = evidenceItems.filter(e => e.type !== "llm_red_flag" && e.type !== "llm_observation");
  const evidenceCount = nonLlmEvidence.filter(e => e.weight >= 5).length;
  let confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + humanResult.indicators.length * 0.03
  );

  confidence *= 0.85;

  const totalMarkers = nonLlmEvidence.length + humanResult.indicators.length;
  if (totalMarkers < 3) {
    confidence *= 0.7;
  }

  return {
    slopScore,
    confidence: Math.round(confidence * 100) / 100,
    slopTier: getSlopTier(slopScore, thr),
    authenticityScore,
    validityScore,
    quadrant,
    archetype,
  };
}

export function getSlopTier(score: number, thresholds?: TierThresholds): string {
  const thr = thresholds ?? DEFAULT_THRESHOLDS;
  if (score > thr.high) return "Slop";
  if (score > 55) return "Likely Slop";
  if (score > 35) return "Questionable";
  if (score > thr.low) return "Likely Human";
  return "Clean";
}
