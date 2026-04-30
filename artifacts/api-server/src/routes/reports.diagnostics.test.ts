// Integration tests for the diagnostics endpoint and the
// VULNRAP_USE_NEW_COMPOSITE feature flag / trace-persistence behavior on POST.
//
// We swap @workspace/db for an in-memory fake (the real schema objects are kept
// so drizzle column references still work) and intercept drizzle-orm's
// `eq`/`or`/`and`/`desc` so the fake can apply real filters and ordering.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  createInMemoryDb,
  drizzleOrmOverrides,
  makeHashesTableSpec,
  makeReportsTableSpec,
  makeSimilaritiesTableSpec,
  makeStatsTableSpec,
  resetBaseState,
  seedReport as seedReportShared,
  type BaseDbState,
  type FakeRow,
} from "./__test-fixtures__/in-memory-db";

// Diagnostics-specific state extends the shared base with `analysisTraces`
// rows + an auto-incrementing trace id, plus two test-side toggles:
//   - `failTraceInsert`: when true, the trace TableSpec.insert throws,
//     letting us exercise the strict-mode rollback path in
//     `POST /api/reports`.
//   - `insertedTracePayloads`: every payload the route attempted to insert,
//     including ones the failure hook rejected — so the rollback test can
//     assert "we tried to write a trace before the transaction failed".
interface DbState extends BaseDbState {
  traces: FakeRow[];
  nextTraceId: number;
  failTraceInsert: boolean;
  insertedTracePayloads: FakeRow[];
}

const dbState: DbState = {
  reports: [],
  traces: [],
  hashes: [],
  similarities: [],
  stats: new Map(),
  nextReportId: 1,
  nextTraceId: 1,
  failTraceInsert: false,
  insertedTracePayloads: [],
};
(globalThis as unknown as { __fakeDbState: DbState }).__fakeDbState = dbState;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return { ...actual, ...drizzleOrmOverrides };
});

vi.mock("../lib/active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
}));

vi.mock("../lib/llm-slop", () => ({
  isLLMAvailable: () => false,
  shouldCallLLM: () => false,
  // Task #209 — performAnalysis now reads the structured gate decision so
  // it can flow into auditTelemetry. Mirror the "skipped, LLM unavailable"
  // shape that the real evaluateLlmGate would return when the provider is
  // off — keeps the mocked test path identical to the production behavior.
  evaluateLlmGate: () => ({
    shouldCall: false,
    reason: "skipped_unavailable",
    heuristicScore: 0,
    confidence: 1,
    costGuard: { low: 25, high: 60, confidence: 0.5 },
  }),
  analyzeSlopWithLLM: vi.fn(async () => null),
}));

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const state = (globalThis as unknown as { __fakeDbState: DbState })
    .__fakeDbState;

  const { db, pool } = createInMemoryDb({
    schema,
    // Snapshot mode mirrors the real `db.transaction(fn)` semantics that the
    // strict trace-failure test depends on: when the trace insert throws,
    // every table the transaction touched (reports + traces + counters)
    // must be rolled back.
    transactionMode: "snapshot",
    tables: [
      makeReportsTableSpec(schema, state),
      makeHashesTableSpec(schema, state),
      makeSimilaritiesTableSpec(schema, state),
      makeStatsTableSpec(schema, state),
      // Diagnostics-only table: analysis_traces. The route inserts trace
      // payloads inside the same transaction as the report itself, so we
      // capture every attempted payload (`insertedTracePayloads`) and then
      // optionally throw based on the `failTraceInsert` toggle. Snapshot/
      // restore only carries `traces` + `nextTraceId` so the failure
      // bookkeeping (`insertedTracePayloads`, `failTraceInsert`) survives a
      // rollback for the test to assert against.
      {
        table: schema.analysisTracesTable,
        getRows: () => state.traces,
        insert: (r) => {
          state.insertedTracePayloads.push({ ...r });
          if (state.failTraceInsert) {
            throw new Error("simulated trace insert failure");
          }
          const row = {
            ...r,
            id: state.nextTraceId++,
            createdAt: r.createdAt ?? new Date(),
          };
          state.traces.push(row);
          return row;
        },
        snapshot: () => ({
          rows: state.traces.map((r) => ({ ...r })),
          next: state.nextTraceId,
        }),
        restore: (snap) => {
          const s = snap as { rows: FakeRow[]; next: number };
          state.traces = s.rows;
          state.nextTraceId = s.next;
        },
      },
    ],
  });

  return {
    ...schema,
    db,
    pool,
  };
});

