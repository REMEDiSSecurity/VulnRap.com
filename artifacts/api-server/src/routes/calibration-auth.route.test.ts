// Task #113 — verify the calibration namespace auth gate.
// Task #163 — GET /feedback/calibration/handwavy-phrases is now also
// auth-gated (requireCalibrationAuthStrict) to prevent unauthenticated
// exposure of reviewer-identifying metadata (addedBy, removedBy, rationale,
// etc.). All calibration endpoints — reads and mutations alike — require the
// reviewer token when CALIBRATION_TOKEN is set.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TOKEN = "s3cret-reviewer-token";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let phrasesPath: string;
let __resetForTests: () => void;

const SEED = JSON.stringify(
  {
    _meta: { description: "auth-gate fixture" },
    phrases: ["seed phrase one", "seed phrase two"],
  },
  null,
  2,
);

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "calibration-auth-"));
  phrasesPath = path.join(tmpDir, "handwavy-phrases.json");
  await fs.writeFile(phrasesPath, SEED, "utf8");

  process.env.HANDWAVY_PHRASES_PATH = phrasesPath;
  process.env.CALIBRATION_TOKEN = TOKEN;

  const calibrationRouter = (await import("./calibration")).default;
  const handwavy = await import("../lib/engines/avri/handwavy-phrases");
  __resetForTests = handwavy.__resetHandwavyPhrasesForTests;

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
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  __resetForTests();
  await fs.writeFile(phrasesPath, SEED, "utf8");
  __resetForTests();
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
        // Task #399 — preserve the query string so endpoints that
        // parse req.query (e.g. ?limit=) see the values the test sent
        // instead of an empty object.
        path: url.pathname + url.search,
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

