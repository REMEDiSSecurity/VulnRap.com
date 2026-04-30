import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  dedupKeyForFlag,
  selectNewFlags,
  notifyDriftFlagsIfNew,
  runDriftNotificationCheck,
  startDriftNotificationScheduler,
  listNotifiedFlags,
  removeNotifiedFlags,
  getDriftSchedulerStatus,
  __testing,
  type WebhookDispatcher,
  type WebhookPayload,
  type NotifiedFlagRecord,
} from "./avri-drift-notifications";
import type { AvriDriftReport, DriftFlag } from "./avri-drift";

function makeReport(overrides: Partial<AvriDriftReport> = {}): AvriDriftReport {
  return {
    generatedAt: "2026-04-29T00:00:00.000Z",
    weeksRequested: 8,
    totalReportsScanned: 100,
    cohort: "avri_on_only",
    bucketingNote: "test",
    thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
    weeks: [],
    flags: [],
    runbookPath: "docs/avri-drift-runbook.md",
    ...overrides,
  };
}

const GAP_FLAG: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "GAP_BELOW_45",
  detail: "T1−T3 composite gap 40 < 45pt threshold (T1 n=5 mean=70, T3 n=5 mean=30).",
};

const FAM_FLAG_T1_INJ: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "FAMILY_MEAN_SHIFT",
  detail: "T1 family INJECTION mean shifted by -7pt vs 2026-04-13 (was 80, now 73).",
};

const FAM_FLAG_T3_MEM: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "FAMILY_MEAN_SHIFT",
  detail: "T3 family MEMORY_CORRUPTION mean shifted by +6pt vs 2026-04-13 (was 30, now 36).",
};

describe("dedupKeyForFlag", () => {
  it("scopes GAP_BELOW_45 by week + kind", () => {
    expect(dedupKeyForFlag(GAP_FLAG)).toBe("2026-04-20|GAP_BELOW_45");
  });

  it("scopes FAMILY_MEAN_SHIFT by week + bucket + family", () => {
    expect(dedupKeyForFlag(FAM_FLAG_T1_INJ)).toBe(
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    );
    expect(dedupKeyForFlag(FAM_FLAG_T3_MEM)).toBe(
      "2026-04-20|FAMILY_MEAN_SHIFT|T3|MEMORY_CORRUPTION",
    );
  });

  it("treats the same flag with different numeric values in detail as the same key", () => {
    const refreshed: DriftFlag = {
      ...FAM_FLAG_T1_INJ,
      detail: "T1 family INJECTION mean shifted by -9pt vs 2026-04-13 (was 80, now 71).",
    };
    expect(dedupKeyForFlag(refreshed)).toBe(dedupKeyForFlag(FAM_FLAG_T1_INJ));
  });

  it("falls back to week+kind when the FAMILY_MEAN_SHIFT detail format is unexpected", () => {
    const odd: DriftFlag = {
      weekStart: "2026-04-20",
      kind: "FAMILY_MEAN_SHIFT",
      detail: "totally different format",
    };
    expect(dedupKeyForFlag(odd)).toBe("2026-04-20|FAMILY_MEAN_SHIFT");
  });
});

