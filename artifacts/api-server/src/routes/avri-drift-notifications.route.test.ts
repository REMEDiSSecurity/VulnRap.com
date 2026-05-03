// Task #196 — Cover the new dedup-state read + re-arm endpoints. The lib
// layer is unit-tested separately in
// `lib/avri-drift-notifications.test.ts`; this file exercises the wiring
// (auth gates, validation, status-code policy, response shape) end-to-end
// against a real Express app instance so a regression in the route layer
// can't be hidden by direct lib tests.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
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

const TOKEN = "drift-notify-token";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let statePath: string;
let resetResolvedPath: () => void;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "avri-drift-routes-"));
  statePath = path.join(tmpDir, "notifications.json");

  process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = statePath;
  process.env.CALIBRATION_TOKEN = TOKEN;

  const calibrationRouter = (await import("./calibration")).default;
  const lib = await import("../lib/avri-drift-notifications");
  resetResolvedPath = lib.__testing.resetResolvedPath;
  resetResolvedPath();

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
  delete process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  resetResolvedPath();
  // Reset state to two seed records before every test.
  const seed = {
    notified: [
      {
        key: "2026-04-20|GAP_BELOW_45",
        weekStart: "2026-04-20",
        kind: "GAP_BELOW_45",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "T1−T3 gap dropped to 41.2pt",
      },
      {
        key: "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
        weekStart: "2026-04-20",
        kind: "FAMILY_MEAN_SHIFT",
        notifiedAt: "2026-04-21T00:00:00.000Z",
        detail: "T1 INJECTION mean shifted by +6.3pt",
      },
    ],
  };
  await fs.writeFile(statePath, JSON.stringify(seed), "utf8");
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

const AUTH = { "x-calibration-token": TOKEN };

interface NotificationsList {
  notified: Array<{ key: string; weekStart: string; detail: string }>;
  total: number;
}

interface RearmAuditEntryShape {
  key: string;
  weekStart: string;
  kind: string;
  originalNotifiedAt: string;
  originalDetail: string;
  rearmedAt: string;
  rearmedBy?: string;
  rationale?: string;
}

interface RearmResponse {
  rearmed: number;
  notFound: string[];
  remaining: number;
  removed: Array<{ key: string }>;
  notified: Array<{ key: string }>;
  auditEntries: RearmAuditEntryShape[];
  rearmHistory: RearmAuditEntryShape[];
  error?: string;
}

interface RearmHistoryList {
  history: RearmAuditEntryShape[];
  total: number;
}

describe("GET /feedback/calibration/avri-drift/notifications", () => {
  it("rejects unauthenticated reads with 401 (strict-auth list endpoint)", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/avri-drift/notifications",
    );
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("returns the persisted dedup snapshot when authenticated", async () => {
    const r = await request<NotificationsList>(
      "GET",
      "/feedback/calibration/avri-drift/notifications",
      undefined,
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.notified.map((n) => n.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
  });
});

describe("POST /feedback/calibration/avri-drift/notifications/rearm", () => {
  it("rejects unauthenticated POSTs with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: ["2026-04-20|GAP_BELOW_45"] },
    );
    expect(r.status).toBe(401);
  });

  it("re-arms a known key and returns the refreshed dedup snapshot", async () => {
    const r = await request<RearmResponse>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: ["2026-04-20|GAP_BELOW_45"] },
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.rearmed).toBe(1);
    expect(r.body.notFound).toEqual([]);
    expect(r.body.remaining).toBe(1);
    expect(r.body.removed.map((rm) => rm.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);
    expect(r.body.notified.map((n) => n.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);

    // The persisted file must reflect the removal so a subsequent dispatch
    // run actually re-fires the webhook for the re-armed flag.
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      notified: Array<{ key: string }>;
    };
    expect(persisted.notified.map((n) => n.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
  });

  it("returns 404 when none of the requested keys exist", async () => {
    const r = await request<RearmResponse>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: ["2099-01-01|GAP_BELOW_45"] },
      AUTH,
    );
    expect(r.status).toBe(404);
    expect(r.body.rearmed).toBe(0);
    expect(r.body.notFound).toEqual(["2099-01-01|GAP_BELOW_45"]);
    expect(r.body.remaining).toBe(2);
    // Snapshot still echoes the unchanged dedup state so the UI can update.
    expect(r.body.notified).toHaveLength(2);
  });

  it("returns 200 with mixed results when some keys match and others don't", async () => {
    const r = await request<RearmResponse>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45", "2099-01-01|GAP_BELOW_45"],
      },
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.rearmed).toBe(1);
    expect(r.body.notFound).toEqual(["2099-01-01|GAP_BELOW_45"]);
    expect(r.body.remaining).toBe(1);
  });

  it("rejects an empty keys array with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: [] },
      AUTH,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/non-empty/i);
  });

  it("rejects a missing keys field with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {},
      AUTH,
    );
    expect(r.status).toBe(400);
  });

  it("rejects non-string entries with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: ["2026-04-20|GAP_BELOW_45", 42] },
      AUTH,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/non-empty string/i);
  });

  it("rejects empty / whitespace string entries with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys: ["   "] },
      AUTH,
    );
    expect(r.status).toBe(400);
  });

  it("rejects oversized batches (>200 keys) with 400", async () => {
    const keys = Array.from({ length: 201 }, (_, i) => `bulk-${i}`);
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      { keys },
      AUTH,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/200/);
  });

  it("records reviewer + rationale in the audit log when supplied", async () => {
    const r = await request<RearmResponse>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45"],
        reviewer: "alice",
        rationale: "fix-by date passed",
      },
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.auditEntries).toHaveLength(1);
    expect(r.body.auditEntries[0]!.rearmedBy).toBe("alice");
    expect(r.body.auditEntries[0]!.rationale).toBe("fix-by date passed");
    expect(r.body.auditEntries[0]!.originalDetail).toBe(
      "T1−T3 gap dropped to 41.2pt",
    );
    expect(r.body.rearmHistory.length).toBeGreaterThanOrEqual(1);
    // Audit log must be persisted to disk.
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      rearmHistory: RearmAuditEntryShape[];
    };
    expect(persisted.rearmHistory).toHaveLength(1);
    expect(persisted.rearmHistory[0]!.rearmedBy).toBe("alice");
  });

  it("rejects an over-long reviewer field with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45"],
        reviewer: "x".repeat(201),
      },
      AUTH,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reviewer/i);
  });

  it("rejects an over-long rationale field with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45"],
        rationale: "x".repeat(501),
      },
      AUTH,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rationale/i);
  });

  it("rejects a non-string reviewer with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45"],
        reviewer: 42,
      },
      AUTH,
    );
    expect(r.status).toBe(400);
  });
});

