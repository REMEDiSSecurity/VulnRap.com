export interface ScoringConfig {
  version: string;
  createdAt: string;
  prior: number;
  floor: number;
  ceiling: number;
  axisThresholds: Record<string, number>;
  tierThresholds: { low: number; high: number };
  fabricationBoost: number;
  description: string;
}

const CONFIG_HISTORY: ScoringConfig[] = [
  {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    prior: 15,
    floor: 5,
    ceiling: 95,
    axisThresholds: {
      linguistic: 10,
      factual: 10,
      template: 5,
      llm: 20,
      verification: 55,
    },
    tierThresholds: { low: 20, high: 75 },
    fabricationBoost: 1.3,
    description: "Initial baseline configuration",
  },
];

export function getCurrentConfig(): ScoringConfig {
  return CONFIG_HISTORY[CONFIG_HISTORY.length - 1];
}

export function getConfigVersion(): string {
  return getCurrentConfig().version;
}

export function getConfigHistory(): ScoringConfig[] {
  return [...CONFIG_HISTORY];
}

export function getConfigByVersion(version: string): ScoringConfig | undefined {
  return CONFIG_HISTORY.find((c) => c.version === version);
}

function bumpVersion(current: string): string {
  const parts = current.split(".").map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join(".");
}

export function applyNewConfig(
  changes: Partial<Pick<ScoringConfig, "prior" | "floor" | "ceiling" | "axisThresholds" | "tierThresholds" | "fabricationBoost">>,
  description: string
): ScoringConfig {
  const current = getCurrentConfig();
  const newVersion = bumpVersion(current.version);

  const newConfig: ScoringConfig = {
    version: newVersion,
    createdAt: new Date().toISOString(),
    prior: changes.prior ?? current.prior,
    floor: changes.floor ?? current.floor,
    ceiling: changes.ceiling ?? current.ceiling,
    axisThresholds: changes.axisThresholds
      ? { ...current.axisThresholds, ...changes.axisThresholds }
      : { ...current.axisThresholds },
    tierThresholds: changes.tierThresholds
      ? { ...current.tierThresholds, ...changes.tierThresholds }
      : { ...current.tierThresholds },
    fabricationBoost: changes.fabricationBoost ?? current.fabricationBoost,
    description,
  };

  CONFIG_HISTORY.push(newConfig);
  return newConfig;
}
