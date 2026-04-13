const STORAGE_KEY = "vulnrap_settings";

export type SensitivityPreset = "lenient" | "balanced" | "strict";

export interface VulnRapSettings {
  slopThresholdLow: number;
  slopThresholdHigh: number;
  similarityThreshold: number;
  sensitivityPreset: SensitivityPreset;
}

const DEFAULTS: VulnRapSettings = {
  slopThresholdLow: 20,
  slopThresholdHigh: 75,
  similarityThreshold: 80,
  sensitivityPreset: "balanced",
};

export const SENSITIVITY_PRESETS: Record<SensitivityPreset, { label: string; description: string; axisMultiplier: number; humanMultiplier: number }> = {
  lenient: { label: "Lenient", description: "Higher tolerance — fewer false positives", axisMultiplier: 0.7, humanMultiplier: 1.5 },
  balanced: { label: "Balanced", description: "Default calibration", axisMultiplier: 1.0, humanMultiplier: 1.0 },
  strict: { label: "Strict", description: "Lower tolerance — catches more borderline cases", axisMultiplier: 1.5, humanMultiplier: 0.7 },
};

const PRIOR = 15;
const FLOOR = 5;
const CEILING = 95;
const AXIS_THRESHOLDS: Record<string, number> = { linguistic: 10, factual: 10, template: 5, llm: 20 };

export interface BreakdownData {
  linguistic?: number;
  factual?: number;
  template?: number;
  llm?: number | null;
}

export interface HumanIndicatorData {
  weight: number;
}

export function adjustScore(
  canonicalScore: number,
  preset: SensitivityPreset,
  breakdown?: BreakdownData | null,
  humanIndicators?: HumanIndicatorData[] | null,
): number {
  if (preset === "balanced") return canonicalScore;

  if (!breakdown) {
    const m = SENSITIVITY_PRESETS[preset].axisMultiplier;
    return Math.max(0, Math.min(100, Math.round(canonicalScore * m)));
  }

  const { axisMultiplier, humanMultiplier } = SENSITIVITY_PRESETS[preset];

  const axes: { name: string; score: number }[] = [];
  if (breakdown.linguistic != null) axes.push({ name: "linguistic", score: breakdown.linguistic });
  if (breakdown.factual != null) axes.push({ name: "factual", score: breakdown.factual });
  if (breakdown.template != null) axes.push({ name: "template", score: breakdown.template });
  if (breakdown.llm != null) axes.push({ name: "llm", score: breakdown.llm });

  const activeAxes = axes.filter(a => a.score > (AXIS_THRESHOLDS[a.name] ?? 10));

  let score: number;

  if (activeAxes.length === 0) {
    score = PRIOR;
  } else {
    const probabilities = activeAxes.map(a => {
      let p = (a.score / 100) * axisMultiplier;
      return Math.max(0, Math.min(0.95, p));
    });

    const combinedP = 1 - probabilities.reduce((prod, p) => prod * (1 - p), 1);
    score = Math.round(PRIOR + combinedP * (CEILING - PRIOR));
  }

  if (humanIndicators && humanIndicators.length > 0) {
    const totalReduction = humanIndicators.reduce((sum, h) => sum + h.weight, 0);
    score = Math.max(FLOOR, score + Math.round(totalReduction * humanMultiplier));
  }

  return Math.min(100, Math.max(0, score));
}

export function adjustTier(adjustedScore: number, low: number, high: number): string {
  if (adjustedScore <= low) return "Clean";
  if (adjustedScore <= 35) return "Likely Human";
  if (adjustedScore <= 55) return "Questionable";
  if (adjustedScore <= high) return "Likely Slop";
  return "Slop";
}

export function getSettings(): VulnRapSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Partial<VulnRapSettings>): void {
  try {
    const current = getSettings();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...current, ...settings })
    );
  } catch {}
}

export function resetSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function getSlopTierCustom(
  score: number,
  low: number,
  high: number
): string {
  if (score <= low) return "Clean";
  if (score <= 35) return "Likely Human";
  if (score <= 55) return "Questionable";
  if (score <= high) return "Likely Slop";
  return "Slop";
}

export function getSlopColorCustom(
  score: number,
  low: number,
  high: number
): string {
  if (score <= low) return "text-green-500";
  if (score <= 35) return "text-emerald-400";
  if (score <= 55) return "text-yellow-500";
  if (score <= high) return "text-orange-500";
  return "text-destructive";
}

export function getSlopProgressColorCustom(
  score: number,
  low: number,
  high: number
): string {
  if (score <= low) return "bg-green-500";
  if (score <= 35) return "bg-emerald-400";
  if (score <= 55) return "bg-yellow-500";
  if (score <= high) return "bg-orange-500";
  return "bg-destructive";
}
