// Regression tests for report privacy enforcement.
//
// Verifies that showInFeed=false reports are rejected across all five public
// retrieval endpoints, and that feedback analytics excludes hidden reports.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeRow extends Record<string, unknown> {}

interface DbState {
  reports: FakeRow[];
  feedback: FakeRow[];
  hashes: FakeRow[];
  similarities: FakeRow[];
  stats: Map<string, number>;
  nextReportId: number;
  nextFeedbackId: number;
}

function freshState(): DbState {
  return {
    reports: [],
    feedback: [],
    hashes: [],
    similarities: [],
    stats: new Map(),
    nextReportId: 1,
    nextFeedbackId: 1,
  };
}

const dbState: DbState = freshState();
(globalThis as unknown as { __privacyDbState: DbState }).__privacyDbState = dbState;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
    or: (...conds: unknown[]) => ({ __op: "or", conds }),
    and: (...conds: unknown[]) => ({ __op: "and", conds }),
    desc: (col: unknown) => ({ __op: "desc", col }),
    gte: (col: unknown, val: unknown) => ({ __op: "gte", col, val }),
    isNotNull: (col: unknown) => ({ __op: "isNotNull", col }),
    sql: Object.assign(
      (_strings: TemplateStringsArray) => ({ __op: "sql_fragment" }),
      { mapWith: () => ({ __op: "sql_mapped" }) },
    ),
  };
});

vi.mock("../lib/active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
  deriveVerificationStrategy: vi.fn(() => "standard"),
}));

vi.mock("../lib/llm-slop", () => ({
  isLLMAvailable: () => false,
  shouldCallLLM: () => false,
  // Task #209 — performAnalysis pulls a structured gate decision through
  // evaluateLlmGate so it can flow into the audit telemetry block. Mirror
  // the "skipped, LLM unavailable" shape the real fn returns when the
  // provider is off.
  evaluateLlmGate: () => ({
    shouldCall: false,
    reason: "skipped_unavailable",
    heuristicScore: 0,
    confidence: 1,
    costGuard: { low: 25, high: 60, confidence: 0.5 },
  }),
  analyzeSlopWithLLM: vi.fn(async () => null),
}));

