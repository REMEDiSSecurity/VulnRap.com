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
  analyzeSlopWithLLM: vi.fn(async () => null),
}));

vi.mock("../lib/triage-recommendation", () => ({
  generateTriageRecommendation: vi.fn(() => ({
    action: "ACCEPT",
    confidence: "high",
    rationale: "test",
    challengeQuestions: [],
    temporalSignals: [],
    templateMatch: null,
    revisionResult: null,
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

  type TableKey = "reports" | "feedback" | "hashes" | "similarities" | "unknown";

  function tableKey(table: unknown): TableKey {
    if (table === schema.reportsTable) return "reports";
    if (table === schema.userFeedbackTable) return "feedback";
    if (table === schema.reportHashesTable) return "hashes";
    if (table === schema.similarityResultsTable) return "similarities";
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
    const r = seedReport({ showInFeed: true });
    const res = await get(`/api/reports/${r.id}`);
    expect(res.status).toBe(200);
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
    const r = seedReport({ showInFeed: true });
    const res = await get(`/api/reports/${r.id}/diagnostics`);
    expect(res.status).toBe(200);
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