// Task #398 — Route-level coverage for the unauthenticated
// `scheduler-status` endpoint: stays un-gated regardless of
// CALIBRATION_TOKEN, JSON shape matches the OpenAPI contract, and the
// body never carries the webhook URL or token. Task #277 unit-tested
// the in-memory struct directly; this block exercises the real route.
interface SchedulerStatusEntry {
  replicaId: string;
  hostname: string;
  heartbeatAt: string | null;
  schedulerStarted: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  webhookConfigured: boolean;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickDispatched: boolean | null;
  lastTickNewFlagCount: number | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

// Task #397 — endpoint now returns an array of per-replica entries
// instead of a single object. Tests pick the live in-memory entry
// (this replica) for the assertions that used to address `r.body`.
type SchedulerStatusBody = SchedulerStatusEntry[];

describe("GET /feedback/calibration/avri-drift/scheduler-status", () => {
  const SCHEDULER_PATH = "/feedback/calibration/avri-drift/scheduler-status";
  const REQUIRED_KEYS: ReadonlyArray<keyof SchedulerStatusEntry> = [
    "replicaId",
    "hostname",
    "heartbeatAt",
    "schedulerStarted",
    "startedAt",
    "intervalMs",
    "retryIntervalMs",
    "webhookConfigured",
    "lastTickAt",
    "lastTickOk",
    "lastTickRanCheck",
    "lastTickDispatched",
    "lastTickNewFlagCount",
    "nextTickAt",
    "ticksCompleted",
  ];

  // Helper: pick this replica's entry. Tests start with state seeded
  // by `beforeEach` (no persisted heartbeats), so the array contains
  // exactly one entry — the live in-memory record for this replica.
  // We pick by `schedulerStarted: true` when a scheduler is running,
  // else the sole entry, so the same helper works for both the
  // "never started" and "running" code paths.
  const pickLive = (body: SchedulerStatusBody): SchedulerStatusEntry => {
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    return body.find((e) => e.schedulerStarted) ?? body[0]!;
  };

  let scheduler: { stop(): void } | null = null;

  beforeEach(async () => {
    const lib = await import("../lib/avri-drift-notifications");
    lib.__testing.resetSchedulerStatus();
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    // Restore the strict-auth token that the suite-level beforeAll set,
    // in case an individual test cleared it to exercise the no-token
    // branch.
    process.env.CALIBRATION_TOKEN = TOKEN;
  });

  it("returns 200 unauthenticated even when CALIBRATION_TOKEN is configured", async () => {
    // Sanity-check the suite's env so a future refactor that stops
    // setting the token in `beforeAll` doesn't quietly turn this into
    // a no-op.
    expect(process.env.CALIBRATION_TOKEN).toBe(TOKEN);
    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(pickLive(r.body).schedulerStarted).toBe(false);
  });

  it("returns 200 unauthenticated when CALIBRATION_TOKEN is not set", async () => {
    delete process.env.CALIBRATION_TOKEN;
    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    expect(pickLive(r.body).schedulerStarted).toBe(false);
  });

  it("ignores a stray x-calibration-token header (route is un-gated, not opportunistically auth'd)", async () => {
    const r = await request<SchedulerStatusBody>(
      "GET",
      SCHEDULER_PATH,
      undefined,
      { "x-calibration-token": "wrong-token" },
    );
    expect(r.status).toBe(200);
  });

  it("returns the 'never started' baseline before the scheduler runs", async () => {
    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    const live = pickLive(r.body);
    expect(live).toMatchObject({
      schedulerStarted: false,
      startedAt: null,
      intervalMs: null,
      retryIntervalMs: null,
      lastTickAt: null,
      lastTickOk: null,
      lastTickRanCheck: null,
      lastTickDispatched: null,
      lastTickNewFlagCount: null,
      nextTickAt: null,
      ticksCompleted: 0,
    });
    // webhookConfigured is derived from env at read-time, so just
    // assert the type — the env-set case is covered separately below.
    expect(typeof live.webhookConfigured).toBe("boolean");
  });

  it("reflects a running scheduler with schedulerStarted + nextTickAt populated", async () => {
    const lib = await import("../lib/avri-drift-notifications");
    // Use a long initial delay so the real timer can't fire during the
    // request and mutate the status struct mid-test. The unref'd timer
    // also won't keep the process alive after the suite ends, but
    // afterEach still calls stop() to be tidy.
    scheduler = lib.startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 60_000,
      run: async () => ({ ok: true }),
    });
    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    const live = pickLive(r.body);
    expect(live.schedulerStarted).toBe(true);
    expect(live.startedAt).not.toBeNull();
    expect(live.intervalMs).toBe(60_000);
    expect(live.retryIntervalMs).toBe(5_000);
    expect(live.nextTickAt).not.toBeNull();
    expect(live.ticksCompleted).toBe(0);
    // No tick has fired yet, so the per-tick fields stay null.
    expect(live.lastTickAt).toBeNull();
    expect(live.lastTickOk).toBeNull();
  });