describe("calibration auth gate (CALIBRATION_TOKEN set)", () => {
  it("GET hand-wavy phrases without a token is rejected with 401 (Task #163 — strict read gate)", async () => {
    const r = await request<{ error: string }>("GET", "/feedback/calibration/handwavy-phrases");
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("GET hand-wavy phrases with the correct token returns the phrase list", async () => {
    const r = await request<{ phrases: unknown[]; total: number }>(
      "GET",
      "/feedback/calibration/handwavy-phrases",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.phrases)).toBe(true);
  });

  it("GET hand-wavy phrases with the wrong token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/handwavy-phrases",
      undefined,
      { "X-Calibration-Token": "wrong-token" },
    );
    expect(r.status).toBe(401);
  });

  it("POST hand-wavy phrases without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "blocked anonymous phrase" },
    );
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("POST hand-wavy phrases with the wrong token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "blocked wrong-token phrase" },
      { "X-Calibration-Token": "not-the-token" },
    );
    expect(r.status).toBe(401);
  });

  it("POST hand-wavy phrases with the X-Calibration-Token header succeeds", async () => {
    const r = await request<{ added: boolean; phrase: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "authorized header phrase" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(201);
    expect(r.body.added).toBe(true);
    expect(r.body.phrase).toBe("authorized header phrase");
  });

  it("POST hand-wavy phrases with Bearer authorization succeeds", async () => {
    const r = await request<{ added: boolean }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "authorized bearer phrase" },
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(201);
    expect(r.body.added).toBe(true);
  });

  it("DELETE hand-wavy phrases without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one" },
    );
    expect(r.status).toBe(401);
  });

  it("DELETE hand-wavy phrases with the token succeeds", async () => {
    const r = await request<{ removed: boolean }>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
  });

  it("POST /feedback/calibration/handwavy-phrases/reinstate without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases/reinstate",
      { phrase: "anything", removedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(r.status).toBe(401);
  });

  it("POST /feedback/calibration/handwavy-phrases/reinstate with the token bypasses the gate (404 because no history)", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases/reinstate",
      { phrase: "no such phrase", removedAt: "2026-01-01T00:00:00.000Z" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).not.toBe(401);
  });

  it("POST /feedback/calibration/handwavy-phrases/undo without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases/undo",
      { phrase: "anything", addedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(r.status).toBe(401);
  });

  it("POST /feedback/calibration/handwavy-phrases/undo with the token bypasses the gate (404 because no marker)", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases/undo",
      { phrase: "no such phrase", addedAt: "2026-01-01T00:00:00.000Z" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).not.toBe(401);
  });

  it("POST /feedback/calibration/apply without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/apply",
      { changes: { prior: 10 }, description: "anonymous attempt" },
    );
    expect(r.status).toBe(401);
  });

  it("POST /feedback/calibration/apply with the token is accepted", async () => {
    const r = await request<{ message?: string; config?: { version: number }; error?: string }>(
      "POST",
      "/feedback/calibration/apply",
      { changes: { prior: 12 }, description: "authorized apply with token" },
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).not.toBe(401);
    if (r.status === 201) {
      expect(r.body.config).toBeDefined();
      expect(r.body.message).toMatch(/updated/i);
    }
  });

  // Task #83 — the new auto/manual drift notify endpoint must be
  // gated by the same calibration token so a leaked URL can't be used
  // to drain a webhook quota or learn the dedup-state shape.
  it("POST /feedback/calibration/avri-drift/notify without a token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notify",
    );
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("POST /feedback/calibration/avri-drift/notify with the wrong token is rejected with 401", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/avri-drift/notify",
      undefined,
      { "X-Calibration-Token": "not-the-token" },
    );
    expect(r.status).toBe(401);
  });

  it("POST /feedback/calibration/avri-drift/notify with the token bypasses the auth gate", async () => {
    // We don't assert the response shape here because the underlying
    // drift query touches the live DB connection (which is not seeded
    // for this fixture). The contract we're locking in is: with a
    // valid token the request must NOT 401 — i.e. it reaches the
    // handler. Any handler-internal error surfaces as 500, which is
    // still a "passed the gate" outcome for the auth contract.
    const r = await request<{ error?: string; outcome?: unknown }>(
      "POST",
      "/feedback/calibration/avri-drift/notify",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).not.toBe(401);
  });

  // Task #117 — un-gated auth-status probe used by the dashboard to render a
  // "Reviewer token: configured / missing / invalid" indicator BEFORE the
  // reviewer triggers a mutation that 401s. The probe must remain reachable
  // without a token (so the UI can detect the misconfigured case at all),
  // and must report the same accept/reject decision the auth middleware
  // would compute for the same headers.
  it("GET /feedback/calibration/auth-status without a token returns serverRequiresToken=true and mutationsAllowed=false", async () => {
    const r = await request<{
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>("GET", "/feedback/calibration/auth-status");
    expect(r.status).toBe(200);
    expect(r.body.serverRequiresToken).toBe(true);
    expect(r.body.tokenPresented).toBe(false);
    expect(r.body.tokenValid).toBe(false);
    expect(r.body.mutationsAllowed).toBe(false);
  });

  it("GET /feedback/calibration/auth-status with the correct token reports mutationsAllowed=true", async () => {
    const r = await request<{
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>("GET", "/feedback/calibration/auth-status", undefined, { "X-Calibration-Token": TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.serverRequiresToken).toBe(true);
    expect(r.body.tokenPresented).toBe(true);
    expect(r.body.tokenValid).toBe(true);
    expect(r.body.mutationsAllowed).toBe(true);
  });

  it("GET /feedback/calibration/auth-status with the correct Bearer token reports mutationsAllowed=true", async () => {
    const r = await request<{
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>("GET", "/feedback/calibration/auth-status", undefined, { Authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.body.tokenPresented).toBe(true);
    expect(r.body.tokenValid).toBe(true);
    expect(r.body.mutationsAllowed).toBe(true);
  });

  it("GET /feedback/calibration/auth-status with the wrong token reports tokenPresented=true but mutationsAllowed=false", async () => {
    const r = await request<{
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>("GET", "/feedback/calibration/auth-status", undefined, { "X-Calibration-Token": "not-the-token" });
    expect(r.status).toBe(200);
    expect(r.body.serverRequiresToken).toBe(true);
    expect(r.body.tokenPresented).toBe(true);
    expect(r.body.tokenValid).toBe(false);
    expect(r.body.mutationsAllowed).toBe(false);
  });

  it("GET /feedback/calibration/auth-status never echoes the configured token", async () => {
    const r = await request<Record<string, unknown>>(
      "GET",
      "/feedback/calibration/auth-status",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    // The response body is JSON-stringified before the assertion so we catch
    // any field at any nesting level that might have leaked the secret.
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
});

// Task #399 — strict-auth gate + response shape for the recent-alerts
// endpoint that powers the "Recent calibration auth alerts" panel on
// the /feedback-analytics dashboard. The handler doesn't go anywhere
// near the brute-force ring buffer's contents (those live in the
// alerter's own unit tests); these cases just pin the route's auth
// gate and the JSON envelope.
describe("GET /feedback/calibration/auth-brute-force-alerts (Task #399)", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts",
    );
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/token/i);
  });

  it("rejects a request with the wrong token with 401", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts",
      undefined,
      { "X-Calibration-Token": "wrong-token" },
    );
    expect(r.status).toBe(401);
  });

  it("returns the recent-alerts envelope with the correct shape when authenticated", async () => {
    const r = await request<{
      alerts: unknown[];
      total: number;
      limit: number;
      bufferSize: number;
    }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.alerts)).toBe(true);
    expect(typeof r.body.total).toBe("number");
    expect(typeof r.body.limit).toBe("number");
    expect(typeof r.body.bufferSize).toBe("number");
    expect(r.body.bufferSize).toBeGreaterThanOrEqual(r.body.limit);
    expect(r.body.total).toBe(r.body.alerts.length);
  });

  it("rejects a non-numeric ?limit= with 400", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts?limit=abc",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/limit/i);
  });

  it("rejects a non-positive ?limit= with 400", async () => {
    const r = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts?limit=0",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(400);
  });

  it("clamps an oversized ?limit= to the configured buffer size rather than 400-ing", async () => {
    const r = await request<{ limit: number; bufferSize: number }>(
      "GET",
      "/feedback/calibration/auth-brute-force-alerts?limit=999999",
      undefined,
      { "X-Calibration-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(r.body.bufferSize);
  });
});

