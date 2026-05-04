// Query-budget regression tests for the hottest report read path.
//
// Task #726 acceptance criterion: "a query-budget assertion in tests for
// the hottest query paths so a future N+1 regression fails CI."
//
// GET /api/reports/:id issues at most 3 db.select() calls in the worst case:
//
//   #1  (always)      fetch the report row by id
//   #2  (conditional) template-duplicate lookup — only when report.templateHash
//                     is non-null
//   #3  (conditional) revision-candidate lookup — only when there is a
//                     similarity match with score ≥ 70
//
// A change that adds a select anywhere along this path (e.g. an extra join,
// an eager-loaded count, a background enrichment that sneaks into the read
// route) will push the count above the budget ceiling and fail CI here
// instead of surfacing as a production TTFB regression.
//
// The harness (`__test-fixtures__/query-counter.ts`) wraps the in-memory db
// returned by `createInMemoryDb` with a select counter. The mock boundary is
// bridged via globalThis because vi.mock factories are hoisted by vitest's
// transform but their *body* runs lazily (only when the module is first
// imported), so any globalThis assignment made at module-evaluation time is
// visible inside the factory.

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
import {
  createSelectCounter,
  withSelectCounter,
  type SelectCounter,
} from "./__test-fixtures__/query-counter";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface DbState extends BaseDbState {
  feedback: FakeRow[];
  nextFeedbackId: number;
}

const dbState: DbState = {
  reports: [],
  feedback: [],
  hashes: [],
  similarities: [],
  stats: new Map(),
  nextReportId: 1,
  nextFeedbackId: 1,
};

// Counter for db.select() calls. Bridged via globalThis so the vi.mock
// factory (hoisted to top of file) can access it once the module has
// been fully evaluated.
const selectCounter: SelectCounter = createSelectCounter();

// Bridge both objects across the vi.mock hoisting boundary.
(
  globalThis as unknown as {
    __budgetDbState: DbState;
    __budgetSelectCounter: SelectCounter;
  }
).__budgetDbState = dbState;
(
  globalThis as unknown as {
    __budgetDbState: DbState;
    __budgetSelectCounter: SelectCounter;
  }
).__budgetSelectCounter = selectCounter;

// ---------------------------------------------------------------------------
// vi.mock — same set as reports.privacy.test.ts so the handler's imports
// resolve without a live Postgres or external services.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return { ...actual, ...drizzleOrmOverrides };
});

vi.mock("../lib/active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
  deriveVerificationStrategy: vi.fn(() => "standard"),
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

vi.mock("../lib/triage-recommendation", () => ({
  generateTriageRecommendation: vi.fn(() => ({
    action: "STANDARD_TRIAGE",
    reason: "test",
    note: "test",
    challengeQuestions: [],
    temporalSignals: [],
    templateMatch: null,
    revision: null,
    matrixInputs: null,
  })),
  buildV36TriageContext: vi.fn(() => ({})),
  computeTemporalSignals: vi.fn(() => []),
  detectRevision: vi.fn(() => null),
}));

vi.mock("../lib/triage-assistant", () => ({
  generateTriageAssistant: vi.fn(() => null),
}));

vi.mock("../lib/engines", () => ({
  isNewCompositeEnabled: () => false,
  analyzeWithEnginesTraced: vi.fn(() => ({ composite: null, trace: null })),
  compositeToLegacySlopScore: vi.fn((n: number) => 100 - n),
}));

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const g = globalThis as unknown as {
    __budgetDbState: DbState;
    __budgetSelectCounter: SelectCounter;
  };
  const state = g.__budgetDbState;
  const counter = g.__budgetSelectCounter;

  const { db: rawDb, pool } = createInMemoryDb({
    schema,
    transactionMode: "passthrough",
    tables: [
      makeReportsTableSpec(schema, state),
      makeHashesTableSpec(schema, state),
      makeSimilaritiesTableSpec(schema, state),
      makeStatsTableSpec(schema, state),
      {
        table: schema.userFeedbackTable,
        getRows: () => state.feedback,
        insert: (r) => {
          const row = {
            ...r,
            id: state.nextFeedbackId++,
            createdAt: r.createdAt ?? new Date(),
          };
          state.feedback.push(row);
          return row;
        },
      },
    ],
  });

  return {
    db: withSelectCounter(rawDb, counter),
    pool,
    reportsTable: schema.reportsTable,
    reportHashesTable: schema.reportHashesTable,
    similarityResultsTable: schema.similarityResultsTable,
    reportStatsTable: schema.reportStatsTable,
    userFeedbackTable: schema.userFeedbackTable,
    analysisTracesTable: schema.analysisTracesTable,
  };
});

// ---------------------------------------------------------------------------
// Server setup — reuse the real Express app so middleware (body parsing,
// route registration) matches production exactly.
// ---------------------------------------------------------------------------

