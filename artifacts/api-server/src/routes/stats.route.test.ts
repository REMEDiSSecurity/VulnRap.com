// Task #236 — route-level integration test for the visitor analytics
// endpoints (`GET /stats/visitors`, `POST /stats/visit`).
//
// These two handlers were the source of a regression where a missing
// `page_views` table in development bubbled raw Postgres "undefined_table"
// errors out as 500s, polluting the network panel and server logs on every
// homepage / /stats render. The handlers were patched to detect the
// SQLSTATE 42P01 path (both the raw pg error and the drizzle wrapper that
// hangs the original error off `.cause`) and degrade gracefully:
//
//   - GET  /stats/visitors → 200 with { totalUniqueVisitors: 0, totalVisits: 0 }
//   - POST /stats/visit    → 200 with { recorded: false }
//
// Other DB errors (anything that is NOT 42P01) must still surface as a 500
// so genuine breakage in production is not silently swallowed.
//
// Task #329 — extended to cover the four remaining handlers in this router
// (`GET /stats`, `GET /stats/recent`, `GET /stats/distribution`,
// `GET /stats/trends`) with happy-path response-shape, status, and
// `Cache-Control` assertions so a future refactor of the Drizzle select
// chains, the response zod schemas, or the cache headers can't silently
// break the homepage stats panel without anything failing in CI.
//
// This file mocks `@workspace/db` so we can control what `db.execute`
// returns/throws on a per-test basis without needing a real Postgres
// connection. The `reportsTable` / `userFeedbackTable` re-exports are
// re-exported from the actual schema so the stats router's other handlers
// (which we don't exercise here) still type-check / import successfully.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ExecuteFn = (...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Per-test handle: each test installs a fresh implementation before issuing
// requests. Default is "table absent" (42P01) so a test that forgets to
// configure the mock will still match the real-world dev behaviour.
const executeMock = vi.fn() as unknown as ExecuteFn & {
  mockImplementation: (fn: ExecuteFn) => void;
  mockReset: () => void;
};

// Per-test FIFO of pre-built row arrays for the db.select(...) chain. Each
// top-level `db.select(...)` call in the handler under test pops the next
// entry. Default is [] for any unconfigured call so handlers that don't
// touch select (the visitor analytics tests) keep passing.
const selectQueue: unknown[][] = [];

// A thenable chain that accepts every method drizzle's select-chain exposes
// (.from / .where / .orderBy / .limit / .groupBy) and resolves to a
// pre-seeded row array when awaited. This avoids modeling actual Drizzle
// semantics — the handlers don't introspect the chain, they just `await` it
// — while still being expressive enough to drive every /stats* handler in
// this router.
function makeSelectChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.where = passthrough;
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.groupBy = passthrough;
  chain.then = (
    resolve: (v: unknown[]) => void,
    reject: (e: unknown) => void,
  ): void => {
    try {
      resolve(rows);
    } catch (e) {
      reject(e);
    }
  };
  return chain;
}

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      execute: (...args: unknown[]) =>
        (executeMock as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
      // /stats, /stats/recent, /stats/distribution, /stats/trends all
      // build their result via `db.select(...).from(...).[where|orderBy|
      // limit|groupBy](...)`. Each top-level db.select(...) call pulls the
      // next pre-seeded row array off selectQueue (or [] when the queue is
      // empty), and the chain methods are no-ops that return the same
      // thenable so the handler can await it regardless of which methods
      // it chains.
      select: () => {
        const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
        return makeSelectChain(rows);
      },
    },
    reportsTable: schema.reportsTable,
    userFeedbackTable: schema.userFeedbackTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Pin a stable HMAC key so the visit handler's hash derivation is
  // deterministic and doesn't emit the "ephemeral key" warning during the
  // test run.
  process.env.VISITOR_HMAC_KEY = "stats-route-test-hmac-key";

  const statsRouter = (await import("./stats")).default;
  const app = express();
  app.use(express.json());
  app.use(statsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.VISITOR_HMAC_KEY;
});

beforeEach(() => {
  (executeMock as unknown as { mockReset: () => void }).mockReset();
  selectQueue.length = 0;
});

interface HttpResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        // pathname alone strips ?query=... (which the trends handler uses
        // to clamp `days`). Include search so query params reach the
        // route.
        path: `${url.pathname}${url.search}`,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": String(data.length) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            // 500 responses come back as Express's default HTML error page
            // (no JSON middleware kicks in), so be lenient: hand the raw
            // text back as the body when JSON parsing fails. Tests that
            // care about JSON shape only inspect 200 responses.
            let parsed: unknown;
            if (text.length === 0) {
              parsed = {};
            } else {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
            }
            resolve({
              status: res.statusCode ?? 0,
              body: parsed as T,
              headers: res.headers,
            });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Build a fake pg "undefined_table" error. The SQLSTATE 42P01 code is what
