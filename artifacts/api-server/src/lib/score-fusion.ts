import type { LinguisticResult } from "./linguistic-analysis";
import type { FactualResult } from "./factual-verification";
import type { LLMSlopResult } from "./llm-slop";
import { detectHumanIndicators, type HumanIndicator } from "./human-indicators";
import type { VerificationResult } from "./active-verification";
import { getCurrentConfig, getConfigVersion } from "./scoring-config";

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
}

export interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

export interface FusionResult {
  slopScore: number;
  qualityScore: number;
  confidence: number;
  breakdown: ScoreBreakdown;
  evidence: EvidenceItem[];
  humanIndicators: HumanIndicator[];
  slopTier: string;
}

export interface TierThresholds {
  low: number;
  high: number;
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  low: 20,
  high: 75,
};

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

  const hasHallucinatedFunction = factual.evidence.some(
    e => e.type === "hallucinated_function" || e.type === "fabricated_cve"
  );
  const hasFutureCve = factual.evidence.some(e => e.type === "future_cve");
  const hasFakeAsan = factual.evidence.some(e => e.type === "fake_asan");
  const hasFabricationBoost = hasHallucinatedFunction || hasFutureCve || hasFakeAsan;

  const templateScore = linguistic.templateScore;

  const linguisticAxisScore = Math.round(
    linguistic.lexicalScore * 0.6 + linguistic.statisticalScore * 0.4
  );

  const axisScores: { name: string; score: number }[] = [
    { name: "linguistic", score: linguisticAxisScore },
    { name: "factual", score: factual.score },
    { name: "template", score: templateScore },
  ];
  if (llm) {
    axisScores.push({ name: "llm", score: llm.llmSlopScore });
  }
  if (verification && verification.checks.length > 0) {
    axisScores.push({ name: "verification", score: verification.score });
  }

  const activeAxes = axisScores.filter(
    a => a.score > (params.AXIS_THRESHOLDS[a.name] ?? 10)
  );

  let slopScore: number;

  if (activeAxes.length === 0) {
    slopScore = params.PRIOR;
  } else {
    const probabilities = activeAxes.map(a => {
      let p = a.score / 100;
      if (hasFabricationBoost && a.name === "factual") {
        p = Math.min(1, p * params.FABRICATION_BOOST);
      }
      return Math.max(0, Math.min(0.95, p));
    });

    const combinedP = 1 - probabilities.reduce((prod, p) => prod * (1 - p), 1);

    slopScore = Math.round(params.PRIOR + combinedP * (params.CEILING - params.PRIOR));
  }

  const humanResult = detectHumanIndicators(originalText);

  if (verification) {
    const verifiedCount = verification.checks.filter(c => c.result === "verified").length;
    if (verifiedCount > 0) {
      const verifiedReduction = Math.min(verifiedCount * -3, -1);
      slopScore = Math.max(params.FLOOR, slopScore + verifiedReduction);
    }
  }

  slopScore = Math.max(params.FLOOR, slopScore + humanResult.totalReduction);

  slopScore = Math.min(100, Math.max(0, slopScore));

  const evidenceCount = allEvidence.filter(e => e.weight >= 5).length;
  const confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + (llm ? 0.2 : 0) + humanResult.indicators.length * 0.03 + (verification && verification.checks.length > 0 ? 0.1 : 0)
  );

  for (const indicator of humanResult.indicators) {
    allEvidence.push({
      type: indicator.type,
      description: indicator.description,
      weight: indicator.weight,
      matched: indicator.matched,
    });
  }

  const breakdown: ScoreBreakdown = {
    linguistic: Math.round(linguistic.score),
    factual: Math.round(factual.score),
    template: Math.round(templateScore),
    llm: llm ? Math.round(llm.llmSlopScore) : null,
    verification: verification && verification.checks.length > 0 ? verification.score : null,
    quality: Math.round(qualityScore),
    scoringConfigVersion: getConfigVersion(),
  };

  return {
    slopScore,
    qualityScore: Math.round(qualityScore),
    confidence: Math.round(confidence * 100) / 100,
    breakdown,
    evidence: allEvidence,
    humanIndicators: humanResult.indicators,
    slopTier: getSlopTier(slopScore, thr),
  };
}

export function recomputeSlopScoreWithoutLlm(
  breakdown: { linguistic: number; factual: number; template: number; verification?: number | null },
  evidenceItems: EvidenceItem[],
  originalText: string,
): { slopScore: number; confidence: number; slopTier: string } {
  const thr = loadThresholds();
  const params = loadScoringParams();

  const hasFabricationBoost = evidenceItems.some(
    e => e.type === "hallucinated_function" || e.type === "fabricated_cve" || e.type === "future_cve" || e.type === "fake_asan"
  );

  const axisScores: { name: string; score: number }[] = [
    { name: "linguistic", score: breakdown.linguistic },
    { name: "factual", score: breakdown.factual },
    { name: "template", score: breakdown.template },
  ];
  if (breakdown.verification != null) {
    axisScores.push({ name: "verification", score: breakdown.verification });
  }

  const activeAxes = axisScores.filter(
    a => a.score > (params.AXIS_THRESHOLDS[a.name] ?? 10)
  );

  let slopScore: number;
  if (activeAxes.length === 0) {
    slopScore = params.PRIOR;
  } else {
    const probabilities = activeAxes.map(a => {
      let p = a.score / 100;
      if (hasFabricationBoost && a.name === "factual") {
        p = Math.min(1, p * params.FABRICATION_BOOST);
      }
      return Math.max(0, Math.min(0.95, p));
    });
    const combinedP = 1 - probabilities.reduce((prod, p) => prod * (1 - p), 1);
    slopScore = Math.round(params.PRIOR + combinedP * (params.CEILING - params.PRIOR));
  }

  const humanResult = detectHumanIndicators(originalText);
  slopScore = Math.max(params.FLOOR, slopScore + humanResult.totalReduction);
  slopScore = Math.min(100, Math.max(0, slopScore));

  const nonLlmEvidence = evidenceItems.filter(e => e.type !== "llm_red_flag" && e.type !== "llm_observation");
  const evidenceCount = nonLlmEvidence.filter(e => e.weight >= 5).length;
  const confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + humanResult.indicators.length * 0.03
  );

  return {
    slopScore,
    confidence: Math.round(confidence * 100) / 100,
    slopTier: getSlopTier(slopScore, thr),
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
