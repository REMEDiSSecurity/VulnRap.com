// Task #213 — verify the calibration auth gate emits structured warn-level
// logs for every wrong-token rejection (401) and every throttled bucket
// rejection (429), so an operator can spot brute-force probes in the
// standard pino log stream.
//
// The logged record MUST include the request IP, the originalUrl route,
// and the HTTP method. The 429 record MUST additionally include the
// bucket's configured windowMs/max. The presented (wrong) token value
// MUST never appear anywhere in the log payload — that's the security
// guarantee that lets us safely emit these logs at warn level.
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const warnSpy = vi.fn();

vi.mock("../lib/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: () => {},
    error: () => {},
    debug: () => {},
  },
}));

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  baseUrl: string,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
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

const TOKEN = "logging-test-token";
const WRONG_TOKEN = "definitely-not-the-token-PLEASE-REDACT";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

let activeHarness: Harness | null = null;
let restoreLimiter: (() => void) | null = null;
let restoreAlerter: (() => void) | null = null;

async function startHarness(opts: { max?: number } = {}): Promise<Harness> {
  process.env.CALIBRATION_TOKEN = TOKEN;

  const {
    requireCalibrationAuth,
    requireCalibrationAuthStrict,
    __setCalibrationAuthLimiterForTests,
  } = await import("./require-calibration-auth");
  const { createCalibrationAuthLimiter } =
    await import("./calibration-auth-rate-limit");
  const { createBruteForceAlerter, __setBruteForceAlerterForTests } =
    await import("./calibration-auth-brute-force-alert");

  const limiter = createCalibrationAuthLimiter({
    windowMs: 60_000,
    max: opts.max ?? 3,
  });
  __setCalibrationAuthLimiterForTests(limiter);
  restoreLimiter = () => __setCalibrationAuthLimiterForTests(null);

  // Inject a fresh brute-force alerter per harness so cumulative wrong-token
  // events from earlier tests in this file can't push the alerter past its
  // default threshold (10) mid-test and emit an unexpected
  // "brute-force probe threshold crossed" warn that would inflate warnSpy
  // call counts. statePath:null keeps tests off the shipped JSON state file.
  const alerter = createBruteForceAlerter({
    windowMs: 60_000,
    threshold: 1_000_000,
    webhookUrl: "",
    statePath: null,
  });
  __setBruteForceAlerterForTests(alerter);
  restoreAlerter = () => __setBruteForceAlerterForTests(null);

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.post(
    "/feedback/calibration/handwavy-phrases",
    requireCalibrationAuth,
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.delete(
    "/feedback/calibration/handwavy-phrases",
    requireCalibrationAuth,
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.get(
    "/feedback/calibration/handwavy-phrases",
    requireCalibrationAuthStrict,
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeEach(() => {
  warnSpy.mockClear();
});

afterEach(async () => {
  if (restoreLimiter) {
    restoreLimiter();
    restoreLimiter = null;
  }
  if (restoreAlerter) {
    restoreAlerter();
    restoreAlerter = null;
  }
  if (activeHarness) {
    await activeHarness.close();
    activeHarness = null;
  }
  delete process.env.CALIBRATION_TOKEN;
});

describe("Task #213 — wrong-token 401s on the mutation gate are logged", () => {
  it("emits a structured warn log with ip/route/method on a wrong-token POST", async () => {
    activeHarness = await startHarness({ max: 10 });
    const r = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "x" },
    );
    expect(r.status).toBe(401);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = warnSpy.mock.calls[0];
    expect(msg).toBe("calibration auth: wrong-token attempt rejected (401)");
    expect(fields).toMatchObject({
      route: "/feedback/calibration/handwavy-phrases",
      method: "POST",
      gate: "mutation",
    });
    expect(typeof fields.ip === "string" || fields.ip === null).toBe(true);
  });

  it("emits a warn log even when no token header is present at all", async () => {
    activeHarness = await startHarness({ max: 10 });
    const r = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      {},
      { phrase: "x" },
    );
    expect(r.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields] = warnSpy.mock.calls[0];
    expect(fields.gate).toBe("mutation");
    expect(fields.method).toBe("POST");
  });

  it("captures the originalUrl for DELETE mutations too", async () => {
    activeHarness = await startHarness({ max: 10 });
    const r = await request<{ error: string }>(
      activeHarness.baseUrl,
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { Authorization: `Bearer ${WRONG_TOKEN}` },
      { phrase: "x" },
    );
    expect(r.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields] = warnSpy.mock.calls[0];
    expect(fields.method).toBe("DELETE");
    expect(fields.route).toBe("/feedback/calibration/handwavy-phrases");
  });

  it("does NOT log when the correct token is presented", async () => {
    activeHarness = await startHarness({ max: 10 });
    const r = await request<{ ok: boolean }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": TOKEN },
      { phrase: "x" },
    );
    expect(r.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("Task #213 — strict-read 401s are also logged", () => {
  it("logs a strict-read rejection with gate='strict-read'", async () => {
    activeHarness = await startHarness({ max: 10 });
    const r = await request<{ error: string }>(
      activeHarness.baseUrl,
      "GET",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
    );
    expect(r.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = warnSpy.mock.calls[0];
    expect(msg).toBe("calibration auth: wrong-token attempt rejected (401)");
    expect(fields.gate).toBe("strict-read");
    expect(fields.method).toBe("GET");
  });
});

describe("Task #213 — 429s from the throttle are logged with bucket window/limit", () => {
  it("emits a structured warn log including windowMs and max when the bucket trips", async () => {
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });

    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { "X-Calibration-Token": WRONG_TOKEN },
        { phrase: `attempt ${i}` },
      );
      expect(r.status).toBe(401);
    }
    // Each 401 above produced a "401" log; clear so we can assert the
    // throttle log alone.
    expect(warnSpy.mock.calls.length).toBe(MAX);
    warnSpy.mockClear();

    const blocked = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "boom" },
    );
    expect(blocked.status).toBe(429);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = warnSpy.mock.calls[0];
    expect(msg).toBe("calibration auth: wrong-token throttle triggered (429)");
    expect(fields).toMatchObject({
      route: "/feedback/calibration/handwavy-phrases",
      method: "POST",
      windowMs: 60_000,
      max: MAX,
    });
  });
});

describe("Task #213 — the presented (wrong) token value is NEVER logged", () => {
  it("the secret token does not appear in any 401 or 429 log payload", async () => {
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });

    // Trigger MAX 401s and one 429 — burn all rejection paths.
    for (let i = 0; i < MAX + 1; i++) {
      await request<unknown>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        {
          "X-Calibration-Token": WRONG_TOKEN,
          Authorization: `Bearer ${WRONG_TOKEN}`,
        },
        { phrase: `bad ${i}` },
      );
    }
    // And a strict-read 401 too.
    await request<unknown>(
      activeHarness.baseUrl,
      "GET",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
    );

    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(MAX + 2);
    for (const [fields, msg] of warnSpy.mock.calls) {
      const serialized = JSON.stringify(fields ?? {}) + " " + String(msg ?? "");
      expect(serialized).not.toContain(WRONG_TOKEN);
    }
  });
});
