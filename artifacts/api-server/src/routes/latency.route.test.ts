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

interface SeededRow {
  totalDurationMs: number;
  trace: {
    stages: Array<{ stage: string; durationMs: number }>;
  } | null;
  createdAt: Date;
}

let seededRows: SeededRow[] = [];

let capturedGteCutoff: Date | null = null;

vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return {
    ...actual,
    gte: (_col: unknown, val: unknown) => {
      if (val instanceof Date) capturedGteCutoff = val;
      return { _tag: "gte", cutoff: val };
    },
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );

  function makeSelectChain(rowsFn: () => unknown[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = (): Record<string, unknown> => chain;
    chain.from = passthrough;
    chain.where = (condition: unknown): Record<string, unknown> => {
      const cond = condition as { _tag?: string; cutoff?: unknown } | null;
      if (cond && cond._tag === "gte" && cond.cutoff instanceof Date) {
        const cutoff = cond.cutoff as Date;
        const original = rowsFn;
        rowsFn = () => {
          const all = original();
          return all.filter((_, i) => seededRows[i].createdAt >= cutoff);
        };
      }
      return chain;
    };
    chain.orderBy = passthrough;
    chain.limit = passthrough;
    chain.groupBy = passthrough;
    chain.then = (
      resolve: (v: unknown[]) => void,
      reject: (e: unknown) => void,
    ): void => {
      try {
        resolve(rowsFn());
      } catch (e) {
        reject(e);
      }
    };
    return chain;
  }

  return {
    db: {
      select: (fields: Record<string, unknown>) => {
        return makeSelectChain(() => {
          const keys = Object.keys(fields);
          return seededRows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              out[k] = (r as unknown as Record<string, unknown>)[k];
            }
            return out;
          });
        });
      },
    },
    analysisTracesTable: schema.analysisTracesTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const latencyRouter = (await import("./latency")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", latencyRouter);
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
  seededRows = [];
  capturedGteCutoff = null;
});

function request<T>(urlPath: string): Promise<{
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
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
    req.end();
  });
}

