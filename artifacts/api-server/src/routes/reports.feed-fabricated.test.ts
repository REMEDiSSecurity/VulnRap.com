// Route tests for GET /api/reports/feed?fabricatedEvidence=... — uses the
// same in-memory fake-DB pattern as reports.diagnostics.test.ts, extended
// so the fabricated-evidence SQL predicates (drizzle `sql` template tags,
// not `eq`) are evaluated in JS against each row's vulnrapEngineResults.
// The fake matcher mirrors the route's Engine 2 (Technical Substance)
// scoping so a row whose AVRI block lives on a different engine does NOT
// match the filter.

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

// We tag the route's fabricated-evidence sql predicates with a sentinel
// string so applyCond can recognize and evaluate them. Other sql usages
// (orderBy, count(*)::int, coalesce(...)) are passed through transparently.
const FAKE_RAW_HTTP_TAG = "__fab_fakeRawHttp__";
const STRIPPED_TRACE_TAG = "__fab_strippedTrace__";
const EITHER_TAG = "__fab_either__";

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  type SqlFn = ((strings: TemplateStringsArray, ...args: unknown[]) => unknown) & {
    raw?: (s: string) => unknown;
  };
  const realSql = actual.sql as SqlFn;
  const wrappedSql: SqlFn = ((strings: TemplateStringsArray, ...args: unknown[]) => {
    const joined = strings.join("?");
    // Detect the route's two AVRI predicates and the OR ("either") wrapper.
    // The route builds "either" by interpolating the two predicates inside
    // an outer sql`(... OR ...)` so we identify it by checking that both
    // tags appear inside the args.
    if (joined.includes('signalBreakdown.avri.rawHttp.isFake')) {
      return { __fabKind: FAKE_RAW_HTTP_TAG };
    }
    if (joined.includes('signalBreakdown.avri.crashTrace.isStripped')) {
      return { __fabKind: STRIPPED_TRACE_TAG };
    }
    const innerKinds = args
      .map((a) => (a as { __fabKind?: string })?.__fabKind)
      .filter(Boolean) as string[];
    if (
      innerKinds.includes(FAKE_RAW_HTTP_TAG) &&
      innerKinds.includes(STRIPPED_TRACE_TAG)
    ) {
      return { __fabKind: EITHER_TAG };
    }
    return realSql(strings, ...args);
  }) as SqlFn;
  // Preserve the .raw/.placeholder helpers the route or drizzle internals
  // may reach for. We don't intercept those; they fall back to the real impl.
  for (const key of Object.keys(realSql)) {
    (wrappedSql as unknown as Record<string, unknown>)[key] = (
      realSql as unknown as Record<string, unknown>
    )[key];
  }
  return {
    ...actual,
    sql: wrappedSql,
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
    | { __fabKind: string }
    | null
    | undefined;

  function findColName(table: Record<string, unknown>, col: unknown): string {
    for (const k of Object.keys(table)) {
      if (table[k] === col) return k;
    }
    return "__unknown__";
  }

  // Mirrors the JS row mapper: only the engine whose name matches
  // /Technical Substance/i is considered when deriving the AVRI booleans.
  function rowMatchesFakeRawHttp(row: FakeRow): boolean {
    const engines = ((row.vulnrapEngineResults ?? {}) as {
      engines?: Array<{
        engine?: string;
        signalBreakdown?: { avri?: { rawHttp?: { isFake?: boolean } | null } };
      }>;
    }).engines ?? [];
    const e2 = engines.find((e) => /Technical Substance/i.test(e?.engine ?? ""));
    return e2?.signalBreakdown?.avri?.rawHttp?.isFake === true;
  }
  function rowMatchesStrippedTrace(row: FakeRow): boolean {
    const engines = ((row.vulnrapEngineResults ?? {}) as {
      engines?: Array<{
        engine?: string;
        signalBreakdown?: {
          avri?: { crashTrace?: { isStripped?: boolean } | null };
        };
      }>;
    }).engines ?? [];
    const e2 = engines.find((e) => /Technical Substance/i.test(e?.engine ?? ""));
    return e2?.signalBreakdown?.avri?.crashTrace?.isStripped === true;
  }

  function applyCond(
    rows: FakeRow[],
    cond: Cond,
    table: Record<string, unknown>,
  ): FakeRow[] {
    if (!cond || typeof cond !== "object") return rows;
    if ((cond as { __fabKind?: string }).__fabKind === FAKE_RAW_HTTP_TAG) {
      return rows.filter(rowMatchesFakeRawHttp);
    }
    if ((cond as { __fabKind?: string }).__fabKind === STRIPPED_TRACE_TAG) {
      return rows.filter(rowMatchesStrippedTrace);
    }
    if ((cond as { __fabKind?: string }).__fabKind === EITHER_TAG) {
      return rows.filter(
        (r) => rowMatchesFakeRawHttp(r) || rowMatchesStrippedTrace(r),
      );
    }
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

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  const id = dbState.nextReportId++;
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
