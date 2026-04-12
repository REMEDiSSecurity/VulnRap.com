const STORAGE_KEY = "vulnrap_settings";

export interface VulnRapSettings {
  slopThresholdLow: number;
  slopThresholdHigh: number;
  similarityThreshold: number;
}

const DEFAULTS: VulnRapSettings = {
  slopThresholdLow: 20,
  slopThresholdHigh: 75,
  similarityThreshold: 80,
};

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
  if (score < low) return "text-green-500";
  if (score < high) return "text-yellow-500";
  return "text-destructive";
}

export function getSlopProgressColorCustom(
  score: number,
  low: number,
  high: number
): string {
  if (score < low) return "bg-green-500";
  if (score < high) return "bg-yellow-500";
  return "bg-destructive";
}
