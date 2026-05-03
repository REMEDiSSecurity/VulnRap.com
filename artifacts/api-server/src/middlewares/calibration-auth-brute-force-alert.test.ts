import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const warnSpy = vi.fn();
const infoSpy = vi.fn();

vi.mock("../lib/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: (...args: unknown[]) => infoSpy(...args),
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

const TOKEN = "alerter-test-token";
const WRONG_TOKEN = "definitely-not-the-token-PLEASE-REDACT";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

let activeHarness: Harness | null = null;
let restoreLimiter: (() => void) | null = null;
let restoreAlerter: (() => void) | null = null;

interface DispatchCall {
  url: string;
  payload: import("./calibration-auth-brute-force-alert").BruteForceAlertPayload;
}

interface HarnessOpts {
  limiterMax?: number;
  alertThreshold?: number;
  alertWindowMs?: number;
  webhookUrl?: string;
  runbookUrl?: string;
  now?: () => number;
}

interface HarnessHandles {
  base: Harness;
  dispatchCalls: DispatchCall[];
  flushAlerter: () => Promise<void>;
}

async function startHarness(opts: HarnessOpts = {}): Promise<HarnessHandles> {
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
    max: opts.limiterMax ?? 1000,
  });
  __setCalibrationAuthLimiterForTests(limiter);
  restoreLimiter = () => __setCalibrationAuthLimiterForTests(null);

  const dispatchCalls: DispatchCall[] = [];
  const alerter = createBruteForceAlerter({
    windowMs: opts.alertWindowMs ?? 60_000,
    threshold: opts.alertThreshold ?? 3,
    webhookUrl: opts.webhookUrl ?? "https://example.test/hook",
    runbookUrl: opts.runbookUrl ?? "https://example.test/runbook",
    now: opts.now,
    dispatch: async (url, payload) => {
      dispatchCalls.push({ url, payload });
      return { ok: true, status: 200 };
    },
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
    base: {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    },
    dispatchCalls,
    flushAlerter: () => alerter.flushPending(),
  };
}

let tmpStateDir: string | null = null;

beforeEach(() => {
  warnSpy.mockClear();
  infoSpy.mockClear();
  // Pin every alerter built in this suite to a per-test scratch dir so
  // unit tests never touch the shipped
  // artifacts/api-server/data/calibration-auth-brute-force-state.json.
  tmpStateDir = mkdtempSync(path.join(tmpdir(), "bf-alert-state-"));
  process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH = path.join(
    tmpStateDir,
    "state.json",
  );
});

afterEach(async () => {
  if (restoreAlerter) {
    restoreAlerter();
    restoreAlerter = null;
  }
  if (restoreLimiter) {
    restoreLimiter();
    restoreLimiter = null;
  }
  if (activeHarness) {
    await activeHarness.close();
    activeHarness = null;
  }
  delete process.env.CALIBRATION_TOKEN;
  delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL;
  delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD;
  delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS;
  delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_RUNBOOK_URL;
  delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH;
  delete process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS;
  delete process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES;
  if (tmpStateDir !== null) {
    rmSync(tmpStateDir, { recursive: true, force: true });
    tmpStateDir = null;
  }
});

