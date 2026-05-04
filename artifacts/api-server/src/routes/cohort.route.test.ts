// Task #615 — unit tests for the cohort baseline helpers and the
// /cohort/baseline route handler.
//
// The pure helpers (`buildEmptyBins`, `bucketIndexForScore`,
// `percentileRankFromBins`, `medianFromBins`) are exercised directly
// without any HTTP / DB mocking. The route itself is exercised through a
// minimal Express harness with `@workspace/db` mocked the same way the
// existing stats route tests do — a per-test FIFO of pre-built rows that
// the drizzle select chain pops on `await`.
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

import {
  buildEmptyBins,
  bucketIndexForScore,
  percentileRankFromBins,
  medianFromBins,
  exactPercentileFromCounts,
  parseScoreParam,
  type CohortBin,
} from "./cohort";
import type { AddressInfo } from "node:net";

describe("cohort helpers — pure math", () => {
  it("buildEmptyBins partitions 0..100 into 10 equal buckets with the last inclusive of 100", () => {
    const bins = buildEmptyBins();
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ min: 0, max: 10, count: 0 });
    expect(bins[9]).toEqual({ min: 90, max: 100, count: 0 });
    // No gaps and no overlaps between adjacent buckets.
    for (let i = 1; i < bins.length; i++) {
      expect(bins[i].min).toBe(bins[i - 1].max);
    }
  });

  it("bucketIndexForScore clamps below 0 and at/above 100 into the edge buckets", () => {
    expect(bucketIndexForScore(-5)).toBe(0);
    expect(bucketIndexForScore(0)).toBe(0);
    expect(bucketIndexForScore(9)).toBe(0);
    expect(bucketIndexForScore(10)).toBe(1);
    expect(bucketIndexForScore(55)).toBe(5);
    expect(bucketIndexForScore(99)).toBe(9);
    expect(bucketIndexForScore(100)).toBe(9);
    expect(bucketIndexForScore(123)).toBe(9);
  });

  it("percentileRankFromBins returns 0 for an empty cohort", () => {
    const bins = buildEmptyBins();
    expect(percentileRankFromBins(50, bins)).toBe(0);
  });

  it("percentileRankFromBins uses mid-rank: tied scores in a single bucket sit at 50%", () => {
    const bins = buildEmptyBins();
    bins[5].count = 4; // four reports all in [50, 60)
    // Score 55 falls in bucket 5; below=0, same=4, total=4 → (0 + 2)/4 = 50%.
    expect(percentileRankFromBins(55, bins)).toBe(50);
  });

  it("percentileRankFromBins puts a top-bucket report above the bulk of the cohort", () => {
    const bins = buildEmptyBins();
    // 78% of reports score below 60, the queried score sits in [60,70).
    bins[0].count = 30;
    bins[1].count = 24;
    bins[2].count = 24;
    bins[6].count = 22; // queried score lives here
    // total=100, below=78, same=22 → (78 + 11)/100 = 89%.
    expect(percentileRankFromBins(65, bins)).toBe(89);
  });

  it("percentileRankFromBins clamps to the 0..100 range", () => {
    const bins = buildEmptyBins();
    bins[0].count = 5;
    expect(percentileRankFromBins(-50, bins)).toBeGreaterThanOrEqual(0);
    expect(percentileRankFromBins(500, bins)).toBeLessThanOrEqual(100);
  });

  it("medianFromBins returns null for an empty cohort and a midpoint otherwise", () => {
    expect(medianFromBins(buildEmptyBins())).toBeNull();
    const bins = buildEmptyBins();
    bins[2].count = 1;
    bins[3].count = 1;
    bins[4].count = 1; // 3 samples; median sits in bucket index 3 = midpoint 35
    expect(medianFromBins(bins)).toBe(35);
  });

  it("medianFromBins handles a single-bucket cohort", () => {
    const bins: CohortBin[] = buildEmptyBins();
    bins[7].count = 12;
    expect(medianFromBins(bins)).toBe(75);
  });

  it("exactPercentileFromCounts uses mid-rank and rounds to one decimal", () => {
    expect(exactPercentileFromCounts(0, 0, 0)).toBe(0);
    // 78 strictly below, 22 tied → (78 + 11)/100 = 89%.
    expect(exactPercentileFromCounts(78, 22, 100)).toBe(89);
    // 61 vs 69 in a fixture cohort: with the histogram both round to the
    // same bucket, but with raw counts they get distinct percentiles.
    expect(exactPercentileFromCounts(60, 1, 100)).toBe(60.5);
    expect(exactPercentileFromCounts(68, 1, 100)).toBe(68.5);
  });

  it("exactPercentileFromCounts clamps to 0..100", () => {
    expect(exactPercentileFromCounts(-5, 0, 10)).toBeGreaterThanOrEqual(0);
    expect(exactPercentileFromCounts(20, 0, 10)).toBeLessThanOrEqual(100);
  });

  it("parseScoreParam parses, clamps, and rejects garbage", () => {
    expect(parseScoreParam(undefined)).toBeNull();
    expect(parseScoreParam("")).toBeNull();
    expect(parseScoreParam("nope")).toBeNull();
    expect(parseScoreParam("62")).toBe(62);
    expect(parseScoreParam("123")).toBe(100);
    expect(parseScoreParam("-9")).toBe(0);
    expect(parseScoreParam(["55", "12"])).toBe(55);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Route-level tests (Express harness + mocked @workspace/db).
// ──────────────────────────────────────────────────────────────────────

type SelectResult = Array<{ bucket: number; count: number }>;
const selectQueue: SelectResult[] = [];
const selectArgsLog: unknown[] = [];

function makeSelectChain(rows: SelectResult): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.where = passthrough;
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.groupBy = passthrough;
  chain.then = (
    resolve: (v: SelectResult) => void,
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
      select: (args?: unknown) => {
        selectArgsLog.push(args);
        const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
        return makeSelectChain(rows);
      },
    },
    reportsTable: schema.reportsTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const cohortRouter = (await import("./cohort")).default;
  const app = express();
  app.use(express.json());
  app.use(cohortRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  selectQueue.length = 0;
  selectArgsLog.length = 0;
});

interface HttpResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}

