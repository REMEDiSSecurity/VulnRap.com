// Task #764 — Route-level coverage for the unauthenticated
// `GET /feedback/calibration/rescore-backfill/scheduler-status` endpoint
// added in Task #388.  The lib layer is unit-tested in
// `lib/rescore-backfill-scheduler.test.ts`; this file exercises the
// route wiring against a real Express app so regressions in the
// calibration.ts layer surface here rather than in the unit tests.
//
// Three hard requirements from the task brief:
//   (a) endpoint stays un-gated even when CALIBRATION_TOKEN is set
//   (b) JSON shape matches the RescoreSchedulerStatus interface (OpenAPI
//       contract — the path is not yet in openapi.yaml but the TS
//       interface is the authoritative shape)
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

const TOKEN = "rescore-route-test-token";

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

type LeadershipSkipReason = "lock-held-elsewhere" | "recent-run";

interface RescoreSchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  limit: number | null;
  maxRuntimeMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickSkippedReason: LeadershipSkipReason | null;
  lastTickProcessed: number | null;
  lastTickRescored: number | null;
  lastTickFailed: number | null;
  lastTickDeadlineReached: boolean | null;
  lastTickElapsedMs: number | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

describe("GET /feedback/calibration/rescore-backfill/scheduler-status", () => {
  const SCHEDULER_PATH =
    "/feedback/calibration/rescore-backfill/scheduler-status";

  const REQUIRED_KEYS: ReadonlyArray<keyof RescoreSchedulerStatus> = [
    "schedulerStarted",
    "schedulerEnabled",
    "startedAt",
    "intervalMs",
    "retryIntervalMs",
    "limit",
    "maxRuntimeMs",
    "lastTickAt",
    "lastTickOk",
    "lastTickRanCheck",
    "lastTickSkippedReason",
    "lastTickProcessed",
    "lastTickRescored",
    "lastTickFailed",
    "lastTickDeadlineReached",
    "lastTickElapsedMs",
    "nextTickAt",
    "ticksCompleted",
  ];

  let scheduler: { stop(): void } | null = null;

  beforeEach(async () => {
    const lib = await import("../lib/rescore-backfill-scheduler");
    lib.__testing.resetSchedulerStatus();
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    process.env.CALIBRATION_TOKEN = TOKEN;
  });

  // (a) un-gated — token present
  it("returns 200 unauthenticated even when CALIBRATION_TOKEN is configured", async () => {
    expect(process.env.CALIBRATION_TOKEN).toBe(TOKEN);
    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(r.body.schedulerStarted).toBe(false);
  });

  // (a) un-gated — no token at all
  it("returns 200 unauthenticated when CALIBRATION_TOKEN is not set", async () => {
    delete process.env.CALIBRATION_TOKEN;
    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(r.body.schedulerStarted).toBe(false);
  });

  // (a) un-gated — stray credential header is silently ignored
  it("ignores a stray x-calibration-token header (route is un-gated, not opportunistically auth'd)", async () => {
    const r = await request<RescoreSchedulerStatus>(
      "GET",
      SCHEDULER_PATH,
      undefined,
      { "x-calibration-token": "wrong-token" },
    );
    expect(r.status).toBe(200);
  });

  // (b) baseline shape before any scheduler runs
  it("returns the 'never started' baseline before the scheduler runs", async () => {
    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      schedulerStarted: false,
      startedAt: null,
      intervalMs: null,
      retryIntervalMs: null,
      limit: null,
      maxRuntimeMs: null,
      lastTickAt: null,
      lastTickOk: null,
      lastTickRanCheck: null,
      lastTickSkippedReason: null,
      lastTickProcessed: null,
      lastTickRescored: null,
      lastTickFailed: null,
      lastTickDeadlineReached: null,
      lastTickElapsedMs: null,
      nextTickAt: null,
      ticksCompleted: 0,
    });
    // schedulerEnabled is derived from env at read-time; just assert type.
    expect(typeof r.body.schedulerEnabled).toBe("boolean");
  });

  // (b) shape when scheduler is running
  it("reflects a running scheduler with schedulerStarted + nextTickAt populated", async () => {
    const lib = await import("../lib/rescore-backfill-scheduler");
    // Long initialDelayMs prevents the real timer from firing during the
    // request and mutating the status struct mid-test.
    scheduler = lib.startRescoreBackfillScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 60_000,
      run: async () => ({ ok: true, ranCheck: true }),
    });
    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(r.body.schedulerStarted).toBe(true);
    expect(r.body.startedAt).not.toBeNull();
    expect(r.body.intervalMs).toBe(60_000);
    expect(r.body.retryIntervalMs).toBe(5_000);
    expect(r.body.nextTickAt).not.toBeNull();
    expect(r.body.ticksCompleted).toBe(0);
    // No tick has fired yet, so per-tick fields stay null.
    expect(r.body.lastTickAt).toBeNull();
    expect(r.body.lastTickOk).toBeNull();
  });

  // (b) key-set lock — no missing keys, no surprise keys
  it("matches the RescoreSchedulerStatus shape exactly — no missing keys, no surprise keys", async () => {
    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    for (const key of REQUIRED_KEYS) {
      expect(r.body).toHaveProperty(key);
    }
    expect(Object.keys(r.body).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  // (c) no secrets in the response body
  it("does not leak the CALIBRATION_TOKEN or any URL-shaped secret in the response body", async () => {
    const lib = await import("../lib/rescore-backfill-scheduler");
    scheduler = lib.startRescoreBackfillScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 60_000,
      run: async () => ({ ok: true, ranCheck: true }),
    });

    const r = await request<RescoreSchedulerStatus>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);

    const raw = JSON.stringify(r.body);

    // No URL-shaped string — defends against a future field carrying a
    // webhook URL or other credential-bearing URL.
    expect(raw).not.toMatch(/https?:\/\//);

    // No CALIBRATION_TOKEN value — even though the route is un-gated, a
    // future patch that echoed the configured auth token would expose a
    // credential on a public endpoint.
    expect(raw).not.toContain(TOKEN);
  });
});