// the stats handlers key off of via isMissingPageViewsTable().
function makeUndefinedTableError(): Error {
  const err = new Error('relation "page_views" does not exist') as Error & { code?: string };
  err.code = "42P01";
  return err;
}

// drizzle-orm wraps driver errors in DrizzleQueryError and exposes the
// original pg error (with its SQLSTATE) on `.cause`. The stats handlers
// must detect either shape; this helper covers the wrapped case.
function makeWrappedUndefinedTableError(): Error {
  const wrapped = new Error("Failed query: insert into page_views ...") as Error & {
    cause?: unknown;
  };
  wrapped.cause = makeUndefinedTableError();
  return wrapped;
}

describe("GET /stats/visitors", () => {
  it("degrades to zero counts when page_views table is absent (42P01)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeUndefinedTableError();
      });

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("degrades to zero counts when 42P01 is wrapped in DrizzleQueryError.cause", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeWrappedUndefinedTableError();
      });

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("returns real counts when page_views exists with rows", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({
        rows: [{ total_unique_visitors: 42, total_visits: 7 }],
      }));

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 42, totalVisits: 7 });
  });

  it("returns zero counts when page_views exists but has no rows", async () => {
    // Postgres' count(distinct ...) returns 0/0 for an empty table, but
    // defensive coding in the handler also coerces a missing row to 0.
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({ rows: [] }));

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("surfaces non-undefined-table DB errors as 500 (no silent fallback)", async () => {
    // A genuine connection or permission error must NOT be coerced into a
    // {0,0} success — that would mask real breakage in production.
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        const err = new Error("connection refused") as Error & { code?: string };
        err.code = "08006"; // connection_failure, not 42P01
        throw err;
      });

    const r = await request<{ totalUniqueVisitors?: number }>("GET", "/stats/visitors");
    expect(r.status).toBe(500);
  });
});

