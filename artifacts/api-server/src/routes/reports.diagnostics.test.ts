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

interface FakeRow extends Record<string, unknown> {}

interface DbState {
  reports: FakeRow[];
  traces: FakeRow[];
  hashes: FakeRow[];
  similarities: FakeRow[];
  stats: Map<string, number>;
  nextReportId: number;
  nextTraceId: number;
  failTraceInsert: boolean;
  insertedTracePayloads: FakeRow[];
}

function freshState(): DbState {
  return {
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
}

const dbState: DbState = freshState();
(globalThis as unknown as { __fakeDbState: DbState }).__fakeDbState = dbState;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
    or: (...conds: unknown[]) => ({ __op: "or", conds }),
    and: (...conds: unknown[]) => ({ __op: "and", conds }),
    desc: (col: unknown) => ({ __op: "desc", col }),
  };
});

vi.mock("../lib/active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
}));

vi.mock("../lib/llm-slop", () => ({
  isLLMAvailable: () => false,
  shouldCallLLM: () => false,
  analyzeSlopWithLLM: vi.fn(async () => null),
}));

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const state = (globalThis as unknown as { __fakeDbState: DbState })
    .__fakeDbState;

  type Cond =
    | { __op: "eq"; col: unknown; val: unknown }
    | { __op: "or"; conds: Cond[] }
    | { __op: "and"; conds: Cond[] }
    | { __op: "desc"; col: unknown }
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
    if ((cond as { __op?: string }).__op === "eq") {
      const c = cond as { col: unknown; val: unknown };
      const colName = findColName(table, c.col);
      return rows.filter((r) => r[colName] === c.val);
    }
    if ((cond as { __op?: string }).__op === "or") {
      const c = cond as { conds: Cond[] };
      return rows.filter(
        (r) => c.conds.some((sub) => applyCond([r], sub, table).length > 0),
      );
    }
    if ((cond as { __op?: string }).__op === "and") {
      const c = cond as { conds: Cond[] };
      return c.conds.reduce<FakeRow[]>(
        (acc, sub) => applyCond(acc, sub, table),
        rows,
      );
    }
    return rows;
  }

  function tableKey(
    table: unknown,
  ): "reports" | "traces" | "hashes" | "similarities" | "stats" | "unknown" {
    if (table === schema.reportsTable) return "reports";
    if (table === schema.analysisTracesTable) return "traces";
    if (table === schema.reportHashesTable) return "hashes";
    if (table === schema.similarityResultsTable) return "similarities";
    if (table === schema.reportStatsTable) return "stats";
    return "unknown";
  }

  function getTableRows(table: unknown): FakeRow[] {
    const k = tableKey(table);
    if (k === "reports") return state.reports;
    if (k === "traces") return state.traces;
    if (k === "hashes") return state.hashes;
    if (k === "similarities") return state.similarities;
    if (k === "stats") {
      return Array.from(state.stats.entries()).map(([key, value]) => ({
        key,
        value,
      }));
    }
    return [];
  }

  function selectChain(): Record<string, unknown> {
    let cond: Cond = null;
    let limitN: number | null = null;
    let order: { col: string; dir: "asc" | "desc" } | null = null;
    let table: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      from(t: Record<string, unknown>) {
        table = t;
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
      orderBy(o: unknown) {
        if ((o as { __op?: string })?.__op === "desc") {
          order = {
            col: findColName(table!, (o as { col: unknown }).col),
            dir: "desc",
          };
        }
        return chain;
      },
      then(resolve: (rows: FakeRow[]) => void, reject: (err: unknown) => void) {
        try {
          let rows = getTableRows(table);
          rows = applyCond(rows, cond, table!);
          if (order) {
            const o = order;
            rows = [...rows].sort((a, b) => {
              const av = a[o.col] as number | string | Date;
              const bv = b[o.col] as number | string | Date;
              if (av < bv) return o.dir === "desc" ? 1 : -1;
              if (av > bv) return o.dir === "desc" ? -1 : 1;
              return 0;
            });
          }
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
        const row = {
          ...r,
          id: state.nextReportId++,
          createdAt: r.createdAt ?? new Date(),
        };
        state.reports.push(row);
        inserted.push(row);
      } else if (k === "traces") {
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

  function makeDb() {
    const db: Record<string, unknown> = {
      select(_proj?: unknown) {
        return {
          from(t: Record<string, unknown>) {
            const chain = selectChain();
            (chain.from as (t: unknown) => unknown)(t);
            return chain;
          },
        };
      },
      insert(table: unknown) {
        return {
          values(input: FakeRow | FakeRow[]) {
            const inputs = Array.isArray(input) ? input : [input];
            const op: Record<string, unknown> = {
              returning() {
                return {
                  then(
                    resolve: (rows: FakeRow[]) => void,
                    reject: (err: unknown) => void,
                  ) {
                    try {
                      resolve(doInsert(table, inputs));
                    } catch (e) {
                      reject(e);
                    }
                  },
                };
              },
              onConflictDoUpdate(_o: unknown) {
                return {
                  then(
                    resolve: (v: undefined) => void,
                    reject: (err: unknown) => void,
                  ) {
                    try {
                      // For stats tables we simulate "increment on conflict"
                      // already; just call doInsert which adds/increments.
                      doInsert(table, inputs);
                      resolve(undefined);
                    } catch (e) {
                      reject(e);
                    }
                  },
                };
              },
              then(
                resolve: (v: undefined) => void,
                reject: (err: unknown) => void,
              ) {
                try {
                  doInsert(table, inputs);
                  resolve(undefined);
                } catch (e) {
                  reject(e);
                }
              },
            };
            return op;
          },
        };
      },
    };

    function snapshot(): DbState {
      return {
        reports: state.reports.map((r) => ({ ...r })),
        traces: state.traces.map((r) => ({ ...r })),
        hashes: state.hashes.map((r) => ({ ...r })),
        similarities: state.similarities.map((r) => ({ ...r })),
        stats: new Map(state.stats),
        nextReportId: state.nextReportId,
        nextTraceId: state.nextTraceId,
        failTraceInsert: state.failTraceInsert,
        insertedTracePayloads: [...state.insertedTracePayloads],
      };
    }
    function restore(snap: DbState) {
      state.reports = snap.reports;
      state.traces = snap.traces;
      state.hashes = snap.hashes;
      state.similarities = snap.similarities;
      state.stats = snap.stats;
      state.nextReportId = snap.nextReportId;
      state.nextTraceId = snap.nextTraceId;
    }

    db.transaction = async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const snap = snapshot();
      try {
        return await fn(db);
      } catch (err) {
        restore(snap);
        throw err;
      }
    };

    return db;
  }

  return {
    ...schema,
    db: makeDb(),
    pool: { end: async () => undefined },
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
  Object.assign(dbState, freshState());
  delete process.env.VULNRAP_USE_NEW_COMPOSITE;
  delete process.env.VULNRAP_TRACE_BEST_EFFORT;
});

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  const id = dbState.nextReportId++;
  const row: FakeRow = {
    id,
    deleteToken: "tok",
    contentHash: "hash",
    simhash: "0",
    minhashSignature: [],
    lshBuckets: [],
    contentText: null,
    redactedText: null,
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
    showInFeed: false,
    fileName: null,
    fileSize: 0,
    createdAt: new Date(),
    ...overrides,
  };
  dbState.reports.push(row);
  return row;
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
