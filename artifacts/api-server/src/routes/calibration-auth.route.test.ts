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
});