describe("selectNewFlags", () => {
  const baseRecord = (key: string): NotifiedFlagRecord => ({
    key,
    weekStart: "2026-04-20",
    kind: "GAP_BELOW_45",
    notifiedAt: "2026-04-21T00:00:00.000Z",
    detail: "old",
  });

  it("partitions flags into new vs already-notified", () => {
    const out = selectNewFlags(
      [GAP_FLAG, FAM_FLAG_T1_INJ, FAM_FLAG_T3_MEM],
      [baseRecord("2026-04-20|GAP_BELOW_45")],
    );
    expect(out.newFlags.map((f) => f.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
      "2026-04-20|FAMILY_MEAN_SHIFT|T3|MEMORY_CORRUPTION",
    ]);
    expect(out.alreadyNotified.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);
  });

  it("collapses duplicates within a single report", () => {
    const out = selectNewFlags([GAP_FLAG, GAP_FLAG], []);
    expect(out.newFlags).toHaveLength(1);
    expect(out.alreadyNotified).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// notifyDriftFlagsIfNew — uses a tmp state file so we don't touch the shipped
// data/avri-drift-notifications.json. Each test gets its own fresh file.
// ---------------------------------------------------------------------------

describe("notifyDriftFlagsIfNew", () => {
  let tmpDir: string;
  let statePath: string;
  let originalEnv: {
    url?: string;
    statePath?: string;
    publicUrl?: string;
    runbookUrl?: string;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "avri-drift-notify-"));
    statePath = path.join(tmpDir, "notifications.json");
    originalEnv = {
      url: process.env.AVRI_DRIFT_WEBHOOK_URL,
      statePath: process.env.AVRI_DRIFT_NOTIFICATIONS_PATH,
      publicUrl: process.env.PUBLIC_URL,
      runbookUrl: process.env.AVRI_DRIFT_RUNBOOK_URL,
    };
    process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = statePath;
    delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    delete process.env.PUBLIC_URL;
    delete process.env.AVRI_DRIFT_RUNBOOK_URL;
    __testing.resetResolvedPath();
  });

  afterEach(() => {
    if (originalEnv.url === undefined) delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    else process.env.AVRI_DRIFT_WEBHOOK_URL = originalEnv.url;
    if (originalEnv.statePath === undefined)
      delete process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
    else process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = originalEnv.statePath;
    if (originalEnv.publicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalEnv.publicUrl;
    if (originalEnv.runbookUrl === undefined)
      delete process.env.AVRI_DRIFT_RUNBOOK_URL;
    else process.env.AVRI_DRIFT_RUNBOOK_URL = originalEnv.runbookUrl;
    __testing.resetResolvedPath();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function recordingDispatcher(): {
    dispatch: WebhookDispatcher;
    calls: Array<{ url: string; payload: WebhookPayload }>;
    response: { ok: boolean; status?: number; error?: string };
  } {
    const calls: Array<{ url: string; payload: WebhookPayload }> = [];
    const handle = {
      dispatch: (async (url: string, payload: WebhookPayload) => {
        calls.push({ url, payload });
        return handle.response;
      }) as WebhookDispatcher,
      calls,
      response: { ok: true, status: 200 } as { ok: boolean; status?: number; error?: string },
    };
    return handle;
  }

  it("dispatches the webhook with all new flags and persists dedup state", async () => {
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG, FAM_FLAG_T1_INJ] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      publicUrl: "https://vulnrap.example.com",
      dispatch: rec.dispatch,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.webhookSkipped).toBe(false);
    expect(outcome.notified).toHaveLength(2);
    expect(outcome.alreadyNotified).toHaveLength(0);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe("https://example.com/hook");
    expect(rec.calls[0]!.payload.event).toBe("avri_drift_flags");
    expect(rec.calls[0]!.payload.calibrationUrl).toBe(
      "https://vulnrap.example.com/feedback-analytics",
    );
    expect(rec.calls[0]!.payload.runbookUrl).toBe(
      "https://vulnrap.example.com/docs/avri-drift-runbook.md",
    );
    expect(rec.calls[0]!.payload.flags.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);

    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified.map((n) => n.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
  });

  it("does not re-dispatch flags that are already in the dedup state", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        notified: [
          {
            key: "2026-04-20|GAP_BELOW_45",
            weekStart: "2026-04-20",
            kind: "GAP_BELOW_45",
            notifiedAt: "2026-04-21T00:00:00.000Z",
            detail: "old",
          },
        ],
      }),
    );
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified).toHaveLength(0);
    expect(outcome.alreadyNotified).toHaveLength(1);
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  it("dispatches new flags even when older flags from the same week are already notified", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        notified: [
          {
            key: "2026-04-20|GAP_BELOW_45",
            weekStart: "2026-04-20",
            kind: "GAP_BELOW_45",
            notifiedAt: "2026-04-21T00:00:00.000Z",
            detail: "old",
          },
        ],
      }),
    );
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG, FAM_FLAG_T1_INJ] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified.map((f) => f.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
    expect(outcome.alreadyNotified.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);
    expect(rec.calls[0]!.payload.flags).toHaveLength(1);
  });

  it("does NOT mark flags as notified when the webhook fails", async () => {
    const rec = recordingDispatcher();
    rec.response = { ok: false, status: 503, error: "HTTP 503" };
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.dispatchResult).toEqual({ ok: false, status: 503, error: "HTTP 503" });
    expect(outcome.notified).toHaveLength(0);
    // State file must not have been written / must remain empty so the next
    // dispatch will retry the same flag.
    if (existsSync(statePath)) {
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
        notified: NotifiedFlagRecord[];
      };
      expect(persisted.notified).toEqual([]);
    }
  });

  it("returns webhookSkipped + records flags when AVRI_DRIFT_WEBHOOK_URL is not set", async () => {
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      // No webhookUrl override and AVRI_DRIFT_WEBHOOK_URL is unset by beforeEach.
      dispatch: rec.dispatch,
    });
    expect(rec.calls).toHaveLength(0);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.webhookSkipped).toBe(true);
    // Critical: we DID record the flag so a future webhook hookup doesn't
    // retroactively spam reviewers with a backlog.
    expect(outcome.notified.map((f) => f.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified.map((n) => n.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
  });

  it("returns a no-op outcome when the report has no flags", async () => {
    const rec = recordingDispatcher();
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified).toHaveLength(0);
    expect(outcome.alreadyNotified).toHaveLength(0);
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("falls back to PUBLIC_URL or vulnrap.com when no link override is provided", async () => {
    const rec = recordingDispatcher();
    process.env.PUBLIC_URL = "https://prod.example.com/";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    // Trailing slash in PUBLIC_URL must be stripped.
    expect(outcome.calibrationUrl).toBe("https://prod.example.com/feedback-analytics");
    expect(outcome.runbookUrl).toBe(
      "https://prod.example.com/docs/avri-drift-runbook.md",
    );
  });

  it("uses AVRI_DRIFT_RUNBOOK_URL when provided so reviewers get a working link", async () => {
    const rec = recordingDispatcher();
    process.env.PUBLIC_URL = "https://prod.example.com";
    process.env.AVRI_DRIFT_RUNBOOK_URL =
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.calibrationUrl).toBe("https://prod.example.com/feedback-analytics");
    expect(outcome.runbookUrl).toBe(
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md",
    );
    // The dispatched payload must carry the override too.
    expect(rec.calls[0]!.payload.runbookUrl).toBe(
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md",
    );
  });

  it("prefers an explicit runbookUrl option over the env override", async () => {
    const rec = recordingDispatcher();
    process.env.AVRI_DRIFT_RUNBOOK_URL = "https://env.example.com/runbook";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      runbookUrl: "https://opt.example.com/runbook",
      dispatch: rec.dispatch,
    });
    expect(outcome.runbookUrl).toBe("https://opt.example.com/runbook");
  });
});

