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
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const baseHeaders: Record<string, string> = data
      ? { "Content-Type": "application/json", "Content-Length": String(data.length) }
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

interface RearmResponse {
  rearmed: number;
  notFound: string[];
  remaining: number;
  removed: Array<{ key: string }>;
  notified: Array<{ key: string }>;
  error?: string;
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
    expect(r.body.removed.map((rm) => rm.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
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
        keys: [
          "2026-04-20|GAP_BELOW_45",
          "2099-01-01|GAP_BELOW_45",
        ],
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
});
