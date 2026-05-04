import { describe, it, expect, afterEach, vi } from "vitest";
import { checkCalibrationDrift } from "./calibration-drift-guard";
import type { ScoringConfig } from "./scoring-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

const BASE_CONFIG: ScoringConfig = {
  version: "1.0.0",
  createdAt: new Date().toISOString(),
  prior: 15,
  floor: 5,
  ceiling: 95,
  axisThresholds: { linguistic: 10, factual: 10, template: 5, llm: 20, verification: 55 },
  tierThresholds: { low: 20, high: 75 },
  fabricationBoost: 1.3,
  description: "test baseline",
};

describe("calibration-drift-guard", () => {
  it("reports no drift for small changes", () => {
    const result = checkCalibrationDrift(BASE_CONFIG, { prior: 16 });
    expect(result.driftDetected).toBe(false);
    expect(result.drifts).toHaveLength(0);
  });

  it("detects drift when a scalar exceeds the default 20% threshold", () => {
    const result = checkCalibrationDrift(BASE_CONFIG, { prior: 20 });
    expect(result.driftDetected).toBe(true);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0].field).toBe("prior");
    expect(result.drifts[0].oldValue).toBe(15);
    expect(result.drifts[0].newValue).toBe(20);
  });

  it("detects drift on axisThresholds", () => {
    const result = checkCalibrationDrift(BASE_CONFIG, {
      axisThresholds: { linguistic: 20 },
    });
    expect(result.driftDetected).toBe(true);
    expect(result.drifts[0].field).toBe("axisThresholds.linguistic");
  });

  it("detects drift on tierThresholds", () => {
    const result = checkCalibrationDrift(BASE_CONFIG, {
      tierThresholds: { low: 30 },
    });
    expect(result.driftDetected).toBe(true);
    expect(result.drifts[0].field).toBe("tierThresholds.low");
  });

  it("respects CALIBRATION_DRIFT_THRESHOLD env var", () => {
    vi.stubEnv("CALIBRATION_DRIFT_THRESHOLD", "0.5");
    const result = checkCalibrationDrift(BASE_CONFIG, { prior: 20 });
    expect(result.driftDetected).toBe(false);

    const result2 = checkCalibrationDrift(BASE_CONFIG, { prior: 25 });
    expect(result2.driftDetected).toBe(true);
  });

  it("handles multiple drifts", () => {
    const result = checkCalibrationDrift(BASE_CONFIG, {
      prior: 25,
      floor: 10,
      fabricationBoost: 2.5,
    });
    expect(result.driftDetected).toBe(true);
    expect(result.drifts.length).toBeGreaterThanOrEqual(3);
  });
});