// Imports that depend on the mocks must come AFTER the vi.mock calls above.
// vitest hoists vi.mock so this ordering is preserved at runtime.
const appModule = await import("../app");
const app = appModule.default;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetBaseState(dbState);
  dbState.traces = [];
  dbState.nextTraceId = 1;
  dbState.failTraceInsert = false;
  dbState.insertedTracePayloads = [];
  delete process.env.VULNRAP_USE_NEW_COMPOSITE;
  delete process.env.VULNRAP_TRACE_BEST_EFFORT;
});

// Defaults come from the shared `BASE_REPORT` (showInFeed: true so the
// happy-path tests don't have to flip it; null `redactedText`/`contentText`
// so the route's verification step is naturally skipped).
function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  return seedReportShared(dbState, overrides);
}

function seedTrace(overrides: Partial<FakeRow> = {}): FakeRow {
  const id = dbState.nextTraceId++;
  const row: FakeRow = {
    id,
    correlationId: `cid-${id}`,
    reportId: null,
    totalDurationMs: 10,
    trace: { stages: [], correlationId: `cid-${id}` },
    createdAt: new Date(),
    ...overrides,
  };
  dbState.traces.push(row);
  return row;
}

async function postReport(body: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

const SAMPLE_REPORT_TEXT =
  "Title: Reflected XSS in /search\n" +
  "Severity: medium\n" +
  "Steps to reproduce:\n" +
  "1. Navigate to https://example.com/search?q=<script>alert(1)</script>\n" +
  "2. Observe the alert popup confirms script execution.\n" +
  "Impact: An attacker can execute arbitrary JavaScript in the victim's browser.\n" +
  "Expected: input should be HTML-escaped before being reflected.\n";

describe("GET /api/reports/:id/diagnostics", () => {
  it("returns 404 when the report does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/reports/9999/diagnostics`);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toMatch(/not found/i);
  });

  it("happy path: returns the trace paired by correlation_id", async () => {
    const report = seedReport({
      vulnrapCompositeScore: 72,
      vulnrapCompositeLabel: "Likely Genuine",
      vulnrapOverridesApplied: ["TEST_OVERRIDE"],
      vulnrapCorrelationId: "abc-123",
      vulnrapDurationMs: 42,
      vulnrapEngineResults: { engines: [], compositeBreakdown: {}, warnings: [], engineCount: 3 },
    });
    seedTrace({
      correlationId: "abc-123",
      reportId: report.id as number,
      totalDurationMs: 42,
      trace: { correlationId: "abc-123", stages: [{ stage: "extract_signals", durationMs: 5 }] },
    });

    const res = await fetch(`${baseUrl}/api/reports/${report.id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reportId).toBe(report.id);
    expect(body.correlationId).toBe("abc-123");
    expect(body.composite).toEqual({
      score: 72,
      label: "Likely Genuine",
      overridesApplied: ["TEST_OVERRIDE"],
    });
    expect(body.legacyMapping.slopScore).toBe(28); // 100 - 72
    expect(body.legacyMapping.displayMode).toBe("vulnrap-composite");
    expect(body.featureFlags.VULNRAP_USE_NEW_COMPOSITE).toBe(true);
    expect(body.trace).toEqual({
      correlationId: "abc-123",
      stages: [{ stage: "extract_signals", durationMs: 5 }],
    });
  });

  it("legacy report (no correlation_id) falls back to most-recent trace by reportId", async () => {
    const report = seedReport({ vulnrapCorrelationId: null });
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    seedTrace({
      correlationId: "old",
      reportId: report.id as number,
      createdAt: older,
      trace: { tag: "older" },
    });
    seedTrace({
      correlationId: "new",
      reportId: report.id as number,
      createdAt: newer,
      trace: { tag: "newer" },
    });

    const res = await fetch(`${baseUrl}/api/reports/${report.id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.correlationId).toBeNull();
    expect(body.trace).toEqual({ tag: "newer" });
  });

  it("exposes Engine 2 verificationSources summary with the documented shape", async () => {
    const report = seedReport({
      vulnrapCompositeScore: 64,
      vulnrapCompositeLabel: "REASONABLE",
      vulnrapCorrelationId: "verif-1",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 70,
            verdict: "GREEN",
            confidence: "HIGH",
            signalBreakdown: {
              verificationSources: {
                referenced: 4,
                fallback: 2,
                verified: 3,
                total: 4,
              },
            },
          },
        ],
        compositeBreakdown: {},
        warnings: [],
        engineCount: 1,
      },
    });

    const res = await fetch(`${baseUrl}/api/reports/${report.id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const e2 = body.engines.engines.find(
      (e: { engine: string }) => e.engine === "Technical Substance Analyzer",
    );
    expect(e2).toBeDefined();
    const vs = e2.signalBreakdown.verificationSources;
    expect(vs).toEqual({
      referenced: 4,
      fallback: 2,
      verified: 3,
      total: 4,
    });
    expect(typeof vs.verified).toBe("number");
    expect(typeof vs.total).toBe("number");
    expect(typeof vs.referenced).toBe("number");
    expect(typeof vs.fallback).toBe("number");
  });

  it("prefers correlation_id pairing over the most-recent trace", async () => {
    const report = seedReport({ vulnrapCorrelationId: "match-me" });
    // The matching trace is OLDER than the unrelated one; pairing must still
    // win over orderBy(createdAt desc) fallback.
    seedTrace({
      correlationId: "unrelated",
      reportId: report.id as number,
      createdAt: new Date(),
      trace: { tag: "unrelated-newer" },
    });
    seedTrace({
      correlationId: "match-me",
      reportId: report.id as number,
      createdAt: new Date(Date.now() - 120_000),
      trace: { tag: "matching-older" },
    });

    const res = await fetch(`${baseUrl}/api/reports/${report.id}/diagnostics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.correlationId).toBe("match-me");
    expect(body.trace).toEqual({ tag: "matching-older" });
  });
});

