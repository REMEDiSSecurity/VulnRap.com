import { describe, it, expect, beforeEach } from "vitest";
import {
  snapshotCalibrationChange,
  getCalibrationSnapshots,
  getCalibrationSnapshotById,
  __resetCalibrationSnapshotsForTests,
} from "./calibration-rollback-log";
import type { ScoringConfig } from "./scoring-config";

const CONFIG_V1: ScoringConfig = {
  version: "1.0.0",
  createdAt: "2025-01-01T00:00:00Z",
  prior: 15,
  floor: 5,
  ceiling: 95,
  axisThresholds: { linguistic: 10, factual: 10, template: 5, llm: 20, verification: 55 },
  tierThresholds: { low: 20, high: 75 },
  fabricationBoost: 1.3,
  description: "baseline",
};

const CONFIG_V2: ScoringConfig = {
  ...CONFIG_V1,
  version: "1.0.1",
  prior: 20,
  description: "bumped prior",
};

beforeEach(() => {
  __resetCalibrationSnapshotsForTests();
});

describe("calibration-rollback-log", () => {
  it("records and retrieves snapshots", () => {
    const snap = snapshotCalibrationChange("apply", "test change", CONFIG_V1, CONFIG_V2);
    expect(snap.id).toBe("snap-1");
    expect(snap.trigger).toBe("apply");
    expect(snap.configBefore.version).toBe("1.0.0");
    expect(snap.configAfter.version).toBe("1.0.1");

    const all = getCalibrationSnapshots();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("snap-1");
  });

  it("retrieves snapshot by id", () => {
    snapshotCalibrationChange("apply", "first", CONFIG_V1, CONFIG_V2);
    snapshotCalibrationChange("rollback", "second", CONFIG_V2, CONFIG_V1);

    const found = getCalibrationSnapshotById("snap-2");
    expect(found).toBeDefined();
    expect(found!.trigger).toBe("rollback");
    expect(found!.description).toBe("second");

    const notFound = getCalibrationSnapshotById("snap-999");
    expect(notFound).toBeUndefined();
  });

  it("caps at MAX_SNAPSHOTS (200)", () => {
    for (let i = 0; i < 210; i++) {
      snapshotCalibrationChange(
        "apply",
        `change ${i}`,
        { ...CONFIG_V1, version: `${i}.0.0` },
        { ...CONFIG_V2, version: `${i}.0.1` },
      );
    }
    const all = getCalibrationSnapshots();
    expect(all.length).toBeLessThanOrEqual(200);
  });
});