function request<T>(urlPath: string): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = text.length === 0 ? {} : JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsed as T,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface CohortBaselineResponse {
  cwe: string | null;
  windowDays: number;
  totalReports: number;
  median: number | null;
  percentile: number | null;
  queriedScore: number | null;
  bins: Array<{ min: number; max: number; count: number }>;
}

describe("GET /cohort/baseline", () => {
  it("returns an empty cohort with the 10-bucket scaffolding when no reports exist", async () => {
    selectQueue.push([]);
    const r = await request<CohortBaselineResponse>("/cohort/baseline");
    expect(r.status).toBe(200);
    expect(r.body.cwe).toBeNull();
    expect(r.body.windowDays).toBe(7);
    expect(r.body.totalReports).toBe(0);
    expect(r.body.median).toBeNull();
    expect(r.body.percentile).toBeNull();
    expect(r.body.queriedScore).toBeNull();
    expect(r.body.bins).toHaveLength(10);
    expect(r.body.bins.every((b) => b.count === 0)).toBe(true);
  });

  it("returns an exact percentile for the queried score against a small fixture cohort", async () => {
    // Histogram payload first (drives `bins` + `totalReports` + `median`),
    // then the count-aggregate payload that drives the exact percentile.
    // Fixture: 100 reports; 78 score strictly below 65, 4 score exactly 65.
    // Mid-rank percentile = (78 + 4/2) / 100 = 80%. The bucket math would
    // round both 61 and 69 into the same [60,70) bucket and report the
    // same 89%, so this test pins the exact path against a value the
    // bucket math cannot produce.
    selectQueue.push([
      { bucket: 0, count: 30 },
      { bucket: 1, count: 24 },
      { bucket: 2, count: 24 },
      { bucket: 6, count: 22 },
    ]);
    selectQueue.push([
      { below: 78, equal: 4 } as unknown as { bucket: number; count: number },
    ]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?score=65",
    );
    expect(r.status).toBe(200);
    expect(r.body.totalReports).toBe(100);
    expect(r.body.queriedScore).toBe(65);
    expect(r.body.percentile).toBe(80);
  });

  it("distinguishes 61 vs 69 — bucket math collapses them, the exact path does not", async () => {
    // Same histogram as above (78 below the [60,70) bucket, 22 in it),
    // but different equal-counts at the queried score.
    selectQueue.push([
      { bucket: 0, count: 30 },
      { bucket: 1, count: 24 },
      { bucket: 2, count: 24 },
      { bucket: 6, count: 22 },
    ]);
    selectQueue.push([
      { below: 78, equal: 1 } as unknown as { bucket: number; count: number },
    ]);
    const r1 = await request<CohortBaselineResponse>(
      "/cohort/baseline?score=61",
    );
    expect(r1.body.percentile).toBe(78.5);

    selectQueue.push([
      { bucket: 0, count: 30 },
      { bucket: 1, count: 24 },
      { bucket: 2, count: 24 },
      { bucket: 6, count: 22 },
    ]);
    selectQueue.push([
      { below: 99, equal: 1 } as unknown as { bucket: number; count: number },
    ]);
    const r2 = await request<CohortBaselineResponse>(
      "/cohort/baseline?score=69",
    );
    expect(r2.body.percentile).toBe(99.5);
  });

  it("skips the exact-percentile query (and returns null) when the cohort is empty", async () => {
    selectQueue.push([]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?score=50",
    );
    expect(r.status).toBe(200);
    expect(r.body.totalReports).toBe(0);
    expect(r.body.percentile).toBeNull();
    expect(r.body.queriedScore).toBe(50);
  });

  it("ignores a non-numeric score and falls back to the bucket-only response", async () => {
    selectQueue.push([{ bucket: 5, count: 3 }]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?score=banana",
    );
    expect(r.status).toBe(200);
    expect(r.body.percentile).toBeNull();
    expect(r.body.queriedScore).toBeNull();
  });

  it("packs per-bucket SQL rows into the histogram and totals them", async () => {
    selectQueue.push([
      { bucket: 0, count: 3 },
      { bucket: 5, count: 7 },
      { bucket: 9, count: 2 },
    ]);
    const r = await request<CohortBaselineResponse>("/cohort/baseline");
    expect(r.status).toBe(200);
    expect(r.body.totalReports).toBe(12);
    expect(r.body.bins[0].count).toBe(3);
    expect(r.body.bins[5].count).toBe(7);
    expect(r.body.bins[9].count).toBe(2);
    // Median sample sits in bucket 5 → midpoint 55.
    expect(r.body.median).toBe(55);
  });

  it("sets a 1h Cache-Control header so the ribbon can be cached aggressively", async () => {
    selectQueue.push([]);
    const r = await request<CohortBaselineResponse>("/cohort/baseline");
    expect(r.headers["cache-control"]).toContain("max-age=3600");
  });

  it("echoes the cwe scope when a known family is supplied", async () => {
    selectQueue.push([{ bucket: 4, count: 5 }]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?cwe=INJECTION",
    );
    expect(r.status).toBe(200);
    expect(r.body.cwe).toBe("INJECTION");
    expect(r.body.totalReports).toBe(5);
  });

  it("bins against vulnrap_composite_score (the metric shown in the results header), not slop_score, by default", async () => {
    // Regression for task #615: the ribbon's marker is positioned by the
    // displayed composite score, so the cohort histogram MUST be built from
    // the same column or the percentile label is meaningless.
    selectQueue.push([]);
    await request<CohortBaselineResponse>("/cohort/baseline");
    const schema = await import("@workspace/db/schema");
    const args = selectArgsLog[0] as { bucket: { queryChunks: unknown[] } };
    const chunks = args.bucket.queryChunks;
    expect(chunks).toContain(schema.reportsTable.vulnrapCompositeScore);
    expect(chunks).not.toContain(schema.reportsTable.slopScore);
  });

  it("bins against slop_score when metric=slop is requested (task #933)", async () => {
    // The legacy AI Detection Score card on /results/:id reuses the same
    // baseline ribbon UI; the marker there is positioned by the slop score
    // so the cohort histogram MUST switch to slop_score for that mode.
    selectQueue.push([{ bucket: 6, count: 4 }]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?metric=slop",
    );
    expect(r.status).toBe(200);
    expect(r.body.totalReports).toBe(4);
    const schema = await import("@workspace/db/schema");
    const args = selectArgsLog[0] as { bucket: { queryChunks: unknown[] } };
    const chunks = args.bucket.queryChunks;
    expect(chunks).toContain(schema.reportsTable.slopScore);
    expect(chunks).not.toContain(schema.reportsTable.vulnrapCompositeScore);
  });

  it("skips the engine-medians follow-up query for metric=slop", async () => {
    // Engine medians only make sense against the composite cohort. For the
    // slop cohort we should never issue the second select on
    // vulnrap_engine_results / quality_score — the response carries
    // engineMedians:null instead.
    selectQueue.push([{ bucket: 5, count: 1 }]);
    const r = await request<
      CohortBaselineResponse & { engineMedians: unknown }
    >("/cohort/baseline?metric=slop");
    expect(r.status).toBe(200);
    expect(r.body.engineMedians).toBeNull();
    // Only the histogram select should have been issued.
    expect(selectArgsLog).toHaveLength(1);
  });

  it("falls back to the composite cohort when metric is unknown", async () => {
    selectQueue.push([]);
    await request<CohortBaselineResponse>("/cohort/baseline?metric=bogus");
    const schema = await import("@workspace/db/schema");
    const args = selectArgsLog[0] as { bucket: { queryChunks: unknown[] } };
    const chunks = args.bucket.queryChunks;
    expect(chunks).toContain(schema.reportsTable.vulnrapCompositeScore);
  });

  it("falls back to the platform cohort (cwe=null) when an unknown family is requested", async () => {
    selectQueue.push([{ bucket: 3, count: 2 }]);
    const r = await request<CohortBaselineResponse>(
      "/cohort/baseline?cwe=NOT_A_FAMILY",
    );
    expect(r.status).toBe(200);
    expect(r.body.cwe).toBeNull();
    expect(r.body.totalReports).toBe(2);
  });
});
