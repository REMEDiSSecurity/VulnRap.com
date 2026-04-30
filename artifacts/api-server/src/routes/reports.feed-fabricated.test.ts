// Route tests for GET /api/reports/feed?fabricatedEvidence=... — uses the
// same in-memory fake-DB pattern as reports.diagnostics.test.ts. The seed
// helper derives the cached `fakeRawHttp` / `strippedCrashTrace` columns
// from each row's `vulnrapEngineResults` so the in-memory rows mirror what
// the real insert path writes.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface FakeRow extends Record<string, unknown> {}

interface DbState {
  reports: FakeRow[];
  nextReportId: number;
}

function freshState(): DbState {
  return { reports: [], nextReportId: 1 };
}

const dbState: DbState = freshState();
(globalThis as unknown as { __fakeDbStateFeedFab: DbState }).__fakeDbStateFeedFab =
  dbState;

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

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const state = (
    globalThis as unknown as { __fakeDbStateFeedFab: DbState }
  ).__fakeDbStateFeedFab;

  type Cond =
    | { __op: "eq"; col: unknown; val: unknown }
    | { __op: "or"; conds: Cond[] }
    | { __op: "and"; conds: Cond[] }
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

  function selectChain(projection: Record<string, unknown> | undefined) {
    let cond: Cond = null;
    let limitN: number | null = null;
    let offsetN = 0;
    let groupKeyName: string | null = null;
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
      offset(n: number) {
        offsetN = n;
        return chain;
      },
      orderBy(_o: unknown) {
        // No ordering needed for these focused tests; rows are returned in
        // insertion order which is fine for assertions on set membership.
        return chain;
      },
      groupBy(g: unknown) {
        // The route groups by either reportsTable.slopTier (a column ref)
        // or by sql`coalesce(${avriFamily}, 'FLAT')` (anything truthy that
        // isn't a column). Detect the family case so we can fold rows on
        // the avriFamily column with the same FLAT fallback.
        if (table) {
          const colName = findColName(table, g);
          if (colName !== "__unknown__") {
            groupKeyName = colName;
            return chain;
          }
        }
        groupKeyName = "__avriFamilyCoalesced__";
        return chain;
      },
      then(
        resolve: (rows: unknown) => unknown,
        reject?: (err: unknown) => unknown,
      ) {
        try {
          let rows = state.reports.slice();
          rows = applyCond(rows, cond, table!);
          if (limitN != null) rows = rows.slice(offsetN, offsetN + limitN);
          // Project / aggregate based on requested shape.
          const proj = projection ?? {};
          const projKeys = Object.keys(proj);
          const wantsCount =
            projKeys.includes("count") || projKeys.includes("totalPublic");
          if (groupKeyName) {
            // Group + count.
            const groups = new Map<string | null, number>();
            for (const r of rows) {
              let k: string | null;
              if (groupKeyName === "__avriFamilyCoalesced__") {
                k = (r.avriFamily as string | null) ?? "FLAT";
              } else {
                k = (r[groupKeyName] as string | null) ?? null;
              }
              groups.set(k, (groups.get(k) ?? 0) + 1);
            }
            const out: Record<string, unknown>[] = [];
            for (const [k, n] of groups) {
              const row: Record<string, unknown> = { count: n };
              if (projKeys.includes("tier")) row.tier = k;
              if (projKeys.includes("family")) row.family = k;
              out.push(row);
            }
            resolve(out);
            return;
          }
          if (wantsCount && limitN == null) {
            // Aggregate row (count / avg) — return a single result.
            const totalPublic = rows.length;
            const avgScore =
              rows.length === 0
                ? 0
                : rows.reduce(
                    (s, r) => s + ((r.slopScore as number | null) ?? 0),
                    0,
                  ) / rows.length;
            const out: Record<string, unknown> = {};
            if (projKeys.includes("count")) out.count = totalPublic;
            if (projKeys.includes("totalPublic"))
              out.totalPublic = totalPublic;
            if (projKeys.includes("avgScore")) out.avgScore = avgScore;
            resolve([out]);
            return;
          }
          // Plain projection: return the requested columns.
          if (projKeys.length === 0) {
            resolve(rows);
            return;
          }
          const out = rows.map((r) => {
            const o: Record<string, unknown> = {};
            for (const k of projKeys) {
              const colRef = proj[k];
              const colName = findColName(table!, colRef);
              o[k] = colName === "__unknown__" ? null : r[colName];
            }
            return o;
          });
          resolve(out);
        } catch (err) {
          reject?.(err);
        }
      },
    };
    return chain;
  }

  function makeDb() {
    return {
      select(projection?: Record<string, unknown>) {
        return {
          from(t: Record<string, unknown>) {
            const chain = selectChain(projection);
            (chain.from as (t: unknown) => unknown)(t);
            return chain;
          },
        };
      },
    };
  }

  return {
    ...schema,
    db: makeDb(),
    pool: { end: async () => undefined },
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
  Object.assign(dbState, freshState());
});