describe("threshold crossing dispatches a webhook", () => {
  it("does not dispatch below threshold", async () => {
    const h = await startHarness({ alertThreshold: 5 });
    activeHarness = h.base;

    for (let i = 0; i < 4; i++) {
      const r = await request(
        h.base.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { "X-Calibration-Token": WRONG_TOKEN },
        { phrase: `i=${i}` },
      );
      expect(r.status).toBe(401);
    }
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(0);
  });

  it("dispatches once with a payload that names the IP, threshold, window, and runbook", async () => {
    const h = await startHarness({ alertThreshold: 3 });
    activeHarness = h.base;

    for (let i = 0; i < 3; i++) {
      const r = await request(
        h.base.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { "X-Calibration-Token": WRONG_TOKEN },
        { phrase: `i=${i}` },
      );
      expect(r.status).toBe(401);
    }
    await h.flushAlerter();

    expect(h.dispatchCalls.length).toBe(1);
    const [call] = h.dispatchCalls;
    expect(call.url).toBe("https://example.test/hook");
    expect(call.payload.event).toBe("calibration_auth_brute_force");
    expect(call.payload.threshold).toBe(3);
    expect(call.payload.windowMs).toBe(60_000);
    expect(call.payload.wrongTokenCount).toBe(3);
    expect(call.payload.rejectionsByStatus).toEqual({ "401": 3, "429": 0 });
    expect(call.payload.rejectionsByGate.mutation).toBe(3);
    expect(call.payload.lastRoute).toBe(
      "/feedback/calibration/handwavy-phrases",
    );
    expect(call.payload.lastMethod).toBe("POST");
    expect(call.payload.runbookUrl).toBe("https://example.test/runbook");
    const actionsBlob = call.payload.recommendedActions.join("\n");
    expect(actionsBlob).toMatch(/rotate calibration_token/i);
    expect(actionsBlob).toMatch(/block the offending ip/i);
    expect(typeof call.payload.ip).toBe("string");
    expect(call.payload.ip.length).toBeGreaterThan(0);
  });

  it("counts 429s alongside 401s toward the threshold", async () => {
    const h = await startHarness({ limiterMax: 2, alertThreshold: 3 });
    activeHarness = h.base;

    const r1 = await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "1" },
    );
    expect(r1.status).toBe(401);
    const r2 = await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "2" },
    );
    expect(r2.status).toBe(401);
    const r3 = await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "3" },
    );
    expect(r3.status).toBe(429);

    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);
    const payload = h.dispatchCalls[0]!.payload;
    expect(payload.rejectionsByStatus).toEqual({ "401": 2, "429": 1 });
    expect(payload.wrongTokenCount).toBe(3);
  });

  it("does not dispatch on a correct-token request", async () => {
    const h = await startHarness({ alertThreshold: 1 });
    activeHarness = h.base;

    const r = await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": TOKEN },
      { phrase: "x" },
    );
    expect(r.status).toBe(200);
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(0);
  });
});

describe("strict-read 401s also count toward the per-IP threshold", () => {
  it("a strict-read GET 401 increments the same counter as a mutation POST 401", async () => {
    const h = await startHarness({ alertThreshold: 2 });
    activeHarness = h.base;

    const r1 = await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "x" },
    );
    expect(r1.status).toBe(401);
    const r2 = await request(
      h.base.baseUrl,
      "GET",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
    );
    expect(r2.status).toBe(401);

    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);
    const payload = h.dispatchCalls[0]!.payload;
    expect(payload.wrongTokenCount).toBe(2);
    expect(payload.rejectionsByGate).toMatchObject({
      mutation: 1,
      "strict-read": 1,
    });
  });
});

describe("per-IP dedup within the alert window", () => {
  it("does not re-fire on subsequent failures within the same window", async () => {
    const h = await startHarness({ alertThreshold: 2 });
    activeHarness = h.base;

    for (let i = 0; i < 5; i++) {
      await request(
        h.base.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { "X-Calibration-Token": WRONG_TOKEN },
        { phrase: `i=${i}` },
      );
    }
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);
  });

  it("re-fires for the same IP after the cooldown window lapses", async () => {
    let mockNow = 1_000_000;
    const tickClock = (deltaMs: number) => {
      mockNow += deltaMs;
    };
    const h = await startHarness({
      alertThreshold: 2,
      alertWindowMs: 1_000,
      now: () => mockNow,
    });
    activeHarness = h.base;

    await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "a" },
    );
    await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "b" },
    );
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);

    await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "c" },
    );
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);

    tickClock(2_000);

    await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "d" },
    );
    await request(
      h.base.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { "X-Calibration-Token": WRONG_TOKEN },
      { phrase: "e" },
    );
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(2);
  });
});

