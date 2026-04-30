// Task #388 — Coverage for the recurring rescore-backfill scheduler.
// The scheduler mirrors the AVRI drift scheduler shape (`startDriftNotificationScheduler`),
// so the test surface here mirrors `avri-drift-notifications.test.ts`:
// short-circuit when disabled, success vs. retry cadence, defensive
// handling of a runner that throws, stop() cancels future ticks, and
// the heartbeat status reflects the latest tick outcome.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildRescoreOpts,
  runRescoreBackfillCheck,
  startRescoreBackfillScheduler,
  getRescoreBackfillSchedulerStatus,
  __testing,
} from "./rescore-backfill-scheduler";
import type { BackfillStats } from "../backfill-vulnrap-helpers";

const ENV_KEYS = [
  "RESCORE_BACKFILL_SCHEDULER_ENABLED",
  "RESCORE_BACKFILL_INTERVAL_MS",
  "RESCORE_BACKFILL_RETRY_INTERVAL_MS",
  "RESCORE_BACKFILL_LIMIT",
  "RESCORE_BACKFILL_MAX_RUNTIME_MS",
  "RESCORE_BACKFILL_BATCH_SIZE",
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

function makeStats(overrides: Partial<BackfillStats> = {}): BackfillStats {
  return {
    processed: 0,
    updated: 0,
    reconstructed: 0,
    rescoredUpdated: 0,
    rescoredReconstructed: 0,
    skippedNoSignals: 0,
    skippedConcurrent: 0,
    failed: 0,
    deadlineReached: false,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("buildRescoreOpts", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it("pins rescore + cached-hallucination filter and pulls safety caps from defaults", () => {
    const opts = buildRescoreOpts();
    expect(opts.rescore).toBe(true);
    expect(opts.onlyWithCachedHallucination).toBe(true);
    expect(opts.dryRun).toBe(false);
    expect(opts.limit).toBe(__testing.DEFAULT_LIMIT);
    expect(opts.maxRuntimeMs).toBe(__testing.DEFAULT_MAX_RUNTIME_MS);
    expect(opts.batchSize).toBe(__testing.DEFAULT_BATCH_SIZE);
  });

  it("env vars override the safety caps", () => {
    process.env.RESCORE_BACKFILL_LIMIT = "42";
    process.env.RESCORE_BACKFILL_MAX_RUNTIME_MS = "12345";
    process.env.RESCORE_BACKFILL_BATCH_SIZE = "10";
    const opts = buildRescoreOpts();
    expect(opts.limit).toBe(42);
    expect(opts.maxRuntimeMs).toBe(12345);
    expect(opts.batchSize).toBe(10);
  });

  it("invalid env values fall back to defaults rather than crashing", () => {
    process.env.RESCORE_BACKFILL_LIMIT = "not-a-number";
    process.env.RESCORE_BACKFILL_MAX_RUNTIME_MS = "-5";
    expect(buildRescoreOpts().limit).toBe(__testing.DEFAULT_LIMIT);
    expect(buildRescoreOpts().maxRuntimeMs).toBe(
      __testing.DEFAULT_MAX_RUNTIME_MS,
    );
  });

  it("call-site overrides win over env / defaults", () => {
    process.env.RESCORE_BACKFILL_LIMIT = "42";
    const opts = buildRescoreOpts({ limit: 7, maxRuntimeMs: 99 });
    expect(opts.limit).toBe(7);
    expect(opts.maxRuntimeMs).toBe(99);
  });
});

describe("runRescoreBackfillCheck", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  it("short-circuits without scanning the DB when the scheduler is disabled", async () => {
    // Without RESCORE_BACKFILL_SCHEDULER_ENABLED set, the helper must
    // return ranCheck=false without touching the DB. The test environment
    // has no DB connection, so the absence of a throw IS the proof of
    // the short-circuit.
    const result = await runRescoreBackfillCheck();
    expect(result).toEqual({ ok: true, ranCheck: false });
  });

  it("treats common falsey strings as disabled", async () => {
    for (const v of ["", "0", "false", "no"]) {
      process.env.RESCORE_BACKFILL_SCHEDULER_ENABLED = v;
      const result = await runRescoreBackfillCheck();
      expect(result.ranCheck).toBe(false);
    }
  });

  it("recognizes '1' and 'true' (case-insensitive) as enabled", () => {
    for (const v of ["1", "true", "TRUE", "True"]) {
      process.env.RESCORE_BACKFILL_SCHEDULER_ENABLED = v;
      expect(__testing.isSchedulerEnabled()).toBe(true);
    }
  });
});

describe("startRescoreBackfillScheduler", () => {
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

  async function flushTick(): Promise<void> {
    // Allow microtasks queued by the just-fired tick to settle so the
    // scheduler's status update + re-arm complete before the next assert.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("ticks on the success interval after a successful run", async () => {
    const calls: string[] = [];
    const sched = startRescoreBackfillScheduler({
      intervalMs: 1000,
      retryIntervalMs: 100,
      initialDelayMs: 10,
      run: async () => {
        calls.push("ok");
        return { ok: true, ranCheck: true, stats: makeStats() };
      },
    });
    try {
      expect(sched.ticksCompleted()).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      await flushTick();
      expect(calls).toEqual(["ok"]);
      expect(sched.ticksCompleted()).toBe(1);

      // Must wait the full success interval, not the retry interval.
      await vi.advanceTimersByTimeAsync(99);
      expect(calls).toEqual(["ok"]);
      await vi.advanceTimersByTimeAsync(901);
      await flushTick();
      expect(calls).toEqual(["ok", "ok"]);
      expect(sched.ticksCompleted()).toBe(2);
    } finally {
      sched.stop();
    }
  });

  it("re-arms with the retry interval after a failed run", async () => {
    let nextOk = false;
    const calls: boolean[] = [];
    const sched = startRescoreBackfillScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 50,
      initialDelayMs: 0,
      run: async () => {
        calls.push(nextOk);
        return { ok: nextOk, ranCheck: true, stats: makeStats() };
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();
      expect(calls).toEqual([false]);

      nextOk = true;
      await vi.advanceTimersByTimeAsync(50);
      await flushTick();
      expect(calls).toEqual([false, true]);
    } finally {
      sched.stop();
    }
  });

  it("survives a runner that throws unexpectedly", async () => {
    let firstCall = true;
    const sched = startRescoreBackfillScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 25,
      initialDelayMs: 0,
      run: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("boom");
        }
        return { ok: true, ranCheck: true, stats: makeStats() };
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();
      expect(sched.ticksCompleted()).toBe(1);
      await vi.advanceTimersByTimeAsync(25);
      await flushTick();
      expect(sched.ticksCompleted()).toBe(2);
    } finally {
      sched.stop();
    }
  });

  it("stop() cancels future ticks", async () => {
    let calls = 0;
    const sched = startRescoreBackfillScheduler({
      intervalMs: 50,
      retryIntervalMs: 10,
      initialDelayMs: 0,
      run: async () => {
        calls += 1;
        return { ok: true, ranCheck: true, stats: makeStats() };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushTick();
    expect(calls).toBe(1);

    sched.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await flushTick();
    expect(calls).toBe(1);
  });

  it("seeds the heartbeat with start metadata before the first tick fires", () => {
    process.env.RESCORE_BACKFILL_SCHEDULER_ENABLED = "true";
    const sched = startRescoreBackfillScheduler({
      intervalMs: 5_000,
      retryIntervalMs: 500,
      initialDelayMs: 1_000,
      run: async () => ({ ok: true, ranCheck: true, stats: makeStats() }),
    });
    try {
      const status = getRescoreBackfillSchedulerStatus();
      expect(status.schedulerStarted).toBe(true);
      expect(status.schedulerEnabled).toBe(true);
      expect(status.intervalMs).toBe(5_000);
      expect(status.retryIntervalMs).toBe(500);
      expect(status.startedAt).not.toBeNull();
      expect(status.nextTickAt).not.toBeNull();
      expect(status.ticksCompleted).toBe(0);
      expect(status.lastTickAt).toBeNull();
      // Safety caps surface so the heartbeat panel can render the
      // "this scheduler will process at most N rows / M ms per tick"
      // guarantee without scraping logs.
      expect(status.limit).toBe(__testing.DEFAULT_LIMIT);
      expect(status.maxRuntimeMs).toBe(__testing.DEFAULT_MAX_RUNTIME_MS);
    } finally {
      sched.stop();
    }
  });

  it("populates the heartbeat with stats from the most recent tick", async () => {
    const stats = makeStats({
      processed: 12,
      rescoredUpdated: 7,
      rescoredReconstructed: 3,
      failed: 0,
      deadlineReached: false,
      elapsedMs: 4321,
    });
    const sched = startRescoreBackfillScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 1_000,
      initialDelayMs: 0,
      run: async () => ({ ok: true, ranCheck: true, stats }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();
      const status = getRescoreBackfillSchedulerStatus();
      expect(status.lastTickOk).toBe(true);
      expect(status.lastTickRanCheck).toBe(true);
      expect(status.lastTickProcessed).toBe(12);
      // 7 (engine-rescored) + 3 (reconstructed) = 10 rescored rows. The
      // calibration UI surfaces this aggregate so reviewers don't need
      // to multiply two columns to see how much work the tick did.
      expect(status.lastTickRescored).toBe(10);
      expect(status.lastTickFailed).toBe(0);
      expect(status.lastTickDeadlineReached).toBe(false);
      expect(status.lastTickElapsedMs).toBe(4321);
      expect(status.ticksCompleted).toBe(1);
      expect(status.nextTickAt).not.toBeNull();
    } finally {
      sched.stop();
    }
  });

  it("records the deadline-reached flag from the underlying backfill stats", async () => {
    const sched = startRescoreBackfillScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 1_000,
      initialDelayMs: 0,
      run: async () => ({
        ok: true,
        ranCheck: true,
        stats: makeStats({
          processed: 500,
          rescoredUpdated: 500,
          deadlineReached: true,
          elapsedMs: 600_000,
        }),
      }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();
      const status = getRescoreBackfillSchedulerStatus();
      // Must surface so reviewers can spot a wedged backlog: every
      // tick hitting the cap means the limit/runtime is set too low for
      // the workload (or the scan needs investigation).
      expect(status.lastTickDeadlineReached).toBe(true);
      expect(status.lastTickProcessed).toBe(500);
    } finally {
      sched.stop();
    }
  });

  it("stop() clears nextTickAt so the heartbeat doesn't lie about a future tick", async () => {
    const sched = startRescoreBackfillScheduler({
      intervalMs: 5_000,
      retryIntervalMs: 500,
      initialDelayMs: 0,
      run: async () => ({ ok: true, ranCheck: true, stats: makeStats() }),
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushTick();
    expect(getRescoreBackfillSchedulerStatus().nextTickAt).not.toBeNull();
    sched.stop();
    expect(getRescoreBackfillSchedulerStatus().nextTickAt).toBeNull();
  });
});

describe("getRescoreBackfillSchedulerStatus", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    __testing.resetSchedulerStatus();
  });
  afterEach(() => {
    restoreEnv(envSnap);
    __testing.resetSchedulerStatus();
  });

  it("returns a 'never started' snapshot before the scheduler boots", () => {
    const status = getRescoreBackfillSchedulerStatus();
    expect(status.schedulerStarted).toBe(false);
    expect(status.schedulerEnabled).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.intervalMs).toBeNull();
    expect(status.lastTickAt).toBeNull();
    expect(status.ticksCompleted).toBe(0);
  });

  it("reflects RESCORE_BACKFILL_SCHEDULER_ENABLED at read time, not boot time", () => {
    // Operator can flip the env on a running replica and the heartbeat
    // panel must show the new value without restarting the process.
    expect(getRescoreBackfillSchedulerStatus().schedulerEnabled).toBe(false);
    process.env.RESCORE_BACKFILL_SCHEDULER_ENABLED = "true";
    expect(getRescoreBackfillSchedulerStatus().schedulerEnabled).toBe(true);
  });
});