const appModule = await import("../app");
const app = appModule.default;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetBaseState(dbState);
  dbState.feedback = [];
  dbState.nextFeedbackId = 1;
  selectCounter.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  return seedReportShared(dbState, overrides);
}

async function getReport(
  id: number,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "GET",
        hostname: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        path: `/api/reports/${id}`,
        headers,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Query-budget tests for GET /api/reports/:id
//
// Budget ceiling per code path:
//
//   404 path (not found)                         : exactly 1 select
//   200 path — no templateHash, no high-sim      : exactly 1 select
//   200 path — templateHash only                 : exactly 2 selects
//   200 path — high-sim only (similarity ≥ 70)  : exactly 2 selects
//   200 path — templateHash + high-sim (worst)   : at most  3 selects  ← hard ceiling
//   304 conditional GET                          : exactly 1 select
// ---------------------------------------------------------------------------

describe("Task #726 — GET /api/reports/:id query budgets", () => {
  it("404 (report not found) issues exactly 1 select", async () => {
    // No rows seeded → the handler fetches, gets [], and returns 404.
    const r = await getReport(999);
    expect(r.status).toBe(404);
    expect(selectCounter.count).toBe(1);
  });

  it("200 path with no templateHash and no similarity matches issues exactly 1 select", async () => {
    // Base report: templateHash=null (default), similarityMatches=[] (default).
    // Handler path: fetch → 200. No follow-up selects.
    const report = seedReport({ showInFeed: true });
    const r = await getReport(report.id as number);
    expect(r.status).toBe(200);
    expect(selectCounter.count).toBe(1);
  });

  it("200 path with templateHash issues exactly 2 selects", async () => {
    // templateHash triggers a second SELECT to find template duplicates.
    const report = seedReport({
      showInFeed: true,
      templateHash: "tmpl-budget-test",
      similarityMatches: [],
    });
    const r = await getReport(report.id as number);
    expect(r.status).toBe(200);
    expect(selectCounter.count).toBe(2);
  });

  it("200 path with a high-similarity match issues exactly 2 selects", async () => {
    // A similarity score ≥ 70 triggers a second SELECT to look up the
    // candidate revision row. templateHash is null so the template-duplicate
    // select is skipped entirely.
    const other = seedReport({ showInFeed: true });
    const report = seedReport({
      showInFeed: true,
      templateHash: null,
      similarityMatches: [
        {
          reportId: other.id,
          similarity: 75,
          matchType: "near-duplicate",
        },
      ],
    });
    const r = await getReport(report.id as number);
    expect(r.status).toBe(200);
    expect(selectCounter.count).toBe(2);
  });

  it("200 path with templateHash + high-sim (worst case) issues at most 3 selects", async () => {
    // Both conditional branches fire:
    //   select #1 — fetch report by id
    //   select #2 — template-duplicate lookup (templateHash is non-null)
    //   select #3 — revision-candidate lookup (similarity ≥ 70)
    // This is the hard budget ceiling for this endpoint. Any regression that
    // adds a fourth select (e.g. an extra join, an eager-loaded count) will
    // push selectCounter.count above 3 and fail here.
    const other = seedReport({ showInFeed: true });
    const report = seedReport({
      showInFeed: true,
      templateHash: "tmpl-worst-case",
      similarityMatches: [
        {
          reportId: other.id,
          similarity: 80,
          matchType: "near-duplicate",
        },
      ],
    });
    const r = await getReport(report.id as number);
    expect(r.status).toBe(200);
    // Hard ceiling — updating this number requires a deliberate, reviewed
    // decision (and a matching update to docs/performance.md).
    expect(selectCounter.count).toBeLessThanOrEqual(3);
  });

  it("304 conditional GET short-circuits after exactly 1 select", async () => {
    // The handler fetches the report row (select #1), sets Last-Modified, and
    // then checks req.fresh. If the client's If-Modified-Since header is ≥
    // Last-Modified, Express sets req.fresh=true and the handler returns 304
    // before reaching any of the follow-up selects. This test locks in that
    // short-circuit so a future "move the cache check below the heavy selects"
    // refactor fails CI immediately.
    const createdAt = new Date("2026-04-30T12:00:00.000Z");
    const report = seedReport({
      showInFeed: true,
      templateHash: "tmpl-304-test",
      similarityMatches: [{ reportId: 99, similarity: 90, matchType: "near" }],
      createdAt,
    });

    // If-Modified-Since must be ≥ Last-Modified (createdAt) for req.fresh=true.
    const ims = new Date(createdAt.getTime() + 1000).toUTCString();
    const r = await getReport(report.id as number, {
      "If-Modified-Since": ims,
    });
    expect(r.status).toBe(304);
    // Only the initial report-fetch select must have fired.
    expect(selectCounter.count).toBe(1);
  });
});