function makeEngine2(opts: { fake?: boolean; stripped?: boolean }) {
  return {
    engines: [
      {
        engine: "Technical Substance Analyzer",
        signalBreakdown: {
          avri: {
            rawHttp: { isFake: opts.fake === true },
            crashTrace: { isStripped: opts.stripped === true },
          },
        },
      },
    ],
  };
}

// Mirrors deriveFabricatedEvidenceFlags + the route's insert-time
// population so seeded rows behave like real inserts: only the engine
// whose name matches /Technical Substance/i is considered. Callers can
// still override `fakeRawHttp` / `strippedCrashTrace` explicitly to
// simulate legacy rows that the backfill hasn't touched yet.
function deriveSeedFlags(blob: unknown): {
  fakeRawHttp: boolean;
  strippedCrashTrace: boolean;
} {
  const engines = ((blob ?? {}) as {
    engines?: Array<{
      engine?: string;
      signalBreakdown?: {
        avri?: {
          rawHttp?: { isFake?: boolean } | null;
          crashTrace?: { isStripped?: boolean } | null;
        };
      };
    }>;
  }).engines ?? [];
  const e2 = engines.find((e) => /Technical Substance/i.test(e?.engine ?? ""))
    ?.signalBreakdown?.avri;
  return {
    fakeRawHttp: e2?.rawHttp?.isFake === true,
    strippedCrashTrace: e2?.crashTrace?.isStripped === true,
  };
}

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  const id = dbState.nextReportId++;
  const derived = deriveSeedFlags(overrides.vulnrapEngineResults);
  const row: FakeRow = {
    id,
    deleteToken: "tok",
    contentHash: `hash-${id}`,
    simhash: "0",
    minhashSignature: [],
    lshBuckets: [],
    contentText: null,
    redactedText: null,
    contentMode: "similarity_only",
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
    showInFeed: true,
    fileName: null,
    fileSize: 0,
    avriFamily: "FLAT",
    fakeRawHttp: derived.fakeRawHttp,
    strippedCrashTrace: derived.strippedCrashTrace,
    createdAt: new Date(),
    ...overrides,
  };
  dbState.reports.push(row);
  return row;
}