describe("POST /api/reports — VULNRAP_USE_NEW_COMPOSITE flag and trace persistence", () => {
  it("with VULNRAP_USE_NEW_COMPOSITE=false, persists no trace and stores no correlation_id", async () => {
    process.env.VULNRAP_USE_NEW_COMPOSITE = "false";

    const res = await postReport({ rawText: SAMPLE_REPORT_TEXT });
    expect(res.status).toBe(201);
    const body = await res.json() as any;

    expect(body.id).toBeTypeOf("number");
    expect(body.vulnrap).toBeNull();

    expect(dbState.reports).toHaveLength(1);
    const stored = dbState.reports[0];
    expect(stored.vulnrapCorrelationId).toBeNull();
    expect(stored.vulnrapCompositeScore).toBeNull();
    expect(stored.vulnrapDurationMs).toBeNull();

    expect(dbState.traces).toHaveLength(0);
    expect(dbState.insertedTracePayloads).toHaveLength(0);
  });

  it("rolls back the entire transaction when analysis_traces insert fails (strict mode)", async () => {
    process.env.VULNRAP_USE_NEW_COMPOSITE = "true";
    process.env.VULNRAP_TRACE_BEST_EFFORT = "false";
    dbState.failTraceInsert = true;

    const res = await postReport({ rawText: SAMPLE_REPORT_TEXT });
    expect(res.status).toBe(500);

    // Both reports and traces tables must end up empty (transaction rolled back).
    expect(dbState.reports).toHaveLength(0);
    expect(dbState.traces).toHaveLength(0);
    // The trace insert was attempted before the failure.
    expect(dbState.insertedTracePayloads.length).toBeGreaterThan(0);
  });

  it("VULNRAP_TRACE_BEST_EFFORT=true downgrades trace failure to a warning and keeps the report", async () => {
    process.env.VULNRAP_USE_NEW_COMPOSITE = "true";
    process.env.VULNRAP_TRACE_BEST_EFFORT = "true";
    dbState.failTraceInsert = true;

    const res = await postReport({ rawText: SAMPLE_REPORT_TEXT });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.id).toBeTypeOf("number");

    // Report persisted with composite + correlation id, but trace row absent.
    expect(dbState.reports).toHaveLength(1);
    const stored = dbState.reports[0];
    expect(stored.vulnrapCorrelationId).toBeTypeOf("string");
    expect(stored.vulnrapCompositeScore).toBeTypeOf("number");

    expect(dbState.traces).toHaveLength(0);
    expect(dbState.insertedTracePayloads.length).toBeGreaterThan(0);
  });
});
