// Task #620 — Coverage for the recurring score-stability scheduler.
// Mirrors `rescore-backfill-scheduler.test.ts`: short-circuit when
// disabled, status reflects the latest tick outcome, defensive
// handling of a runner that throws, and stop() cancels future ticks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runScoreStabilityCheck,
  startScoreStabilityScheduler,
  getScoreStabilitySchedulerStatus,
  __testing,
  type StabilityCheckResult,
} from "./score-stability-scheduler";

const ENV_KEYS = [
  "SCORE_STABILITY_SCHEDULER_ENABLED",
  "SCORE_STABILITY_INTERVAL_MS",
  "SCORE_STABILITY_RETRY_INTERVAL_MS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("runScoreStabilityCheck", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restoreEnv(envSnap));

  it("short-circuits when disabled (no DB scan)", async () => {
    const result = await runScoreStabilityCheck();
    expect(result.ranCheck).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("startScoreStabilityScheduler", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    __testing.resetSchedulerStatus();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    restoreEnv(envSnap);
    __testing.resetSchedulerStatus();
  });

  it("populates status before the first tick", () => {
    const handle = startScoreStabilityScheduler({
      intervalMs: 1000,
      retryIntervalMs: 500,
      initialDelayMs: 100,
      run: async () => ({ ok: true, ranCheck: false }),
    });
    const status = getScoreStabilitySchedulerStatus();
    expect(status.schedulerStarted).toBe(true);
    expect(status.intervalMs).toBe(1000);
    expect(status.retryIntervalMs).toBe(500);
    expect(status.nextTickAt).not.toBeNull();
    expect(status.lastTickAt).toBeNull();
    expect(status.ticksCompleted).toBe(0);
    handle.stop();
  });

  it("reflects a successful tick and re-arms at intervalMs", async () => {
    const result: StabilityCheckResult = {
      ok: true,
      ranCheck: true,
      rescore: {
        scanned: 5,
        logged: 5,
        flips: 1,
        skippedNoSignals: 0,
        skippedDuplicate: 0,
        failed: 0,
        codeVersion: "test-version",
      },
      alert: {
        date: "2026-05-02",
        flipRate: 0.05,
        alertThreshold: 0.02,
        exceeded: true,
        dispatched: true,
        alreadyAlerted: false,
        webhookSkipped: false,
      },
    };
    const run = vi.fn().mockResolvedValue(result);
    const handle = startScoreStabilityScheduler({
      intervalMs: 1000,
      retryIntervalMs: 500,
      initialDelayMs: 10,
      run,
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(run).toHaveBeenCalledTimes(1);
    const status = getScoreStabilitySchedulerStatus();
    expect(status.ticksCompleted).toBe(1);
    expect(status.lastTickOk).toBe(true);
    expect(status.lastTickRanCheck).toBe(true);
    expect(status.lastTickScanned).toBe(5);
    expect(status.lastTickLogged).toBe(5);
    expect(status.lastTickFlips).toBe(1);
    expect(status.lastTickFailed).toBe(0);
    expect(status.lastAlertDate).toBe("2026-05-02");
    expect(status.lastAlertDispatched).toBe(true);
    handle.stop();
  });

  it("re-arms at retryIntervalMs when the runner reports failure", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, ranCheck: true })
      .mockResolvedValue({ ok: true, ranCheck: true });
    const handle = startScoreStabilityScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 100,
      initialDelayMs: 10,
      run,
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getScoreStabilitySchedulerStatus().lastTickOk).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(run).toHaveBeenCalledTimes(2);
    expect(getScoreStabilitySchedulerStatus().lastTickOk).toBe(true);
    handle.stop();
  });

  it("survives a runner that throws", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const handle = startScoreStabilityScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 100,
      initialDelayMs: 10,
      run,
    });
    await vi.advanceTimersByTimeAsync(15);
    const status = getScoreStabilitySchedulerStatus();
    expect(status.ticksCompleted).toBe(1);
    expect(status.lastTickOk).toBe(false);
    handle.stop();
  });

  it("stop() cancels future ticks", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, ranCheck: false });
    const handle = startScoreStabilityScheduler({
      intervalMs: 100,
      retryIntervalMs: 50,
      initialDelayMs: 10,
      run,
    });
    await vi.advanceTimersByTimeAsync(15);
    expect(run).toHaveBeenCalledTimes(1);
    handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getScoreStabilitySchedulerStatus().nextTickAt).toBeNull();
  });
});