describe("GET /api/reports/feed — fabricated-evidence filter", () => {
  it("default (no filter): returns all visible reports and summary describes the full corpus", async () => {
    seedReport({ avriFamily: "FLAT", slopTier: "Questionable" });
    seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      slopTier: "Likely Genuine",
      vulnrapEngineResults: makeEngine2({ fake: true }),
    });
    seedReport({
      avriFamily: "INJECTION",
      slopTier: "Likely Genuine",
      vulnrapEngineResults: makeEngine2({ stripped: true }),
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.total).toBe(3);
    expect(body.reports).toHaveLength(3);
    expect(body.summary.totalPublic).toBe(3);
    expect(body.summary.familyCounts).toEqual({
      FLAT: 1,
      MEMORY_CORRUPTION: 1,
      INJECTION: 1,
    });
  });

  it("fabricatedEvidence=fake_raw_http: returns only rows whose Engine 2 reports rawHttp.isFake=true and narrows the summary", async () => {
    seedReport({ avriFamily: "FLAT" });
    const fakeRow = seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
    });
    seedReport({
      avriFamily: "INJECTION",
      vulnrapEngineResults: makeEngine2({ stripped: true }),
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=fake_raw_http`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.total).toBe(1);
    expect(body.reports.map((r: { id: number }) => r.id)).toEqual([fakeRow.id]);
    expect(body.reports[0].fakeRawHttp).toBe(true);
    expect(body.reports[0].strippedCrashTrace).toBe(false);
    // Summary block must reflect the filtered subset, not the full corpus.
    expect(body.summary.totalPublic).toBe(1);
    expect(body.summary.familyCounts).toEqual({ MEMORY_CORRUPTION: 1 });
  });

  it("fabricatedEvidence=stripped_trace: returns only rows whose Engine 2 reports crashTrace.isStripped=true and narrows the summary", async () => {
    seedReport({ avriFamily: "FLAT" });
    seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
    });
    const strippedRow = seedReport({
      avriFamily: "INJECTION",
      vulnrapEngineResults: makeEngine2({ stripped: true }),
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=stripped_trace`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.total).toBe(1);
    expect(body.reports.map((r: { id: number }) => r.id)).toEqual([
      strippedRow.id,
    ]);
    expect(body.reports[0].strippedCrashTrace).toBe(true);
    expect(body.reports[0].fakeRawHttp).toBe(false);
    expect(body.summary.totalPublic).toBe(1);
    expect(body.summary.familyCounts).toEqual({ INJECTION: 1 });
  });

  it("fabricatedEvidence=either: returns rows with either flag and summary counts both families", async () => {
    seedReport({ avriFamily: "FLAT" });
    const fakeRow = seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
    });
    const strippedRow = seedReport({
      avriFamily: "INJECTION",
      vulnrapEngineResults: makeEngine2({ stripped: true }),
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=either`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.total).toBe(2);
    const ids = body.reports.map((r: { id: number }) => r.id).sort();
    expect(ids).toEqual([fakeRow.id, strippedRow.id].sort());
    expect(body.summary.totalPublic).toBe(2);
    expect(body.summary.familyCounts).toEqual({
      MEMORY_CORRUPTION: 1,
      INJECTION: 1,
    });
  });

  it("ignores AVRI flags carried by engines other than Engine 2 — listing and chips stay consistent", async () => {
    // Same flag set, but on a different engine name. The mapper would derive
    // fakeRawHttp=false for this row (it only walks Technical Substance), so
    // the SQL filter must agree to avoid showing rows whose chips read false.
    seedReport({
      avriFamily: "FLAT",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Some Other Analyzer",
            signalBreakdown: {
              avri: {
                rawHttp: { isFake: true },
                crashTrace: { isStripped: true },
              },
            },
          },
        ],
      },
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=either`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(0);
    expect(body.reports).toHaveLength(0);
    expect(body.summary.totalPublic).toBe(0);
    expect(body.summary.familyCounts).toEqual({});
  });

  it("SQL filter reads the cached column (unbackfilled row with blob fake=true but cached column false is NOT matched)", async () => {
    // Simulates an unbackfilled legacy row: the JSONB blob carries
    // isFake=true but the cached column is still false. The route filters
    // on the cached column, so the row must be excluded.
    seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
      fakeRawHttp: false,
      strippedCrashTrace: false,
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=fake_raw_http`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(0);
    expect(body.reports).toHaveLength(0);
  });

  it("backfilled cached column makes the row match (same blob, cached column flipped to true)", async () => {
    seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
      fakeRawHttp: true,
      strippedCrashTrace: false,
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=fake_raw_http`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(1);
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].fakeRawHttp).toBe(true);
  });

  it("chips fall back to the JSONB blob when the cached column hasn't been backfilled yet", async () => {
    // No filter applied, so the SQL gate is just `show_in_feed = true`.
    // The row mapper should still surface fakeRawHttp=true on the chip
    // by deriving it from the blob, keeping per-row chips correct during
    // the deploy-vs-backfill window.
    seedReport({
      avriFamily: "FLAT",
      vulnrapEngineResults: makeEngine2({ fake: true, stripped: true }),
      fakeRawHttp: false,
      strippedCrashTrace: false,
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(1);
    expect(body.reports[0].fakeRawHttp).toBe(true);
    expect(body.reports[0].strippedCrashTrace).toBe(true);
  });

  it("unknown fabricatedEvidence value falls through to no-op (mirrors avriFamily handling)", async () => {
    seedReport({ avriFamily: "FLAT" });
    seedReport({
      avriFamily: "MEMORY_CORRUPTION",
      vulnrapEngineResults: makeEngine2({ fake: true }),
    });

    const res = await fetch(
      `${baseUrl}/api/reports/feed?fabricatedEvidence=garbage`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.total).toBe(2);
    expect(body.summary.totalPublic).toBe(2);
  });
});