describe("webhook URL is optional", () => {
  it("emits a structured warn log even when no webhook URL is configured", async () => {
    const h = await startHarness({ alertThreshold: 2, webhookUrl: "" });
    activeHarness = h.base;

    for (let i = 0; i < 2; i++) {
      await request(
        h.base.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { "X-Calibration-Token": WRONG_TOKEN },
        { phrase: `i=${i}` },
      );
    }
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(0);

    const alertWarn = warnSpy.mock.calls.find(
      ([, msg]) =>
        typeof msg === "string" &&
        msg === "calibration auth: brute-force probe threshold crossed",
    );
    expect(alertWarn).toBeDefined();
    const fields = alertWarn![0] as Record<string, unknown>;
    expect(fields.threshold).toBe(2);
    expect(fields.webhookConfigured).toBe(false);
    expect(typeof fields.ip).toBe("string");
  });
});

describe("env var defaults inherit the limiter knobs", () => {
  it("defaults alert window/threshold to CALIBRATION_AUTH_RATE_LIMIT_*", async () => {
    process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS = "30000";
    process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES = "7";

    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    let captured: { url: string; payload: unknown } | null = null;
    const alerter = createBruteForceAlerter({
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async (url, payload) => {
        captured = { url, payload };
        return { ok: true, status: 200 };
      },
    });

    for (let i = 0; i < 7; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/feedback/calibration/handwavy-phrases",
        method: "POST",
        ip: "203.0.113.99",
      });
    }
    await alerter.flushPending();

    expect(captured).not.toBeNull();
    const payload = captured!.payload as {
      windowMs: number;
      threshold: number;
      ip: string;
    };
    expect(payload.windowMs).toBe(30_000);
    expect(payload.threshold).toBe(7);
    expect(payload.ip).toBe("203.0.113.99");
  });

  it("CALIBRATION_AUTH_BRUTE_FORCE_* env vars override the limiter defaults", async () => {
    process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS = "30000";
    process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES = "7";
    process.env.CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS = "120000";
    process.env.CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD = "20";

    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    let captured: { payload: { windowMs: number; threshold: number } } | null =
      null;
    const alerter = createBruteForceAlerter({
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async (_url, payload) => {
        captured = { payload };
        return { ok: true, status: 200 };
      },
    });

    for (let i = 0; i < 20; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/feedback/calibration/handwavy-phrases",
        method: "POST",
        ip: "198.51.100.4",
      });
    }
    await alerter.flushPending();

    expect(captured).not.toBeNull();
    expect(captured!.payload.windowMs).toBe(120_000);
    expect(captured!.payload.threshold).toBe(20);
  });

  it("re-reads the webhook URL env on every alert decision", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    const calls: string[] = [];
    let mockNow = 1_000_000;
    const tickClock = (deltaMs: number) => {
      mockNow += deltaMs;
    };
    const alerter = createBruteForceAlerter({
      threshold: 2,
      windowMs: 1_000,
      now: () => mockNow,
      runbookUrl: "https://example.test/runbook",
      // Intentionally omit webhookUrl so the env is consulted per alert.
      dispatch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200 };
      },
    });

    // First alert: env unset → no dispatch attempt.
    delete process.env.CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL;
    for (let i = 0; i < 2; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "203.0.113.50",
      });
    }
    await alerter.flushPending();
    expect(calls.length).toBe(0);

    // Operator now sets the env. The very next alert (after cooldown lapses)
    // must dispatch without restarting the process.
    tickClock(5_000);
    process.env.CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL =
      "https://example.test/late-hook";
    for (let i = 0; i < 2; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "203.0.113.50",
      });
    }
    await alerter.flushPending();
    expect(calls).toEqual(["https://example.test/late-hook"]);
  });
});

