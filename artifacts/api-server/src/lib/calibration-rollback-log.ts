import { logger } from "./logger";
import type { ScoringConfig } from "./scoring-config";

export interface CalibrationSnapshot {
  id: string;
  timestamp: string;
  trigger: "apply" | "rollback";
  description: string;
  configBefore: ScoringConfig;
  configAfter: ScoringConfig;
}

const SNAPSHOTS: CalibrationSnapshot[] = [];
const MAX_SNAPSHOTS = 200;

let nextId = 1;

export function snapshotCalibrationChange(
  trigger: CalibrationSnapshot["trigger"],
  description: string,
  configBefore: ScoringConfig,
  configAfter: ScoringConfig,
): CalibrationSnapshot {
  const snap: CalibrationSnapshot = {
    id: `snap-${nextId++}`,
    timestamp: new Date().toISOString(),
    trigger,
    description,
    configBefore: { ...configBefore },
    configAfter: { ...configAfter },
  };
  SNAPSHOTS.push(snap);
  if (SNAPSHOTS.length > MAX_SNAPSHOTS) {
    SNAPSHOTS.splice(0, SNAPSHOTS.length - MAX_SNAPSHOTS);
  }
  logger.info(
    {
      snapshotId: snap.id,
      trigger,
      versionBefore: configBefore.version,
      versionAfter: configAfter.version,
    },
    "[calibration-rollback] snapshot recorded",
  );
  return snap;
}

export function getCalibrationSnapshots(): CalibrationSnapshot[] {
  return [...SNAPSHOTS];
}

export function getCalibrationSnapshotById(
  id: string,
): CalibrationSnapshot | undefined {
  return SNAPSHOTS.find((s) => s.id === id);
}

export function __resetCalibrationSnapshotsForTests(): void {
  SNAPSHOTS.length = 0;
  nextId = 1;
}