describe("POST /stats/visit", () => {
  it("returns { recorded: false } when page_views table is absent (42P01)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeUndefinedTableError();
      });

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: false });
  });

  it("returns { recorded: false } when 42P01 is wrapped in DrizzleQueryError.cause", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeWrappedUndefinedTableError();
      });

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: false });
  });

  it("returns { recorded: true } on a successful insert", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({ rows: [] }));

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: true });
  });

  it("surfaces non-undefined-table DB errors as 500 (no silent fallback)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        const err = new Error("unique violation") as Error & { code?: string };
        err.code = "23505"; // unique_violation, not 42P01
        throw err;
      });

    const r = await request<{ recorded?: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Task #329 — happy-path coverage for the four remaining stats handlers.
//
// These tests don't try to exercise every error path; they pin down the
// response shape, status code, and Cache-Control header so a future
// refactor of the Drizzle select chains, the response zod schemas, or the
// cache-header strings is forced to acknowledge this contract instead of
// silently breaking the homepage stats panel.
// ---------------------------------------------------------------------------

const HOMEPAGE_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=120";
const TRENDS_CACHE_CONTROL = "public, max-age=120, stale-while-revalidate=300";

describe("GET /stats", () => {
  it("returns aggregate stats with the expected shape and homepage cache header", async () => {
    // Handler issues 4 db.select(...) calls in this exact order:
    //   1) totals          — count(*), avg slop, full / similarity_only
    //   2) duplicateCounts — count(*) where similarityMatches is non-empty
    //   3) todayCounts     — count(*) since today 00:00
    //   4) weekCounts      — count(*) since 7 days ago
    selectQueue.push([
      {
        totalReports: 12,
        avgSlopScore: 47.36,
        fullCount: 9,
        similarityOnlyCount: 3,
      },
    ]);
    selectQueue.push([{ duplicatesDetected: 4 }]);
    selectQueue.push([{ count: 2 }]);
    selectQueue.push([{ count: 6 }]);

    const r = await request<{
      totalReports: number;
      duplicatesDetected: number;
      avgSlopScore: number;
      reportsByMode: { full: number; similarity_only: number };
      reportsToday: number;
      reportsThisWeek: number;
    }>("GET", "/stats");

    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe(HOMEPAGE_CACHE_CONTROL);
    expect(r.body).toEqual({
      totalReports: 12,
      duplicatesDetected: 4,
      // Handler rounds to 1 decimal: 47.36 → 47.4.
      avgSlopScore: 47.4,
      reportsByMode: { full: 9, similarity_only: 3 },
      reportsToday: 2,
      reportsThisWeek: 6,
    });
  });
});

describe("GET /stats/recent", () => {
  it("maps recent reports to the public summary shape", async () => {
    const created = new Date("2026-04-15T10:30:00.000Z");
    selectQueue.push([
      {
        id: 101,
        slopScore: 88,
        slopTier: "Slop",
        // Handler reports `matchCount`, derived from array length.
        similarityMatches: [
          { reportId: 7, similarity: 0.9, matchType: "near" },
          { reportId: 8, similarity: 0.8, matchType: "near" },
        ],
        createdAt: created,
      },
      {
        id: 102,
        slopScore: 12,
        slopTier: "Clean",
        similarityMatches: [],
        createdAt: created,
      },
    ]);

    const r = await request<{
      recentReports: Array<{
        id: number;
        slopScore: number;
        slopTier: string;
        matchCount: number;
        createdAt: string;
      }>;
    }>("GET", "/stats/recent");

    expect(r.status).toBe(200);
    expect(r.body.recentReports).toHaveLength(2);
    expect(r.body.recentReports[0]).toEqual({
      id: 101,
      slopScore: 88,
      slopTier: "Slop",
      matchCount: 2,
      createdAt: created.toISOString(),
    });
    expect(r.body.recentReports[1]).toMatchObject({
      id: 102,
      matchCount: 0,
      slopTier: "Clean",
    });
  });
});

describe("GET /stats/distribution", () => {
  it("returns 5 score buckets, the total, and the homepage cache header", async () => {
    // Handler issues a single db.select(...) call returning one row with the
    // total + 5 bucket counts (b0..b4) corresponding to the bucket defs in
    // the handler.
    selectQueue.push([
      { total: 50, b0: 10, b1: 8, b2: 12, b3: 14, b4: 6 },
    ]);

    const r = await request<{
      buckets: Array<{ label: string; min: number; max: number; count: number }>;
      totalReports: number;
    }>("GET", "/stats/distribution");

    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe(HOMEPAGE_CACHE_CONTROL);
    expect(r.body.totalReports).toBe(50);
    expect(r.body.buckets).toEqual([
      { label: "Clean", min: 0, max: 20, count: 10 },
      { label: "Likely Human", min: 21, max: 35, count: 8 },
      { label: "Questionable", min: 36, max: 55, count: 12 },
      { label: "Likely Slop", min: 56, max: 75, count: 14 },
      { label: "Slop", min: 76, max: 100, count: 6 },
    ]);
  });
});

describe("GET /stats/trends", () => {
  it("returns daily report + feedback trends with the trends cache header", async () => {
    // Handler issues 3 db.select(...) calls in this exact order:
    //   1) dailyReports  — per-day counts + tier breakdown for reports
    //   2) dailyFeedback — per-day count + avg + helpful counts for feedback
    //   3) totals        — totalReports + totalFeedback
    selectQueue.push([
      {
        date: "2026-04-28",
        count: 4,
        avgScore: 52.5,
        clean: 1,
        likelyHuman: 1,
        questionable: 1,
        likelySlop: 1,
        slop: 0,
      },
      {
        date: "2026-04-29",
        count: 2,
        avgScore: 80.0,
        clean: 0,
        likelyHuman: 0,
        questionable: 0,
        likelySlop: 1,
        slop: 1,
      },
    ]);
    selectQueue.push([
      {
        date: "2026-04-29",
        count: 4,
        avgRating: 4.5,
        helpfulCount: 3,
        totalCount: 4,
      },
    ]);
    selectQueue.push([{ totalReports: 6, totalFeedback: 4 }]);

    const r = await request<{
      days: number;
      totalReports: number;
      totalFeedback: number;
      dailyReports: Array<{
        date: string;
        count: number;
        avgScore: number;
        tiers: {
          clean: number;
          likelyHuman: number;
          questionable: number;
          likelySlop: number;
          slop: number;
        };
      }>;
      feedbackTrend: Array<{
        date: string;
        count: number;
        avgRating: number;
        agreementRate: number;
      }>;
    }>("GET", "/stats/trends?days=30");

    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe(TRENDS_CACHE_CONTROL);
    // Handler clamps days into [7, 365]; 30 passes through unchanged.
    expect(r.body.days).toBe(30);
    expect(r.body.totalReports).toBe(6);
    expect(r.body.totalFeedback).toBe(4);
    expect(r.body.dailyReports).toEqual([
      {
        date: "2026-04-28",
        count: 4,
        avgScore: 52.5,
        tiers: {
          clean: 1,
          likelyHuman: 1,
          questionable: 1,
          likelySlop: 1,
          slop: 0,
        },
      },
      {
        date: "2026-04-29",
        count: 2,
        avgScore: 80.0,
        tiers: {
          clean: 0,
          likelyHuman: 0,
          questionable: 0,
          likelySlop: 1,
          slop: 1,
        },
      },
    ]);
    // 3 helpful out of 4 → 75% rounded.
    expect(r.body.feedbackTrend).toEqual([
      { date: "2026-04-29", count: 4, avgRating: 4.5, agreementRate: 75 },
    ]);
  });

  it("clamps the days query param into [7, 365]", async () => {
    // Empty rows for all 3 select calls are fine — we only care about the
    // clamped echo in the response body.
    selectQueue.push([]);
    selectQueue.push([]);
    selectQueue.push([{ totalReports: 0, totalFeedback: 0 }]);

    const r = await request<{ days: number }>("GET", "/stats/trends?days=999");
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(365);
  });
});