// ---------------------------------------------------------------------------
// runDriftNotificationCheck — single-shot helper used by both the scheduler
// and (in spirit) the manual notify endpoint. Verifies the cheap
// short-circuit when no webhook is configured.
// ---------------------------------------------------------------------------

describe("runDriftNotificationCheck", () => {
  let originalUrl: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.AVRI_DRIFT_WEBHOOK_URL;
    delete process.env.AVRI_DRIFT_WEBHOOK_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    else process.env.AVRI_DRIFT_WEBHOOK_URL = originalUrl;
  });

  it("short-circuits without scanning the DB when no webhook is configured", async () => {
    // No env, no DB connection in the test environment — proves the
    // short-circuit by virtue of NOT throwing on the missing DB.
    const result = await runDriftNotificationCheck();
    expect(result).toEqual({ ok: true, ranCheck: false });
  });
});

// ---------------------------------------------------------------------------
// startDriftNotificationScheduler — the deterministic background timer that
// replaces the throttled fire-and-forget hook on POST /api/reports
// (Task #197). Tests use vi.useFakeTimers() + an injected runner so they
// don't touch the DB or the wall clock.
// ---------------------------------------------------------------------------

describe("startDriftNotificationScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushTick(): Promise<void> {
    // Allow the queued microtasks for the just-fired tick to settle so
    // the scheduler has a chance to re-arm before the next assertion.
    await Promise.resolve();
    await Promise.resolve();
  }

  it("ticks on the success interval after a successful run", async () => {
    const calls: string[] = [];
    const sched = startDriftNotificationScheduler({
      intervalMs: 1000,
      retryIntervalMs: 100,
      initialDelayMs: 10,
      run: async () => {
        calls.push("ok");
        return { ok: true };
      },
    });
    try {
      expect(sched.ticksCompleted()).toBe(0);

      await vi.advanceTimersByTimeAsync(10);
      await flushTick();
      expect(calls).toEqual(["ok"]);
      expect(sched.ticksCompleted()).toBe(1);

      // Next tick must wait the full success interval, not the retry
      // interval, because the previous run returned ok.
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
    const sched = startDriftNotificationScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 50,
      initialDelayMs: 0,
      run: async () => {
        calls.push(nextOk);
        return { ok: nextOk };
      },
    });
    try {
      // First tick fails → must re-arm at retryIntervalMs (50ms),
      // not the success intervalMs (10s).
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
    const sched = startDriftNotificationScheduler({
      intervalMs: 10_000,
      retryIntervalMs: 25,
      initialDelayMs: 0,
      run: async () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("boom");
        }
        return { ok: true };
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();
      expect(sched.ticksCompleted()).toBe(1);

      // The throw must be treated as a failure → reschedule at the
      // retry interval, not the success interval.
      await vi.advanceTimersByTimeAsync(25);
      await flushTick();
      expect(sched.ticksCompleted()).toBe(2);
    } finally {
      sched.stop();
    }
  });

  it("stop() cancels future ticks", async () => {
    let calls = 0;
    const sched = startDriftNotificationScheduler({
      intervalMs: 50,
      retryIntervalMs: 10,
      initialDelayMs: 0,
      run: async () => {
        calls += 1;
        return { ok: true };
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
});

// ---------------------------------------------------------------------------
// Task #196 — listNotifiedFlags / removeNotifiedFlags drive the calibration
// UI's "re-arm a notified flag" button. removeNotifiedFlags must be a true
// inverse of notifyDriftFlagsIfNew: after removing a key the next dispatch
// run sees the matching flag as never-notified and re-fires the webhook.
// ---------------------------------------------------------------------------

describe("listNotifiedFlags / removeNotifiedFlags", () => {
  let tmpDir: string;
  let statePath: string;
  let originalStatePath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "avri-drift-rearm-"));
    statePath = path.join(tmpDir, "notifications.json");
    originalStatePath = process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
    process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = statePath;
    __testing.resetResolvedPath();
  });

  afterEach(() => {
    if (originalStatePath === undefined)
      delete process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
    else process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = originalStatePath;
    __testing.resetResolvedPath();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedState(records: NotifiedFlagRecord[]) {
    writeFileSync(statePath, JSON.stringify({ notified: records }));
  }

  it("listNotifiedFlags returns an empty array when the state file does not exist", () => {
    expect(listNotifiedFlags()).toEqual([]);
  });

  it("listNotifiedFlags returns a deep copy so callers cannot mutate persisted state", () => {
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "old",
      },
    ]);
    const snap = listNotifiedFlags();
    expect(snap).toHaveLength(1);
    snap[0]!.detail = "MUTATED";
    const second = listNotifiedFlags();
    expect(second[0]!.detail).toBe("old");
  });

  it("removeNotifiedFlags drops matching entries and reports remaining count", () => {
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "gap detail",
      },
      {
        key: "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
        weekStart: "2026-04-20",
        kind: "FAMILY_MEAN_SHIFT",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "fam detail",
      },
      {
        key: "2026-04-13|GAP_BELOW_45",
        weekStart: "2026-04-13",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-14T00:00:00.000Z",
        detail: "old gap",
      },
    ]);

    const result = removeNotifiedFlags(["2026-04-20|GAP_BELOW_45"]);
    expect(result.removed.map((r) => r.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    expect(result.notFound).toEqual([]);
    expect(result.remaining).toBe(2);

    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified.map((n) => n.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
      "2026-04-13|GAP_BELOW_45",
    ]);
  });

  it("removeNotifiedFlags reports unknown keys without modifying state", () => {
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "gap",
      },
    ]);
    const result = removeNotifiedFlags(["does-not-exist"]);
    expect(result.removed).toEqual([]);
    expect(result.notFound).toEqual(["does-not-exist"]);
    expect(result.remaining).toBe(1);
    // Untouched on no-op so we don't churn the file mtime.
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified).toHaveLength(1);
  });

  it("removeNotifiedFlags collapses duplicate input keys", () => {
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "gap",
      },
    ]);
    const result = removeNotifiedFlags([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|GAP_BELOW_45",
    ]);
    expect(result.removed).toHaveLength(1);
    expect(result.notFound).toEqual([]);
    expect(result.remaining).toBe(0);
  });

  it("removeNotifiedFlags ignores empty / non-string inputs", () => {
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "gap",
      },
    ]);
    const result = removeNotifiedFlags(["", "   ", "2026-04-20|GAP_BELOW_45"]);
    expect(result.removed.map((r) => r.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    expect(result.notFound).toEqual([]);
  });

  it("re-armed flags fire on the next dispatch run (round-trip with notifyDriftFlagsIfNew)", async () => {
    // Step 1: seed the state as if reviewers had already been paged about
    // the gap flag.
    seedState([
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "old gap",
      },
    ]);
    const calls: Array<{ url: string; payload: WebhookPayload }> = [];
    const dispatch: WebhookDispatcher = async (url, payload) => {
      calls.push({ url, payload });
      return { ok: true, status: 200 };
    };

    // Pre-condition: dispatching now suppresses the gap flag.
    let outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch,
    });
    expect(outcome.dispatched).toBe(false);
    expect(calls).toHaveLength(0);

    // Step 2: re-arm the gap key via the new lib function.
    const removeResult = removeNotifiedFlags(["2026-04-20|GAP_BELOW_45"]);
    expect(removeResult.removed).toHaveLength(1);
    expect(removeResult.remaining).toBe(0);

    // Step 3: the next dispatch run must re-fire the webhook for it.
    outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch,
    });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.notified.map((f) => f.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.flags.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);

    // And the dedup state has been re-recorded with a fresh notifiedAt so
    // subsequent runs go back to suppressing it.
    const refreshed = listNotifiedFlags();
    expect(refreshed.map((r) => r.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    expect(refreshed[0]!.notifiedAt).not.toBe("2026-04-21T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// getDriftSchedulerStatus exposes the in-memory scheduler heartbeat that the
// calibration page reads. Tests pin the wall clock and inject a runner so
// the status struct's timestamps are deterministic.
// ---------------------------------------------------------------------------

describe("getDriftSchedulerStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
    __testing.resetSchedulerStatus();
  });

  afterEach(() => {
    vi.useRealTimers();
    __testing.resetSchedulerStatus();
  });

  async function flushTick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("returns the 'never started' baseline before the scheduler runs", () => {
    const status = getDriftSchedulerStatus();
    expect(status.schedulerStarted).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.lastTickAt).toBeNull();
    expect(status.nextTickAt).toBeNull();
    expect(status.lastTickOk).toBeNull();
    expect(status.ticksCompleted).toBe(0);
  });

  it("seeds startedAt + nextTickAt when the scheduler starts", () => {
    const sched = startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 1_000,
      run: async () => ({ ok: true }),
    });
    try {
      const status = getDriftSchedulerStatus();
      expect(status.schedulerStarted).toBe(true);
      expect(status.startedAt).toBe("2026-04-29T00:00:00.000Z");
      expect(status.intervalMs).toBe(60_000);
      expect(status.retryIntervalMs).toBe(5_000);
      // initialDelayMs is added to the wall clock; first tick is due
      // 1s after start.
      expect(status.nextTickAt).toBe("2026-04-29T00:00:01.000Z");
      expect(status.lastTickAt).toBeNull();
      expect(status.ticksCompleted).toBe(0);
    } finally {
      sched.stop();
    }
  });

  it("updates lastTickAt + nextTickAt + counters after each successful tick", async () => {
    const sched = startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 1_000,
      run: async () => ({
        ok: true,
        ranCheck: true,
        outcome: {
          // newFlagCount on the status surface is derived from
          // notified.length so it stays in sync with the dedup state
          // file (the actual number of flags written to disk).
          notified: [
            { ...GAP_FLAG, key: "k1" },
            { ...FAM_FLAG_T1_INJ, key: "k2" },
          ],
          alreadyNotified: [],
          dispatched: true,
          dispatchResult: { ok: true },
        },
      }),
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await flushTick();

      const status = getDriftSchedulerStatus();
      expect(status.lastTickAt).toBe("2026-04-29T00:00:01.000Z");
      expect(status.lastTickOk).toBe(true);
      expect(status.lastTickRanCheck).toBe(true);
      expect(status.lastTickDispatched).toBe(true);
      expect(status.lastTickNewFlagCount).toBe(2);
      // After a successful tick the next firing is intervalMs (60s)
      // away, not retryIntervalMs.
      expect(status.nextTickAt).toBe("2026-04-29T00:01:01.000Z");
      expect(status.ticksCompleted).toBe(1);
    } finally {
      sched.stop();
    }
  });

  it("uses the retry cadence when a tick fails", async () => {
    const sched = startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 0,
      run: async () => ({
        ok: false,
        ranCheck: true,
      }),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushTick();

      const status = getDriftSchedulerStatus();
      expect(status.lastTickOk).toBe(false);
      // Failed tick reschedules at retryIntervalMs (5s), not the
      // success intervalMs (60s).
      expect(status.nextTickAt).toBe("2026-04-29T00:00:05.000Z");
      expect(status.ticksCompleted).toBe(1);
    } finally {
      sched.stop();
    }
  });

  it("clears nextTickAt when stop() is called", async () => {
    const sched = startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 1_000,
      run: async () => ({ ok: true }),
    });
    expect(getDriftSchedulerStatus().nextTickAt).not.toBeNull();
    sched.stop();
    const status = getDriftSchedulerStatus();
    expect(status.nextTickAt).toBeNull();
    // schedulerStarted stays true so the UI can still show the
    // "scheduler ran but is stopped" state. startedAt is preserved
    // for the same reason.
    expect(status.schedulerStarted).toBe(true);
    expect(status.startedAt).toBe("2026-04-29T00:00:00.000Z");
  });
});