describe("different IPs get independent counters", () => {
  it("two IPs that each cross the threshold each get their own alert", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    const calls: Array<{ ip: string; count: number }> = [];
    const alerter = createBruteForceAlerter({
      threshold: 2,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async (_url, payload) => {
        calls.push({ ip: payload.ip, count: payload.wrongTokenCount });
        return { ok: true, status: 200 };
      },
    });

    for (const ip of ["10.0.0.1", "10.0.0.2"]) {
      for (let i = 0; i < 2; i++) {
        alerter.recordWrongTokenEvent({
          status: 401,
          gate: "mutation",
          route: "/feedback/calibration/handwavy-phrases",
          method: "POST",
          ip,
        });
      }
    }
    await alerter.flushPending();

    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.ip).sort()).toEqual(["10.0.0.1", "10.0.0.2"]);
    for (const c of calls) expect(c.count).toBe(2);
  });

  it("ignores events with no source IP", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    const calls: unknown[] = [];
    const alerter = createBruteForceAlerter({
      threshold: 1,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async (_url, payload) => {
        calls.push(payload);
        return { ok: true, status: 200 };
      },
    });
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: null,
    });
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "",
    });
    await alerter.flushPending();
    expect(calls.length).toBe(0);
  });
});

describe("the presented (wrong) token never appears in the dispatched payload", () => {
  it("neither the wrong token nor the configured token leaks into the payload", async () => {
    const h = await startHarness({ alertThreshold: 2 });
    activeHarness = h.base;

    for (let i = 0; i < 3; i++) {
      await request(
        h.base.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        {
          "X-Calibration-Token": WRONG_TOKEN,
          Authorization: `Bearer ${WRONG_TOKEN}`,
        },
        { phrase: `i=${i}` },
      );
    }
    await h.flushAlerter();
    expect(h.dispatchCalls.length).toBe(1);
    const serialized = JSON.stringify(h.dispatchCalls[0]);
    expect(serialized).not.toContain(WRONG_TOKEN);
    expect(serialized).not.toContain(TOKEN);
  });
});

describe("a thrown dispatcher does not crash the request", () => {
  it("catches the throw and leaves the IP in cooldown so it isn't re-tried for this window", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    let dispatchCount = 0;
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async () => {
        dispatchCount += 1;
        throw new Error("simulated network blowup");
      },
    });

    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "192.0.2.7",
    });
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "192.0.2.7",
    });
    await alerter.flushPending();
    expect(dispatchCount).toBe(1);
  });
});

