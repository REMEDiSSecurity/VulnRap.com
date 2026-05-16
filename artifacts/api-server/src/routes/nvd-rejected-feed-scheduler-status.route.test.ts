// Task #1338 — Route-level coverage for the unauthenticated
// `GET /feedback/calibration/nvd-rejected-feed/scheduler-status` endpoint.
// The lib layer is unit-tested in `lib/nvd-rejected-feed-scheduler.test.ts`;
// this file exercises the route wiring against a real Express app so
// regressions in calibration.ts surface here rather than in the unit tests.
//
// Hard requirements (mirroring the rescore-backfill scheduler-status test):
//   (a) endpoint stays un-gated even when CALIBRATION_TOKEN is set
//   (b) JSON shape matches the NvdRejectedFeedSchedulerStatus interface
//   (c) body never leaks secrets (no webhook URL, no token value)

import http from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { AddressInfo } from "node:net";

const TOKEN = "nvd-rejected-route-test-token";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.CALIBRATION_TOKEN = TOKEN;

  const calibrationRouter = (await import("./calibration")).default;

  const app = express();
  app.use(express.json());
  app.use(calibrationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.CALIBRATION_TOKEN;
});

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data =
      body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const baseHeaders: Record<string, string> = data
      ? {
          "Content-Type": "application/json",
          "Content-Length": String(data.length),
        }
      : {};
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { ...baseHeaders, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const parsed = text.length > 0 ? JSON.parse(text) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
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

interface NvdRejectedFeedSchedulerStatusBody {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanTick: boolean | null;
  lastTickCount: number | null;
  lastTickDurationMs: number | null;
  loadedFromDisk: number | null;
  loadedFetchedAt: string | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

describe("GET /feedback/calibration/nvd-rejected-feed/scheduler-status", () => {
  const SCHEDULER_PATH =
    "/feedback/calibration/nvd-rejected-feed/scheduler-status";

  const REQUIRED_KEYS: ReadonlyArray<
    keyof NvdRejectedFeedSchedulerStatusBody
  > = [
    "schedulerStarted",
    "schedulerEnabled",
    "startedAt",
    "intervalMs",
    "retryIntervalMs",
    "lastTickAt",
    "lastTickOk",
    "lastTickRanTick",
    "lastTickCount",
    "lastTickDurationMs",
    "loadedFromDisk",
    "loadedFetchedAt",
    "nextTickAt",
    "ticksCompleted",
  ];

  beforeEach(async () => {
    const lib = await import("../lib/nvd-rejected-feed-scheduler");
    lib.__testing.resetSchedulerStatus();
  });

  afterEach(() => {
    process.env.CALIBRATION_TOKEN = TOKEN;
  });

  // (a) un-gated — token present
  it("returns 200 unauthenticated even when CALIBRATION_TOKEN is configured", async () => {
    expect(process.env.CALIBRATION_TOKEN).toBe(TOKEN);
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
    );
    expect(r.status).toBe(200);
    expect(r.body.schedulerStarted).toBe(false);
  });

  // (a) un-gated — no token at all
  it("returns 200 unauthenticated when CALIBRATION_TOKEN is not set", async () => {
    delete process.env.CALIBRATION_TOKEN;
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
    );
    expect(r.status).toBe(200);
    expect(r.body.schedulerStarted).toBe(false);
  });

  // (a) un-gated — stray credential header is silently ignored
  it("ignores a stray x-calibration-token header (route is un-gated, not opportunistically auth'd)", async () => {
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
      undefined,
      { "x-calibration-token": "wrong-token" },
    );
    expect(r.status).toBe(200);
  });

  // (b) baseline shape before any scheduler runs
  it("returns the 'never started' baseline before the scheduler runs", async () => {
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      schedulerStarted: false,
      startedAt: null,
      intervalMs: null,
      retryIntervalMs: null,
      lastTickAt: null,
      lastTickOk: null,
      lastTickRanTick: null,
      lastTickCount: null,
      lastTickDurationMs: null,
      loadedFromDisk: null,
      loadedFetchedAt: null,
      nextTickAt: null,
      ticksCompleted: 0,
    });
    // schedulerEnabled is derived from env at read-time; just assert type.
    expect(typeof r.body.schedulerEnabled).toBe("boolean");
  });

  // (b) key-set lock — no missing keys, no surprise keys
  it("matches the NvdRejectedFeedSchedulerStatus shape exactly — no missing keys, no surprise keys", async () => {
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
    );
    expect(r.status).toBe(200);
    for (const key of REQUIRED_KEYS) {
      expect(r.body).toHaveProperty(key);
    }
    expect(Object.keys(r.body).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  // (c) no secrets in the response body
  it("does not leak the CALIBRATION_TOKEN or any URL-shaped secret in the response body", async () => {
    const r = await request<NvdRejectedFeedSchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
    );
    expect(r.status).toBe(200);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toContain(TOKEN);
  });
});