// Task #117 — dedicated suite for the open / single-reviewer / local-dev
// fallback. When CALIBRATION_TOKEN is unset, the auth gate is a no-op and
// the probe should report serverRequiresToken=false / mutationsAllowed=true
// regardless of whether the caller sent a token, so the UI renders a
// neutral "not required" chip rather than a misleading "missing" warning.
//
// The middleware reads `process.env.CALIBRATION_TOKEN` on every request, so
// we can reuse the gated suite's server: we just temporarily unset the env
// var around the open-mode assertions and restore it afterwards.
describe("calibration auth-status probe (CALIBRATION_TOKEN unset / open mode)", () => {
  beforeEach(() => {
    delete process.env.CALIBRATION_TOKEN;
  });

  afterAll(() => {
    process.env.CALIBRATION_TOKEN = TOKEN;
  });

  it("GET /feedback/calibration/auth-status reports serverRequiresToken=false / mutationsAllowed=true when the env var is unset", async () => {
    const r = await request<{
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>("GET", "/feedback/calibration/auth-status");
    expect(r.status).toBe(200);
    expect(r.body.serverRequiresToken).toBe(false);
    expect(r.body.tokenPresented).toBe(false);
    expect(r.body.tokenValid).toBe(false);
    expect(r.body.mutationsAllowed).toBe(true);
  });

  it("GET /feedback/calibration/auth-status with no token configured but a presented token still reports mutationsAllowed=true", async () => {
    const r = await request<{
      serverRequiresToken: boolean;
      tokenPresented: boolean;
      tokenValid: boolean;
      mutationsAllowed: boolean;
    }>(
      "GET",
      "/feedback/calibration/auth-status",
      undefined,
      { "X-Calibration-Token": "anything" },
    );
    expect(r.status).toBe(200);
    expect(r.body.serverRequiresToken).toBe(false);
    expect(r.body.tokenPresented).toBe(true);
    // tokenValid stays false when there's nothing on the server to compare
    // against — the UI keys off mutationsAllowed (and serverRequiresToken)
    // rather than tokenValid for the "open" case.
    expect(r.body.tokenValid).toBe(false);
    expect(r.body.mutationsAllowed).toBe(true);
  });
});
