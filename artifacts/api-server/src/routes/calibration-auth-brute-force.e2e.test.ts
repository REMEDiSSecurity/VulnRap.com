// End-to-end coverage for the calibration brute-force webhook. Boots the
// built api-server bundle as a child process, points the webhook env at a
// localhost listener, and verifies (1) the threshold-crossing payload and
// (2) the dedup cooldown. Complements the unit tests in
// middlewares/calibration-auth-brute-force-alert.test.ts which inject a
// dispatcher into an in-process Express app.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const ARTIFACT_DIR = path.resolve(path.dirname(__filename), "..", "..");
const DIST_DIR = path.resolve(ARTIFACT_DIR, "dist");
const SERVER_ENTRY = path.resolve(DIST_DIR, "index.mjs");
const BUILD_SCRIPT = path.resolve(ARTIFACT_DIR, "build.mjs");

// The bundle's backfill-vulnrap.ts has a top-level "run as script" guard
// that misfires when bundled into dist/index.mjs (import.meta.url and
// process.argv[1] both resolve to the bundle path). We spawn a tiny
// dynamic-import wrapper instead so those two values diverge and the
// guard stays dormant.
const SERVER_WRAPPER = path.resolve(DIST_DIR, "__e2e_server_wrapper.mjs");
const SERVER_ENTRY_URL = pathToFileURL(SERVER_ENTRY).href;

const TOKEN = "e2e-brute-force-reviewer-token";
const WRONG_TOKEN = "definitely-not-the-token";
const ALERT_THRESHOLD = 3;
const ALERT_WINDOW_MS = 60_000;
// Keep the limiter cap well above ALERT_THRESHOLD so the limiter does not
// short-circuit with 429 before the alert threshold is crossed.
const LIMITER_MAX = 10_000;

interface CapturedHook {
  method: string;
  url: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  receivedAt: number;
}

interface WebhookListener {
  url: string;
  received: CapturedHook[];
  close: () => Promise<void>;
}

async function startWebhookListener(): Promise<WebhookListener> {
  const received: CapturedHook[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: parsed,
        headers: req.headers,
        receivedAt: Date.now(),
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface ApiHarness {
  baseUrl: string;
  proc: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

// Per-test temp dir for the brute-force cooldown JSON. Without this the
// spawned api-server defaults to the shipped
// artifacts/api-server/data/calibration-auth-brute-force-state.json file
// and dirties source control with test-generated IP entries every run.
const tempStateDirs: string[] = [];
function createScratchStatePath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulnrap-brute-force-state-"));
  tempStateDirs.push(dir);
  return path.join(dir, "state.json");
}

async function startApiServer(env: Record<string, string>): Promise<ApiHarness> {
  const port = await pickFreePort();
  // Hermeticity: strip any inherited CALIBRATION_AUTH_BRUTE_FORCE_* / rate-limit
  // env vars from the parent so the caller's explicit values are the only
  // configuration the spawned server sees for the alerter under test.
  const inherited: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      key.startsWith("CALIBRATION_AUTH_BRUTE_FORCE_") ||
      key.startsWith("CALIBRATION_AUTH_RATE_LIMIT_")
    ) {
      delete inherited[key];
    }
  }
  // Default the persisted-cooldown JSON to a per-test scratch file so the
  // spawned server never touches the shipped data file. Caller can override.
  const stateEnv: Record<string, string> = env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH
    ? {}
    : { CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH: createScratchStatePath() };
  const proc = spawn("node", ["--enable-source-maps", SERVER_WRAPPER], {
    // NODE_ENV cleared to skip productionOnly migrations against the dev DB.
    env: {
      ...inherited,
      ...stateEnv,
      ...env,
      PORT: String(port),
      NODE_ENV: "",
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: string[] = [];
  proc.stdout?.on("data", (b: Buffer) => chunks.push(b.toString("utf8")));
  proc.stderr?.on("data", (b: Buffer) => chunks.push(b.toString("utf8")));

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `api-server did not log "Server listening" within 30s.\n--- captured output ---\n${chunks.join("")}`,
          ),
        );
      }, 30_000);
      const onChunk = () => {
        if (chunks.join("").includes("Server listening")) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(
          new Error(
            `api-server exited early with code ${code ?? "null"}.\n--- captured output ---\n${chunks.join("")}`,
          ),
        );
      };
      function cleanup(): void {
        clearTimeout(timeout);
        proc.stdout?.off("data", onChunk);
        proc.stderr?.off("data", onChunk);
        proc.off("exit", onExit);
      }
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);
      proc.once("exit", onExit);
      // Cover the race where "Server listening" lands between the
      // collecting listener (attached above) and onChunk (just attached).
      onChunk();
    });
  } catch (err) {
    // Make sure we never leak a still-running child if startup rejects
    // (e.g. timed out waiting for the readiness log).
    if (proc.exitCode === null && !proc.killed) {
      proc.kill("SIGKILL");
    }
    throw err;
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    proc,
    output: () => chunks.join(""),
    stop: async () => {
      if (proc.exitCode !== null || proc.killed) return;
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      // The api-server has no SIGTERM handler today, so SIGTERM is enough
      // for Node to exit. SIGKILL after a short grace just covers regressions.
      proc.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 1_000);
      await exited;
      clearTimeout(killTimer);
    },
  };
}

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  baseUrl: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: unknown,
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!predicate()) {
    throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
  }
}

let activeApi: ApiHarness | null = null;
let activeListener: WebhookListener | null = null;

