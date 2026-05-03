// Task #116 — verify the wrong-token throttle on /feedback/calibration
// mutation routes. Together with require-calibration-auth.ts (Task #113), the
// throttle ensures the reviewer-token gate cannot be brute-forced at the
// rate the server can answer requests.
//
// The throttle is integrated into requireCalibrationAuth's failure path, so
// only wrong-token requests touch the limiter. Correct-token requests bypass
// it entirely — a legitimate reviewer who shares an IP with an attacker
// (NAT, office network) is never throttled. These tests exercise that
// guarantee end-to-end through the real calibration router.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

const TOKEN = "s3cret-throttle-token";

interface HttpResponse<T> {
  status: number;
  body: T;
  headers: http.IncomingHttpHeaders;
}

function request<T>(
  baseUrl: string,
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
    if (data) req.write(data);
    req.end();
  });
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

interface HarnessOptions {
  windowMs?: number;
  max?: number;
  /**
   * When true, the limiter is constructed with no explicit options so it
   * falls back to the env-var defaults — this is how we exercise the
   * tunable knobs end-to-end.
   */
  useEnvDefaults?: boolean;
}

let activeHarness: Harness | null = null;
let restoreLimiter: (() => void) | null = null;
let restoreAlerter: (() => void) | null = null;

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "calibration-throttle-"),
  );
  const phrasesPath = path.join(tmpDir, "handwavy-phrases.json");
  const seed = JSON.stringify(
    {
      _meta: { description: "throttle-test fixture" },
      phrases: ["seed phrase one", "seed phrase two"],
    },
    null,
    2,
  );
  await fs.writeFile(phrasesPath, seed, "utf8");

  process.env.HANDWAVY_PHRASES_PATH = phrasesPath;
  process.env.CALIBRATION_TOKEN = TOKEN;

  const calibrationRouter = (await import("./calibration")).default;
  const handwavy = await import("../lib/engines/avri/handwavy-phrases");
  handwavy.__resetHandwavyPhrasesForTests();
  const { createCalibrationAuthLimiter } =
    await import("../middlewares/calibration-auth-rate-limit");
  const { __setCalibrationAuthLimiterForTests } =
    await import("../middlewares/require-calibration-auth");

  // Inject a fresh limiter into the auth middleware so its in-memory hit
  // store is isolated from every other test. Without this, the lazy
  // singleton inside require-calibration-auth.ts would carry counts
  // between tests.
  const limiter = opts.useEnvDefaults
    ? createCalibrationAuthLimiter()
    : createCalibrationAuthLimiter({
        windowMs: opts.windowMs ?? 60_000,
        max: opts.max ?? 3,
      });
  __setCalibrationAuthLimiterForTests(limiter);
  restoreLimiter = () => __setCalibrationAuthLimiterForTests(null);

  // Task #761 — inject a fresh per-test brute-force alerter (with a
  // threshold high enough to never fire) so the many wrong-token 401s
  // these tests generate cannot accumulate on the lazy singleton and
  // emit unexpected "calibration auth: brute-force probe threshold
  // crossed" warns that bleed into other test files. Mirrors the
  // isolation pattern used in calibration-auth-logging.test.ts.
  const { createBruteForceAlerter, __setBruteForceAlerterForTests } =
    await import("../middlewares/calibration-auth-brute-force-alert");
  const alerter = createBruteForceAlerter({
    windowMs: 60_000,
    threshold: 1_000_000,
    webhookUrl: "",
    statePath: null,
  });
  __setBruteForceAlerterForTests(alerter);
  restoreAlerter = () => __setBruteForceAlerterForTests(null);

  const app = express();
  app.use(express.json());
  app.use(calibrationRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { baseUrl, close };
}

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

describe("Task #116 — wrong-token attempts on calibration mutations are throttled", () => {
  it("returns 401 for the first MAX wrong-token attempts and then 429", async () => {
    const MAX = 3;
    activeHarness = await startHarness({ max: MAX });
    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: `attempt ${i}` },
        { "X-Calibration-Token": "wrong" },
      );
      expect(r.status).toBe(401);
    }
    const blocked = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "should be throttled" },
      { "X-Calibration-Token": "wrong" },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);
    // Standard rate-limit headers should be present.
    expect(blocked.headers["ratelimit-limit"]).toBeDefined();
  });

  it("the throttle covers DELETE as well as POST mutation routes", async () => {
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });
    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase one" },
        { "X-Calibration-Token": "wrong" },
      );
      expect(r.status).toBe(401);
    }
    const blocked = await request<{ error: string }>(
      activeHarness.baseUrl,
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one" },
      { "X-Calibration-Token": "wrong" },
    );
    expect(blocked.status).toBe(429);
  });

  it("throttle applies even when the token header is missing entirely (no header == failed auth)", async () => {
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });
    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: `no-header attempt ${i}` },
      );
      expect(r.status).toBe(401);
    }
    const blocked = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "should be throttled" },
    );
    expect(blocked.status).toBe(429);
  });
});