describe("per-IP cooldown is persisted across process restarts (Task #400)", () => {
  it("a fresh alerter rebuilt with the same state path does not re-fire for an IP still inside its cooldown window", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    let mockNow = 1_000_000;
    const tick = (deltaMs: number) => {
      mockNow += deltaMs;
    };

    // -- Process #1: cross the threshold so the cooldown is recorded.
    const callsA: string[] = [];
    const alerterA = createBruteForceAlerter({
      threshold: 2,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async (_url, payload) => {
        callsA.push(payload.ip);
        return { ok: true, status: 200 };
      },
    });
    for (let i = 0; i < 2; i++) {
      alerterA.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "203.0.113.42",
      });
    }
    await alerterA.flushPending();
    expect(callsA).toEqual(["203.0.113.42"]);

    // The state file should now exist and carry the cooldown stamp.
    const statePath = process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH!;
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      perIp: Array<{ ip: string; lastAlertedAt: number }>;
    };
    expect(persisted.perIp).toEqual([
      { ip: "203.0.113.42", lastAlertedAt: 1_000_000 },
    ]);

    // -- Simulated restart: advance the clock a little (still well
    // inside the cooldown window) and build a brand-new alerter that
    // shares the persisted state file.
    tick(5_000);
    const callsB: string[] = [];
    const alerterB = createBruteForceAlerter({
      threshold: 2,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async (_url, payload) => {
        callsB.push(payload.ip);
        return { ok: true, status: 200 };
      },
    });
    for (let i = 0; i < 4; i++) {
      alerterB.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "203.0.113.42",
      });
    }
    await alerterB.flushPending();
    // No re-page across the restart: cooldown survived.
    expect(callsB).toEqual([]);
  });

  it("once the cooldown window has elapsed after a restart, the same IP can re-fire", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    let mockNow = 2_000_000;
    const tick = (deltaMs: number) => {
      mockNow += deltaMs;
    };

    const callsA: string[] = [];
    const alerterA = createBruteForceAlerter({
      threshold: 2,
      windowMs: 1_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async (_url, payload) => {
        callsA.push(payload.ip);
        return { ok: true, status: 200 };
      },
    });
    for (let i = 0; i < 2; i++) {
      alerterA.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "198.51.100.7",
      });
    }
    await alerterA.flushPending();
    expect(callsA.length).toBe(1);

    // Restart well after the cooldown window has expired.
    tick(60_000);

    const callsB: string[] = [];
    const alerterB = createBruteForceAlerter({
      threshold: 2,
      windowMs: 1_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async (_url, payload) => {
        callsB.push(payload.ip);
        return { ok: true, status: 200 };
      },
    });
    for (let i = 0; i < 2; i++) {
      alerterB.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: "198.51.100.7",
      });
    }
    await alerterB.flushPending();
    // Cooldown window has lapsed, so the IP is allowed to re-page.
    expect(callsB).toEqual(["198.51.100.7"]);
  });

  it("statePath: null disables persistence (memory-only alerter)", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    const calls: string[] = [];
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      statePath: null,
      dispatch: async (_url, payload) => {
        calls.push(payload.ip);
        return { ok: true, status: 200 };
      },
    });
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "192.0.2.99",
    });
    await alerter.flushPending();
    expect(calls).toEqual(["192.0.2.99"]);

    // The per-test scratch file should not have been touched.
    const statePath = process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH!;
    expect(existsSync(statePath)).toBe(false);
  });

  it("per-IP cooldown records are capped on disk by persistHistoryLimit (oldest dropped first)", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");

    let mockNow = 5_000_000;
    const tick = (deltaMs: number) => {
      mockNow += deltaMs;
    };

    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      persistHistoryLimit: 2,
      now: () => mockNow,
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip,
      });
      tick(1_000);
    }
    await alerter.flushPending();

    const statePath = process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH!;
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      perIp: Array<{ ip: string; lastAlertedAt: number }>;
    };
    // Three IPs alerted, capped at two persisted records, oldest (10.0.0.1) dropped.
    expect(persisted.perIp.length).toBe(2);
    const ips = persisted.perIp.map((r) => r.ip).sort();
    expect(ips).toEqual(["10.0.0.2", "10.0.0.3"]);
  });
});

