// Task #706 — route-level tests for the public status / uptime snapshot.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTraceRow {
  createdAt: Date;
  totalDurationMs: number;
  trace: { stages: Array<{ stage: string; durationMs: number }> } | null;
}

const selectQueue: FakeTraceRow[][] = [];

function makeSelectChain(rows: FakeTraceRow[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.where = passthrough;
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.then = (
    resolve: (v: FakeTraceRow[]) => void,
    reject: (e: unknown) => void,
  ): void => {
    try { resolve(rows); } catch (e) { reject(e); }
  };
  return chain;
}

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      select: () => {
        const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
        return makeSelectChain(rows);
      },
    },
    analysisTracesTable: schema.analysisTracesTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const statusRouter = (await import("./status")).default;
  const app = express();
  app.use(express.json());
  app.use(statusRouter);
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
          try { parsed = text.length === 0 ? {} : JSON.parse(text); } catch { parsed = text; }
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

interface StatusResponse {
  generatedAt: string;
  overallStatus: "operational" | "degraded" | "down";
  uptime: { windowDays: number; daysWithTraffic: number; uptimePercentage: number };
  latency: { windowHours: number; sampleCount: number; p50Ms: number; p95Ms: number };
  engines: Array<{
    id: string;
    label: string;
    status: "operational" | "degraded" | "down" | "unknown";
    recentSampleCount: number;
    lastSeenAt: string | null;
  }>;
}

describe("GET /public/status", () => {
  it("returns operational with all engines unknown when there are no traces", async () => {
    selectQueue.push([]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.status).toBe(200);
    expect(r.body.overallStatus).toBe("operational");
    expect(r.body.uptime.daysWithTraffic).toBe(0);
    expect(r.body.uptime.uptimePercentage).toBe(0);
    expect(r.body.latency.sampleCount).toBe(0);
    expect(r.body.engines).toHaveLength(5);
    for (const eng of r.body.engines) {
      expect(eng.status).toBe("unknown");
      expect(eng.lastSeenAt).toBeNull();
    }
  });

  it("marks every engine operational when each stage was seen in the last hour", async () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 60_000); // 5 min ago
    const stages = [
      "engine1_ai_authorship",
      "engine2_substance",
      "engine3_cwe_coherence",
      "avri_composite",
      "perplexity",
    ].map((stage) => ({ stage, durationMs: 12 }));
    selectQueue.push([
      { createdAt: recent, totalDurationMs: 800, trace: { stages } },
      { createdAt: recent, totalDurationMs: 1200, trace: { stages } },
    ]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.status).toBe(200);
    expect(r.body.overallStatus).toBe("operational");
    expect(r.body.uptime.daysWithTraffic).toBe(1);
    expect(r.body.latency.sampleCount).toBe(2);
    // p50 of [800, 1200] is 1000; p95 sits very close to 1200.
    expect(r.body.latency.p50Ms).toBeCloseTo(1000, 0);
    expect(r.body.latency.p95Ms).toBeCloseTo(1180, 0);
    for (const eng of r.body.engines) {
      expect(eng.status).toBe("operational");
      expect(eng.recentSampleCount).toBe(2);
      expect(eng.lastSeenAt).not.toBeNull();
    }
  });

  it("marks an engine down when its stage hasn't been seen in 6h, and overall status follows", async () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 60_000);
    const stale = new Date(now - 30 * 60 * 60_000); // 30 hours ago
    selectQueue.push([
      // Recent run that exercises every engine *except* AVRI.
      {
        createdAt: recent,
        totalDurationMs: 500,
        trace: {
          stages: [
            { stage: "engine1_ai_authorship", durationMs: 10 },
            { stage: "engine2_substance", durationMs: 10 },
            { stage: "engine3_cwe_coherence", durationMs: 10 },
            { stage: "perplexity", durationMs: 10 },
          ],
        },
      },
      // Old run that's the only place AVRI ever appears.
      {
        createdAt: stale,
        totalDurationMs: 500,
        trace: { stages: [{ stage: "avri_composite", durationMs: 10 }] },
      },
    ]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.status).toBe(200);
    const avri = r.body.engines.find((e) => e.id === "avri")!;
    expect(avri.status).toBe("down");
    expect(avri.recentSampleCount).toBe(0);
    expect(r.body.overallStatus).toBe("down");
  });

  it("sets a 60s public Cache-Control header", async () => {
    selectQueue.push([]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.headers["cache-control"]).toContain("max-age=60");
    expect(r.headers["cache-control"]).toContain("public");
  });
});