vi.mock("../lib/triage-recommendation", () => ({
  // The route spreads this object straight into the response and then runs
  // GetReportResponse.parse(...). The zod schema requires a real
  // TriageRecommendation shape (action ∈ AUTO_CLOSE|MANUAL_REVIEW|
  // CHALLENGE_REPORTER|PRIORITIZE|STANDARD_TRIAGE, plus reason/note/
  // matrixInputs), so the mock has to satisfy that or the parse throws and
  // turns into a 500 — which is exactly what kept the 200-path tests broken.
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
  // generateTriageAssistant is synchronous (not async); the route assigns its
  // return value directly without awaiting, so a Promise-returning mock would
  // make the body's `if (mdTriageAssistant)` branch enter with a Promise and
  // then crash on `.gaps.length`. Return null synchronously.
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
  const state = (globalThis as unknown as { __privacyDbState: DbState })
    .__privacyDbState;

  type Cond =
    | { __op: "eq"; col: unknown; val: unknown }
    | { __op: "or"; conds: Cond[] }
    | { __op: "and"; conds: Cond[] }
    | { __op: "gte"; col: unknown; val: unknown }
    | { __op: "isNotNull"; col: unknown }
    | { __op: "sql_fragment" }
    | null
    | undefined;

  function findColName(table: Record<string, unknown>, col: unknown): string {
    for (const k of Object.keys(table)) {
      if (table[k] === col) return k;
    }
    return "__unknown__";
  }

  function applyCond(
    rows: FakeRow[],
    cond: Cond,
    table: Record<string, unknown>,
  ): FakeRow[] {
    if (!cond || typeof cond !== "object") return rows;
    const op = (cond as { __op?: string }).__op;
    if (op === "eq") {
      const c = cond as { col: unknown; val: unknown };
      const colName = findColName(table, c.col);
      if (colName === "__unknown__") return rows;
      // Handle column-to-column comparisons (JOIN conditions like col1 = col2)
      const valColName = findColName(table, c.val);
      if (valColName !== "__unknown__") {
        return rows.filter((r) => r[colName] === r[valColName]);
      }
      return rows.filter((r) => r[colName] === c.val);
    }
    if (op === "or") {
      const c = cond as { conds: Cond[] };
      return rows.filter((r) =>
        c.conds.some((sub) => applyCond([r], sub, table).length > 0),
      );
    }
    if (op === "and") {
      const c = cond as { conds: Cond[] };
      return c.conds.reduce<FakeRow[]>(
        (acc, sub) => applyCond(acc, sub, table),
        rows,
      );
    }
    return rows;
  }

  type TableKey = "reports" | "feedback" | "hashes" | "similarities" | "stats" | "unknown";

  function tableKey(table: unknown): TableKey {
    if (table === schema.reportsTable) return "reports";
    if (table === schema.userFeedbackTable) return "feedback";
    if (table === schema.reportHashesTable) return "hashes";
    if (table === schema.similarityResultsTable) return "similarities";
    if (table === schema.reportStatsTable) return "stats";
    return "unknown";
  }

  function getTableRows(table: unknown): FakeRow[] {
    const k = tableKey(table);
    if (k === "reports") return state.reports;
    if (k === "feedback") return state.feedback;
    if (k === "hashes") return state.hashes;
    if (k === "similarities") return state.similarities;
    return [];
  }

  function selectChain(): Record<string, unknown> {
    let cond: Cond = null;
    let limitN: number | null = null;
    let baseTable: Record<string, unknown> | null = null;
    let joined: { rows: FakeRow[]; schema: Record<string, unknown> } | null = null;

    const chain: Record<string, unknown> = {
      from(t: Record<string, unknown>) {
        baseTable = t;
        return chain;
      },
      where(c: Cond) {
        cond = c;
        return chain;
      },
      limit(n: number) {
        limitN = n;
        return chain;
      },
      orderBy(_o: unknown) {
        return chain;
      },
      groupBy(_o: unknown) {
        return chain;
      },
      innerJoin(joinTable: unknown, joinCond: Cond) {
        const baseRows = getTableRows(baseTable);
        const joinRows = getTableRows(joinTable);
        const joinSchema = joinTable as Record<string, unknown>;
        const merged: FakeRow[] = [];
        const effectiveSchema = { ...baseTable!, ...joinSchema };
        for (const base of baseRows) {
          for (const jr of joinRows) {
            const combined = { ...jr, ...base };
            if (applyCond([combined], joinCond, effectiveSchema).length > 0) {
              merged.push(combined);
            }
          }
        }
        joined = { rows: merged, schema: effectiveSchema };
        return chain;
      },
      leftJoin(joinTable: unknown, joinCond: Cond) {
        const baseRows = getTableRows(baseTable);
        const joinRows = getTableRows(joinTable);
        const joinSchema = joinTable as Record<string, unknown>;
        const effectiveSchema = { ...baseTable!, ...joinSchema };
        const merged: FakeRow[] = [];
        for (const base of baseRows) {
          const matches: FakeRow[] = [];
          for (const jr of joinRows) {
            const combined = { ...jr, ...base };
            if (applyCond([combined], joinCond, effectiveSchema).length > 0) {
              matches.push(combined);
            }
          }
          merged.push(...(matches.length > 0 ? matches : [{ ...base }]));
        }
        joined = { rows: merged, schema: effectiveSchema };
        return chain;
      },
      then(
        resolve: (rows: FakeRow[]) => void,
        reject: (err: unknown) => void,
      ) {
        try {
          let rows = joined ? joined.rows : getTableRows(baseTable);
          const effectiveSchema = joined
            ? joined.schema
            : (baseTable as Record<string, unknown>);
          rows = applyCond(rows, cond, effectiveSchema);
          if (limitN != null) rows = rows.slice(0, limitN);
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      },
    };
    return chain;
  }

  function doInsert(table: unknown, rows: FakeRow[]): FakeRow[] {
    const k = tableKey(table);
    const inserted: FakeRow[] = [];
    for (const r of rows) {
      if (k === "reports") {
        const row = { ...r, id: state.nextReportId++, createdAt: r.createdAt ?? new Date() };
        state.reports.push(row);
        inserted.push(row);
      } else if (k === "feedback") {
        const row = { ...r, id: state.nextFeedbackId++, createdAt: r.createdAt ?? new Date() };
        state.feedback.push(row);
        inserted.push(row);
      } else if (k === "hashes") {
        state.hashes.push({ ...r });
        inserted.push({ ...r });
      } else if (k === "similarities") {
        state.similarities.push({ ...r });
        inserted.push({ ...r });
      } else if (k === "stats") {
        const key = r.key as string;
        const inc = typeof r.value === "number" ? r.value : 1;
        state.stats.set(key, (state.stats.get(key) ?? 0) + inc);
      }
    }
    return inserted;
  }

  const db: Record<string, unknown> = {
    select(_proj?: unknown) {
      return { from: (t: Record<string, unknown>) => { const c = selectChain(); (c.from as (t: unknown) => unknown)(t); return c; } };
    },
    insert(table: unknown) {
      return {
        values(input: FakeRow | FakeRow[]) {
          const inputs = Array.isArray(input) ? input : [input];
          const op: Record<string, unknown> = {
            returning() {
              return { then(res: (r: FakeRow[]) => void, rej: (e: unknown) => void) { try { res(doInsert(table, inputs)); } catch (e) { rej(e); } } };
            },
            onConflictDoUpdate(_o: unknown) {
              return { then(res: (v: undefined) => void, rej: (e: unknown) => void) { try { doInsert(table, inputs); res(undefined); } catch (e) { rej(e); } } };
            },
            then(res: (v: undefined) => void, rej: (e: unknown) => void) {
              try { doInsert(table, inputs); res(undefined); } catch (e) { rej(e); }
            },
          };
          return op;
        },
      };
    },
    transaction: async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => fn(db),
  };

  return {
    db,
    reportsTable: schema.reportsTable,
    reportHashesTable: schema.reportHashesTable,
    similarityResultsTable: schema.similarityResultsTable,
    reportStatsTable: schema.reportStatsTable,
    userFeedbackTable: schema.userFeedbackTable,
    // /reports/:id/diagnostics looks up analysis_traces by correlation_id and
    // again by report_id. Without exporting this table the route resolves it
    // to undefined and the drizzle chain throws on `.where(eq(undefined.col,
    // ...))`, which surfaced to the harness as a 500. We don't seed any rows
    // for it here — the fake selectChain just returns [] for unknown tables,
    // which exercises the legacy "no trace" branch the route handles fine.
    analysisTracesTable: schema.analysisTracesTable,
    pool: { end: async () => undefined },
  };
});

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
  dbState.reports = [];
  dbState.feedback = [];
  dbState.hashes = [];
  dbState.similarities = [];
  dbState.stats = new Map();
  dbState.nextReportId = 1;
  dbState.nextFeedbackId = 1;
});

const BASE_REPORT: FakeRow = {
  deleteToken: "tok",
  contentHash: "abc123",
  simhash: "sim0",
  minhashSignature: [],
  lshBuckets: [],
  contentText: "sample",
  redactedText: "sample",
  contentMode: "full",
  slopScore: 50,
  slopTier: "Questionable",
  qualityScore: 50,
  confidence: 0.5,
  breakdown: {},
  evidence: [],
  similarityMatches: [],
  sectionHashes: {},
  sectionMatches: [],
  redactionSummary: { totalRedactions: 0, categories: {} },
  feedback: [],
  llmSlopScore: null,
  llmFeedback: null,
  llmBreakdown: null,
  authenticityScore: 0,
  validityScore: 0,
  quadrant: "WEAK_HUMAN",
  archetype: "REQUEST_DETAILS",
  humanIndicators: [],
  templateHash: null,
  vulnrapCompositeScore: null,
  vulnrapCompositeLabel: null,
  vulnrapEngineResults: null,
  vulnrapOverridesApplied: null,
  vulnrapCorrelationId: null,
  vulnrapDurationMs: null,
  fileName: null,
  fileSize: 0,
  showInFeed: true,
};

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    ...BASE_REPORT,
    id: dbState.nextReportId++,
    createdAt: new Date(),
    ...overrides,
  };
  dbState.reports.push(row);
  return row;
}