  it("matches the OpenAPI shape exactly — no missing keys, no surprise keys", async () => {
    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);
    const live = pickLive(r.body);
    for (const key of REQUIRED_KEYS) {
      expect(live).toHaveProperty(key);
    }
    // Lock the key set so a future patch that drops the webhook URL,
    // an error message, or a bearer token into the status struct fails
    // here instead of silently leaking on a public endpoint.
    expect(Object.keys(live).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it("does not leak AVRI_DRIFT_WEBHOOK_URL even when the env is set and the scheduler is running", async () => {
    // A realistic-looking secret URL with a credential-shaped path
    // segment so the `not.toContain` checks below fail loudly if any
    // future patch ever serializes the URL into the status struct.
    const sentinelUrl =
      "https://hooks.example-leak-test.invalid/services/T0SECRET/B0SECRET/abcdef1234567890";
    process.env.AVRI_DRIFT_WEBHOOK_URL = sentinelUrl;

    const lib = await import("../lib/avri-drift-notifications");
    scheduler = lib.startDriftNotificationScheduler({
      intervalMs: 60_000,
      retryIntervalMs: 5_000,
      initialDelayMs: 60_000,
      run: async () => ({ ok: true }),
    });

    const r = await request<SchedulerStatusBody>("GET", SCHEDULER_PATH);
    expect(r.status).toBe(200);

    // The boolean projection is fine to expose — the UI uses it to warn
    // when the webhook is missing — but the URL itself must never
    // appear anywhere in the body.
    expect(pickLive(r.body).webhookConfigured).toBe(true);

    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain(sentinelUrl);
    expect(raw).not.toContain("hooks.example-leak-test.invalid");
    expect(raw).not.toContain("T0SECRET");
    expect(raw).not.toContain("B0SECRET");
    expect(raw).not.toContain("abcdef1234567890");
    // No URL-shaped string at all — defends against a future field
    // that quotes a different webhook URL (e.g. a "lastDispatchedTo").
    expect(raw).not.toMatch(/https?:\/\//);
    // And no calibration token either — even though the route is
    // un-gated, a future field that echoed the configured auth token
    // would defeat the whole "no credentials in this body" policy.
    expect(raw).not.toContain(TOKEN);
  });
});

describe("GET /feedback/calibration/avri-drift/notifications/rearm-history", () => {
  it("rejects unauthenticated reads with 401 (strict-auth audit endpoint)", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/avri-drift/notifications/rearm-history",
    );
    expect(r.status).toBe(401);
  });

  it("returns an empty list when no re-arm has occurred yet", async () => {
    const r = await request<RearmHistoryList>(
      "GET",
      "/feedback/calibration/avri-drift/notifications/rearm-history",
      undefined,
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.history).toEqual([]);
    expect(r.body.total).toBe(0);
  });

  it("surfaces audit entries appended by a prior re-arm call", async () => {
    await request<RearmResponse>(
      "POST",
      "/feedback/calibration/avri-drift/notifications/rearm",
      {
        keys: ["2026-04-20|GAP_BELOW_45"],
        reviewer: "bob",
        rationale: "manual re-page",
      },
      AUTH,
    );
    const r = await request<RearmHistoryList>(
      "GET",
      "/feedback/calibration/avri-drift/notifications/rearm-history",
      undefined,
      AUTH,
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.history[0]!.key).toBe("2026-04-20|GAP_BELOW_45");
    expect(r.body.history[0]!.rearmedBy).toBe("bob");
    expect(r.body.history[0]!.rationale).toBe("manual re-page");
  });
});
