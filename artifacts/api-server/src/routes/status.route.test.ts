// Task #706 — route-level tests for the public status / uptime snapshot.
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

interface StatusResponse {
  generatedAt: string;
  overallStatus: "operational" | "degraded" | "down";
  uptime: {
    windowDays: number;
    daysWithTraffic: number;
    uptimePercentage: number;
  };
  latency: {
    windowHours: number;
    sampleCount: number;
    p50Ms: number;
    p95Ms: number;
  };
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
      { createdAt: recent, totalDurationMs: 800, trace: { stages }, reportId: "rpt-a" },
      { createdAt: recent, totalDurationMs: 1200, trace: { stages }, reportId: "rpt-b" },
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

  it("excludes synthetic heartbeat rows (reportId IS NULL) from latency, but still counts them for engine liveness and uptime", async () => {
    // Models the exact scenario the user cares about: zero organic
    // traffic in the last 24h, only synthetic heartbeats. Engines
    // must still show operational and uptime stays high, but the
    // published p50/p95 must NOT be derived from heartbeat ticks.
    const now = Date.now();
    const recent = new Date(now - 5 * 60_000);
    const stages = [
      "engine1_ai_authorship",
      "engine2_substance",
      "engine3_cwe_coherence",
      "avri_composite",
      "perplexity",
    ].map((stage) => ({ stage, durationMs: 12 }));
    selectQueue.push([
      // Two synthetic heartbeat ticks (reportId === null).
      { createdAt: recent, totalDurationMs: 20, trace: { stages }, reportId: null },
      { createdAt: recent, totalDurationMs: 22, trace: { stages }, reportId: null },
      // One organic submission with very different latency.
      { createdAt: recent, totalDurationMs: 9999, trace: { stages }, reportId: "rpt-real" },
    ]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.status).toBe(200);
    // Engines stay operational because heartbeats DO count for liveness.
    for (const eng of r.body.engines) {
      expect(eng.status).toBe("operational");
      expect(eng.lastSeenAt).not.toBeNull();
    }
    expect(r.body.uptime.daysWithTraffic).toBe(1);
    // Latency counts ONLY the one organic row — heartbeats excluded.
    expect(r.body.latency.sampleCount).toBe(1);
    expect(r.body.latency.p50Ms).toBeCloseTo(9999, 0);
    expect(r.body.latency.p95Ms).toBeCloseTo(9999, 0);
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

  it("treats avri_composite as healthy evidence for linguistic/substance/cwe (AVRI-mode regression)", async () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 60_000);
    selectQueue.push([
      {
        createdAt: recent,
        totalDurationMs: 600,
        trace: {
          stages: [
            { stage: "extract_signals", durationMs: 5 },
            { stage: "perplexity", durationMs: 10 },
            { stage: "avri_composite", durationMs: 50 },
          ],
        },
      },
    ]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.status).toBe(200);
    expect(r.body.overallStatus).toBe("operational");
    for (const eng of r.body.engines) {
      expect(eng.status).toBe("operational");
      expect(eng.recentSampleCount).toBe(1);
    }
  });

  it("counts a trace once per engine even when multiple matching stages are present", async () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 60_000);
    selectQueue.push([
      {
        createdAt: recent,
        totalDurationMs: 600,
        trace: {
          stages: [
            { stage: "engine1_ai_authorship", durationMs: 10 },
            { stage: "engine2_substance", durationMs: 10 },
            { stage: "engine3_cwe_coherence", durationMs: 10 },
            { stage: "avri_composite", durationMs: 50 },
            { stage: "perplexity", durationMs: 10 },
          ],
        },
      },
    ]);
    const r = await request<StatusResponse>("/public/status");
    const linguistic = r.body.engines.find((e) => e.id === "linguistic")!;
    const substance = r.body.engines.find((e) => e.id === "substance")!;
    const cwe = r.body.engines.find((e) => e.id === "cwe")!;
    expect(linguistic.recentSampleCount).toBe(1);
    expect(substance.recentSampleCount).toBe(1);
    expect(cwe.recentSampleCount).toBe(1);
  });

  it("attributes ongoing incidents to all sub-engines when only avri_composite traces exist (AVRI-mode regression)", async () => {
    const now = Date.now();
    const old = new Date(now - 25 * 60 * 60_000); // 25h ago — well past 1h gap threshold
    selectQueue.push([
      {
        createdAt: old,
        totalDurationMs: 600,
        trace: {
          stages: [
            { stage: "perplexity", durationMs: 10 },
            { stage: "avri_composite", durationMs: 50 },
          ],
        },
      },
    ]);
    interface IncidentsResponse {
      incidents: Array<{
        affectedEngines: Array<{ id: string; label: string }>;
        severity: "degraded" | "outage";
      }>;
    }
    const r = await request<IncidentsResponse>("/public/status/incidents");
    expect(r.status).toBe(200);
    expect(r.body.incidents.length).toBeGreaterThan(0);
    const affectedIds = new Set(
      r.body.incidents[0].affectedEngines.map((e) => e.id),
    );
    for (const id of ["linguistic", "substance", "cwe", "avri", "llm_gate"]) {
      expect(affectedIds.has(id)).toBe(true);
    }
    expect(r.body.incidents[0].severity).toBe("outage");
  });

  it("sets a 60s public Cache-Control header", async () => {
    selectQueue.push([]);
    const r = await request<StatusResponse>("/public/status");
    expect(r.headers["cache-control"]).toContain("max-age=60");
    expect(r.headers["cache-control"]).toContain("public");
  });
});
