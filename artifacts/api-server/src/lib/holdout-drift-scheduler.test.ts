// Task #1117 — Atomic write tests for holdout-drift-scheduler.
//
// writeAlertState is exposed via __testing so we can call it directly
// without needing a DB / fetch. This keeps the test offline and fast.

import os from "node:os";
import path from "node:path";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __testing } from "./holdout-drift-scheduler";

const STATE_PATH_ENV = "HOLDOUT_DRIFT_ALERTS_PATH";

describe("writeAlertState leaves no .tmp siblings (Task #1117)", () => {
  let tmpDir: string;
  let statePath: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[STATE_PATH_ENV];
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "holdout-drift-atomic-"));
    statePath = path.join(tmpDir, "holdout-drift-alerts.json");
    process.env[STATE_PATH_ENV] = statePath;
    __testing.resetResolvedPath();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_PATH_ENV];
    else process.env[STATE_PATH_ENV] = originalEnv;
    __testing.resetResolvedPath();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves only the state file and no .tmp siblings after a successful write", () => {
    __testing.writeAlertState({
      _meta: "test",
      alerts: [
        {
          dedupKey: "2026-05-04",
          alertedAt: "2026-05-04T00:00:00.000Z",
          f1Gap: 0.15,
          accuracyGap: null,
          dispatched: true,
          webhookSkipped: false,
        },
      ],
    });

    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["holdout-drift-alerts.json"]);

    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alerts: Array<{ dedupKey: string }>;
    };
    expect(persisted.alerts).toHaveLength(1);
    expect(persisted.alerts[0]!.dedupKey).toBe("2026-05-04");
  });

  it("leaves no .tmp siblings after multiple successive writes", () => {
    for (let i = 0; i < 4; i++) {
      __testing.writeAlertState({
        alerts: [
          {
            dedupKey: `2026-05-0${i + 1}`,
            alertedAt: "2026-05-01T00:00:00.000Z",
            f1Gap: 0.1,
            accuracyGap: null,
            dispatched: true,
            webhookSkipped: false,
          },
        ],
      });
    }
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["holdout-drift-alerts.json"]);
  });
});
