import type { ScoringConfig } from "./scoring-config";

const DEFAULT_THRESHOLD = 0.2;

function getThreshold(): number {
  const raw = process.env.CALIBRATION_DRIFT_THRESHOLD;
  if (raw !== undefined) {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  }
  return DEFAULT_THRESHOLD;
}

export interface DriftCheckResult {
  driftDetected: boolean;
  threshold: number;
  drifts: DriftDetail[];
}

export interface DriftDetail {
  field: string;
  oldValue: number;
  newValue: number;
  relativeChange: number;
}

function relativeChange(oldVal: number, newVal: number): number {
  if (oldVal === 0) return newVal === 0 ? 0 : 1;
  return Math.abs(newVal - oldVal) / Math.abs(oldVal);
}

export function checkCalibrationDrift(
  current: ScoringConfig,
  changes: Partial<
    Pick<
      ScoringConfig,
      | "prior"
      | "floor"
      | "ceiling"
      | "axisThresholds"
      | "fabricationBoost"
    >
  > & { tierThresholds?: Partial<{ low: number; high: number }> },
): DriftCheckResult {
  const threshold = getThreshold();
  const drifts: DriftDetail[] = [];

  const scalars: Array<{
    field: string;
    key: keyof Pick<ScoringConfig, "prior" | "floor" | "ceiling" | "fabricationBoost">;
  }> = [
    { field: "prior", key: "prior" },
    { field: "floor", key: "floor" },
    { field: "ceiling", key: "ceiling" },
    { field: "fabricationBoost", key: "fabricationBoost" },
  ];

  for (const { field, key } of scalars) {
    const newVal = changes[key];
    if (newVal === undefined) continue;
    const oldVal = current[key];
    const rc = relativeChange(oldVal as number, newVal as number);
    if (rc >= threshold) {
      drifts.push({
        field,
        oldValue: oldVal as number,
        newValue: newVal as number,
        relativeChange: rc,
      });
    }
  }

  if (changes.axisThresholds) {
    for (const [axis, newVal] of Object.entries(changes.axisThresholds)) {
      const oldVal = current.axisThresholds[axis];
      if (oldVal === undefined) continue;
      const rc = relativeChange(oldVal, newVal);
      if (rc >= threshold) {
        drifts.push({
          field: `axisThresholds.${axis}`,
          oldValue: oldVal,
          newValue: newVal,
          relativeChange: rc,
        });
      }
    }
  }

  if (changes.tierThresholds) {
    const tt = changes.tierThresholds;
    if (tt.low !== undefined) {
      const rc = relativeChange(current.tierThresholds.low, tt.low);
      if (rc >= threshold) {
        drifts.push({
          field: "tierThresholds.low",
          oldValue: current.tierThresholds.low,
          newValue: tt.low,
          relativeChange: rc,
        });
      }
    }
    if (tt.high !== undefined) {
      const rc = relativeChange(current.tierThresholds.high, tt.high);
      if (rc >= threshold) {
        drifts.push({
          field: "tierThresholds.high",
          oldValue: current.tierThresholds.high,
          newValue: tt.high,
          relativeChange: rc,
        });
      }
    }
  }

  return {
    driftDetected: drifts.length > 0,
    threshold,
    drifts,
  };
}
