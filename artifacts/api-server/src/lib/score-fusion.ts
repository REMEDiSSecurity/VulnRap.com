import type { LinguisticResult } from "./linguistic-analysis";
import type { FactualResult } from "./factual-verification";
import type { LLMSlopResult } from "./llm-slop";
import { detectHumanIndicators, type HumanIndicator } from "./human-indicators";

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

const PRIOR = 15;
const FLOOR = 5;
const CEILING = 95;

const AXIS_THRESHOLDS: Record<string, number> = {
  linguistic: 10,
  factual: 10,
  template: 5,
  llm: 20,
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
  originalText: string,
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

  const activeAxes = axisScores.filter(
    a => a.score > (AXIS_THRESHOLDS[a.name] ?? 10)
  );

  let slopScore: number;

  if (activeAxes.length === 0) {
    slopScore = PRIOR;
  } else {
    const probabilities = activeAxes.map(a => {
      let p = a.score / 100;
      if (hasFabricationBoost && a.name === "factual") {
        p = Math.min(1, p * 1.3);
      }
      return Math.max(0, Math.min(0.95, p));
    });

    const combinedP = 1 - probabilities.reduce((prod, p) => prod * (1 - p), 1);

    slopScore = Math.round(PRIOR + combinedP * (CEILING - PRIOR));
  }

  const humanResult = detectHumanIndicators(originalText);
  slopScore = Math.max(FLOOR, slopScore + humanResult.totalReduction);

  slopScore = Math.min(100, Math.max(0, slopScore));

  const evidenceCount = allEvidence.filter(e => e.weight >= 5).length;
  const confidence = Math.min(
    1.0,
    0.3 + evidenceCount * 0.07 + (llm ? 0.2 : 0) + humanResult.indicators.length * 0.03
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
    quality: Math.round(qualityScore),
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

export function getSlopTier(score: number, thresholds?: TierThresholds): string {
  const thr = thresholds ?? DEFAULT_THRESHOLDS;
  if (score > thr.high) return "Slop";
  if (score > 55) return "Likely Slop";
  if (score > 35) return "Questionable";
  if (score > thr.low) return "Likely Human";
  return "Clean";
}
