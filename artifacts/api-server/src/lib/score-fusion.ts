import type { LinguisticResult } from "./linguistic-analysis";
import type { FactualResult } from "./factual-verification";
import type { LLMSlopResult } from "./llm-slop";

export interface ScoreBreakdown {
  linguistic: number;
  factual: number;
  template: number;
  llm: number | null;
  quality: number;
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
  slopTier: string;
}

export interface TierThresholds {
  low: number;
  high: number;
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  low: 30,
  high: 70,
};

const BASE_WEIGHTS = {
  linguistic: 0.25,
  factual: 0.30,
  llm: 0.35,
  template: 0.10,
};

const NO_LLM_WEIGHTS = {
  linguistic: 0.25 + 0.35 * 0.4,
  factual: 0.30 + 0.35 * 0.4,
  template: 0.10 + 0.35 * 0.2,
};

export function loadThresholds(): TierThresholds {
  const low = parseInt(process.env.SLOP_THRESHOLD_LOW || "", 10);
  const high = parseInt(process.env.SLOP_THRESHOLD_HIGH || "", 10);

  const validLow = !isNaN(low) && low >= 0 && low <= 100 ? low : DEFAULT_THRESHOLDS.low;
  const validHigh = !isNaN(high) && high >= 0 && high <= 100 ? high : DEFAULT_THRESHOLDS.high;

  if (validLow >= validHigh) {
    return DEFAULT_THRESHOLDS;
  }

  return { low: validLow, high: validHigh };
}

export function fuseScores(
  linguistic: LinguisticResult,
  factual: FactualResult,
  llm: LLMSlopResult | null,
  qualityScore: number,
  thresholds?: TierThresholds,
): FusionResult {
  const thr = thresholds ?? loadThresholds();

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

  const hasHallucinatedFunction = factual.evidence.some(
    e => e.type === "hallucinated_function" || e.type === "fabricated_cve"
  );
  const hasFutureCve = factual.evidence.some(e => e.type === "future_cve");
  const hasFakeAsan = factual.evidence.some(e => e.type === "fake_asan");

  const templateScore = linguistic.templateScore;

  let rawScore: number;

  if (llm) {
    let weights = { ...BASE_WEIGHTS };

    if (hasHallucinatedFunction || hasFutureCve || hasFakeAsan) {
      weights = {
        linguistic: 0.15,
        factual: 0.50,
        llm: 0.25,
        template: 0.10,
      };
    }

    rawScore =
      linguistic.lexicalScore * (weights.linguistic * 0.6) +
      linguistic.statisticalScore * (weights.linguistic * 0.4) +
      factual.score * weights.factual +
      llm.llmSlopScore * weights.llm +
      templateScore * weights.template;
  } else {
    let weights = { ...NO_LLM_WEIGHTS };

    if (hasHallucinatedFunction || hasFutureCve || hasFakeAsan) {
      weights = {
        linguistic: 0.25,
        factual: 0.55,
        template: 0.20,
      };
    }

    rawScore =
      linguistic.lexicalScore * (weights.linguistic * 0.6) +
      linguistic.statisticalScore * (weights.linguistic * 0.4) +
      factual.score * weights.factual +
      templateScore * weights.template;
  }

  const evidenceCount = allEvidence.filter(e => e.weight >= 5).length;
  const confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + (llm ? 0.2 : 0)
  );

  const slopScore = Math.min(100, Math.max(0, Math.round(
    rawScore * confidence + 50 * (1 - confidence)
  )));

  const breakdown: ScoreBreakdown = {
    linguistic: Math.round(linguistic.score),
    factual: Math.round(factual.score),
    template: Math.round(templateScore),
    llm: llm ? Math.round(llm.llmSlopScore) : null,
    quality: Math.round(qualityScore),
  };

  return {
    slopScore,
    qualityScore: Math.round(qualityScore),
    confidence: Math.round(confidence * 100) / 100,
    breakdown,
    evidence: allEvidence,
    slopTier: getSlopTier(slopScore, thr),
  };
}

export function getSlopTier(score: number, thresholds?: TierThresholds): string {
  const thr = thresholds ?? DEFAULT_THRESHOLDS;
  if (score >= thr.high) return "Pure Slop";
  if (score >= Math.round((thr.low + thr.high) / 2)) return "Highly Suspicious";
  if (score >= thr.low) return "Questionable";
  if (score >= Math.round(thr.low / 2)) return "Mildly Suspicious";
  return "Probably Legit";
}