beforeAll(() => {
  // Rebuild so the test always exercises the current source.
  const r = spawnSync("node", [BUILD_SCRIPT], { cwd: ARTIFACT_DIR, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`api-server build failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  // Write the wrapper AFTER building (the build wipes dist/ first).
  writeFileSync(
    SERVER_WRAPPER,
    `await import(${JSON.stringify(SERVER_ENTRY_URL)});\n`,
    "utf8",
  );
}, 60_000);

afterEach(async () => {
  if (activeApi) {
    await activeApi.stop();
    activeApi = null;
  }
  if (activeListener) {
    await activeListener.close();
    activeListener = null;
  }
});

afterAll(() => {
  for (const dir of tempStateDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the temp dir is small and self-pruning anyway
    }
  }
});

describe("calibration brute-force webhook (e2e against the real built server)", () => {
  it(
    "POSTs the dispatched payload to CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL once the per-IP threshold is crossed",
    async () => {
      activeListener = await startWebhookListener();
      activeApi = await startApiServer({
        CALIBRATION_TOKEN: TOKEN,
        CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL: activeListener.url,
        CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD: String(ALERT_THRESHOLD),
        CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS: String(ALERT_WINDOW_MS),
        CALIBRATION_AUTH_BRUTE_FORCE_RUNBOOK_URL: "https://e2e.example.test/runbook",
        CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES: String(LIMITER_MAX),
        CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS: String(ALERT_WINDOW_MS),
      });

      // X-Forwarded-For exercises the real `trust proxy` chain.
      const FORWARDED_IP = "203.0.113.7";
      for (let i = 0; i < ALERT_THRESHOLD; i++) {
        const r = await request<{ error: string }>(
          activeApi.baseUrl,
          "POST",
          "/api/feedback/calibration/handwavy-phrases",
          {
            "X-Calibration-Token": WRONG_TOKEN,
            "X-Forwarded-For": FORWARDED_IP,
          },
          { phrase: `e2e brute force probe ${i}` },
        );
        expect(r.status).toBe(401);
      }

      // Dispatch is fire-and-forget; give it a moment to land.
      await waitFor(() => activeListener!.received.length >= 1, 5_000);
      expect(activeListener.received).toHaveLength(1);

      const hook = activeListener.received[0]!;
      expect(hook.method).toBe("POST");
      expect(hook.url).toBe("/hook");
      expect(hook.headers["content-type"]).toMatch(/application\/json/);
      expect(hook.headers["user-agent"]).toMatch(/vulnrap-calibration-brute-force-alerter/);

      const payload = hook.body as {
        event: string;
        ip: string;
        threshold: number;
        windowMs: number;
        wrongTokenCount: number;
        rejectionsByStatus: { "401": number; "429": number };
        rejectionsByGate: { mutation: number; "strict-read": number };
        lastRoute: string;
        lastMethod: string;
        runbookUrl: string;
        recommendedActions: string[];
      };
      expect(payload.event).toBe("calibration_auth_brute_force");
      expect(payload.threshold).toBe(ALERT_THRESHOLD);
      expect(payload.windowMs).toBe(ALERT_WINDOW_MS);
      expect(payload.wrongTokenCount).toBe(ALERT_THRESHOLD);
      expect(payload.rejectionsByStatus).toEqual({
        "401": ALERT_THRESHOLD,
        "429": 0,
      });
      expect(payload.rejectionsByGate.mutation).toBe(ALERT_THRESHOLD);
      expect(payload.lastRoute).toBe("/api/feedback/calibration/handwavy-phrases");
      expect(payload.lastMethod).toBe("POST");
      expect(payload.runbookUrl).toBe("https://e2e.example.test/runbook");
      expect(payload.ip).toBe(FORWARDED_IP);
      // Tokens must never leak into the dispatched payload.
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(WRONG_TOKEN);
      expect(serialized).not.toContain(TOKEN);
    },
    60_000,
  );

  it(
    "dedup cooldown holds — a second wrong-token burst from the same IP within the window does not re-fire",
    async () => {
      activeListener = await startWebhookListener();
      activeApi = await startApiServer({
        CALIBRATION_TOKEN: TOKEN,
        CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL: activeListener.url,
        CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD: String(ALERT_THRESHOLD),
        CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS: String(ALERT_WINDOW_MS),
        CALIBRATION_AUTH_BRUTE_FORCE_RUNBOOK_URL: "https://e2e.example.test/runbook",
        CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES: String(LIMITER_MAX),
        CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS: String(ALERT_WINDOW_MS),
      });

      // First burst — crosses the threshold and fires exactly one alert.
      for (let i = 0; i < ALERT_THRESHOLD; i++) {
        const r = await request<{ error: string }>(
          activeApi.baseUrl,
          "POST",
          "/api/feedback/calibration/handwavy-phrases",
          { "X-Calibration-Token": WRONG_TOKEN },
          { phrase: `dedup first ${i}` },
        );
        expect(r.status).toBe(401);
      }
      await waitFor(() => activeListener!.received.length >= 1, 5_000);
      expect(activeListener.received).toHaveLength(1);

      // Second burst — same IP/window. Cooldown must suppress the alert.
      for (let i = 0; i < ALERT_THRESHOLD * 3; i++) {
        const r = await request<{ error: string }>(
          activeApi.baseUrl,
          "POST",
          "/api/feedback/calibration/handwavy-phrases",
          { "X-Calibration-Token": WRONG_TOKEN },
          { phrase: `dedup second ${i}` },
        );
        expect(r.status).toBe(401);
      }

      // Poll across a 1s grace period — fail fast if a 2nd dispatch arrives.
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if (activeListener.received.length > 1) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(activeListener.received).toHaveLength(1);
    },
    60_000,
  );
});
