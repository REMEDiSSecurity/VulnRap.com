// Task #356 — route-level coverage for the PATCH rename support added to
// the curated phrase edit endpoint in Task #247. The engine's rename rules
// are exercised by `handwavy-phrases.test.ts` and the reviewer flow has a
// Playwright spec, but neither pins the JSON wiring on the Express route
// itself: validation order, status codes, and the response body shape.
// These supertest-style cases lock that contract down so a regression in
// the route handler — wrong status for a collision, a missed length check,
// a forgotten "no updates" branch — surfaces here instead of in the UI.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_TOKEN = "rename-route-test-token";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let phrasesPath: string;
let __resetForTests: () => void;

const SEED = JSON.stringify(
  {
    _meta: { description: "rename-route fixture" },
    phrases: ["seed phrase one", "seed phrase two"],
  },
  null,
  2,
);

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "calibration-rename-"));
  phrasesPath = path.join(tmpDir, "handwavy-phrases.json");
  await fs.writeFile(phrasesPath, SEED, "utf8");

  process.env.HANDWAVY_PHRASES_PATH = phrasesPath;
  process.env.CALIBRATION_TOKEN = TEST_TOKEN;

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
  delete process.env.HANDWAVY_PHRASES_PATH;
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

function request<T>(method: string, urlPath: string, body?: unknown): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
          "X-Calibration-Token": TEST_TOKEN,
        },
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

type Marker = {
  phrase: string;
  category: "absence" | "hedging" | "buzzword";
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  edits?: Array<{
    editedAt: string;
    editedBy?: string;
    phrase?: { from: string; to: string };
    category?: { from: string; to: string };
    rationale?: { from: string; to: string };
  }>;
};

interface EditResponse {
  edited: boolean;
  phrase: string;
  total: number;
  marker: Marker;
  editEntry?: {
    editedAt: string;
    editedBy?: string;
    phrase?: { from: string; to: string };
    category?: { from: string; to: string };
    rationale?: { from: string; to: string };
  };
  phrases: Marker[];
}

describe("PATCH /feedback/calibration/handwavy-phrases — Task #247 newPhrase rename", () => {
  it("renames the marker in place, returns the new identity, and persists the change", async () => {
    // Seed the marker with reviewer + rationale so we can assert that the
    // rename preserves the original add audit context (only the route's
    // contract; the engine has its own coverage for this).
    const add = await request<{ added: boolean; phrase: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      {
        phrase: "rename source phrase",
        category: "hedging",
        reviewer: "alice@team.com",
        rationale: "initial reason",
      },
    );
    expect(add.status).toBe(201);

    const r = await request<EditResponse>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "rename source phrase",
      newPhrase: "  Rename   TARGET   Phrase  ",
      reviewer: "bob@team.com",
    });
    expect(r.status).toBe(200);
    expect(r.body.edited).toBe(true);
    // Response identity flips to the normalized new phrase so the UI can
    // keep referencing the marker after a rename.
    expect(r.body.phrase).toBe("rename target phrase");
    expect(r.body.marker.phrase).toBe("rename target phrase");
    // Original add metadata is preserved across the rename.
    expect(r.body.marker.addedBy).toBe("alice@team.com");
    expect(r.body.marker.rationale).toBe("initial reason");
    expect(r.body.marker.category).toBe("hedging");
    // Audit entry records the rename as a from/to pair on `phrase`.
    expect(r.body.editEntry?.phrase).toEqual({
      from: "rename source phrase",
      to: "rename target phrase",
    });
    expect(r.body.editEntry?.editedBy).toBe("bob@team.com");
    // The active list reflects the rename — old identity is gone.
    const phrases = r.body.phrases.map((m) => m.phrase);
    expect(phrases).toContain("rename target phrase");
    expect(phrases).not.toContain("rename source phrase");

    // Confirm a fresh GET also reflects the rename.
    const list = await request<{ phrases: Marker[] }>(
      "GET",
      "/feedback/calibration/handwavy-phrases",
    );
    const found = list.body.phrases.find((m) => m.phrase === "rename target phrase");
    expect(found?.addedBy).toBe("alice@team.com");
    expect(found?.edits?.[0].phrase).toEqual({
      from: "rename source phrase",
      to: "rename target phrase",
    });
  });

  it("returns edited=false when the newPhrase normalizes to the existing phrase (no-op rename)", async () => {
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "noop rename marker",
      category: "absence",
    });
    const r = await request<EditResponse>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "noop rename marker",
      newPhrase: "  Noop   Rename   MARKER  ",
    });
    expect(r.status).toBe(200);
    expect(r.body.edited).toBe(false);
    // Identity is still the original normalized form, no audit entry was
    // appended, and the list is unchanged.
    expect(r.body.phrase).toBe("noop rename marker");
    expect(r.body.editEntry).toBeUndefined();
    const found = r.body.phrases.find((m) => m.phrase === "noop rename marker");
    expect(found?.edits ?? []).toHaveLength(0);
  });

  it("returns 409 when the rename target collides with another active phrase", async () => {
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "collision source",
      category: "hedging",
    });
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "collision target",
      category: "hedging",
    });
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "collision source",
      newPhrase: "Collision   TARGET",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already uses that normalized form/i);

    // The active list must be untouched after a rejected rename.
    const list = await request<{ phrases: Marker[] }>(
      "GET",
      "/feedback/calibration/handwavy-phrases",
    );
    const phrases = list.body.phrases.map((m) => m.phrase);
    expect(phrases).toContain("collision source");
    expect(phrases).toContain("collision target");
  });

  it("rejects a too-short newPhrase with 400", async () => {
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "short rename target",
      category: "absence",
    });
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "short rename target",
      newPhrase: "ab",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least 3 characters/i);
  });

  it("rejects a too-long newPhrase with 400", async () => {
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "long rename target",
      category: "absence",
    });
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "long rename target",
      newPhrase: "x".repeat(201),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 200 characters/i);
  });

  it("rejects an empty-string newPhrase with 400 (route-level guard before the engine)", async () => {
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "seed phrase one",
      newPhrase: "   ",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/newPhrase/);
  });

  it("rejects a non-string newPhrase with 400", async () => {
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "seed phrase one",
      newPhrase: 123,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/newPhrase/);
  });

  it("rejects a body with no category, rationale, OR newPhrase with 400", async () => {
    const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
      phrase: "seed phrase one",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/category.*rationale.*newPhrase/i);
  });
});