// Task #423 — Verify the route surfaces the soft-citation inferred CWE
// on each feed row when it's present in vulnrap_engine_results, sourced
// from signalBreakdown.avri.softCitation (preferred) or
// signalBreakdown.softCitation (legacy). The badge on the reports feed
// reads these fields so reviewers can scan / batch by inferred CWE
// without opening each report.

function makeEngine3Avri(opts: { name: string; cwe: string }) {
  return {
    engines: [
      {
        engine: "CWE Coherence Checker",
        signalBreakdown: {
          avri: {
            family: "WEB_CLIENT",
            softCitation: { name: opts.name, inferredCwe: opts.cwe },
          },
        },
      },
    ],
  };
}

function makeEngine3Legacy(opts: { name: string; cwe: string }) {
  return {
    engines: [
      {
        engine: "CWE Coherence Checker",
        signalBreakdown: {
          softCitation: { name: opts.name, inferredCwe: opts.cwe },
        },
      },
    ],
  };
}

describe("GET /api/reports/feed — Task #423 inferredCwe row field", () => {
  it("emits inferredCwe + inferredCweName when AVRI soft citation is present", async () => {
    const row = seedReport({
      avriFamily: "WEB_CLIENT",
      vulnrapEngineResults: makeEngine3Avri({ name: "XSS", cwe: "CWE-79" }),
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const out = body.reports.find((r: { id: number }) => r.id === row.id);
    expect(out).toBeDefined();
    expect(out.inferredCwe).toBe("CWE-79");
    expect(out.inferredCweName).toBe("XSS");
  });

  it("falls back to legacy signalBreakdown.softCitation for rows analysed before AVRI rolled out", async () => {
    const row = seedReport({
      avriFamily: "FLAT",
      vulnrapEngineResults: makeEngine3Legacy({
        name: "Open Redirect",
        cwe: "CWE-601",
      }),
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const out = body.reports.find((r: { id: number }) => r.id === row.id);
    expect(out).toBeDefined();
    expect(out.inferredCwe).toBe("CWE-601");
    expect(out.inferredCweName).toBe("Open Redirect");
  });

  it("emits null inferredCwe when no soft citation fired (e.g. explicit CWE was claimed)", async () => {
    const row = seedReport({
      avriFamily: "INJECTION",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "CWE Coherence Checker",
            signalBreakdown: {
              avri: { family: "INJECTION", softCitation: null },
            },
          },
        ],
      },
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const out = body.reports.find((r: { id: number }) => r.id === row.id);
    expect(out).toBeDefined();
    expect(out.inferredCwe).toBeNull();
    expect(out.inferredCweName).toBeNull();
  });

  it("emits null inferredCwe for rows with no engine results (legacy / failed pipelines)", async () => {
    const row = seedReport({
      avriFamily: "FLAT",
      vulnrapEngineResults: null,
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const out = body.reports.find((r: { id: number }) => r.id === row.id);
    expect(out).toBeDefined();
    expect(out.inferredCwe).toBeNull();
    expect(out.inferredCweName).toBeNull();
  });

  it("does not interfere with existing fabricated-evidence filters (a row can carry both inferredCwe and the fabricated chips)", async () => {
    // A real-world combo: AVRI Engine 2 flagged the report's raw HTTP as
    // fake AND Engine 3 inferred a CWE from the report's text. Both
    // signals should surface on the same row independently.
    const row = seedReport({
      avriFamily: "REQUEST_SMUGGLING",
      vulnrapEngineResults: {
        engines: [
          {
            engine: "Technical Substance Analyzer",
            signalBreakdown: {
              avri: {
                rawHttp: { isFake: true },
                crashTrace: { isStripped: false },
              },
            },
          },
          {
            engine: "CWE Coherence Checker",
            signalBreakdown: {
              avri: {
                family: "REQUEST_SMUGGLING",
                softCitation: {
                  name: "Request Smuggling",
                  inferredCwe: "CWE-444",
                },
              },
            },
          },
        ],
      },
    });

    const res = await fetch(`${baseUrl}/api/reports/feed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const out = body.reports.find((r: { id: number }) => r.id === row.id);
    expect(out).toBeDefined();
    expect(out.fakeRawHttp).toBe(true);
    expect(out.inferredCwe).toBe("CWE-444");
    expect(out.inferredCweName).toBe("Request Smuggling");
  });
});