// Task #399 — the alerter exposes an in-memory ring buffer of
// dispatched alerts so the calibration UI can show "what just
// tripped" without scraping pino logs.
describe("recentAlerts() ring buffer", () => {
  it("returns an empty list before any threshold has been crossed", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    const alerter = createBruteForceAlerter({
      threshold: 3,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    expect(alerter.recentAlerts()).toEqual([]);

    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "192.0.2.10",
    });
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "192.0.2.10",
    });
    await alerter.flushPending();
    // Two events with threshold=3 should still be empty.
    expect(alerter.recentAlerts()).toEqual([]);
  });

  it("records each dispatched alert with the same fields the webhook payload carries", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    let mockNow = 5_000_000;
    const alerter = createBruteForceAlerter({
      threshold: 2,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/feedback/calibration/handwavy-phrases",
      method: "POST",
      ip: "203.0.113.42",
    });
    mockNow += 100;
    alerter.recordWrongTokenEvent({
      status: 429,
      gate: "strict-read",
      route: "/feedback/calibration/handwavy-phrases",
      method: "GET",
      ip: "203.0.113.42",
    });
    await alerter.flushPending();

    const alerts = alerter.recentAlerts();
    expect(alerts.length).toBe(1);
    const [entry] = alerts;
    expect(entry.ip).toBe("203.0.113.42");
    expect(entry.threshold).toBe(2);
    expect(entry.windowMs).toBe(60_000);
    expect(entry.wrongTokenCount).toBe(2);
    expect(entry.rejectionsByStatus).toEqual({ "401": 1, "429": 1 });
    expect(entry.rejectionsByGate).toEqual({ mutation: 1, "strict-read": 1 });
    expect(entry.lastRoute).toBe("/feedback/calibration/handwavy-phrases");
    expect(entry.lastMethod).toBe("GET");
    expect(entry.runbookUrl).toBe("https://example.test/runbook");
    expect(entry.detectedAt).toBe(new Date(5_000_100).toISOString());
    expect(entry.firstSeenAt).toBe(new Date(5_000_000).toISOString());
    expect(entry.lastSeenAt).toBe(new Date(5_000_100).toISOString());
  });

  it("records the alert even when no webhook is configured (so the UI panel still shows it)", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "",
      runbookUrl: "https://example.test/runbook",
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "203.0.113.50",
    });
    await alerter.flushPending();

    const alerts = alerter.recentAlerts();
    expect(alerts.length).toBe(1);
    expect(alerts[0].ip).toBe("203.0.113.50");
  });

  it("returns alerts newest-first regardless of the order they fired", async () => {
    const { createBruteForceAlerter } =
      await import("./calibration-auth-brute-force-alert");
    let mockNow = 1_000_000;
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "203.0.113.1",
    });
    mockNow += 1_000;
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "203.0.113.2",
    });
    mockNow += 1_000;
    alerter.recordWrongTokenEvent({
      status: 401,
      gate: "mutation",
      route: "/x",
      method: "POST",
      ip: "203.0.113.3",
    });
    await alerter.flushPending();

    const alerts = alerter.recentAlerts();
    expect(alerts.map((a) => a.ip)).toEqual([
      "203.0.113.3",
      "203.0.113.2",
      "203.0.113.1",
    ]);
  });

  it("honors the limit argument and clamps it to the buffer size", async () => {
    const { createBruteForceAlerter, __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS } =
      await import("./calibration-auth-brute-force-alert");
    let mockNow = 1_000_000;
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async () => ({ ok: true, status: 200 }),
    });

    for (let i = 0; i < 5; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: `203.0.113.${i + 1}`,
      });
      mockNow += 1_000;
    }
    await alerter.flushPending();

    expect(alerter.recentAlerts(3).length).toBe(3);
    // Default limit (no arg) returns the configured default cap.
    expect(alerter.recentAlerts().length).toBe(
      Math.min(
        5,
        __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS.recentAlertsDefaultLimit,
      ),
    );
    // Asking for more than what's in the buffer returns whatever is available
    // (capped by the configured buffer size).
    const huge = alerter.recentAlerts(1_000_000);
    expect(huge.length).toBeLessThanOrEqual(
      __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS.recentAlertsBufferSize,
    );
    expect(huge.length).toBe(5);
    // Bad limits (zero/negative/NaN) fall back to the default.
    expect(alerter.recentAlerts(0).length).toBe(
      Math.min(
        5,
        __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS.recentAlertsDefaultLimit,
      ),
    );
    expect(alerter.recentAlerts(-3).length).toBe(
      Math.min(
        5,
        __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS.recentAlertsDefaultLimit,
      ),
    );
  });

  it("evicts the oldest entry once the buffer fills up (FIFO)", async () => {
    const { createBruteForceAlerter, __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS } =
      await import("./calibration-auth-brute-force-alert");
    let mockNow = 1_000_000;
    const alerter = createBruteForceAlerter({
      threshold: 1,
      windowMs: 60_000,
      webhookUrl: "https://example.test/hook",
      runbookUrl: "https://example.test/runbook",
      now: () => mockNow,
      dispatch: async () => ({ ok: true, status: 200 }),
    });
    const cap = __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS.recentAlertsBufferSize;
    // Fire one more alert than the buffer can hold.
    for (let i = 0; i < cap + 1; i++) {
      alerter.recordWrongTokenEvent({
        status: 401,
        gate: "mutation",
        route: "/x",
        method: "POST",
        ip: `198.51.100.${(i % 250) + 1}`,
      });
      mockNow += 1_000;
    }
    await alerter.flushPending();

    const all = alerter.recentAlerts(cap + 10);
    expect(all.length).toBe(cap);
    // Newest IP should be at the head; the very first IP should have
    // been evicted by the cap+1th push.
    expect(all[0].ip).toBe(`198.51.100.${(cap % 250) + 1}`);
    expect(all.find((a) => a.ip === "198.51.100.1")).toBeUndefined();
  });
});
