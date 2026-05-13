// Coverage for the synthetic health-heartbeat scheduler.
//
// The scheduler exists so the public status page never reports a
// "Major outage" purely because no one submitted a report recently —
// it ticks the real pipeline against canned text every few minutes
// and persists the trace, so engine health is self-evidencing.
//
// These tests pin the contract reviewers care about:
//   1. Disabling via env produces a no-op tick (never touches the DB).
//   2. A successful tick runs the real pipeline, persists the trace
//      to `analysis_traces` with `reportId = null`, and marks it with
//      the `synthetic_heartbeat` note so future filters can find it.
//   3. The scheduler re-arms at the success cadence after an OK tick
//      and at the (shorter) retry cadence after a failure.
//   4. Status reflects the most recent tick.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock the engines module so the heartbeat tick is fast and
// deterministic (no Perplexity/AVRI internals invoked here).
const analyzeMock = vi.fn();
vi.mock("./engines", () => ({
  analyzeWithEnginesTraced: (text: string, opts: unknown) =>
    analyzeMock(text, opts),
}));

// Capture every row inserted into analysis_traces, plus the args of
// each DELETE call so prune tests can pin the WHERE-clause shape. The
// scheduler dynamically imports @workspace/db / drizzle-orm so these
// mocks must be in place before the first tick resolves the imports.
const insertedRows: Array<Record<string, unknown>> = [];
let deleteCalls = 0;
let deleteReturnRows: Array<{ id: number }> = [];
let lastDeleteWhere: unknown = null;
vi.mock("@workspace/db", () => {
  const analysisTracesTable = {
    __table: "analysis_traces",
    createdAt: { __col: "created_at" },
    trace: { __col: "trace" },
    id: { __col: "id" },
  } as const;
  return {
    analysisTracesTable,
    db: {
      insert: (table: unknown) => {
        expect(table).toBe(analysisTracesTable);
        return {
          values: async (row: Record<string, unknown>) => {
            insertedRows.push(row);
          },
        };
      },
      delete: (table: unknown) => {
        expect(table).toBe(analysisTracesTable);
        deleteCalls += 1;
        return {
          where: (clause: unknown) => {
            lastDeleteWhere = clause;
            return {
              returning: async () => deleteReturnRows,
            };
          },
        };
      },
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ __and: parts }),
  lt: (col: unknown, val: unknown) => ({ __lt: { col, val } }),
  isNull: (col: unknown) => ({ __isNull: col }),
  sql: (strings: TemplateStringsArray, ..._args: unknown[]) => ({
    __sql: strings.join("?"),
  }),
}));

import {
  runHeartbeatTick,
  startHealthHeartbeatScheduler,
  getHealthHeartbeatSchedulerStatus,
  pruneSyntheticHeartbeats,
  HEARTBEAT_NOTE,
  __testing,
} from "./health-heartbeat-scheduler";

const ORIGINAL_DISABLED = process.env.HEALTH_HEARTBEAT_DISABLED;

function makeFakeTraceResult(overrides: { correlationId?: string } = {}) {
  const correlationId = overrides.correlationId ?? "hb-corr-123";
  return {
    composite: { overallScore: 80 },
    perplexity: {},
    trace: {
      correlationId,
      reportId: null,
      totalDurationMs: 42,
      stages: [],
      enginesUsed: ["linguistic", "substance", "cwe", "avri", "llm_gate"],
      composite: null,
      signalsSummary: null,
      featureFlags: {},
      notes: [],
    },
  } as ReturnType<typeof analyzeMock>;
}

beforeEach(() => {
  vi.useFakeTimers();
  insertedRows.length = 0;
  deleteCalls = 0;
  deleteReturnRows = [];
  lastDeleteWhere = null;
  analyzeMock.mockReset();
  __testing.resetSchedulerStatus();
  __testing.resetLastPruneAt();
  delete process.env.HEALTH_HEARTBEAT_DISABLED;
  delete process.env.HEALTH_HEARTBEAT_RETENTION_DAYS;
  delete process.env.HEALTH_HEARTBEAT_PRUNE_INTERVAL_MS;
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_DISABLED === undefined) {
    delete process.env.HEALTH_HEARTBEAT_DISABLED;
  } else {
    process.env.HEALTH_HEARTBEAT_DISABLED = ORIGINAL_DISABLED;
  }
});