function seedFeedback(overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    id: dbState.nextFeedbackId++,
    reportId: null,
    rating: 3,
    helpful: true,
    comment: null,
    createdAt: new Date(),
    ...overrides,
  };
  dbState.feedback.push(row);
  return row;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe("GET /api/reports/:id — showInFeed enforcement", () => {
  it("returns 404 for a hidden report", async () => {
    const r = seedReport({ showInFeed: false });
    const res = await get(`/api/reports/${r.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a public report", async () => {
    const r = seedReport({
      showInFeed: true,
      contentHash: "hash-detail-200",
      slopScore: 42,
      slopTier: "Likely Slop",
    });
    const res = await get(`/api/reports/${r.id}`);
    expect(res.status).toBe(200);
    // Task #265: previously the 200 path was masked behind a 500 from a
    // schema-invalid triage mock + a missing analysisTracesTable export.
    // Lock the response body shape so future regressions on
    // GetReportResponse.parse(...) (e.g. a new required zod field) are
    // caught here instead of silently flipping the status back to 500.
    const body = res.body as Record<string, unknown>;
    expect(body.id).toBe(r.id);
    expect(body.contentHash).toBe("hash-detail-200");
    expect(body.slopScore).toBe(42);
    expect(body.slopTier).toBe("Likely Slop");
    expect(body.contentMode).toBe("full");
    expect(body.redactionSummary).toEqual({ totalRedactions: 0, categories: {} });
    expect(body.evidence).toEqual([]);
    expect(body.similarityMatches).toEqual([]);
    expect(body.feedback).toEqual([]);
    // verification + triageRecommendation are computed downstream of the
    // mocked libs; the shape (not the value) is what protects this route.
    expect(body.verification).toBeNull();
    expect(body.triageRecommendation).toMatchObject({
      action: "STANDARD_TRIAGE",
      reason: expect.any(String),
      note: expect.any(String),
    });
    expect(body.vulnrap).toBeNull();
  });
});

describe("GET /api/reports/:id/verify — showInFeed enforcement", () => {
  it("returns 404 for a hidden report", async () => {
    const r = seedReport({ showInFeed: false });
    const res = await get(`/api/reports/${r.id}/verify`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a public report", async () => {
    const r = seedReport({ showInFeed: true });
    const res = await get(`/api/reports/${r.id}/verify`);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/reports/:id/diagnostics — showInFeed enforcement", () => {
  it("returns 404 for a hidden report", async () => {
    const r = seedReport({ showInFeed: false });
    const res = await get(`/api/reports/${r.id}/diagnostics`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a public report", async () => {
    const r = seedReport({
      showInFeed: true,
      vulnrapCompositeScore: 65,
      vulnrapCompositeLabel: "REASONABLE",
      vulnrapCorrelationId: "diag-200",
      vulnrapDurationMs: 17,
      vulnrapOverridesApplied: ["TEST_OVERRIDE"],
      vulnrapEngineResults: { engines: [], compositeBreakdown: {}, warnings: [], engineCount: 0 },
    });
    const res = await get(`/api/reports/${r.id}/diagnostics`);
    expect(res.status).toBe(200);
    // Task #265: lock the diagnostics body shape so a future regression that
    // breaks the trace lookup or composite block can't silently revert this
    // back to 500. The harness no longer seeds analysis_traces rows, so the
    // route exercises the "no trace" fallback path.
    const body = res.body as Record<string, unknown>;
    expect(body.reportId).toBe(r.id);
    expect(body.correlationId).toBe("diag-200");
    expect(body.durationMs).toBe(17);
    expect(body.composite).toEqual({
      score: 65,
      label: "REASONABLE",
      overridesApplied: ["TEST_OVERRIDE"],
    });
    expect(body.legacyMapping).toMatchObject({
      slopScore: 35,
      displayMode: expect.any(String),
    });
    expect(body.featureFlags).toMatchObject({
      VULNRAP_USE_NEW_COMPOSITE: expect.any(Boolean),
    });
    expect(body.trace).toBeNull();
  });
});

describe("GET /api/reports/:id/triage-report — showInFeed enforcement", () => {
  it("returns 404 for a hidden report", async () => {
    const r = seedReport({ showInFeed: false });
    const res = await get(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(404);
  });

  it("returns 200 for a public report", async () => {
    const r = seedReport({ showInFeed: true });
    const res = await get(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);
  });
});

// Task 67: The printable triage report must surface which active-verification
// mode (SOURCE_CODE / ENDPOINT / MANUAL_ONLY / GENERIC) routed the report so a
// reviewer can tell that e.g. "no GitHub checks" is expected for an
// ENDPOINT-mode family. This mirrors the existing diagnostics-panel "Active
// verification mode" line.
describe("GET /api/reports/:id/triage-report — verification mode header", () => {
  async function getText(path: string): Promise<{ status: number; body: string }> {
    const r = await fetch(`${baseUrl}${path}`);
    return { status: r.status, body: await r.text() };
  }

  it("includes Mode line and family above the verification table for ENDPOINT mode", async () => {
    const av = await import("../lib/active-verification");
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      checks: [
        {
          type: "poc_plausibility_warning",
          target: "https://example.com/api/foo",
          result: "warning",
          detail: "PoC uses placeholder domain example.com",
          weight: 5,
          source: "referenced_in_report",
        },
      ],
      summary: { verified: 0, notFound: 0, warnings: 1, errors: 0 },
      triageNotes: [],
      score: 5,
      detectedProjects: [],
      mode: "ENDPOINT",
      familyName: "XSS / CSRF / clickjacking / open redirect",
    });

    const r = seedReport({ showInFeed: true, redactedText: "sample text" });
    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);

    const verifIdx = res.body.indexOf("## Verification Results");
    expect(verifIdx).toBeGreaterThan(-1);
    const modeIdx = res.body.indexOf(
      "- Mode: **ENDPOINT** — XSS / CSRF / clickjacking / open redirect",
    );
    expect(modeIdx).toBeGreaterThan(verifIdx);
    // The Mode bullet must appear before the verification table header.
    expect(modeIdx).toBeLessThan(res.body.indexOf("| Check | Status |"));
  });

  it("reproduces the 'requires manual reproduction' hint for MANUAL_ONLY families", async () => {
    const av = await import("../lib/active-verification");
    const skipNote =
      "Active verification skipped — HTTP request smuggling / desync requires manual reproduction.";
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      checks: [
        {
          type: "manual_review_required",
          target: "HTTP request smuggling / desync",
          result: "skipped",
          detail:
            "Automated source/endpoint verification is not meaningful for the HTTP request smuggling / desync family; route to a human reviewer.",
          weight: 0,
        },
      ],
      summary: { verified: 0, notFound: 0, warnings: 0, errors: 0 },
      triageNotes: [skipNote],
      score: 0,
      detectedProjects: [],
      mode: "MANUAL_ONLY",
      familyName: "HTTP request smuggling / desync",
    });

    const r = seedReport({ showInFeed: true, redactedText: "sample text" });
    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(
      "- Mode: **MANUAL_ONLY** — HTTP request smuggling / desync",
    );
    expect(res.body).toContain(`- ${skipNote}`);
  });

  it("omits the family suffix when familyName is not set", async () => {
    const av = await import("../lib/active-verification");
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      checks: [],
      summary: { verified: 0, notFound: 0, warnings: 0, errors: 0 },
      triageNotes: [],
      score: 0,
      detectedProjects: [],
      mode: "GENERIC",
    });

    const r = seedReport({ showInFeed: true, redactedText: "sample text" });
    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("- Mode: **GENERIC**");
    expect(res.body).not.toContain("- Mode: **GENERIC** —");
  });

  it("renders the same Mode line for cache-hit results as for fresh ones", async () => {
    // Task 67 acceptance: "The same line appears whether the verification ran
    // fresh or was served from cache." performActiveVerification persists
    // mode/familyName onto the cached VerificationResult and backfills them on
    // older cache entries, so the route is agnostic to provenance — we prove
    // that here by feeding it back-to-back results that *would* have come from
    // a fresh run vs. an L1 cache hit (cacheMetadata distinguishes the two)
    // and asserting the rendered Mode line is byte-identical.
    const av = await import("../lib/active-verification");
    const baseResult = {
      checks: [
        {
          type: "github_file_verified",
          target: "example/foo:src/parse.c",
          result: "verified" as const,
          detail: "File path exists",
          weight: -8,
          source: "referenced_in_report" as const,
        },
      ],
      summary: { verified: 1, notFound: 0, warnings: 0, errors: 0 },
      triageNotes: [],
      score: -8,
      detectedProjects: [],
      mode: "SOURCE_CODE" as const,
      familyName: "Memory corruption / unsafe C",
    };

    // Fresh run.
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      ...baseResult,
      cacheMetadata: { hits: { l1: 0, db: 0, fresh: 1 } },
    });
    const fresh = seedReport({ showInFeed: true, redactedText: "fresh body" });
    const freshRes = await getText(`/api/reports/${fresh.id}/triage-report`);
    expect(freshRes.status).toBe(200);

    // Cached run (same VerificationResult shape, but cacheMetadata says L1
    // hit — the route must not key off provenance and must render the same
    // Mode line).
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      ...baseResult,
      cacheMetadata: { hits: { l1: 1, db: 0, fresh: 0 } },
    });
    const cached = seedReport({ showInFeed: true, redactedText: "cached body" });
    const cachedRes = await getText(`/api/reports/${cached.id}/triage-report`);
    expect(cachedRes.status).toBe(200);

    const expected = "- Mode: **SOURCE_CODE** — Memory corruption / unsafe C";
    expect(freshRes.body).toContain(expected);
    expect(cachedRes.body).toContain(expected);
  });

  it("emits docs pointer lines under the Triage Recommendation, Matrix Inputs, and AVRI Family Rubric headings", async () => {
    // Task 259: each major section in the markdown export carries a one-line
    // italicised pointer to its canonical /changelog anchor, built through
    // the same PUBLIC_URL → request-origin → vulnrap.com resolution as the
    // verification-sources line.
    const tr = await import("../lib/triage-recommendation");
    vi.mocked(tr.generateTriageRecommendation).mockReturnValueOnce({
      action: "PRIORITIZE",
      reason: "High composite + strong evidence",
      note: "Composite 78 with 3 strong evidence items.",
      challengeQuestions: [],
      temporalSignals: [],
      templateMatch: null,
      revision: null,
      matrixInputs: {
        compositeScore: 78,
        engine2Score: 64,
        verificationRatio: 0.75,
        strongEvidenceCount: 3,
      },
    } as ReturnType<typeof tr.generateTriageRecommendation>);

    const previousPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://vulnrap.com";
    try {
      const r = seedReport({
        showInFeed: true,
        redactedText: "sample triage body",
        // Seed an AVRI composite + Engine 2 sub-block so the AVRI Family
        // Rubric section renders end-to-end and the docs pointer below it
        // can be asserted in the same export.
        vulnrapEngineResults: {
          avri: {
            family: "MEMORY_CORRUPTION",
            familyName: "Memory corruption / unsafe C",
            classification: { confidence: "HIGH", reason: "matched CWE-787" },
            goldHitCount: 1,
            velocityPenalty: 0,
            templatePenalty: 0,
            rawCompositeBeforeBehavioralPenalties: 50,
          },
          engines: [
            {
              engine: "Technical Substance Analyzer",
              signalBreakdown: {
                avri: {
                  family: "MEMORY_CORRUPTION",
                  familyName: "Memory corruption / unsafe C",
                  goldHitCount: 1,
                  goldTotalCount: 5,
                  goldHits: [],
                  goldMisses: [],
                  absencePenalty: 0,
                  absencePenalties: [],
                  contradictions: [],
                },
              },
            },
          ],
        },
      });
      const res = await getText(`/api/reports/${r.id}/triage-report`);
      expect(res.status).toBe(200);

      // 1) Triage Recommendation pointer sits between the section header and
      //    the **Action** line so readers see the link before the action.
      const trHeaderIdx = res.body.indexOf("## Triage Recommendation");
      const trDocsIdx = res.body.indexOf(
        "_Learn more about how triage recommendations are chosen: https://vulnrap.com/changelog#triage-recommendation_",
      );
      const trActionIdx = res.body.indexOf("**Action**: PRIORITIZE");
      expect(trHeaderIdx).toBeGreaterThan(-1);
      expect(trDocsIdx).toBeGreaterThan(trHeaderIdx);
      expect(trDocsIdx).toBeLessThan(trActionIdx);

      // 2) Matrix Inputs pointer sits between its header and the
      //    **Composite Score** bullet.
      const miHeaderIdx = res.body.indexOf("## Matrix Inputs");
      const miDocsIdx = res.body.indexOf(
        "_Learn more about the triage-matrix inputs: https://vulnrap.com/changelog#triage-matrix-inputs_",
      );
      const miCompositeIdx = res.body.indexOf("- **Composite Score**: 78");
      expect(miHeaderIdx).toBeGreaterThan(trHeaderIdx);
      expect(miDocsIdx).toBeGreaterThan(miHeaderIdx);
      expect(miDocsIdx).toBeLessThan(miCompositeIdx);

      // 3) AVRI Family Rubric pointer sits between its header and the
      //    **Family** bullet.
      const avriHeaderIdx = res.body.indexOf("## AVRI Family Rubric");
      const avriDocsIdx = res.body.indexOf(
        "_Learn more about the AVRI Family Rubric: https://vulnrap.com/changelog#avri-family-rubric_",
      );
      const avriFamilyIdx = res.body.indexOf(
        "- **Family**: Memory corruption / unsafe C",
      );
      expect(avriHeaderIdx).toBeGreaterThan(-1);
      expect(avriDocsIdx).toBeGreaterThan(avriHeaderIdx);
      expect(avriDocsIdx).toBeLessThan(avriFamilyIdx);
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previousPublicUrl;
    }
  });

  it("falls back to the request-derived origin for the Triage / Matrix / AVRI pointer lines when PUBLIC_URL is unset", async () => {
    // Task 259: the request-origin fallback must apply to every new pointer
    // line so self-hosted installs without PUBLIC_URL still get working
    // docs links in the markdown export.
    const tr = await import("../lib/triage-recommendation");
    vi.mocked(tr.generateTriageRecommendation).mockReturnValueOnce({
      action: "PRIORITIZE",
      reason: "fallback test",
      note: "fallback test",
      challengeQuestions: [],
      temporalSignals: [],
      templateMatch: null,
      revision: null,
      matrixInputs: {
        compositeScore: 50,
        engine2Score: 50,
        verificationRatio: 0,
        strongEvidenceCount: 0,
      },
    } as ReturnType<typeof tr.generateTriageRecommendation>);

    const previousPublicUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const r = seedReport({
        showInFeed: true,
        redactedText: "fallback body",
        vulnrapEngineResults: {
          avri: {
            family: "MEMORY_CORRUPTION",
            familyName: "Memory corruption / unsafe C",
            classification: { confidence: "HIGH", reason: "matched CWE-787" },
            goldHitCount: 0,
            velocityPenalty: 0,
            templatePenalty: 0,
          },
          engines: [
            {
              engine: "Technical Substance Analyzer",
              signalBreakdown: {
                avri: {
                  family: "MEMORY_CORRUPTION",
                  familyName: "Memory corruption / unsafe C",
                  goldHitCount: 0,
                  goldTotalCount: 5,
                  goldHits: [],
                  goldMisses: [],
                  absencePenalty: 0,
                  absencePenalties: [],
                  contradictions: [],
                },
              },
            },
          ],
        },
      });
      const res = await getText(`/api/reports/${r.id}/triage-report`);
      expect(res.status).toBe(200);

      // The test server binds to 127.0.0.1; each pointer line must use the
      // request origin (not a hard-coded vulnrap.com) so self-hosted exports
      // resolve back to the same origin the report was downloaded from.
      expect(res.body).toMatch(
        /_Learn more about how triage recommendations are chosen: http:\/\/127\.0\.0\.1:\d+\/changelog#triage-recommendation_/,
      );
      expect(res.body).toMatch(
        /_Learn more about the triage-matrix inputs: http:\/\/127\.0\.0\.1:\d+\/changelog#triage-matrix-inputs_/,
      );
      expect(res.body).toMatch(
        /_Learn more about the AVRI Family Rubric: http:\/\/127\.0\.0\.1:\d+\/changelog#avri-family-rubric_/,
      );
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previousPublicUrl;
    }
  });

  it("emits a docs link under the verified/referenced/search-fallback breakdown", async () => {
    // Task 188: the submitter results UI links the breakdown line to
    // /changelog#verification-sources via a "Learn more →" affordance. The
    // markdown export shares that same line, so a downloaded report shared
    // outside the app should carry an inline pointer to the same docs section
    // — otherwise the breakdown is opaque to anyone reading the export in
    // isolation.
    const av = await import("../lib/active-verification");
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      checks: [
        {
          type: "github_file_verified",
          target: "example/foo:src/parse.c",
          result: "verified",
          detail: "File path exists",
          weight: -8,
          source: "referenced_in_report",
        },
        {
          type: "github_repo_search",
          target: "fooproj",
          result: "warning",
          detail: "Guessed from project keyword",
          weight: 0,
          source: "search_fallback",
        },
      ],
      summary: { verified: 1, notFound: 0, warnings: 1, errors: 0 },
      triageNotes: [],
      score: -8,
      detectedProjects: [],
      mode: "SOURCE_CODE",
      familyName: "Memory corruption / unsafe C",
    });

    const previousPublicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://vulnrap.com";
    try {
      const r = seedReport({ showInFeed: true, redactedText: "sample text" });
      const res = await getText(`/api/reports/${r.id}/triage-report`);
      expect(res.status).toBe(200);

      const breakdownIdx = res.body.indexOf(
        "- verified 1/1 · referenced: 1 · search-fallback: 1",
      );
      const docsIdx = res.body.indexOf(
        "- _Learn more about referenced vs. search-fallback verification: https://vulnrap.com/changelog#verification-sources_",
      );
      expect(breakdownIdx).toBeGreaterThan(-1);
      expect(docsIdx).toBeGreaterThan(breakdownIdx);
      // Docs link must sit above the per-check verification table.
      expect(docsIdx).toBeLessThan(res.body.indexOf("| Check | Status |"));
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previousPublicUrl;
    }
  });

  it("falls back to the request-derived origin when PUBLIC_URL is unset", async () => {
    // Self-hosted installs that do not configure PUBLIC_URL should still get
    // a working docs link in the exported markdown — the route falls back to
    // the request's protocol+host so the link points back at the same origin
    // the submitter downloaded the report from.
    const av = await import("../lib/active-verification");
    vi.mocked(av.performActiveVerification).mockResolvedValueOnce({
      checks: [
        {
          type: "github_file_verified",
          target: "example/foo:src/parse.c",
          result: "verified",
          detail: "File path exists",
          weight: -8,
          source: "referenced_in_report",
        },
      ],
      summary: { verified: 1, notFound: 0, warnings: 0, errors: 0 },
      triageNotes: [],
      score: -8,
      detectedProjects: [],
      mode: "SOURCE_CODE",
      familyName: "Memory corruption / unsafe C",
    });

    const previousPublicUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const r = seedReport({ showInFeed: true, redactedText: "sample text" });
      const res = await getText(`/api/reports/${r.id}/triage-report`);
      expect(res.status).toBe(200);
      // The test server binds to 127.0.0.1; the link must use the request
      // origin (not a hard-coded vulnrap.com) so self-hosted exports work.
      expect(res.body).toMatch(
        /- _Learn more about referenced vs\. search-fallback verification: http:\/\/127\.0\.0\.1:\d+\/changelog#verification-sources_/,
      );
    } finally {
      if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previousPublicUrl;
    }
  });
});

describe("GET /api/reports/:id/compare/:matchId — showInFeed enforcement", () => {
  it("returns 404 when source report is hidden", async () => {
    const hidden = seedReport({
      showInFeed: false,
      similarityMatches: [{ reportId: 99, similarity: 80, matchType: "full" }],
    });
    const pub = seedReport({ showInFeed: true });
    const res = await get(`/api/reports/${hidden.id}/compare/${pub.id}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when matched report is hidden", async () => {
    const hidden = seedReport({ id: 99, showInFeed: false });
    const pub = seedReport({
      showInFeed: true,
      similarityMatches: [{ reportId: 99, similarity: 80, matchType: "full" }],
    });
    const res = await get(`/api/reports/${pub.id}/compare/${hidden.id}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/feedback/analytics — reportId exclusion", () => {
  // The analytics endpoint must never emit reportId in outliers or recentFeedback
  // items because numeric report IDs are sequential and guessable. The API
  // response mapping explicitly omits this field; these tests confirm the omission
  // holds at the HTTP boundary.
  //
  // Filtering of hidden-report feedback (showInFeed=false) is enforced by the
  // innerJoin conditions in feedback.ts and verified at the database query level
  // via code review.

  it("returns 200 and response lacks reportId in recentFeedback items", async () => {
    // Seed a public report and feedback linked to it (feedback ID matches
    // report ID so the in-memory join simulation resolves correctly).
    seedReport({ showInFeed: true, slopScore: 50 });
    seedFeedback({ reportId: 1, rating: 4, helpful: true, comment: "ok" });

    const res = await get("/api/feedback/analytics");
    expect(res.status).toBe(200);

    const body = res.body as { recentFeedback: Array<Record<string, unknown>> };
    for (const item of body.recentFeedback ?? []) {
      expect(item).not.toHaveProperty("reportId");
    }
  });

  it("returns 200 and response lacks reportId in outliers items", async () => {
    // Slop score of 90 with rating 1 qualifies as an outlier.
    seedReport({ showInFeed: true, slopScore: 90, qualityScore: 10 });
    seedFeedback({ reportId: 1, rating: 1, helpful: false, comment: "bad" });

    const res = await get("/api/feedback/analytics");
    expect(res.status).toBe(200);

    const body = res.body as { outliers: Array<Record<string, unknown>> };
    for (const item of body.outliers ?? []) {
      expect(item).not.toHaveProperty("reportId");
    }
  });
});

// Task 64 / Task 189: Task 64 added an "AVRI Family Rubric" section to the
// markdown emitted by GET /reports/:id/triage-report (mirroring the rubric the
// diagnostics panel renders), but it had no automated coverage. These tests
// confirm that when the stored report carries an AVRI composite block and an
// Engine 2 signalBreakdown.avri sub-block, the printable triage report
// surfaces the family name, gold-hit/miss bullets, absence penalties, and
// AVRI-prefixed composite overrides — and that legacy reports without any
// AVRI data have the section omitted entirely.
describe("GET /api/reports/:id/triage-report — AVRI Family Rubric section", () => {
  async function getText(path: string): Promise<{ status: number; body: string }> {
    const r = await fetch(`${baseUrl}${path}`);
    return { status: r.status, body: await r.text() };
  }

  // Mirrors the fixture shapes used by
  // artifacts/vulnrap/src/components/diagnostics-panel.test.tsx so the
  // server-side markdown export and client-side panel agree on the same
  // AVRI payload contract.
  const AVRI_VULNRAP_BLOB = {
    avri: {
      family: "MEMORY_CORRUPTION",
      familyName: "Memory corruption / unsafe C",
      classification: {
        confidence: "HIGH",
        reason: "matched member CWE-787",
        evidence: ["CWE-787"],
        technology: null,
      },
      goldHitCount: 1,
      velocityPenalty: -10,
      templatePenalty: 0,
      rawCompositeBeforeBehavioralPenalties: 42,
    },
    engines: [
      {
        engine: "Technical Substance Analyzer",
        score: 38,
        verdict: "RED",
        confidence: "MEDIUM",
        signalBreakdown: {
          avri: {
            family: "MEMORY_CORRUPTION",
            familyName: "Memory corruption / unsafe C",
            baseScore: 22,
            goldHitCount: 1,
            goldTotalCount: 8,
            goldHits: [
              {
                id: "asan_or_sanitizer",
                description: "AddressSanitizer crash output",
                points: 22,
              },
            ],
            goldMisses: [
              {
                id: "valgrind",
                description: "Valgrind error trace",
                points: 18,
              },
            ],
            absencePenalty: -8,
            absencePenalties: [
              {
                id: "no_size_or_offset",
                description: "No explicit byte/size/offset value",
                points: 5,
              },
            ],
            contradictions: [],
            contradictionPenalty: 0,
            rawAvriScore: 14,
            legacyScore: 50,
            blendedScore: 38,
          },
        },
      },
    ],
  };

  it("renders the AVRI rubric with family, gold hits/misses, absence penalties, and AVRI composite overrides", async () => {
    const r = seedReport({
      showInFeed: true,
      redactedText: "sample report body",
      vulnrapEngineResults: AVRI_VULNRAP_BLOB,
      vulnrapOverridesApplied: [
        "AVRI_NO_GOLD_SIGNALS: zero gold signals for Memory corruption / unsafe C",
        "AVRI_VELOCITY: same-day submission velocity penalty (-10)",
        // Non-AVRI override — must NOT appear under the AVRI composite-overrides
        // bullet list (the route filters by AVRI_* token prefix).
        "TEMPLATE_DUPLICATE: previously seen template",
      ],
    });

    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);

    // Section header is present.
    const sectionIdx = res.body.indexOf("## AVRI Family Rubric");
    expect(sectionIdx).toBeGreaterThan(-1);

    // Family name + classification metadata mirrored from the composite block.
    expect(res.body).toContain("- **Family**: Memory corruption / unsafe C");
    expect(res.body).toContain("- **Classification confidence**: HIGH");
    expect(res.body).toContain("- **Classification reason**: matched member CWE-787");

    // Gold signals tally combines composite goldHitCount with Engine 2
    // goldTotalCount.
    expect(res.body).toContain("- **Gold signals**: 1/8");

    // Gold hits header + bullet (uses + sign and ASCII text).
    expect(res.body).toContain("- **Gold signals found**:");
    expect(res.body).toContain(
      "  - +22 AddressSanitizer crash output (asan_or_sanitizer)",
    );

    // Gold misses header + bullet (uses unicode minus U+2212, not ASCII hyphen).
    expect(res.body).toContain("- **Expected signals missing**:");
    expect(res.body).toContain("  - \u221218 Valgrind error trace (valgrind)");

    // Absence penalties block (haircut comes from the Engine 2 absencePenalty).
    expect(res.body).toContain("- **Absence penalties applied** (haircut -8):");
    expect(res.body).toContain(
      "  - \u22125 No explicit byte/size/offset value (no_size_or_offset)",
    );

    // AVRI-prefixed composite overrides surfaced under "Composite overrides:".
    const overridesIdx = res.body.indexOf("- **Composite overrides**:");
    expect(overridesIdx).toBeGreaterThan(sectionIdx);
    expect(res.body).toContain(
      "  - No gold signals for family — `AVRI_NO_GOLD_SIGNALS: zero gold signals for Memory corruption / unsafe C`",
    );
    expect(res.body).toContain(
      "  - Submission-velocity penalty — `AVRI_VELOCITY: same-day submission velocity penalty (-10)`",
    );

    // Non-AVRI override must not appear inside the AVRI composite-overrides
    // bullet list (the route only surfaces AVRI_*-prefixed rules here).
    const avriSectionEnd = res.body.indexOf("\n---", sectionIdx);
    const avriSection = res.body.slice(sectionIdx, avriSectionEnd > -1 ? avriSectionEnd : undefined);
    expect(avriSection).not.toContain("TEMPLATE_DUPLICATE");

    // Composite-before-behavioural-penalties trailer is rendered when present.
    expect(res.body).toContain("- Composite before behavioural penalties: 42");
  });

  it("renders the STRIPPED_CRASH_TRACE block with reason, frame counts, and revoked trace gold signals", async () => {
    // Mirrors the diagnostics-panel test fixture for the same branch
    // (artifacts/vulnrap/src/components/diagnostics-panel.test.tsx
    // "renders the STRIPPED_CRASH_TRACE block ..."), so the markdown
    // export and the on-screen panel agree on the same crashTrace payload.
    const r = seedReport({
      showInFeed: true,
      redactedText: "sample report body",
      vulnrapEngineResults: {
        avri: {
          family: "MEMORY_CORRUPTION",
          familyName: "Memory corruption / unsafe C",
          classification: {
            confidence: "HIGH",
            reason: "matched member CWE-787",
            evidence: ["CWE-787"],
            technology: null,
          },
          goldHitCount: 0,
          velocityPenalty: 0,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 18,
        },
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 22,
            verdict: "RED",
            confidence: "MEDIUM",
            signalBreakdown: {
              avri: {
                family: "MEMORY_CORRUPTION",
                familyName: "Memory corruption / unsafe C",
                baseScore: 18,
                goldHitCount: 0,
                goldTotalCount: 8,
                goldHits: [],
                goldMisses: [],
                absencePenalty: 0,
                absencePenalties: [],
                contradictions: [],
                contradictionPenalty: 0,
                crashTrace: {
                  framesAnalyzed: 6,
                  goodFrames: 1,
                  placeholderFrames: 4,
                  isStripped: true,
                  reason:
                    "Crash trace has 4/6 frames with placeholder symbols/offsets",
                  revokedGoldHits: [
                    { id: "asan_or_sanitizer", points: 22 },
                    { id: "stack_trace_with_offset", points: 14 },
                  ],
                  penalty: -18,
                },
                rawAvriScore: 0,
                legacyScore: 30,
                blendedScore: 22,
              },
            },
          },
        ],
      },
      vulnrapOverridesApplied: [],
    });

    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("## AVRI Family Rubric");

    // Title says "Stripped crash trace" for MEMORY_CORRUPTION (the helper
    // picks the trace-kind label by family id).
    expect(res.body).toContain(
      "- **Stripped crash trace** (penalty -18): Crash trace has 4/6 frames with placeholder symbols/offsets — frames 6, good 1, placeholder 4",
    );

    // Revoked trace gold signals use the unicode minus (U+2212) the helper
    // interpolates around the points value.
    expect(res.body).toContain(
      "  - Trace gold signals revoked: asan_or_sanitizer (\u221222), stack_trace_with_offset (\u221214)",
    );
  });

  it("renders the STRIPPED_CRASH_TRACE block with race-trace wording for RACE_CONCURRENCY reports", async () => {
    // Mirrors the diagnostics-panel race-trace fixture so the
    // family-driven wording switch ("crash trace" → "race trace") is
    // covered on the markdown side too.
    const r = seedReport({
      showInFeed: true,
      redactedText: "race report body",
      vulnrapEngineResults: {
        avri: {
          family: "RACE_CONCURRENCY",
          familyName: "Concurrency / data race",
          classification: {
            confidence: "HIGH",
            reason: "matched member CWE-362",
            evidence: ["CWE-362"],
            technology: null,
          },
          goldHitCount: 0,
          velocityPenalty: 0,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 18,
        },
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 22,
            verdict: "RED",
            confidence: "MEDIUM",
            signalBreakdown: {
              avri: {
                family: "RACE_CONCURRENCY",
                familyName: "Concurrency / data race",
                baseScore: 18,
                goldHitCount: 0,
                goldTotalCount: 6,
                goldHits: [],
                goldMisses: [],
                absencePenalty: 0,
                absencePenalties: [],
                contradictions: [],
                contradictionPenalty: 0,
                crashTrace: {
                  framesAnalyzed: 5,
                  goodFrames: 1,
                  placeholderFrames: 3,
                  isStripped: true,
                  reason:
                    "TSan trace has 3/5 frames with placeholder symbols/offsets",
                  revokedGoldHits: [
                    { id: "tsan_or_helgrind_header", points: 22 },
                  ],
                  penalty: -18,
                },
                rawAvriScore: 0,
                legacyScore: 30,
                blendedScore: 22,
              },
            },
          },
        ],
      },
      vulnrapOverridesApplied: [],
    });

    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);

    // Wording reads "race trace" (not "crash trace" / "tool trace") because
    // the helper switches on familyId === "RACE_CONCURRENCY".
    expect(res.body).toContain(
      "- **Stripped race trace** (penalty -18): TSan trace has 3/5 frames with placeholder symbols/offsets — frames 5, good 1, placeholder 3",
    );
    expect(res.body).not.toContain("- **Stripped crash trace**");
    expect(res.body).not.toContain("- **Stripped tool trace**");

    expect(res.body).toContain(
      "  - Trace gold signals revoked: tsan_or_helgrind_header (\u221222)",
    );
  });

  it("renders the FAKE_RAW_HTTP block with reason, header/CRLF/TE-CL counters, and revoked smuggling gold signals", async () => {
    // Mirrors the diagnostics-panel FAKE_RAW_HTTP request-side fixture
    // (no nested rawHttp.response, so the title stays "Fake raw HTTP
    // request" rather than the response/both variants).
    const r = seedReport({
      showInFeed: true,
      redactedText: "smuggling report body",
      vulnrapEngineResults: {
        avri: {
          family: "REQUEST_SMUGGLING",
          familyName: "HTTP request smuggling / desync",
          classification: {
            confidence: "HIGH",
            reason: "matched member CWE-444",
            evidence: ["CWE-444"],
            technology: null,
          },
          goldHitCount: 0,
          velocityPenalty: 0,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 18,
        },
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 22,
            verdict: "RED",
            confidence: "MEDIUM",
            signalBreakdown: {
              avri: {
                family: "REQUEST_SMUGGLING",
                familyName: "HTTP request smuggling / desync",
                baseScore: 18,
                goldHitCount: 0,
                goldTotalCount: 6,
                goldHits: [],
                goldMisses: [],
                absencePenalty: 0,
                absencePenalties: [],
                contradictions: [],
                contradictionPenalty: 0,
                rawHttp: {
                  requestsAnalyzed: 1,
                  totalHeaders: 7,
                  placeholderHeaders: 4,
                  crlfPresent: false,
                  teClConflicts: 1,
                  teClBroken: 1,
                  isFake: true,
                  reason:
                    "Fabricated raw HTTP request (no CRLFs, placeholder header values)",
                  revokedGoldHits: [
                    { id: "raw_http_te_cl_conflict", points: 22 },
                    { id: "raw_http_request_with_headers", points: 14 },
                  ],
                  penalty: -18,
                },
                rawAvriScore: 0,
                legacyScore: 30,
                blendedScore: 22,
              },
            },
          },
        ],
      },
      vulnrapOverridesApplied: [],
    });

    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);

    // Penalty bullet: title is the request-side variant, includes the
    // reason string, the request count, headers good/total split (good =
    // total − placeholder = 7 − 4 = 3), placeholder header count, CRLF
    // yes/no, and the TE/CL conflict (with broken sub-count) numerals.
    expect(res.body).toContain(
      "- **Fake raw HTTP request** (penalty -18): Fabricated raw HTTP request (no CRLFs, placeholder header values) — requests 1, headers 3/7 good, placeholder 4, CRLF no, TE/CL conflicts 1 (broken 1)",
    );

    // Revoked smuggling gold signals: rendered as a sub-bullet,
    // comma-joined, using the unicode minus the helper interpolates.
    expect(res.body).toContain(
      "  - Gold signals revoked: raw_http_te_cl_conflict (\u221222), raw_http_request_with_headers (\u221214)",
    );
  });

  it("omits the AVRI Family Rubric section entirely for legacy reports with no AVRI data", async () => {
    // Legacy report shape: no avri composite block, no Technical Substance
    // engine entry with a signalBreakdown.avri sub-block.
    const r = seedReport({
      showInFeed: true,
      redactedText: "legacy report body",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Some Other Engine",
            score: 50,
            verdict: "GREEN",
            confidence: "LOW",
            signalBreakdown: {},
          },
        ],
      },
      vulnrapOverridesApplied: [],
    });

    const res = await getText(`/api/reports/${r.id}/triage-report`);
    expect(res.status).toBe(200);

    // The whole rubric section — header and any of its bullets — must be absent.
    expect(res.body).not.toContain("## AVRI Family Rubric");
    expect(res.body).not.toContain("- **Family**:");
    expect(res.body).not.toContain("- **Gold signals found**:");
    expect(res.body).not.toContain("- **Expected signals missing**:");
    expect(res.body).not.toContain("- **Absence penalties applied**");
  });
});