function recentDate(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

function row(
  totalDurationMs: number,
  stages: Array<{ stage: string; durationMs: number }>,
  minutesAgo = 5,
): SeededRow {
  return {
    totalDurationMs,
    trace: { stages },
    createdAt: recentDate(minutesAgo),
  };
}

interface SnapshotBody {
  windowHours: number;
  generatedAt: string;
  sampleCount: number;
  pipeline: {
    percentiles: { p50: number; p95: number; p99: number; sampleCount: number };
    bins: Array<{ ltMs: number; count: number }>;
  };
  engines: Array<{
    engine: string;
    percentiles: {
      p50: number;
      p95: number;
      p99: number;
      sampleCount: number;
    };
    bins: Array<{ ltMs: number; count: number }>;
  }>;
  worstEngine: {
    engine: string;
    p95: number;
    pipelineP95: number;
    ratio: number;
  } | null;
}

describe("GET /api/public/latency-snapshot", () => {
  it("returns empty snapshot when no rows exist", async () => {
    seededRows = [];
    const r = await request<SnapshotBody>("/api/public/latency-snapshot");

    expect(r.status).toBe(200);
    expect(r.body.windowHours).toBe(24);
    expect(r.body.sampleCount).toBe(0);
    expect(r.body.pipeline.percentiles).toEqual({
      p50: 0,
      p95: 0,
      p99: 0,
      sampleCount: 0,
    });
    expect(r.body.engines).toEqual([]);
    expect(r.body.worstEngine).toBeNull();
  });

  it("computes p50/p95/p99 correctly for pipeline and each engine", async () => {
    const durations = [
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300,
      1400, 1500, 1600, 1700, 1800, 1900, 2000,
    ];
    seededRows = durations.map((d) =>
      row(d, [
        { stage: "engineA", durationMs: d * 0.6 },
        { stage: "engineB", durationMs: d * 0.4 },
      ]),
    );

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.sampleCount).toBe(20);

    const sorted = [...durations].sort((a, b) => a - b);
    function percentile(vals: number[], p: number): number {
      const rank = (p / 100) * (vals.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      if (lo === hi) return vals[lo];
      const frac = rank - lo;
      return vals[lo] * (1 - frac) + vals[hi] * frac;
    }

    expect(r.body.pipeline.percentiles.p50).toBeCloseTo(
      percentile(sorted, 50),
      1,
    );
    expect(r.body.pipeline.percentiles.p95).toBeCloseTo(
      percentile(sorted, 95),
      1,
    );
    expect(r.body.pipeline.percentiles.p99).toBeCloseTo(
      percentile(sorted, 99),
      1,
    );
    expect(r.body.pipeline.percentiles.sampleCount).toBe(20);

    const engineA = r.body.engines.find((e) => e.engine === "engineA")!;
    expect(engineA).toBeDefined();
    const sortedA = durations.map((d) => d * 0.6).sort((a, b) => a - b);
    expect(engineA.percentiles.p50).toBeCloseTo(percentile(sortedA, 50), 1);
    expect(engineA.percentiles.p95).toBeCloseTo(percentile(sortedA, 95), 1);
    expect(engineA.percentiles.p99).toBeCloseTo(percentile(sortedA, 99), 1);
    expect(engineA.percentiles.sampleCount).toBe(20);

    const engineB = r.body.engines.find((e) => e.engine === "engineB")!;
    expect(engineB).toBeDefined();
    const sortedB = durations.map((d) => d * 0.4).sort((a, b) => a - b);
    expect(engineB.percentiles.p50).toBeCloseTo(percentile(sortedB, 50), 1);
    expect(engineB.percentiles.p95).toBeCloseTo(percentile(sortedB, 95), 1);
    expect(engineB.percentiles.p99).toBeCloseTo(percentile(sortedB, 99), 1);
    expect(engineB.percentiles.sampleCount).toBe(20);
  });

  it("assigns bin counts matching the fixed edges", async () => {
    seededRows = [
      row(30, []),
      row(75, []),
      row(150, []),
      row(350, []),
      row(600, []),
      row(1200, []),
      row(2500, []),
      row(4500, []),
      row(8000, []),
      row(15000, []),
      row(25000, []),
    ];

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);

    const bins = r.body.pipeline.bins;
    expect(bins).toHaveLength(11);

    expect(bins[0]).toEqual({ ltMs: 50, count: 1 });
    expect(bins[1]).toEqual({ ltMs: 100, count: 1 });
    expect(bins[2]).toEqual({ ltMs: 200, count: 1 });
    expect(bins[3]).toEqual({ ltMs: 400, count: 1 });
    expect(bins[4]).toEqual({ ltMs: 800, count: 1 });
    expect(bins[5]).toEqual({ ltMs: 1500, count: 1 });
    expect(bins[6]).toEqual({ ltMs: 3000, count: 1 });
    expect(bins[7]).toEqual({ ltMs: 5000, count: 1 });
    expect(bins[8]).toEqual({ ltMs: 10000, count: 1 });
    expect(bins[9]).toEqual({ ltMs: 20000, count: 1 });
    expect(bins[10]).toEqual({ ltMs: 20000, count: 1 });

    const totalBinned = bins.reduce((s, b) => s + b.count, 0);
    expect(totalBinned).toBe(11);
  });

  it("emits worstEngine when one engine p95 >= 1.5x median AND >= 25% pipeline p95", async () => {
    seededRows = [];
    for (let i = 0; i < 20; i++) {
      seededRows.push(
        row(1000, [
          { stage: "slow", durationMs: 900 },
          { stage: "fast1", durationMs: 50 },
          { stage: "fast2", durationMs: 50 },
        ]),
      );
    }

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.worstEngine).not.toBeNull();
    expect(r.body.worstEngine!.engine).toBe("slow");
    expect(r.body.worstEngine!.ratio).toBeGreaterThanOrEqual(1.5);
    expect(r.body.worstEngine!.p95).toBeGreaterThanOrEqual(
      r.body.worstEngine!.pipelineP95 * 0.25,
    );
  });

  it("worstEngine is null when engines are roughly equal", async () => {
    seededRows = [];
    for (let i = 0; i < 20; i++) {
      seededRows.push(
        row(300, [
          { stage: "eng1", durationMs: 100 },
          { stage: "eng2", durationMs: 100 },
          { stage: "eng3", durationMs: 100 },
        ]),
      );
    }

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.worstEngine).toBeNull();
  });

  it("worstEngine is null when there is only one engine", async () => {
    seededRows = [];
    for (let i = 0; i < 10; i++) {
      seededRows.push(row(500, [{ stage: "solo", durationMs: 500 }]));
    }

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.worstEngine).toBeNull();
  });

  it("worstEngine is null when ratio >= 1.5 but engine p95 < 25% of pipeline p95", async () => {
    seededRows = [];
    for (let i = 0; i < 20; i++) {
      seededRows.push(
        row(10000, [
          { stage: "outlier", durationMs: 200 },
          { stage: "normal1", durationMs: 50 },
          { stage: "normal2", durationMs: 50 },
        ]),
      );
    }

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);

    const outlier = r.body.engines.find((e) => e.engine === "outlier")!;
    const normal = r.body.engines.find((e) => e.engine === "normal1")!;
    expect(outlier.percentiles.p95 / normal.percentiles.p95).toBeGreaterThanOrEqual(1.5);
    expect(outlier.percentiles.p95 / r.body.pipeline.percentiles.p95).toBeLessThan(0.25);

    expect(r.body.worstEngine).toBeNull();
  });

  it("excludes rows older than 24h via the route's gte predicate", async () => {
    seededRows = [
      row(100, [{ stage: "eng", durationMs: 100 }], 5),
      row(99999, [{ stage: "eng", durationMs: 99999 }], 25 * 60),
    ];

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.sampleCount).toBe(1);
    expect(r.body.pipeline.percentiles.p50).toBe(100);

    expect(capturedGteCutoff).toBeInstanceOf(Date);
    const expectedCutoff = Date.now() - 24 * 60 * 60 * 1000;
    expect(capturedGteCutoff!.getTime()).toBeGreaterThan(expectedCutoff - 5000);
    expect(capturedGteCutoff!.getTime()).toBeLessThanOrEqual(expectedCutoff + 5000);
  });

  it("sets Cache-Control header", async () => {
    seededRows = [];
    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=120",
    );
  });

  it("sorts engines by p95 descending", async () => {
    seededRows = [];
    for (let i = 0; i < 20; i++) {
      seededRows.push(
        row(1000, [
          { stage: "alpha", durationMs: 100 },
          { stage: "beta", durationMs: 500 },
          { stage: "gamma", durationMs: 300 },
        ]),
      );
    }

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    const names = r.body.engines.map((e) => e.engine);
    expect(names).toEqual(["beta", "gamma", "alpha"]);
  });

  it("handles rows with null or missing trace gracefully", async () => {
    seededRows = [
      {
        totalDurationMs: 200,
        trace: null,
        createdAt: recentDate(5),
      },
      {
        totalDurationMs: 300,
        trace: { stages: [] },
        createdAt: recentDate(5),
      },
    ];

    const r = await request<SnapshotBody>("/api/public/latency-snapshot");
    expect(r.status).toBe(200);
    expect(r.body.sampleCount).toBe(2);
    expect(r.body.engines).toEqual([]);
  });
});
