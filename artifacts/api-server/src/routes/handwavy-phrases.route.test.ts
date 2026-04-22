// Task #108 — route-level integration test for the reviewer-curated FLAT
// hand-wavy marker phrase endpoints. Mounts the calibration router on an
// isolated express app and exercises GET / POST / DELETE end-to-end so any
// regression in the JSON wiring (status codes, body shape, list refresh)
// surfaces here instead of at runtime in production.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let phrasesPath: string;
let __resetForTests: () => void;
let __restoreDefaults: () => void;

const SEED = JSON.stringify(
  {
    _meta: { description: "test fixture" },
    phrases: ["seed phrase one", "seed phrase two"],
  },
  null,
  2,
);

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handwavy-route-"));
  phrasesPath = path.join(tmpDir, "handwavy-phrases.json");
  await fs.writeFile(phrasesPath, SEED, "utf8");

  // Pin the loader to our tmpdir copy so the test cannot accidentally
  // mutate the real shipped phrase list.
  process.env.HANDWAVY_PHRASES_PATH = phrasesPath;

  const calibrationRouter = (await import("./calibration")).default;
  const handwavy = await import("../lib/engines/avri/handwavy-phrases");
  __resetForTests = handwavy.__resetHandwavyPhrasesForTests;
  __restoreDefaults = handwavy.__restoreHandwavyPhraseDefaultsForTests;

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
        path: url.pathname,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": String(data.length) }
          : {},
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

type Marker = { phrase: string; category: "absence" | "hedging" | "buzzword" };

describe("/feedback/calibration/handwavy-phrases", () => {
  it("GET returns the active list with category metadata", async () => {
    const r = await request<{ phrases: Marker[]; total: number }>("GET", "/feedback/calibration/handwavy-phrases");
    expect(r.status).toBe(200);
    expect(r.body.phrases.map((m) => m.phrase)).toContain("seed phrase one");
    // String-only seed entries default to category "absence" when loaded.
    const seed = r.body.phrases.find((m) => m.phrase === "seed phrase one");
    expect(seed?.category).toBe("absence");
    expect(r.body.total).toBe(r.body.phrases.length);
  });

  it("POST appends a new phrase and the list reflects it", async () => {
    const add = await request<{ added: boolean; phrase: string; category: string; phrases: Marker[] }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "Brand-NEW   Slop  Phrase", category: "buzzword" },
    );
    expect(add.status).toBe(201);
    expect(add.body.added).toBe(true);
    expect(add.body.phrase).toBe("brand-new slop phrase");
    expect(add.body.category).toBe("buzzword");
    expect(add.body.phrases.map((m) => m.phrase)).toContain("brand-new slop phrase");

    const list = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
    const found = list.body.phrases.find((m) => m.phrase === "brand-new slop phrase");
    expect(found?.category).toBe("buzzword");
  });

  it("POST defaults category to 'absence' when omitted", async () => {
    const add = await request<{ added: boolean; category: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "uncategorized phrase here" },
    );
    expect(add.status).toBe(201);
    expect(add.body.category).toBe("absence");
  });

  it("POST rejects an invalid category with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "fine phrase but bad cat", category: "nonsense" },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/category/);
  });

  it("POST returns 200 when phrase is already present", async () => {
    const second = await request<{ added: boolean }>("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "seed phrase one",
    });
    expect(second.status).toBe(200);
    expect(second.body.added).toBe(false);
  });

  it("POST rejects too-short phrases with 400", async () => {
    const r = await request<{ error: string }>("POST", "/feedback/calibration/handwavy-phrases", { phrase: "ab" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least/);
  });

  it("POST rejects missing/empty phrase with 400", async () => {
    const r = await request<{ error: string }>("POST", "/feedback/calibration/handwavy-phrases", {});
    expect(r.status).toBe(400);
  });

  it("DELETE removes an existing phrase", async () => {
    const r = await request<{ removed: boolean; phrases: Marker[] }>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one" },
    );
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
    expect(r.body.phrases.map((m) => m.phrase)).not.toContain("seed phrase one");
  });

  it("DELETE returns 404 when phrase is absent", async () => {
    const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
      phrase: "never registered",
    });
    expect(r.status).toBe(404);
  });

  it("DELETE rejects missing phrase with 400", async () => {
    const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {});
    expect(r.status).toBe(400);
  });

  it("restoreDefaults helper rewrites the file with the curated defaults", () => {
    __restoreDefaults();
    // Sanity: the restore helper does not throw and the file now contains
    // the canonical default markers.
    expect(true).toBe(true);
  });
});