describe("Task #116 — successful authenticated calls are NEVER throttled", () => {
  it("a long run of successful authenticated POSTs never trips the limiter", async () => {
    const MAX = 3;
    activeHarness = await startHarness({ max: MAX });
    for (let i = 0; i < MAX * 5; i++) {
      const r = await request<{ added: boolean; phrase: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: `legit phrase ${i}` },
        { "X-Calibration-Token": TOKEN },
      );
      // Either created (201) or duplicate (200); never 401 or 429.
      expect(r.status).not.toBe(429);
      expect(r.status).not.toBe(401);
    }
  });

  it("a correct-token request still succeeds even after the wrong-token bucket is exhausted from the same IP", async () => {
    // This is the headline acceptance criterion: a legitimate reviewer
    // sharing an IP with an attacker (NAT, office Wi-Fi) MUST keep working.
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });

    // Burn through the bucket with wrong-token attempts.
    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: `attempt ${i}` },
        { "X-Calibration-Token": "still-wrong" },
      );
      expect(r.status).toBe(401);
    }
    // One more wrong-token attempt is throttled — bucket confirmed exhausted.
    const throttled = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "wrong attempt over the cap" },
      { "X-Calibration-Token": "still-wrong" },
    );
    expect(throttled.status).toBe(429);

    // The correct-token reviewer must STILL succeed — never see 429 or 401.
    const ok = await request<{ added: boolean; phrase: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "legit reviewer phrase after throttle" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(ok.status).not.toBe(429);
    expect(ok.status).not.toBe(401);
    expect([200, 201]).toContain(ok.status);
    expect(ok.body.phrase).toBe("legit reviewer phrase after throttle");

    // And subsequent correct-token calls stay unaffected too.
    const ok2 = await request<{ added: boolean }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "another legit reviewer phrase" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(ok2.status).not.toBe(429);
    expect(ok2.status).not.toBe(401);
  });

  it("validation errors (400) with a valid token never burn the bucket", async () => {
    const MAX = 3;
    activeHarness = await startHarness({ max: MAX });
    // Send malformed payloads with a valid token; the route returns 400 but
    // the limiter must not see them at all (correct token bypasses limiter).
    for (let i = 0; i < MAX * 3; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "" }, // empty phrase fails route-level validation
        { "X-Calibration-Token": TOKEN },
      );
      expect(r.status).not.toBe(429);
      expect(r.status).not.toBe(401);
      expect([200, 201, 400]).toContain(r.status);
    }
    // After all those 400s, the bucket should still have its full
    // wrong-token allowance intact.
    for (let i = 0; i < MAX; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: `wrong attempt ${i}` },
        { "X-Calibration-Token": "still-wrong" },
      );
      expect(r.status).toBe(401);
    }
    const blocked = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "after the bucket is empty" },
      { "X-Calibration-Token": "still-wrong" },
    );
    expect(blocked.status).toBe(429);
  });
});

describe("Task #116 — limiter is tunable", () => {
  it("respects an explicit max=1 — the second wrong-token attempt is 429", async () => {
    activeHarness = await startHarness({ max: 1 });
    const first = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "x" },
      { "X-Calibration-Token": "wrong" },
    );
    expect(first.status).toBe(401);
    const second = await request<{ error: string }>(
      activeHarness.baseUrl,
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "y" },
      { "X-Calibration-Token": "wrong" },
    );
    expect(second.status).toBe(429);
  });

  it("picks up CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES from env when no opts are passed", async () => {
    const ORIG_WIN = process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS;
    const ORIG_MAX = process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES;
    process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES = "2";
    try {
      activeHarness = await startHarness({ useEnvDefaults: true });
      for (let i = 0; i < 2; i++) {
        const r = await request<{ error: string }>(
          activeHarness.baseUrl,
          "POST",
          "/feedback/calibration/handwavy-phrases",
          { phrase: `attempt ${i}` },
          { "X-Calibration-Token": "wrong" },
        );
        expect(r.status).toBe(401);
      }
      const blocked = await request<{ error: string }>(
        activeHarness.baseUrl,
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "third attempt" },
        { "X-Calibration-Token": "wrong" },
      );
      expect(blocked.status).toBe(429);
    } finally {
      if (ORIG_WIN === undefined) {
        delete process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS = ORIG_WIN;
      }
      if (ORIG_MAX === undefined) {
        delete process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES;
      } else {
        process.env.CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES = ORIG_MAX;
      }
    }
  });
});

describe("Task #116 — strict reads on the calibration namespace are not throttled", () => {
  it("repeatedly GETting handwavy-phrases without a token returns 401 every time (never 429)", async () => {
    const MAX = 2;
    activeHarness = await startHarness({ max: MAX });
    // The strict-read auth gate (requireCalibrationAuthStrict) intentionally
    // does NOT use the throttle — task scope is mutation routes only.
    // Repeated GET 401s should never surface a 429.
    for (let i = 0; i < MAX * 4; i++) {
      const r = await request<{ error: string }>(
        activeHarness.baseUrl,
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      expect(r.status).toBe(401);
    }
  });
});
