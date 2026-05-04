// Query-budget regression tests for the hottest stats read paths.
//
// Task #726 acceptance criterion: "a query-budget assertion in tests for
// the hottest query paths so a future N+1 regression fails CI."
//
// This file locks in per-endpoint db.select() ceilings for the two dashboard
// stats endpoints that appear on every homepage load. It uses the shared
// `withSelectCounter` harness from `__test-fixtures__/query-counter.ts` so
// the counter pattern is consistent with `reports.query-budget.test.ts`.
//
// Budgets:
//
//   GET /stats             — at most 5 selects on the full 200 path
//                          — exactly 1 select on the 304 short-circuit path
//   GET /stats/distribution — at most 2 selects on the full 200 path
//                           — exactly 1 select on the 304 short-circuit path
//
// The conditional-GET 304 tests are the most important: they verify that the
// MAX(created_at) freshness probe fires BEFORE the heavy aggregate selects,
// not after. A refactor that moves the `req.fresh` check below the heavy
// queries would still return 304 but would have already paid for all the
// aggregates — wasting server time on every warmed-up browser.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";
import {
  createSelectCounter,
  withSelectCounter,
  type SelectCounter,
} from "./__test-fixtures__/query-counter";

// ---------------------------------------------------------------------------
// Select counter — bridged via globalThis so the vi.mock factory (hoisted by
// vitest's transform) can access it once the module has been evaluated.
// ---------------------------------------------------------------------------

const selectCounter: SelectCounter = createSelectCounter();
(
  globalThis as unknown as { __statsbudgetCounter: SelectCounter }
).__statsbudgetCounter = selectCounter;

// FIFO of pre-built row arrays. Each call to db.select(...) pops the next
// entry so the handler's positional selects resolve to the data they expect.
const selectQueue: unknown[][] = [];

// ---------------------------------------------------------------------------
// A thenable chain that accepts every method drizzle's select chain exposes
// and resolves to the next row array from selectQueue when awaited.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock — wraps the raw select function with the shared counter harness so
// every db.select() call is tracked identically to reports.query-budget.ts.
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const counter = (
    globalThis as unknown as { __statsbudgetCounter: SelectCounter }
  ).__statsbudgetCounter;

  // Build a raw db object whose select() pulls from the shared FIFO queue.
  const rawDb: Record<string, unknown> = {
    select: () => {
      const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
      return makeSelectChain(rows);
    },
    execute: async () => ({ rows: [] }),
  };

  return {
    db: withSelectCounter(rawDb, counter),
    reportsTable: schema.reportsTable,
    userFeedbackTable: schema.userFeedbackTable,
    pool: { end: async () => undefined },
  };
});

// ---------------------------------------------------------------------------
// Server setup — mount only the stats router to keep the test scope narrow.
// ---------------------------------------------------------------------------

let server: http.Server;

beforeAll(async () => {
  process.env.VISITOR_HMAC_KEY = "stats-budget-test-hmac-key";
  const statsRouter = (await import("./stats")).default;
  const app = express();
  app.use(express.json());
  app.use(statsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.VISITOR_HMAC_KEY;
});

beforeEach(() => {
  selectQueue.length = 0;
  selectCounter.reset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const req = http.request(
      {
        method: "GET",
        hostname: "127.0.0.1",
        port: addr.port,
        path,
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
// Budget tests
// ---------------------------------------------------------------------------

describe("Task #726 — GET /stats query budget", () => {
  it("200 path issues at most 5 selects", async () => {
    // Handler select order:
    //   #1 freshnessProbe  — MAX(created_at) for Last-Modified header
    //   #2 totals          — count, avg slop, mode breakdown
    //   #3 duplicateCounts — similarity matches count
    //   #4 todayCounts     — reports since today 00:00
    //   #5 weekCounts      — reports since 7 days ago
    selectQueue.push([]); // freshness probe → no row → no Last-Modified set
    selectQueue.push([
      { totalReports: 0, avgSlopScore: 0, fullCount: 0, similarityOnlyCount: 0 },
    ]);
    selectQueue.push([{ duplicatesDetected: 0 }]);
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([{ count: 0 }]);

    const r = await get("/stats");
    expect(r.status).toBe(200);
    expect(selectCounter.count).toBeLessThanOrEqual(5);
  });

  it("304 conditional GET short-circuits after exactly 1 select", async () => {
    // The freshness probe (select #1) sets Last-Modified. If the client's
    // If-Modified-Since header is >= that value, req.fresh is true and the
    // handler returns 304 before firing any of the four aggregate selects.
    // This test locks in that ordering: probe first, heavy selects never.
    const lastMod = new Date("2026-04-30T12:00:00.000Z");
    selectQueue.push([{ lastModified: lastMod }]);
    // Fallback rows in case the 304 short-circuit ever regresses — we want
    // the assertion to catch the regression, not crash on empty queue.
    selectQueue.push([
      { totalReports: 0, avgSlopScore: 0, fullCount: 0, similarityOnlyCount: 0 },
    ]);
    selectQueue.push([{ duplicatesDetected: 0 }]);
    selectQueue.push([{ count: 0 }]);
    selectQueue.push([{ count: 0 }]);

    const ims = new Date(lastMod.getTime() + 1000).toUTCString();
    const r = await get("/stats", { "If-Modified-Since": ims });
    expect(r.status).toBe(304);
    expect(selectCounter.count).toBe(1);
  });
});

describe("Task #726 — GET /stats/distribution query budget", () => {
  it("200 path issues at most 2 selects", async () => {
    // Handler select order:
    //   #1 freshnessProbe    — MAX(created_at) for Last-Modified header
    //   #2 bucket aggregate  — total + 5 per-bucket counts in one query
    selectQueue.push([]); // freshness probe → no row
    selectQueue.push([{ total: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 }]);

    const r = await get("/stats/distribution");
    expect(r.status).toBe(200);
    expect(selectCounter.count).toBeLessThanOrEqual(2);
  });

  it("304 conditional GET short-circuits after exactly 1 select", async () => {
    // Same conditional-GET ordering guarantee as /stats: probe fires first,
    // heavy bucket aggregate must be skipped on a cache hit.
    const lastMod = new Date("2026-04-30T12:00:00.000Z");
    selectQueue.push([{ lastModified: lastMod }]);
    selectQueue.push([{ total: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0 }]);

    const ims = new Date(lastMod.getTime() + 1000).toUTCString();
    const r = await get("/stats/distribution", { "If-Modified-Since": ims });
    expect(r.status).toBe(304);
    expect(selectCounter.count).toBe(1);
  });
});