describe("runHeartbeatTick", () => {
  it("is a no-op when HEALTH_HEARTBEAT_DISABLED is set", async () => {
    process.env.HEALTH_HEARTBEAT_DISABLED = "true";
    const result = await runHeartbeatTick();
    expect(result).toEqual({ ok: true, ranTick: false });
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it("runs the pipeline and persists a synthetic trace tagged for filtering", async () => {
    analyzeMock.mockReturnValueOnce(
      makeFakeTraceResult({ correlationId: "hb-corr-A" }),
    );
    const result = await runHeartbeatTick();
    expect(result.ok).toBe(true);
    expect(result.ranTick).toBe(true);
    expect(result.correlationId).toBe("hb-corr-A");

    expect(analyzeMock).toHaveBeenCalledTimes(1);
    const [text, opts] = analyzeMock.mock.calls[0]!;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(200);
    expect((opts as { claimedCwes: string[] }).claimedCwes).toEqual(["CWE-79"]);

    expect(insertedRows).toHaveLength(1);
    const row = insertedRows[0]!;
    expect(row.reportId).toBeNull();
    expect(row.correlationId).toBe("hb-corr-A");
    const persistedTrace = row.trace as {
      reportId: number | null;
      notes: string[];
    };
    expect(persistedTrace.reportId).toBeNull();
    expect(persistedTrace.notes).toContain(HEARTBEAT_NOTE);
  });

  it("returns ok=false (not throw) when the pipeline blows up so the scheduler re-arms at the retry cadence", async () => {
    analyzeMock.mockImplementationOnce(() => {
      throw new Error("perplexity provider unavailable");
    });
    const result = await runHeartbeatTick();
    expect(result.ok).toBe(false);
    expect(insertedRows).toHaveLength(0);
  });
});

describe("pruneSyntheticHeartbeats", () => {
  it("issues a DELETE filtered by ALL THREE guards (cutoff + null reportId + synthetic note) and reports the row count", async () => {
    deleteReturnRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const before = Date.now();
    const result = await pruneSyntheticHeartbeats(30);
    expect(result.deleted).toBe(3);
    expect(deleteCalls).toBe(1);

    // The WHERE clause must combine three guards in AND. Defense in
    // depth: even if any one guard accidentally matches an organic
    // row, the other two still protect it.
    const where = lastDeleteWhere as { __and?: unknown[] };
    expect(Array.isArray(where.__and)).toBe(true);
    const parts = where.__and!;

    // 1) created_at < (now - 30d)
    const ltPart = parts.find(
      (p): p is { __lt: { col: unknown; val: Date } } =>
        typeof p === "object" && p !== null && "__lt" in p,
    );
    expect(ltPart).toBeDefined();
    const cutoffMs = ltPart!.__lt.val.getTime();
    const expectedCutoffMs = before - 30 * 24 * 60 * 60 * 1000;
    // Allow a small window for the Date.now() call inside the prune
    // happening just after `before`.
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedCutoffMs - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(expectedCutoffMs + 1000);

    // 2) report_id IS NULL — guarantees this DELETE can never touch
    // a row tied to an actual user report.
    const isNullPart = parts.find(
      (p): p is { __isNull: unknown } =>
        typeof p === "object" && p !== null && "__isNull" in p,
    );
    expect(isNullPart).toBeDefined();

    // 3) trace->'notes' @> '["synthetic_heartbeat"]'::jsonb
    const sqlPart = parts.find(
      (p): p is { __sql: string } =>
        typeof p === "object" && p !== null && "__sql" in p,
    );
    expect(sqlPart?.__sql).toContain("synthetic_heartbeat");
  });
});

describe("daily prune piggybacked on the heartbeat tick", () => {
  it("runs the prune on the first successful tick after start", async () => {
    analyzeMock.mockReturnValueOnce(makeFakeTraceResult());
    deleteReturnRows = [{ id: 99 }];
    const result = await runHeartbeatTick();
    expect(result.ok).toBe(true);
    expect(result.pruned).toBe(1);
    expect(deleteCalls).toBe(1);
  });

  it("skips the prune on subsequent ticks until the prune interval elapses", async () => {
    process.env.HEALTH_HEARTBEAT_PRUNE_INTERVAL_MS = String(60 * 60 * 1000); // 1h
    analyzeMock
      .mockReturnValueOnce(makeFakeTraceResult({ correlationId: "hb-A" }))
      .mockReturnValueOnce(makeFakeTraceResult({ correlationId: "hb-B" }))
      .mockReturnValueOnce(makeFakeTraceResult({ correlationId: "hb-C" }));
    deleteReturnRows = [];

    const first = await runHeartbeatTick();
    expect(first.pruned).toBe(0); // ran prune, deleted 0 rows
    expect(deleteCalls).toBe(1);

    const second = await runHeartbeatTick();
    expect(second.pruned).toBeUndefined(); // skipped prune
    expect(deleteCalls).toBe(1);

    // Advance past the prune interval — next tick should prune again.
    vi.setSystemTime(new Date(Date.now() + 61 * 60 * 1000));
    const third = await runHeartbeatTick();
    expect(third.pruned).toBe(0);
    expect(deleteCalls).toBe(2);
  });

  it("treats a prune failure as non-fatal so the tick still reports ok", async () => {
    analyzeMock.mockReturnValueOnce(makeFakeTraceResult());
    // Force the delete chain to throw inside .returning().
    deleteReturnRows = [];
    const origDelete = (
      await import("@workspace/db")
    ).db as unknown as { delete: unknown };
    const realDelete = origDelete.delete;
    origDelete.delete = (table: unknown) => {
      deleteCalls += 1;
      void table;
      return {
        where: () => ({
          returning: async () => {
            throw new Error("simulated db failure");
          },
        }),
      };
    };
    try {
      const result = await runHeartbeatTick();
      expect(result.ok).toBe(true); // tick stays green
      expect(result.pruned).toBeUndefined();
      expect(insertedRows).toHaveLength(1); // insert still happened
    } finally {
      origDelete.delete = realDelete;
    }
  });
});

describe("env parsing", () => {
  it("HEALTH_HEARTBEAT_INITIAL_DELAY_MS overrides the default initial delay", () => {
    const original = process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS;
    try {
      process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS = "1234";
      expect(__testing.autoInitialDelayMs()).toBe(1234);
      delete process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS;
      expect(__testing.autoInitialDelayMs()).toBe(
        __testing.DEFAULT_INITIAL_DELAY_MS,
      );
      process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS = "not-a-number";
      expect(__testing.autoInitialDelayMs()).toBe(
        __testing.DEFAULT_INITIAL_DELAY_MS,
      );
    } finally {
      if (original === undefined) {
        delete process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS;
      } else {
        process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS = original;
      }
    }
  });
});

describe("startHealthHeartbeatScheduler", () => {
  it("ticks at the success cadence after an OK tick and surfaces it in status", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        ranTick: true,
        durationMs: 11,
        correlationId: "hb-1",
      })
      .mockResolvedValueOnce({
        ok: true,
        ranTick: true,
        durationMs: 12,
        correlationId: "hb-2",
      });

    const scheduler = startHealthHeartbeatScheduler({
      intervalMs: 5_000,
      retryIntervalMs: 1_000,
      initialDelayMs: 100,
      run,
    });

    expect(getHealthHeartbeatSchedulerStatus().schedulerStarted).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    const statusAfterFirst = getHealthHeartbeatSchedulerStatus();
    expect(statusAfterFirst.lastTickOk).toBe(true);
    expect(statusAfterFirst.lastCorrelationId).toBe("hb-1");
    expect(statusAfterFirst.ticksCompleted).toBe(1);

    // Next tick should land at the SUCCESS cadence (5s), not the
    // retry cadence (1s).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(run).toHaveBeenCalledTimes(2);

    expect(getHealthHeartbeatSchedulerStatus().lastCorrelationId).toBe("hb-2");
    scheduler.stop();
  });

  it("backs off to the retry cadence after a failed tick", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, ranTick: true })
      .mockResolvedValueOnce({
        ok: true,
        ranTick: true,
        durationMs: 9,
        correlationId: "hb-after-retry",
      });

    const scheduler = startHealthHeartbeatScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 1_000,
      initialDelayMs: 100,
      run,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getHealthHeartbeatSchedulerStatus().lastTickOk).toBe(false);

    // Re-arm at retry cadence (1s), NOT success cadence (60s).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(getHealthHeartbeatSchedulerStatus().lastTickOk).toBe(true);
    expect(getHealthHeartbeatSchedulerStatus().lastCorrelationId).toBe(
      "hb-after-retry",
    );

    scheduler.stop();
  });

  it("stop() prevents further ticks", async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      ranTick: true,
      durationMs: 5,
      correlationId: "hb-x",
    });
    const scheduler = startHealthHeartbeatScheduler({
      intervalMs: 1_000,
      retryIntervalMs: 500,
      initialDelayMs: 100,
      run,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(getHealthHeartbeatSchedulerStatus().nextTickAt).toBeNull();
  });
});
