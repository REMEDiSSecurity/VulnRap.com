// Task #621 — integration tests for GET /api/reports/:id/score-history.
//
// Mirrors the in-memory-db harness used by reports.diagnostics.test.ts so we
// can seed reports with a synthetic rescoreHistory and assert the endpoint
// hydrates the timeline (original entry + each rescore + per-engine details
// for any matching trace).

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
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
import type { AddressInfo } from "node:net";

interface DbState extends BaseDbState {
  traces: FakeRow[];
  nextTraceId: number;
}

const dbState: DbState = {
  reports: [],
  traces: [],
  hashes: [],
  similarities: [],
  stats: new Map(),
  nextReportId: 1,
  nextTraceId: 1,
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
  evaluateLlmGate: () => ({
    shouldCall: false,
    reason: "skipped_unavailable",
    heuristicScore: 0,
    confidence: 1,
    compositeScore: null,
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
    transactionMode: "snapshot",
    tables: [
      makeReportsTableSpec(schema, state),
      makeHashesTableSpec(schema, state),
      makeSimilaritiesTableSpec(schema, state),
      makeStatsTableSpec(schema, state),
      {
        table: (schema as { analysisTracesTable: unknown }).analysisTracesTable,
        getRows: () => state.traces,
        insert: (r) => {
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
});

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

describe("GET /api/reports/:id/score-history", () => {
  it("returns 404 when the report does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/reports/9999/score-history`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the report is not visible in the feed", async () => {
    const report = seedReport({
      showInFeed: false,
      vulnrapCompositeScore: 50,
      vulnrapCompositeLabel: "REASONABLE",
    });
    const res = await fetch(
      `${baseUrl}/api/reports/${report.id}/score-history`,
    );
    expect(res.status).toBe(404);
  });

  it("returns a single original entry when no rescores have happened", async () => {
    const report = seedReport({
      vulnrapCompositeScore: 72,
      vulnrapCompositeLabel: "REASONABLE",
      vulnrapCorrelationId: "orig-1",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Engine 1",
            score: 30,
            verdict: "GREEN",
            confidence: "HIGH",
          },
          {
            engine: "Engine 2",
            score: 80,
            verdict: "GREEN",
            confidence: "HIGH",
          },
        ],
      },
    });

    const res = await fetch(
      `${baseUrl}/api/reports/${report.id}/score-history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reportId: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(body.reportId).toBe(report.id);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      compositeScore: 72,
      label: "REASONABLE",
      source: "original",
      mode: "original",
      correlationId: "orig-1",
    });
    // Current entry pulls per-engine sub-scores from the engines blob.
    expect(body.entries[0].engines).toEqual([
      { engine: "Engine 1", score: 30, verdict: "GREEN", confidence: "HIGH" },
      { engine: "Engine 2", score: 80, verdict: "GREEN", confidence: "HIGH" },
    ]);
  });

  it("expands the rescore audit trail into a chronological original + per-rescore timeline", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const report = seedReport({
      createdAt,
      vulnrapCompositeScore: 71,
      vulnrapCompositeLabel: "REASONABLE",
      vulnrapCorrelationId: "cid-final",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Engine 1",
            score: 20,
            verdict: "GREEN",
            confidence: "HIGH",
          },
        ],
        rescoreHistory: [
          {
            source: "backfill-rescore",
            mode: "engine",
            rescoredAt: "2026-02-01T00:00:00.000Z",
            priorCompositeScore: 62,
            priorCompositeLabel: "NEEDS REVIEW",
            priorCorrelationId: "cid-orig",
            newCompositeScore: 58,
            newCompositeLabel: "NEEDS REVIEW",
            newCorrelationId: "cid-mid",
          },
          {
            source: "backfill-rescore",
            mode: "engine",
            rescoredAt: "2026-03-01T00:00:00.000Z",
            priorCompositeScore: 58,
            priorCompositeLabel: "NEEDS REVIEW",
            priorCorrelationId: "cid-mid",
            newCompositeScore: 71,
            newCompositeLabel: "REASONABLE",
            newCorrelationId: "cid-final",
          },
        ],
      },
    });

    seedTrace({
      correlationId: "cid-orig",
      reportId: report.id as number,
      trace: {
        correlationId: "cid-orig",
        composite: {
          overallScore: 62,
          label: "NEEDS REVIEW",
          overridesApplied: [],
          warnings: [],
        },
        enginesUsed: ["Engine 1", "Engine 2"],
        featureFlags: { VULNRAP_USE_NEW_COMPOSITE: true },
      },
    });
    seedTrace({
      correlationId: "cid-mid",
      reportId: report.id as number,
      trace: {
        correlationId: "cid-mid",
        composite: {
          overallScore: 58,
          label: "NEEDS REVIEW",
          overridesApplied: [],
          warnings: [],
        },
        enginesUsed: ["Engine 1", "Engine 2", "Engine 3"],
        featureFlags: { VULNRAP_USE_AVRI: true },
      },
    });

    const res = await fetch(
      `${baseUrl}/api/reports/${report.id}/score-history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(3);

    // Earliest = priorCompositeScore from the first rescore entry, dated at report.createdAt.
    // codeVersion is intentionally null until a real scorer-version field is
    // persisted (see follow-up #949); engines is null on past entries because
    // analysis_traces does not store per-engine numeric scores (follow-up #950).
    expect(body.entries[0]).toMatchObject({
      compositeScore: 62,
      label: "NEEDS REVIEW",
      source: "original",
      mode: "original",
      correlationId: "cid-orig",
      codeVersion: null,
      engines: null,
      recordedAt: createdAt.toISOString(),
    });

    // Middle entry comes from the first rescore.
    expect(body.entries[1]).toMatchObject({
      compositeScore: 58,
      source: "backfill-rescore",
      mode: "engine",
      correlationId: "cid-mid",
      codeVersion: null,
      engines: null,
      recordedAt: "2026-02-01T00:00:00.000Z",
    });

    // Final entry mirrors the row's current composite + uses the engines blob
    // for per-engine sub-scores.
    expect(body.entries[2]).toMatchObject({
      compositeScore: 71,
      label: "REASONABLE",
      source: "backfill-rescore",
      mode: "engine",
      correlationId: "cid-final",
    });
    expect(body.entries[2].engines).toEqual([
      { engine: "Engine 1", score: 20, verdict: "GREEN", confidence: "HIGH" },
    ]);
  });

  it("labels reconstruction-mode rescores as Reconstructed and skips trace lookup for recon- ids", async () => {
    const report = seedReport({
      vulnrapCompositeScore: 40,
      vulnrapCompositeLabel: "HIGH RISK",
      vulnrapCorrelationId: "recon-xyz",
      vulnrapEngineResults: {
        engines: [],
        rescoreHistory: [
          {
            source: "backfill-rescore",
            mode: "reconstruction",
            rescoredAt: "2026-04-01T00:00:00.000Z",
            priorCompositeScore: 50,
            priorCompositeLabel: "NEEDS REVIEW",
            priorCorrelationId: null,
            newCompositeScore: 40,
            newCompositeLabel: "HIGH RISK",
            newCorrelationId: "recon-xyz",
          },
        ],
      },
    });

    const res = await fetch(
      `${baseUrl}/api/reports/${report.id}/score-history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      compositeScore: 50,
      source: "original",
      mode: "original",
      correlationId: null,
      codeVersion: null,
    });
    expect(body.entries[1]).toMatchObject({
      compositeScore: 40,
      source: "backfill-rescore",
      mode: "reconstruction",
      correlationId: "recon-xyz",
      codeVersion: null,
    });
  });

  it("returns an empty entries list when the report has no vulnrap composite yet", async () => {
    const report = seedReport({
      vulnrapCompositeScore: null,
      vulnrapCompositeLabel: null,
      vulnrapEngineResults: null,
    });
    const res = await fetch(
      `${baseUrl}/api/reports/${report.id}/score-history`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });
});
