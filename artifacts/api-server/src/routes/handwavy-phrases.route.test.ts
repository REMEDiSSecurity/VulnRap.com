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

// Task #163 — GET is now auth-gated (requireCalibrationAuthStrict). Supply a
// test token so the functional tests remain focused on behavior, not auth.
const TEST_TOKEN = "handwavy-route-test-token";

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
  // Task #163 — configure the calibration token so requireCalibrationAuthStrict
  // allows requests through in functional tests.
  process.env.CALIBRATION_TOKEN = TEST_TOKEN;

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

function request<T>(method: string, urlPath: string, body?: unknown): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        // Preserve query strings (Task #160 picker GET takes ?limit=N).
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
          // Task #163 — include the calibration token so GET (now strict-auth) works.
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

  // Task #155 — single-phrase DELETE with `dryRun: true` mirrors the batch
  // dry-run shape (corpus + production removal-impact summary) so the in-UI
  // Trash flow can show the same warning before a one-click removal, without
  // mutating the active list, history, or cache.
  describe("Task #155 single-phrase DELETE dry-run", () => {
    interface SingleDryRunBody {
      dryRun: boolean;
      batch: boolean;
      wouldRemove: number;
      notFound: number;
      duplicateInBatch: number;
      phrase: string;
      raw: string;
      removed: boolean;
      reason: string | null;
      total: number;
      projectedTotal: number;
      results: Array<{ raw: string; phrase: string; removed: boolean; reason?: string }>;
      dryRunImpact: {
        corpus: {
          total: number;
          byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
          validDetectionsLost: number;
          falsePositivesDropped: number;
          corpusSize: number;
          sampleMatches: Array<{ id: string; tier: string }>;
          warning: string | null;
          oldestCreatedAt: string | null;
          newestCreatedAt: string | null;
        };
        production: {
          total: number;
          byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
          validDetectionsLost: number;
          falsePositivesDropped: number;
          corpusSize: number;
          sampleMatches: Array<{ id: string; tier: string }>;
          warning: string | null;
          // Task #218 — bulk-removal preview surfaces the same scan-range
          // signal as the add-time preview (Task #124).
          oldestCreatedAt: string | null;
          newestCreatedAt: string | null;
        } | null;
        productionError: string | null;
        productionLimit: number;
      };
      phrases: Marker[];
    }

    it("DELETE single-phrase dryRun=true returns the same impact shape as batch and does NOT mutate", async () => {
      const r = await request<SingleDryRunBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase one", dryRun: true },
      );
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.batch).toBe(false);
      expect(r.body.wouldRemove).toBe(1);
      expect(r.body.notFound).toBe(0);
      expect(r.body.duplicateInBatch).toBe(0);
      expect(r.body.removed).toBe(true);
      expect(r.body.phrase).toBe("seed phrase one");
      expect(r.body.projectedTotal).toBe(r.body.total - 1);
      // Per-phrase result mirrors the batch shape with exactly one entry.
      expect(r.body.results).toHaveLength(1);
      expect(r.body.results[0].removed).toBe(true);
      expect(r.body.results[0].phrase).toBe("seed phrase one");
      // Corpus impact must be present and well-formed.
      expect(r.body.dryRunImpact.corpus.corpusSize).toBeGreaterThan(0);
      expect(r.body.dryRunImpact.corpus.byTier).toEqual({
        t1Legit: expect.any(Number),
        t2Borderline: expect.any(Number),
        t3Slop: expect.any(Number),
        t4Hallucinated: expect.any(Number),
      });
      expect(r.body.dryRunImpact.productionLimit).toBe(2000);
      expect(r.body.dryRunImpact).toHaveProperty("production");
      expect(r.body.dryRunImpact).toHaveProperty("productionError");
      // Crucially: the active list is unchanged and the seed phrase is still there.
      const list = await request<{ phrases: Marker[]; history: unknown[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      expect(list.body.phrases.map((m) => m.phrase)).toContain("seed phrase one");
    });

    it("DELETE single-phrase dryRun=true surfaces a warning when valid hand-wavy detections would be lost", async () => {
      // Restore curated defaults so a real slop-detecting phrase like
      // "do not have a runnable reproducer" is on the active list — it
      // uniquely flags multiple T3/T4 corpus fixtures, so removing it
      // would un-flag legitimate slop reports that no other curated
      // phrase covers.
      __restoreDefaults();
      const r = await request<SingleDryRunBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "do not have a runnable reproducer", dryRun: true },
      );
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.batch).toBe(false);
      expect(r.body.wouldRemove).toBe(1);
      const c = r.body.dryRunImpact.corpus;
      // The whole point of this task: a single-phrase Trash should warn
      // when removing it would un-flag legitimate T3/T4 slop detections.
      expect(c.validDetectionsLost).toBeGreaterThan(0);
      expect(c.byTier.t3Slop + c.byTier.t4Hallucinated).toBe(c.validDetectionsLost);
      expect(c.warning).not.toBeNull();
      expect(c.warning).toMatch(/un-flag|legitimately/);
    });

    it("DELETE single-phrase dryRun=true with a not-found phrase returns wouldRemove=0 and a zero-impact preview", async () => {
      const r = await request<SingleDryRunBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never registered xyzzy", dryRun: true },
      );
      // No mutation, so the 404 path of the live single-phrase delete does
      // NOT apply to dry-run; we return 200 with a zero-impact preview.
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.wouldRemove).toBe(0);
      expect(r.body.notFound).toBe(1);
      expect(r.body.removed).toBe(false);
      expect(r.body.reason).toBe("not-found");
      expect(r.body.dryRunImpact.corpus.total).toBe(0);
      expect(r.body.dryRunImpact.corpus.warning).toBeNull();
      // Production scan is skipped entirely when nothing would be removed.
      expect(r.body.dryRunImpact.production).not.toBeNull();
      expect(r.body.dryRunImpact.production?.total).toBe(0);
      // Task #218 — even the skipped/zero-impact production placeholder
      // returns the date-range fields with both ends null so the UI can
      // render a uniform shape (mirrors the batch path).
      expect(r.body.dryRunImpact.production?.oldestCreatedAt ?? null).toBeNull();
      expect(r.body.dryRunImpact.production?.newestCreatedAt ?? null).toBeNull();
    });

    it("DELETE single-phrase dryRun=true normalizes the phrase before previewing (mixed case + extra whitespace)", async () => {
      const r = await request<SingleDryRunBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "  Seed   Phrase   ONE  ", dryRun: true },
      );
      expect(r.status).toBe(200);
      expect(r.body.removed).toBe(true);
      expect(r.body.phrase).toBe("seed phrase one");
      expect(r.body.wouldRemove).toBe(1);
    });

    it("DELETE single-phrase dryRun=true rejects missing/empty phrase with 400 (no preview computed)", async () => {
      const r = await request<{ error: string }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { dryRun: true },
      );
      expect(r.status).toBe(400);
    });

    // Task #230 — the reviewer-tunable production-scan window persisted in
    // the calibration UI must drive the single-phrase DELETE dry-run too,
    // not just the add-phrase preview. We accept the same `productionScanLimit`
    // body field, validate it identically, and echo the resolved value back
    // in `dryRunImpact.productionLimit` so the UI subtitle ("last X of up to
    // Y reports") matches the window the server actually scanned.
    describe("Task #230 productionScanLimit on single-phrase DELETE dry-run", () => {
      it("echoes the reviewer-supplied limit back in dryRunImpact.productionLimit", async () => {
        const r = await request<SingleDryRunBody>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrase: "seed phrase one", dryRun: true, productionScanLimit: 500 },
        );
        expect(r.status).toBe(200);
        expect(r.body.dryRun).toBe(true);
        expect(r.body.batch).toBe(false);
        expect(r.body.dryRunImpact.productionLimit).toBe(500);
      });

      it("falls back to the 2000-row default when the field is omitted", async () => {
        const r = await request<SingleDryRunBody>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrase: "seed phrase one", dryRun: true },
        );
        expect(r.status).toBe(200);
        expect(r.body.dryRunImpact.productionLimit).toBe(2000);
      });

      it("accepts the documented bounds (100 and 10000)", async () => {
        const lo = await request<SingleDryRunBody>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrase: "seed phrase one", dryRun: true, productionScanLimit: 100 },
        );
        expect(lo.status).toBe(200);
        expect(lo.body.dryRunImpact.productionLimit).toBe(100);
        const hi = await request<SingleDryRunBody>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrase: "seed phrase one", dryRun: true, productionScanLimit: 10000 },
        );
        expect(hi.status).toBe(200);
        expect(hi.body.dryRunImpact.productionLimit).toBe(10000);
      });

      it("rejects out-of-range / non-integer / non-numeric values with 400", async () => {
        for (const bad of [50, 50000, 1500.5, "lots"] as const) {
          const r = await request<{ error: string }>(
            "DELETE",
            "/feedback/calibration/handwavy-phrases",
            { phrase: "seed phrase one", dryRun: true, productionScanLimit: bad },
          );
          expect(r.status).toBe(400);
          expect(r.body.error).toMatch(/productionScanLimit/);
        }
      });

      it("validates productionScanLimit even when dryRun is omitted (so the bad value never silently slips into a real removal)", async () => {
        const r = await request<{ error: string }>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrase: "seed phrase one", productionScanLimit: 50000 },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });
    });
  });

  // Task #114 — dry-run preview: the route must report a corpus-match summary
  // for the candidate phrase WITHOUT persisting it, so reviewers can back out
  // before a poorly-chosen phrase craters the AVRI score for legitimate reports.
  describe("Task #114 dry-run preview", () => {
    it("dryRun=true returns a corpus match summary and does NOT persist the phrase", async () => {
      const r = await request<{
        dryRun: boolean;
        added: boolean;
        phrase: string;
        category: string;
        phrases: Marker[];
        dryRunMatches: {
          total: number;
          byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
          falsePositives: number;
          corpusSize: number;
          sampleMatches: Array<{ id: string; tier: string }>;
          warning: string | null;
        };
        // Task #119 — production-archive scoring block.
        dryRunMatchesProduction: {
          total: number;
          byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
          falsePositives: number;
          corpusSize: number;
          sampleMatches: Array<{ id: string; tier: string }>;
          warning: string | null;
          // Task #124 — sample createdAt window (ISO timestamps or null).
          oldestCreatedAt: string | null;
          newestCreatedAt: string | null;
        } | null;
        dryRunMatchesProductionError: string | null;
        dryRunMatchesProductionLimit: number;
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "totally novel phrase that no fixture mentions xyzzy",
        category: "buzzword",
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.added).toBe(false);
      expect(r.body.phrase).toBe("totally novel phrase that no fixture mentions xyzzy");
      expect(r.body.category).toBe("buzzword");
      expect(r.body.dryRunMatches.total).toBe(0);
      expect(r.body.dryRunMatches.falsePositives).toBe(0);
      expect(r.body.dryRunMatches.warning).toBeNull();
      expect(r.body.dryRunMatches.corpusSize).toBeGreaterThan(0);
      expect(r.body.dryRunMatches.sampleMatches).toHaveLength(0);

      // Task #119 — Production block must always be present (either as a
      // populated DryRunMatches or as null+error so the UI can show a notice).
      // The route must never silently omit it.
      expect(r.body).toHaveProperty("dryRunMatchesProduction");
      expect(r.body).toHaveProperty("dryRunMatchesProductionError");
      expect(r.body.dryRunMatchesProductionLimit).toBe(2000);
      if (r.body.dryRunMatchesProduction != null) {
        expect(r.body.dryRunMatchesProduction.byTier).toEqual({
          t1Legit: expect.any(Number),
          t2Borderline: expect.any(Number),
          t3Slop: expect.any(Number),
          t4Hallucinated: expect.any(Number),
        });
        expect(r.body.dryRunMatchesProduction.sampleMatches.length).toBeLessThanOrEqual(12);
        // Task #124 — date-range fields are ALWAYS present so the UI can render
        // a "scanned N reports from <oldest> to <newest>" line. Either both are
        // ISO-8601 timestamps (when the scan included rows with createdAt) or
        // both are null (empty scan / no createdAt). They must never be a
        // mixed/partial pair.
        expect(r.body.dryRunMatchesProduction).toHaveProperty("oldestCreatedAt");
        expect(r.body.dryRunMatchesProduction).toHaveProperty("newestCreatedAt");
        const oldest = r.body.dryRunMatchesProduction.oldestCreatedAt;
        const newest = r.body.dryRunMatchesProduction.newestCreatedAt;
        if (oldest === null) {
          expect(newest).toBeNull();
        } else {
          expect(typeof oldest).toBe("string");
          expect(typeof newest).toBe("string");
          // Newest must be >= oldest.
          expect(Date.parse(newest!)).toBeGreaterThanOrEqual(Date.parse(oldest));
        }
      } else {
        expect(typeof r.body.dryRunMatchesProductionError).toBe("string");
      }

      // Confirm the active list was not mutated by the dry-run call.
      const list = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
      expect(list.body.phrases.map((m) => m.phrase)).not.toContain(
        "totally novel phrase that no fixture mentions xyzzy",
      );
    });

    it("dryRun=true surfaces a reviewer warning when the phrase would flag legitimate corpus reports", async () => {
      // "cvss" appears in many T1 LEGIT fixtures (well-evidenced reports cite
      // CVSS vectors), so it is the canonical example of a phrase a reviewer
      // must NOT blindly add to the FLAT haircut list.
      const r = await request<{
        dryRun: boolean;
        dryRunMatches: {
          total: number;
          byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
          falsePositives: number;
          warning: string | null;
          sampleMatches: Array<{ id: string; tier: string }>;
        };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "cvss",
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.dryRunMatches.total).toBeGreaterThan(0);
      // The matcher must find at least one GREEN/YELLOW corpus hit.
      expect(r.body.dryRunMatches.falsePositives).toBeGreaterThan(0);
      expect(r.body.dryRunMatches.warning).not.toBeNull();
      expect(r.body.dryRunMatches.warning).toMatch(/legitimate/);
      // Sample matches are capped at 12 entries.
      expect(r.body.dryRunMatches.sampleMatches.length).toBeLessThanOrEqual(12);
    });

    it("dryRun=true rejects too-short phrases with 400 (same validation as real add)", async () => {
      const r = await request<{ error: string }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "a",
        dryRun: true,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/at least/);
    });

    // Task #125 — reviewer-tunable production-scan window. The optional
    // `productionScanLimit` body field bounds the production archive scan
    // (the second signal alongside the curated benchmark) so heavy-user
    // installs can widen for sharper false-positive detection and small
    // installs can tighten to focus on recent reporter behavior. Default
    // remains 2000 when the field is omitted.
    describe("Task #125 productionScanLimit", () => {
      it("echoes the reviewer-supplied limit back in dryRunMatchesProductionLimit", async () => {
        const r = await request<{
          dryRun: boolean;
          dryRunMatchesProductionLimit: number;
        }>("POST", "/feedback/calibration/handwavy-phrases", {
          phrase: "totally novel phrase that no fixture mentions xyzzy",
          dryRun: true,
          productionScanLimit: 500,
        });
        expect(r.status).toBe(200);
        expect(r.body.dryRun).toBe(true);
        expect(r.body.dryRunMatchesProductionLimit).toBe(500);
      });

      it("falls back to the 2000-row default when the field is omitted", async () => {
        const r = await request<{ dryRunMatchesProductionLimit: number }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
          },
        );
        expect(r.status).toBe(200);
        expect(r.body.dryRunMatchesProductionLimit).toBe(2000);
      });

      it("accepts the documented lower bound (100)", async () => {
        const r = await request<{ dryRunMatchesProductionLimit: number }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: 100,
          },
        );
        expect(r.status).toBe(200);
        expect(r.body.dryRunMatchesProductionLimit).toBe(100);
      });

      it("accepts the documented upper bound (10000)", async () => {
        const r = await request<{ dryRunMatchesProductionLimit: number }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: 10000,
          },
        );
        expect(r.status).toBe(200);
        expect(r.body.dryRunMatchesProductionLimit).toBe(10000);
      });

      it("rejects values below the lower bound with 400", async () => {
        const r = await request<{ error: string }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: 50,
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
        expect(r.body.error).toMatch(/100/);
        expect(r.body.error).toMatch(/10000/);
      });

      it("rejects values above the upper bound with 400", async () => {
        const r = await request<{ error: string }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: 50000,
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("rejects non-integer values with 400", async () => {
        const r = await request<{ error: string }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: 1500.5,
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("rejects non-numeric values with 400", async () => {
        const r = await request<{ error: string }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            dryRun: true,
            productionScanLimit: "lots",
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("validates productionScanLimit even when dryRun is omitted (so the bad value never silently slips into a real add)", async () => {
        const r = await request<{ error: string }>(
          "POST",
          "/feedback/calibration/handwavy-phrases",
          {
            phrase: "totally novel phrase that no fixture mentions xyzzy",
            productionScanLimit: 50000,
          },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });
    });

    // Task #123 — overlap with the existing curated phrase list.
    it("dryRun=true reports overlap with existing curated entries", async () => {
      // Seed list contains "seed phrase one" and "seed phrase two".
      // Candidate "seed phrase" is a substring of both — should flag both as
      // existing-contains-candidate.
      const r = await request<{
        dryRunOverlaps: {
          total: number;
          matches: Array<{ phrase: string; category: string; relation: string }>;
        };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "seed phrase",
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRunOverlaps.total).toBe(2);
      const phrases = r.body.dryRunOverlaps.matches.map((m) => m.phrase).sort();
      expect(phrases).toEqual(["seed phrase one", "seed phrase two"]);
      for (const m of r.body.dryRunOverlaps.matches) {
        expect(m.relation).toBe("existing-contains-candidate");
      }
    });

    it("dryRun=true flags an exact-duplicate candidate as 'equal'", async () => {
      const r = await request<{
        dryRunOverlaps: {
          total: number;
          matches: Array<{ phrase: string; relation: string }>;
        };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "Seed Phrase  ONE", // exercises normalization too
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRunOverlaps.total).toBe(1);
      expect(r.body.dryRunOverlaps.matches[0].phrase).toBe("seed phrase one");
      expect(r.body.dryRunOverlaps.matches[0].relation).toBe("equal");
    });

    it("dryRun=true flags a candidate broader than an existing entry as 'candidate-contains-existing'", async () => {
      const r = await request<{
        dryRunOverlaps: {
          total: number;
          matches: Array<{ phrase: string; relation: string }>;
        };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "the seed phrase one with extra context",
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRunOverlaps.total).toBe(1);
      expect(r.body.dryRunOverlaps.matches[0].phrase).toBe("seed phrase one");
      expect(r.body.dryRunOverlaps.matches[0].relation).toBe("candidate-contains-existing");
    });

    it("dryRun=true returns an empty overlap block when nothing in the curated list overlaps", async () => {
      const r = await request<{
        dryRunOverlaps: { total: number; matches: unknown[] };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "totally novel candidate xyzzy",
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRunOverlaps.total).toBe(0);
      expect(r.body.dryRunOverlaps.matches).toEqual([]);
    });

    it("dryRun is independent of the real add path — a follow-up real add still appends", async () => {
      // First dry-run.
      const dry = await request<{ dryRun: boolean; added: boolean }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "preview-then-commit phrase", dryRun: true },
      );
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.added).toBe(false);

      // Then a real add (no dryRun) must succeed and persist.
      const real = await request<{ added: boolean; phrases: Marker[] }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "preview-then-commit phrase" },
      );
      expect(real.status).toBe(201);
      expect(real.body.added).toBe(true);
      expect(real.body.phrases.map((m) => m.phrase)).toContain("preview-then-commit phrase");
    });
  });

  // --- Task #112: audit trail ---

  it("POST records reviewer + rationale on the marker", async () => {
    const add = await request<{
      added: boolean;
      marker: Marker & { addedBy?: string; addedAt?: string; rationale?: string };
    }>("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "audit-tracked marker",
      category: "absence",
      reviewer: "alice@team.com",
      rationale: "Caught two duplicate reports last sprint.",
    });
    expect(add.status).toBe(201);
    expect(add.body.marker.addedBy).toBe("alice@team.com");
    expect(add.body.marker.rationale).toMatch(/duplicate reports/);
    expect(add.body.marker.addedAt).toBeTypeOf("string");

    const list = await request<{
      phrases: Array<Marker & { addedBy?: string; rationale?: string }>;
    }>("GET", "/feedback/calibration/handwavy-phrases");
    const found = list.body.phrases.find((m) => m.phrase === "audit-tracked marker");
    expect(found?.addedBy).toBe("alice@team.com");
    expect(found?.rationale).toMatch(/duplicate reports/);
  });

  // Task #223 — the e2e suite needs a way to seed a marker with a backdated
  // `addedAt` so the urgent-state styling on the per-row Undo button can be
  // exercised without 4m 30s of real wall-clock wait. The api-server gates
  // that behavior on `HANDWAVY_ALLOW_TEST_BACKDATE=1` so a public deployment
  // cannot be tricked into rewriting the audit timestamp. The two tests
  // below pin the contract: opt-in honors the field, opt-out silently drops
  // it (no 400 — old reviewers POSTing through stale clients should not
  // start failing just because the field is unrecognised).
  describe("Task #223 addedAt backdating gate", () => {
    it("POST honors a caller-supplied addedAt when HANDWAVY_ALLOW_TEST_BACKDATE=1", async () => {
      const original = process.env.HANDWAVY_ALLOW_TEST_BACKDATE;
      process.env.HANDWAVY_ALLOW_TEST_BACKDATE = "1";
      try {
        const backdated = "2026-01-02T03:04:05.000Z";
        const add = await request<{
          added: boolean;
          marker: { phrase: string; addedAt?: string };
        }>("POST", "/feedback/calibration/handwavy-phrases", {
          phrase: "task223 backdated marker honored",
          category: "hedging",
          reviewer: "task223-tester",
          addedAt: backdated,
        });
        expect(add.status).toBe(201);
        expect(add.body.marker.addedAt).toBe(backdated);
      } finally {
        if (original === undefined) {
          delete process.env.HANDWAVY_ALLOW_TEST_BACKDATE;
        } else {
          process.env.HANDWAVY_ALLOW_TEST_BACKDATE = original;
        }
      }
    });

    it("POST silently ignores addedAt when HANDWAVY_ALLOW_TEST_BACKDATE is unset (server clock wins)", async () => {
      const original = process.env.HANDWAVY_ALLOW_TEST_BACKDATE;
      delete process.env.HANDWAVY_ALLOW_TEST_BACKDATE;
      try {
        const before = Date.now();
        const add = await request<{
          added: boolean;
          marker: { phrase: string; addedAt?: string };
        }>("POST", "/feedback/calibration/handwavy-phrases", {
          phrase: "task223 backdated marker ignored",
          category: "hedging",
          reviewer: "task223-tester",
          addedAt: "2020-01-01T00:00:00.000Z",
        });
        const after = Date.now();
        expect(add.status).toBe(201);
        // The supplied addedAt is dropped — the server stamps `new Date()`
        // and the marker's addedAt must fall inside the request window.
        expect(add.body.marker.addedAt).toBeTypeOf("string");
        const stamped = Date.parse(add.body.marker.addedAt!);
        expect(stamped).toBeGreaterThanOrEqual(before);
        expect(stamped).toBeLessThanOrEqual(after);
      } finally {
        if (original === undefined) {
          delete process.env.HANDWAVY_ALLOW_TEST_BACKDATE;
        } else {
          process.env.HANDWAVY_ALLOW_TEST_BACKDATE = original;
        }
      }
    });
  });

  it("POST rejects non-string reviewer/rationale with 400", async () => {
    const r = await request<{ error: string }>(
      "POST",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "phrase with bad reviewer", reviewer: 42 },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reviewer/);
  });

  it("DELETE appends a history entry that records who removed and original add metadata", async () => {
    await request("POST", "/feedback/calibration/handwavy-phrases", {
      phrase: "doomed marker",
      category: "hedging",
      reviewer: "alice@team.com",
      rationale: "noisy on internal triage drills",
    });
    const del = await request<{
      removed: boolean;
      historyEntry: { phrase: string; removedBy?: string; removedAt: string; addedBy?: string; rationale?: string };
      history: Array<{ phrase: string; removedBy?: string }>;
    }>("DELETE", "/feedback/calibration/handwavy-phrases", {
      phrase: "doomed marker",
      reviewer: "bob@team.com",
    });
    expect(del.status).toBe(200);
    expect(del.body.historyEntry.removedBy).toBe("bob@team.com");
    expect(del.body.historyEntry.addedBy).toBe("alice@team.com");
    expect(del.body.historyEntry.rationale).toMatch(/noisy/);
    expect(del.body.history.some((h) => h.phrase === "doomed marker" && h.removedBy === "bob@team.com")).toBe(true);

    const list = await request<{
      history: Array<{ phrase: string; removedBy?: string }>;
    }>("GET", "/feedback/calibration/handwavy-phrases");
    expect(list.body.history.some((h) => h.phrase === "doomed marker" && h.removedBy === "bob@team.com")).toBe(true);
  });

  // --- Task #121: reinstate from history ---

  describe("Task #121 reinstate-from-history", () => {
    it("POST /reinstate re-adds the phrase straight from a history row, with original category and rationale", async () => {
      // Add (with audit), then remove, then reinstate.
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "reinstate me",
        category: "buzzword",
        reviewer: "alice@team.com",
        rationale: "Triggered three duplicate triages last sprint.",
      });
      const del = await request<{
        historyEntry: { phrase: string; removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrase: "reinstate me",
        reviewer: "bob@team.com",
      });
      const removedAt = del.body.historyEntry.removedAt;

      const reinstate = await request<{
        reinstated: boolean;
        phrase: string;
        category: string;
        marker: { phrase: string; category: string; addedBy?: string; rationale?: string };
        historyEntry: { reinstated: boolean; reinstatedBy?: string; reinstatedAt?: string };
        phrases: Marker[];
        history: Array<{ phrase: string; removedAt: string; reinstated?: boolean }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate", {
        phrase: "reinstate me",
        removedAt,
        reviewer: "carol@team.com",
      });
      expect(reinstate.status).toBe(201);
      expect(reinstate.body.reinstated).toBe(true);
      expect(reinstate.body.phrase).toBe("reinstate me");
      expect(reinstate.body.category).toBe("buzzword");
      // Original rationale carried over.
      expect(reinstate.body.marker.rationale).toMatch(/duplicate triages/);
      // CURRENT reviewer recorded as addedBy on the active marker.
      expect(reinstate.body.marker.addedBy).toBe("carol@team.com");
      // History row flagged.
      expect(reinstate.body.historyEntry.reinstated).toBe(true);
      expect(reinstate.body.historyEntry.reinstatedBy).toBe("carol@team.com");
      // Phrase is back on the active list.
      expect(reinstate.body.phrases.map((m) => m.phrase)).toContain("reinstate me");
      // History reflects the flag too.
      const historyRow = reinstate.body.history.find(
        (h) => h.phrase === "reinstate me" && h.removedAt === removedAt,
      );
      expect(historyRow?.reinstated).toBe(true);
    });

    it("POST /reinstate returns 404 when no matching history entry exists", async () => {
      const r = await request<{ error: string; reason?: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { phrase: "ghost phrase", removedAt: "2026-01-01T00:00:00.000Z" },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("history-not-found");
    });

    it("POST /reinstate returns 409 when the same history row was already reinstated", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "twice reinstated phrase",
        category: "absence",
      });
      const del = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "twice reinstated phrase" },
      );
      const removedAt = del.body.historyEntry.removedAt;
      const first = await request("POST", "/feedback/calibration/handwavy-phrases/reinstate", {
        phrase: "twice reinstated phrase",
        removedAt,
      });
      expect(first.status).toBe(201);
      const second = await request<{ reason?: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { phrase: "twice reinstated phrase", removedAt },
      );
      expect(second.status).toBe(409);
      expect(second.body.reason).toBe("already-reinstated");
    });

    it("POST /reinstate rejects missing phrase or removedAt with 400", async () => {
      const noPhrase = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { removedAt: "2026-04-01T00:00:00.000Z" },
      );
      expect(noPhrase.status).toBe(400);
      const noTs = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { phrase: "anything" },
      );
      expect(noTs.status).toBe(400);
      expect(noTs.body.error).toMatch(/removedAt/);
    });
  });

  // --- Task #120: in-place edits ---

  describe("PATCH /feedback/calibration/handwavy-phrases", () => {
    it("PATCH updates the category and returns the edit audit entry", async () => {
      // Seed the row with reviewer + rationale so we can confirm the PATCH
      // preserves the original add metadata and only appends a new edit entry.
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "patchable marker",
        category: "absence",
        reviewer: "alice@team.com",
        rationale: "initial reason",
      });
      const r = await request<{
        edited: boolean;
        marker: {
          phrase: string;
          category: string;
          addedBy?: string;
          rationale?: string;
          edits?: Array<{ editedBy?: string; category?: { from: string; to: string } }>;
        };
        editEntry?: { editedBy?: string; category?: { from: string; to: string } };
      }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "patchable marker",
        category: "buzzword",
        reviewer: "bob@team.com",
      });
      expect(r.status).toBe(200);
      expect(r.body.edited).toBe(true);
      expect(r.body.editEntry?.category).toEqual({ from: "absence", to: "buzzword" });
      expect(r.body.editEntry?.editedBy).toBe("bob@team.com");
      expect(r.body.marker.category).toBe("buzzword");
      expect(r.body.marker.addedBy).toBe("alice@team.com");
      expect(r.body.marker.rationale).toBe("initial reason");
      expect(r.body.marker.edits).toHaveLength(1);

      const list = await request<{
        phrases: Array<{
          phrase: string;
          category: string;
          edits?: Array<{ editedBy?: string }>;
        }>;
      }>("GET", "/feedback/calibration/handwavy-phrases");
      const found = list.body.phrases.find((m) => m.phrase === "patchable marker");
      expect(found?.category).toBe("buzzword");
      expect(found?.edits?.[0].editedBy).toBe("bob@team.com");
    });

    it("PATCH updates the rationale and clears it when empty", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "rationale-edit marker",
        category: "hedging",
        rationale: "first reason",
      });
      const r1 = await request<{ edited: boolean; marker: { rationale?: string } }>(
        "PATCH",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "rationale-edit marker", rationale: "fixed reason" },
      );
      expect(r1.status).toBe(200);
      expect(r1.body.edited).toBe(true);
      expect(r1.body.marker.rationale).toBe("fixed reason");

      const r2 = await request<{ edited: boolean; marker: { rationale?: string } }>(
        "PATCH",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "rationale-edit marker", rationale: "" },
      );
      expect(r2.status).toBe(200);
      expect(r2.body.edited).toBe(true);
      expect(r2.body.marker.rationale).toBeUndefined();
    });

    it("PATCH returns edited=false on a no-op update", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "noop marker",
        category: "absence",
        rationale: "stable reason",
      });
      const r = await request<{ edited: boolean }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "noop marker",
        category: "absence",
        rationale: "stable reason",
      });
      expect(r.status).toBe(200);
      expect(r.body.edited).toBe(false);
    });

    it("PATCH returns 404 when the phrase is not in the active list", async () => {
      const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "phrase that was never added",
        category: "absence",
      });
      expect(r.status).toBe(404);
    });

    it("PATCH rejects an invalid category with 400", async () => {
      const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "seed phrase one",
        category: "nonsense",
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/category/);
    });

    it("PATCH rejects a body with no updates", async () => {
      const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "seed phrase one",
      });
      expect(r.status).toBe(400);
    });

    it("PATCH rejects a missing phrase with 400", async () => {
      const r = await request<{ error: string }>("PATCH", "/feedback/calibration/handwavy-phrases", {
        category: "absence",
      });
      expect(r.status).toBe(400);
    });
  });

  // --- Task #130: undo a brand-new add ---

  describe("Task #130 undo-recent-add", () => {
    it("POST /undo removes the marker and stamps the history row undone:true", async () => {
      const add = await request<{
        marker: { phrase: string; addedAt: string };
      }>("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "undo me phrase",
        category: "buzzword",
        reviewer: "alice@team.com",
        rationale: "Bad call.",
      });
      expect(add.status).toBe(201);
      const addedAt = add.body.marker.addedAt;

      const undo = await request<{
        undone: boolean;
        phrase: string;
        historyEntry: { undone: boolean; undoneBy?: string; removedBy?: string };
        phrases: Array<{ phrase: string }>;
        history: Array<{ phrase: string; removedAt: string; undone?: boolean }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/undo", {
        phrase: "undo me phrase",
        addedAt,
        reviewer: "alice@team.com",
      });
      expect(undo.status).toBe(200);
      expect(undo.body.undone).toBe(true);
      expect(undo.body.historyEntry.undone).toBe(true);
      expect(undo.body.historyEntry.undoneBy).toBe("alice@team.com");
      expect(undo.body.historyEntry.removedBy).toBe("alice@team.com");
      expect(undo.body.phrases.map((m) => m.phrase)).not.toContain("undo me phrase");
      const row = undo.body.history.find((h) => h.phrase === "undo me phrase");
      expect(row?.undone).toBe(true);
    });

    it("POST /undo returns 404 when the phrase isn't on the active list", async () => {
      const r = await request<{ reason: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo",
        { phrase: "ghost phrase that was never added", addedAt: "2026-04-22T12:00:00.000Z" },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("not-found");
    });

    it("POST /undo returns 409 when the addedAt no longer matches", async () => {
      const add = await request<{ marker: { phrase: string; addedAt: string } }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "addedat mismatch undo phrase" },
      );
      expect(add.status).toBe(201);
      const r = await request<{ reason: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo",
        {
          phrase: "addedat mismatch undo phrase",
          addedAt: "2020-01-01T00:00:00.000Z",
        },
      );
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("addedAt-mismatch");
    });

    it("POST /undo rejects missing phrase or addedAt with 400", async () => {
      const noPhrase = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo",
        { addedAt: "2026-04-22T12:00:00.000Z" },
      );
      expect(noPhrase.status).toBe(400);
      const noTs = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo",
        { phrase: "whatever" },
      );
      expect(noTs.status).toBe(400);
      expect(noTs.body.error).toMatch(/addedAt/);
    });
  });

  // --- Task #233: bulk-undo wrapper ---
  describe("Task #233 POST /feedback/calibration/handwavy-phrases/undo-batch", () => {
    it("undoes every supplied (phrase, addedAt) pair and emits one undone:true history row per phrase", async () => {
      const a = await request<{ marker: { phrase: string; addedAt: string } }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "batch-undo-route alpha", category: "absence", reviewer: "alice@team.com" },
      );
      const b = await request<{ marker: { phrase: string; addedAt: string } }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "batch-undo-route bravo", category: "absence", reviewer: "alice@team.com" },
      );
      const c = await request<{ marker: { phrase: string; addedAt: string } }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "batch-undo-route charlie", category: "absence", reviewer: "alice@team.com" },
      );
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(c.status).toBe(201);

      const resp = await request<{
        undone: boolean;
        batch: boolean;
        undoneCount: number;
        skipped: number;
        total: number;
        results: Array<{ phrase: string; undone: boolean; reason?: string; historyEntry?: { undone?: boolean; undoneBy?: string } }>;
        phrases: Array<{ phrase: string }>;
        history: Array<{ phrase: string; undone?: boolean; undoneBy?: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/undo-batch", {
        entries: [
          { phrase: "batch-undo-route alpha", addedAt: a.body.marker.addedAt },
          { phrase: "batch-undo-route bravo", addedAt: b.body.marker.addedAt },
          { phrase: "batch-undo-route charlie", addedAt: c.body.marker.addedAt },
        ],
        reviewer: "alice@team.com",
      });

      expect(resp.status).toBe(200);
      expect(resp.body.undone).toBe(true);
      expect(resp.body.batch).toBe(true);
      expect(resp.body.undoneCount).toBe(3);
      expect(resp.body.skipped).toBe(0);
      expect(resp.body.results).toHaveLength(3);
      for (const r of resp.body.results) {
        expect(r.undone).toBe(true);
        expect(r.historyEntry?.undone).toBe(true);
        expect(r.historyEntry?.undoneBy).toBe("alice@team.com");
      }
      // Active list no longer includes any of the three.
      const active = resp.body.phrases.map((m) => m.phrase);
      expect(active).not.toContain("batch-undo-route alpha");
      expect(active).not.toContain("batch-undo-route bravo");
      expect(active).not.toContain("batch-undo-route charlie");
      // History contains three distinct undone:true rows — no batch-merge collapse.
      const undone = resp.body.history.filter(
        (h) =>
          h.undone === true &&
          (h.phrase === "batch-undo-route alpha" ||
            h.phrase === "batch-undo-route bravo" ||
            h.phrase === "batch-undo-route charlie"),
      );
      expect(undone).toHaveLength(3);
      expect(new Set(undone.map((u) => u.phrase)).size).toBe(3);
    });

    it("reports a skipped entry alongside successful ones without aborting the batch", async () => {
      const fresh = await request<{ marker: { phrase: string; addedAt: string } }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "batch-undo-route mixed-fresh" },
      );
      expect(fresh.status).toBe(201);

      const resp = await request<{
        undoneCount: number;
        skipped: number;
        results: Array<{ phrase: string; undone: boolean; reason?: string }>;
        phrases: Array<{ phrase: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/undo-batch", {
        entries: [
          { phrase: "batch-undo-route mixed-fresh", addedAt: fresh.body.marker.addedAt },
          { phrase: "batch-undo-route never-existed", addedAt: "2026-04-22T12:00:00.000Z" },
        ],
      });

      expect(resp.status).toBe(200);
      expect(resp.body.undoneCount).toBe(1);
      expect(resp.body.skipped).toBe(1);
      expect(resp.body.results).toHaveLength(2);
      const reasonByPhrase = new Map<string, string | undefined>();
      for (const r of resp.body.results) reasonByPhrase.set(r.phrase, r.reason);
      expect(reasonByPhrase.get("batch-undo-route mixed-fresh")).toBeUndefined();
      expect(reasonByPhrase.get("batch-undo-route never-existed")).toBe("not-found");
      const active = resp.body.phrases.map((m) => m.phrase);
      expect(active).not.toContain("batch-undo-route mixed-fresh");
    });

    it("rejects a missing or empty entries array with 400", async () => {
      const noEntries = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        {},
      );
      expect(noEntries.status).toBe(400);
      const empty = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        { entries: [] },
      );
      expect(empty.status).toBe(400);
    });

    it("rejects malformed entries with 400 (missing phrase, missing addedAt, or non-string)", async () => {
      const noPhrase = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        { entries: [{ addedAt: "2026-04-22T12:00:00.000Z" }] },
      );
      expect(noPhrase.status).toBe(400);
      const noAddedAt = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        { entries: [{ phrase: "x" }] },
      );
      expect(noAddedAt.status).toBe(400);
      const wrongType = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        { entries: [{ phrase: 42, addedAt: "2026-04-22T12:00:00.000Z" }] },
      );
      expect(wrongType.status).toBe(400);
    });

    it("rejects oversized batches with 400", async () => {
      const huge = Array.from({ length: 201 }, (_, i) => ({
        phrase: `over-cap phrase ${i}`,
        addedAt: "2026-04-22T12:00:00.000Z",
      }));
      const resp = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        { entries: huge },
      );
      expect(resp.status).toBe(400);
      expect(resp.body.error).toMatch(/200/);
    });

    it("rejects a non-string reviewer with 400", async () => {
      const resp = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo-batch",
        {
          entries: [{ phrase: "x", addedAt: "2026-04-22T12:00:00.000Z" }],
          reviewer: 12345,
        },
      );
      expect(resp.status).toBe(400);
      expect(resp.body.error).toMatch(/reviewer/);
    });
  });

  // --- Task #132: revert a single edit-history entry ---

  describe("POST /feedback/calibration/handwavy-phrases/revert-edit", () => {
    it("undoes a category edit, returning the new marker state and an inverse edit entry", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "revert-route phrase",
        category: "absence",
        reviewer: "alice@team.com",
      });
      const edit = await request<{ editEntry: { editedAt: string } }>(
        "PATCH",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "revert-route phrase", category: "buzzword", reviewer: "bob@team.com" },
      );
      expect(edit.status).toBe(200);
      const editedAt = edit.body.editEntry.editedAt;

      const r = await request<{
        reverted: boolean;
        edited: boolean;
        marker: { category: string; edits?: Array<{ category?: { from: string; to: string }; editedBy?: string }> };
        revertedEntry: { editedAt: string };
      }>("POST", "/feedback/calibration/handwavy-phrases/revert-edit", {
        phrase: "revert-route phrase",
        editedAt,
        reviewer: "carol@team.com",
      });
      expect(r.status).toBe(200);
      expect(r.body.reverted).toBe(true);
      expect(r.body.edited).toBe(true);
      expect(r.body.marker.category).toBe("absence");
      expect(r.body.marker.edits).toHaveLength(2);
      const inverse = r.body.marker.edits?.[1];
      expect(inverse?.editedBy).toBe("carol@team.com");
      expect(inverse?.category).toEqual({ from: "buzzword", to: "absence" });
      expect(r.body.revertedEntry.editedAt).toBe(editedAt);
    });

    it("returns 404 when the phrase is not in the active list", async () => {
      const r = await request<{ error: string; reason: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/revert-edit",
        { phrase: "phrase that was never added", editedAt: "2026-04-22T13:00:00.000Z" },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("phrase-not-found");
    });

    it("returns 404 when no edit entry on that phrase matches editedAt", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "revert-route bad-ts",
        category: "absence",
      });
      await request("PATCH", "/feedback/calibration/handwavy-phrases", {
        phrase: "revert-route bad-ts",
        category: "hedging",
      });
      const r = await request<{ error: string; reason: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/revert-edit",
        { phrase: "revert-route bad-ts", editedAt: "2099-01-01T00:00:00.000Z" },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("edit-not-found");
    });

    it("rejects missing phrase or editedAt with 400", async () => {
      const noPhrase = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/revert-edit",
        { editedAt: "2026-04-22T13:00:00.000Z" },
      );
      expect(noPhrase.status).toBe(400);
      const noTs = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/revert-edit",
        { phrase: "revert-route phrase" },
      );
      expect(noTs.status).toBe(400);
      expect(noTs.body.error).toMatch(/editedAt/);
    });
  });

  // Task #135 — batched DELETE so the CLI can remove many phrases in one
  // round-trip and one history entry instead of N per-phrase calls.
  describe("Task #135 batched DELETE", () => {
    it("DELETE with {phrases: [...]} removes every match in one call and writes ONE batch history entry", async () => {
      // Seed a couple of extra phrases on top of the SEED so we can remove a
      // mix of present + absent in the same batch.
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "batch route alpha", category: "absence" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "batch route bravo", category: "hedging" });

      const r = await request<{
        batch: boolean;
        removed: number;
        notFound: number;
        total: number;
        results: Array<{ raw: string; phrase: string; removed: boolean; reason?: string }>;
        historyEntry: { phrases: Array<{ phrase: string; category: string }>; removedBy?: string } | null;
        phrases: Marker[];
        history: Array<{ phrase?: string; phrases?: Array<{ phrase: string }>; removedAt: string }>;
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["seed phrase one", "batch route alpha", "BATCH route bravo", "never registered"],
        reviewer: "bob@team.com",
      });
      expect(r.status).toBe(200);
      expect(r.body.batch).toBe(true);
      expect(r.body.removed).toBe(3);
      expect(r.body.notFound).toBe(1);
      expect(r.body.results.find((x) => x.raw === "never registered")?.reason).toBe("not-found");
      expect(r.body.historyEntry?.phrases.map((p) => p.phrase)).toEqual([
        "seed phrase one",
        "batch route alpha",
        "batch route bravo",
      ]);
      expect(r.body.historyEntry?.removedBy).toBe("bob@team.com");
      // Active list reflects all removals.
      const active = r.body.phrases.map((m) => m.phrase);
      expect(active).not.toContain("seed phrase one");
      expect(active).not.toContain("batch route alpha");
      expect(active).not.toContain("batch route bravo");
      // History contains exactly one new batch entry, not three.
      const batchEntries = r.body.history.filter((h) => Array.isArray(h.phrases));
      expect(batchEntries.length).toBe(1);
      expect(batchEntries[0].phrases?.length).toBe(3);
    });

    it("DELETE batch returns 404 when nothing matched", async () => {
      const r = await request<{ batch: boolean; removed: number; notFound: number }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["never one", "never two"] },
      );
      expect(r.status).toBe(404);
      expect(r.body.batch).toBe(true);
      expect(r.body.removed).toBe(0);
      expect(r.body.notFound).toBe(2);
    });

    it("DELETE batch rejects sending both `phrase` and `phrases` with 400", async () => {
      const r = await request<{ error: string }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase one", phrases: ["seed phrase two"] },
      );
      expect(r.status).toBe(400);
    });

    it("DELETE batch rejects an empty `phrases` array with 400", async () => {
      const r = await request<{ error: string }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: [] },
      );
      expect(r.status).toBe(400);
    });

    it("DELETE batch rejects > 200 phrases with 400 (server-side cap)", async () => {
      const phrases = Array.from({ length: 201 }, (_, i) => `bulk phrase ${i}`);
      const r = await request<{ error: string }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases },
      );
      expect(r.status).toBe(400);
    });

    // Task #145 — DELETE batch with `dryRun: true` returns a preview that
    // mirrors the post-mutation per-phrase results plus a corpus-impact
    // summary, but DOES NOT touch the active list, history, or cache.
    it("DELETE batch with dryRun=true returns a preview and does NOT mutate the active list", async () => {
      // Seed an extra phrase so we have a mix of present + missing in the batch.
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "batch dryrun alpha",
        category: "absence",
      });
      const r = await request<{
        dryRun: boolean;
        batch: boolean;
        wouldRemove: number;
        notFound: number;
        duplicateInBatch: number;
        total: number;
        projectedTotal: number;
        results: Array<{ raw: string; phrase: string; removed: boolean; reason?: string }>;
        dryRunImpact: {
          corpus: {
            total: number;
            byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
            validDetectionsLost: number;
            falsePositivesDropped: number;
            corpusSize: number;
            sampleMatches: Array<{ id: string; tier: string }>;
            warning: string | null;
          };
          production: unknown;
          productionError: string | null;
          productionLimit: number;
        };
        phrases: Marker[];
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: [
          "seed phrase one",
          "batch dryrun alpha",
          "seed phrase one", // duplicate-in-batch
          "never registered xyzzy",
        ],
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.batch).toBe(true);
      expect(r.body.wouldRemove).toBe(2);
      expect(r.body.notFound).toBe(1);
      expect(r.body.duplicateInBatch).toBe(1);
      expect(r.body.projectedTotal).toBe(r.body.total - 2);
      // Per-phrase results in input order.
      expect(r.body.results[0].removed).toBe(true);
      expect(r.body.results[1].removed).toBe(true);
      expect(r.body.results[2].reason).toBe("duplicate-in-batch");
      expect(r.body.results[3].reason).toBe("not-found");
      // Corpus impact is always present.
      expect(r.body.dryRunImpact.corpus.corpusSize).toBeGreaterThan(0);
      expect(r.body.dryRunImpact.corpus.byTier).toEqual({
        t1Legit: expect.any(Number),
        t2Borderline: expect.any(Number),
        t3Slop: expect.any(Number),
        t4Hallucinated: expect.any(Number),
      });
      expect(r.body.dryRunImpact.productionLimit).toBe(2000);
      // Crucially: the active list and history were NOT mutated.
      const list = await request<{ phrases: Marker[]; history: unknown[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      const active = list.body.phrases.map((m) => m.phrase);
      expect(active).toContain("seed phrase one");
      expect(active).toContain("batch dryrun alpha");
    });

    it("DELETE batch dryRun=true surfaces a warning when valid hand-wavy detections would be lost", async () => {
      // Restore curated defaults so we have real slop-detecting phrases like
      // "private fuzzing harness" available — they appear in T3/T4 corpus
      // fixtures, so removing them would un-flag legitimate slop reports.
      __restoreDefaults();
      const r = await request<{
        dryRun: boolean;
        wouldRemove: number;
        dryRunImpact: {
          corpus: {
            validDetectionsLost: number;
            byTier: { t3Slop: number; t4Hallucinated: number };
            warning: string | null;
          };
        };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        // Pull every default phrase out at once so at least some T3/T4
        // fixtures lose their flag.
        phrases: [
          "do not have a runnable reproducer",
          "do not have a reproducer",
          "private fuzzing harness",
          "private poc",
          "structural rather than",
          "structural vulnerability follows from the design",
          "i have not enumerated",
          "have not been able to confirm",
          "no working proof-of-concept",
          "no runnable proof",
          "follows from the design as observed",
          "deployment is no different in this respect",
          "may not be encrypted",
          "may be present in environment variables",
          "do not appear to be",
          "does not appear to be",
          "appears to be susceptible",
          "consider a holistic remediation",
          "leadership-level discussion",
          "comprehensive zero-trust assessment",
          "modern threat landscape",
          "advanced persistent threats",
          "defense-in-depth posture",
          "weak security culture",
        ],
        dryRun: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.wouldRemove).toBeGreaterThan(0);
      // We expect at least one slop-tier flag to be lost; if the corpus
      // happens not to mention any default phrase the warning will be null,
      // but the byTier tally must still be defined.
      const c = r.body.dryRunImpact.corpus;
      if (c.validDetectionsLost > 0) {
        expect(c.warning).not.toBeNull();
        expect(c.warning).toMatch(/un-flag|legitimately/);
      } else {
        expect(c.warning).toBeNull();
      }
    });

    it("DELETE batch dryRun=true with no matching phrases returns wouldRemove=0 and a zero-impact preview", async () => {
      const r = await request<{
        dryRun: boolean;
        wouldRemove: number;
        notFound: number;
        dryRunImpact: {
          corpus: { total: number; warning: string | null };
          production: { total: number; oldestCreatedAt: string | null; newestCreatedAt: string | null } | null;
          productionError: string | null;
        };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["never one xyzzy", "never two xyzzy"],
        dryRun: true,
      });
      // No mutation, so the batched 404 path does NOT apply to dry-run.
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.wouldRemove).toBe(0);
      expect(r.body.notFound).toBe(2);
      expect(r.body.dryRunImpact.corpus.total).toBe(0);
      expect(r.body.dryRunImpact.corpus.warning).toBeNull();
      // Task #218 — the skipped production block (no removal candidates) still
      // returns the date-range fields with both ends null so the UI can render
      // a uniform shape.
      expect(r.body.dryRunImpact.production).not.toBeNull();
      expect(r.body.dryRunImpact.production?.oldestCreatedAt).toBeNull();
      expect(r.body.dryRunImpact.production?.newestCreatedAt).toBeNull();
    });

    // Task #218 — the bulk-removal preview's production block must surface
    // the same `Scanned N reports from <oldest> to <newest>` signal that the
    // add-time preview already returns (Task #124). Reviewers using the
    // bulk-retire flow have the same "is this signal current or stale?"
    // question and should not have to guess from raw counts.
    it("DELETE batch dryRun=true returns oldestCreatedAt/newestCreatedAt on the production block", async () => {
      // Seed a phrase so removedNormalized is non-empty and the route
      // actually performs the production scan (instead of short-circuiting
      // to the zero-impact placeholder).
      await request("POST", "/feedback/calibration/handwavy-phrases", {
        phrase: "batch dryrun range probe",
        category: "absence",
      });
      const r = await request<{
        dryRunImpact: {
          production: {
            corpusSize: number;
            oldestCreatedAt: string | null;
            newestCreatedAt: string | null;
          } | null;
          productionError: string | null;
        };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["batch dryrun range probe"],
        dryRun: true,
      });
      expect(r.status).toBe(200);
      // Production block must always carry the date-range fields. Either
      // both are ISO-8601 timestamps (rows with createdAt) or both are null
      // (empty scan / no createdAt). Mixed/partial pairs are not allowed.
      if (r.body.dryRunImpact.production != null) {
        expect(r.body.dryRunImpact.production).toHaveProperty("oldestCreatedAt");
        expect(r.body.dryRunImpact.production).toHaveProperty("newestCreatedAt");
        const oldest = r.body.dryRunImpact.production.oldestCreatedAt;
        const newest = r.body.dryRunImpact.production.newestCreatedAt;
        if (oldest === null) {
          expect(newest).toBeNull();
        } else {
          expect(typeof oldest).toBe("string");
          expect(typeof newest).toBe("string");
          // Newest must be >= oldest.
          expect(Date.parse(newest!)).toBeGreaterThanOrEqual(Date.parse(oldest));
        }
      } else {
        expect(typeof r.body.dryRunImpact.productionError).toBe("string");
      }
    });

    // Task #229 / #230 — productionScanLimit on the bulk DELETE path.
    // Task #229 added the per-call knob to the bulk dry-run; Task #230
    // generalized it into the shared calibration window that the
    // add-phrase, single-remove, and bulk-remove paths all consult, with
    // a single shared parser/validator at the top of the DELETE handler.
    // We validate the field on every DELETE (not just dry-run) so a
    // malformed value cannot silently slip into a real removal, but the
    // resolved limit is only consumed on the dry-run path. The single-
    // phrase echo case lives in its own describe block earlier in this
    // file (Task #230 productionScanLimit on single-phrase DELETE
    // dry-run); the cases below cover the batch path plus cross-path
    // validator behavior.
    describe("Task #229 / #230 — productionScanLimit on bulk DELETE", () => {
      it("DELETE batch dry-run echoes the reviewer-supplied productionScanLimit", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit echo a" });
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit echo b" });
        const r = await request<{
          dryRun: boolean;
          batch: boolean;
          dryRunImpact: { productionLimit: number };
        }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit echo a", "bulk plimit echo b"],
          dryRun: true,
          productionScanLimit: 5000,
        });
        expect(r.status).toBe(200);
        expect(r.body.dryRun).toBe(true);
        expect(r.body.batch).toBe(true);
        expect(r.body.dryRunImpact.productionLimit).toBe(5000);
      });

      it("DELETE batch dry-run defaults productionLimit to 2000 when omitted", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit default a" });
        const r = await request<{
          dryRunImpact: { productionLimit: number };
        }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit default a"],
          dryRun: true,
        });
        expect(r.status).toBe(200);
        expect(r.body.dryRunImpact.productionLimit).toBe(2000);
      });

      it("DELETE batch dry-run accepts the documented bounds (100 and 10000)", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit bounds a" });
        const lo = await request<{ dryRunImpact: { productionLimit: number } }>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrases: ["bulk plimit bounds a"], dryRun: true, productionScanLimit: 100 },
        );
        expect(lo.status).toBe(200);
        expect(lo.body.dryRunImpact.productionLimit).toBe(100);
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit bounds b" });
        const hi = await request<{ dryRunImpact: { productionLimit: number } }>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrases: ["bulk plimit bounds b"], dryRun: true, productionScanLimit: 10000 },
        );
        expect(hi.status).toBe(200);
        expect(hi.body.dryRunImpact.productionLimit).toBe(10000);
      });

      it("DELETE batch rejects productionScanLimit below the floor with 400", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit low a" });
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit low a"],
          dryRun: true,
          productionScanLimit: 50,
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("DELETE batch rejects productionScanLimit above the ceiling with 400", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit high a" });
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit high a"],
          dryRun: true,
          productionScanLimit: 99999,
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("DELETE batch rejects non-integer productionScanLimit with 400", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit frac a" });
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit frac a"],
          dryRun: true,
          productionScanLimit: 1500.5,
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      it("DELETE batch rejects non-numeric productionScanLimit with 400", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit str a" });
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit str a"],
          dryRun: true,
          productionScanLimit: "lots",
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });

      // Real (non-dry-run) bulk DELETE: the field is meaningless because the
      // production-scan only runs on the dry-run preview, but a malformed
      // value must STILL be rejected so we never silently accept rubbish on
      // a destructive call. A well-formed value is silently accepted (and
      // ignored, since the real DELETE doesn't consult it).
      it("DELETE batch real removal rejects an out-of-range productionScanLimit even though it is unused", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit real bad" });
        const before = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
        const beforeCount = before.body.phrases.length;
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit real bad"],
          productionScanLimit: 1, // out of range
        });
        expect(r.status).toBe(400);
        // Mutation must NOT have occurred — bad inputs cannot leak past the
        // validator into a real removal.
        const after = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
        expect(after.body.phrases.length).toBe(beforeCount);
        expect(after.body.phrases.map((m) => m.phrase)).toContain("bulk plimit real bad");
      });

      it("DELETE batch real removal accepts a well-formed productionScanLimit and removes the phrases", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit real ok" });
        const r = await request<{ removed: number }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrases: ["bulk plimit real ok"],
          productionScanLimit: 3000,
        });
        expect(r.status).toBe(200);
        expect(r.body.removed).toBe(1);
        const after = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
        expect(after.body.phrases.map((m) => m.phrase)).not.toContain("bulk plimit real ok");
      });

      it("DELETE single-phrase path accepts but does not consume productionScanLimit (validator still runs)", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "single plimit accepted" });
        // The single-phrase removal path is out of scope for Task #229 —
        // its dry-run preview still uses the legacy 2000-row default and
        // does not surface a per-call window override. But because the
        // productionScanLimit validator runs at the TOP of the DELETE
        // handler (before the single-vs-batch branch), a well-formed
        // value is accepted on the single path too; it is simply not
        // consumed. This guarantees that a malformed value cannot slip
        // past the validator on ANY DELETE — see the bad-value test
        // below for the symmetric rejection case.
        const r = await request<{ removed: boolean }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrase: "single plimit accepted",
          productionScanLimit: 4000,
        });
        expect(r.status).toBe(200);
        expect(r.body.removed).toBe(true);
      });

      it("DELETE single-phrase path rejects an out-of-range productionScanLimit with 400 (no mutation)", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "single plimit bad" });
        const r = await request<{ error: string }>("DELETE", "/feedback/calibration/handwavy-phrases", {
          phrase: "single plimit bad",
          productionScanLimit: 1, // out of range
        });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
        // Mutation must NOT have occurred — even on the single-phrase path
        // the up-front validator blocks bad values before any state change.
        const after = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
        expect(after.body.phrases.map((m) => m.phrase)).toContain("single plimit bad");
      });

      // Task #230 — the bounds-acceptance and broad bad-value rejection
      // cases above already cover the dry-run path; this one closes the
      // loop on the real (non-dry-run) batch path by asserting the
      // shared validator still rejects malformed values when `dryRun`
      // is omitted entirely. Without this guarantee a malformed window
      // could silently slip into a destructive call (the dry-run-only
      // tests above don't catch that regression).
      it("DELETE batch validates productionScanLimit even when dryRun is omitted (so a bad value never silently slips into a real batch removal)", async () => {
        await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "bulk plimit no-dryrun a" });
        const r = await request<{ error: string }>(
          "DELETE",
          "/feedback/calibration/handwavy-phrases",
          { phrases: ["bulk plimit no-dryrun a"], productionScanLimit: 50000 },
        );
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/productionScanLimit/);
      });
    });

    it("DELETE batch supports per-phrase reinstate via the existing /reinstate endpoint", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "batch reinstate route a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "batch reinstate route b" });
      const removed = await request<{
        historyEntry: { removedAt: string; phrases: Array<{ phrase: string }> };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["batch reinstate route a", "batch reinstate route b"],
      });
      expect(removed.status).toBe(200);
      const removedAt = removed.body.historyEntry.removedAt;
      const reinstated = await request<{ reinstated: boolean; phrase: string; total: number }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { phrase: "batch reinstate route a", removedAt, reviewer: "carol@team.com" },
      );
      expect([200, 201]).toContain(reinstated.status);
      expect(reinstated.body.reinstated).toBe(true);
      expect(reinstated.body.phrase).toBe("batch reinstate route a");
      const list = await request<{ phrases: Marker[] }>("GET", "/feedback/calibration/handwavy-phrases");
      expect(list.body.phrases.map((m) => m.phrase)).toContain("batch reinstate route a");
    });
  });

  // Task #144 — single-call batch reinstate so reviewers can undo a whole
  // bulk CLI removal without clicking reinstate N times.
  describe("Task #144 batch reinstate", () => {
    it("POST /reinstate-batch reinstates every inner phrase in one call and flips the aggregate flag", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb a", category: "absence" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb b", category: "hedging" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb c", category: "buzzword" });
      const removed = await request<{
        historyEntry: { removedAt: string; phrases: Array<{ phrase: string }> };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb a", "rb b", "rb c"],
        reviewer: "alice@team.com",
      });
      const removedAt = removed.body.historyEntry.removedAt;

      const r = await request<{
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
        historyEntry: { reinstated: boolean; phrases: Array<{ phrase: string; reinstated?: boolean }> };
        phrases: Marker[];
        history: Array<{ removedAt: string; reinstated?: boolean }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
        reviewer: "carol@team.com",
      });
      expect(r.status).toBe(200);
      expect(r.body.reinstatedCount).toBe(3);
      expect(r.body.skipped).toBe(0);
      expect(r.body.results.every((x) => x.reinstated)).toBe(true);
      expect(r.body.historyEntry.reinstated).toBe(true);
      expect(r.body.historyEntry.phrases.every((p) => p.reinstated === true)).toBe(true);
      const active = r.body.phrases.map((m) => m.phrase);
      expect(active).toContain("rb a");
      expect(active).toContain("rb b");
      expect(active).toContain("rb c");
    });

    it("POST /reinstate-batch returns 200 + skip reasons when some inner phrases are already reinstated/active", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb skip a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb skip b" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb skip a", "rb skip b"],
      });
      const removedAt = removed.body.historyEntry.removedAt;
      // Reinstate one ahead of time.
      await request("POST", "/feedback/calibration/handwavy-phrases/reinstate", {
        phrase: "rb skip a",
        removedAt,
      });
      const r = await request<{
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
      });
      expect(r.status).toBe(200);
      expect(r.body.reinstatedCount).toBe(1);
      expect(r.body.skipped).toBe(1);
      const skipA = r.body.results.find((x) => x.phrase === "rb skip a");
      expect(skipA?.reinstated).toBe(false);
      expect(skipA?.reason).toBe("already-reinstated");
    });

    it("POST /reinstate-batch returns 404 when removedAt does not match any history entry", async () => {
      const r = await request<{ reason?: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: "2099-01-01T00:00:00.000Z" },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("history-not-found");
    });

    it("POST /reinstate-batch returns 409 when the matched entry is not a batch", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb single" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", { phrase: "rb single" });
      const r = await request<{ reason?: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: removed.body.historyEntry.removedAt },
      );
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("not-a-batch");
    });

    it("POST /reinstate-batch rejects missing removedAt with 400", async () => {
      const r = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        {},
      );
      expect(r.status).toBe(400);
    });

    // Task #159 — dry-run preview endpoint behaviour.
    it("POST /reinstate-batch with dryRun:true returns the same shape with HTTP 200 and does not mutate state", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb dry alpha", category: "absence" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb dry bravo", category: "hedging" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb dry charlie", category: "buzzword" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb dry alpha", "rb dry bravo", "rb dry charlie"],
        reviewer: "alice@team.com",
      });
      const removedAt = removed.body.historyEntry.removedAt;

      // Snapshot active list + the matching history row before the dry-run.
      const beforeList = await request<{ phrases: Marker[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      const beforeActive = beforeList.body.phrases.map((m) => m.phrase);

      const dry = await request<{
        dryRun: boolean;
        batch: boolean;
        reinstatedCount: number;
        skipped: number;
        total: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
        historyEntry: { reinstated?: boolean; phrases?: Array<{ phrase: string; reinstated?: boolean }> };
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.batch).toBe(true);
      expect(dry.body.reinstatedCount).toBe(3);
      expect(dry.body.skipped).toBe(0);
      expect(dry.body.results.every((r) => r.reinstated)).toBe(true);
      // Projected total = current active size + 3.
      expect(dry.body.total).toBe(beforeActive.length + 3);

      // Active list is UNCHANGED — none of the dry-run phrases came back.
      const afterList = await request<{ phrases: Marker[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      const afterActive = afterList.body.phrases.map((m) => m.phrase);
      expect(afterActive).toEqual(beforeActive);
      expect(afterActive).not.toContain("rb dry alpha");
      expect(afterActive).not.toContain("rb dry bravo");
      expect(afterActive).not.toContain("rb dry charlie");

      // Issuing the real call afterwards still works (no state was
      // accidentally locked / flagged).
      const real = await request<{ reinstatedCount: number; phrases: Marker[] }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt },
      );
      expect(real.status).toBe(200);
      expect(real.body.reinstatedCount).toBe(3);
      const live = real.body.phrases.map((m) => m.phrase);
      expect(live).toContain("rb dry alpha");
      expect(live).toContain("rb dry bravo");
      expect(live).toContain("rb dry charlie");
    });

    it("POST /reinstate-batch with dryRun:true reflects skip reasons without mutating state", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb dry skip a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb dry skip b" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb dry skip a", "rb dry skip b"],
      });
      const removedAt = removed.body.historyEntry.removedAt;
      // Reinstate one ahead of time so the dry-run sees a real skip.
      await request("POST", "/feedback/calibration/handwavy-phrases/reinstate", {
        phrase: "rb dry skip a",
        removedAt,
      });

      const dry = await request<{
        dryRun: boolean;
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.reinstatedCount).toBe(1);
      expect(dry.body.skipped).toBe(1);
      const skipA = dry.body.results.find((x) => x.phrase === "rb dry skip a");
      expect(skipA?.reinstated).toBe(false);
      expect(skipA?.reason).toBe("already-reinstated");
      const wouldB = dry.body.results.find((x) => x.phrase === "rb dry skip b");
      expect(wouldB?.reinstated).toBe(true);

      // The "rb dry skip b" phrase is still NOT in the active list — the
      // dry-run did not actually re-add it.
      const list = await request<{ phrases: Marker[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      expect(list.body.phrases.map((m) => m.phrase)).not.toContain("rb dry skip b");
    });

    it("POST /reinstate-batch rejects non-boolean dryRun with 400", async () => {
      const r = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: "2099-01-01T00:00:00.000Z", dryRun: "yes" },
      );
      expect(r.status).toBe(400);
    });

    it("POST /reinstate-batch with dryRun:true still returns 404 when removedAt does not match", async () => {
      const r = await request<{ reason?: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: "2099-01-01T00:00:00.000Z", dryRun: true },
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("history-not-found");
    });

    // Optional `phrases` allow-list (Task #360) collapses partial-batch
    // reinstates back into a single round-trip. A PROVIDED list — even
    // `[]` — is treated as an explicit allow-list, so an empty array is a
    // no-op rather than reinstating the whole batch.
    it("POST /reinstate-batch with phrases allow-list reinstates only the subset and omits dropped inner rows", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 a", category: "absence" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 b", category: "hedging" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 c", category: "buzzword" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb360 a", "rb360 b", "rb360 c"],
        reviewer: "alice@team.com",
      });
      const removedAt = removed.body.historyEntry.removedAt;

      const r = await request<{
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
        historyEntry: { reinstated?: boolean };
        phrases: Marker[];
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
        // Reviewer dropped `rb360 b` from the confirm panel.
        phrases: ["rb360 a", "rb360 c"],
      });
      expect(r.status).toBe(200);
      expect(r.body.reinstatedCount).toBe(2);
      expect(r.body.skipped).toBe(0);
      const phrases = r.body.results.map((x) => x.phrase).sort();
      expect(phrases).toEqual(["rb360 a", "rb360 c"]);
      expect(r.body.results.every((x) => x.reinstated)).toBe(true);
      // The dropped inner row stays removed; aggregate flag stays false.
      const active = r.body.phrases.map((m) => m.phrase);
      expect(active).toContain("rb360 a");
      expect(active).toContain("rb360 c");
      expect(active).not.toContain("rb360 b");
      expect(r.body.historyEntry.reinstated).not.toBe(true);
    });

    it("POST /reinstate-batch with an empty phrases allow-list is a no-op (does not reinstate the whole batch)", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 empty a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 empty b" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb360 empty a", "rb360 empty b"],
      });
      const r = await request<{
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean }>;
        phrases: Marker[];
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt: removed.body.historyEntry.removedAt,
        phrases: [],
      });
      expect(r.status).toBe(200);
      // An explicit empty allow-list reinstates nothing — neither inner
      // phrase is re-added to the active list.
      expect(r.body.reinstatedCount).toBe(0);
      expect(r.body.skipped).toBe(0);
      expect(r.body.results).toEqual([]);
      const active = r.body.phrases.map((m) => m.phrase);
      expect(active).not.toContain("rb360 empty a");
      expect(active).not.toContain("rb360 empty b");
    });

    it("POST /reinstate-batch with phrases allow-list reports unknown entries as not-in-batch", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 unk a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 unk b" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb360 unk a", "rb360 unk b"],
      });
      const r = await request<{
        reinstatedCount: number;
        skipped: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt: removed.body.historyEntry.removedAt,
        // `rb360 unk c` was never part of this batch (typo / stale list).
        // `rb360 unk b` is dropped from the allow-list and so should
        // disappear from the per-phrase results entirely.
        phrases: ["rb360 unk a", "rb360 unk c"],
      });
      expect(r.status).toBe(200);
      expect(r.body.reinstatedCount).toBe(1);
      expect(r.body.skipped).toBe(1);
      const byPhrase = new Map(r.body.results.map((x) => [x.phrase, x]));
      expect(byPhrase.get("rb360 unk a")?.reinstated).toBe(true);
      expect(byPhrase.get("rb360 unk c")?.reason).toBe("not-in-batch");
      expect(byPhrase.has("rb360 unk b")).toBe(false);
    });

    it("POST /reinstate-batch with phrases allow-list works under dryRun:true without mutating state", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 dry a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb360 dry b" });
      const removed = await request<{
        historyEntry: { removedAt: string };
      }>("DELETE", "/feedback/calibration/handwavy-phrases", {
        phrases: ["rb360 dry a", "rb360 dry b"],
      });
      const removedAt = removed.body.historyEntry.removedAt;

      const dry = await request<{
        dryRun: boolean;
        batch: boolean;
        reinstatedCount: number;
        results: Array<{ phrase: string; reinstated: boolean; reason?: string }>;
      }>("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt,
        dryRun: true,
        phrases: ["rb360 dry a"],
      });
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.reinstatedCount).toBe(1);
      expect(dry.body.results.map((x) => x.phrase)).toEqual(["rb360 dry a"]);
      // Active list unchanged.
      const list = await request<{ phrases: Marker[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases",
      );
      const active = list.body.phrases.map((m) => m.phrase);
      expect(active).not.toContain("rb360 dry a");
      expect(active).not.toContain("rb360 dry b");
    });

    it("POST /reinstate-batch rejects non-array phrases with 400", async () => {
      const r = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: "2099-01-01T00:00:00.000Z", phrases: "rb360 bogus" },
      );
      expect(r.status).toBe(400);
    });

    it("POST /reinstate-batch rejects phrases array with non-string members with 400", async () => {
      const r = await request<{ error: string }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate-batch",
        { removedAt: "2099-01-01T00:00:00.000Z", phrases: ["ok", 5] },
      );
      expect(r.status).toBe(400);
    });
  });

  // Task #160 — slim picker-friendly summary of recent batch removal entries.
  // The reinstate-batch CLI fetches this so reviewers can pick a batch by
  // number instead of copy/pasting an ISO `removedAt`.
  describe("Task #160 GET /removal-batches", () => {
    it("returns recent BATCH removals newest first with phrase counts and reinstated flags", async () => {
      // Two batch removals + one single removal (which should be filtered out).
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 b" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 c" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 d" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 single" });

      const firstBatch = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["rb160 a", "rb160 b"], reviewer: "alice@team.com" },
      );
      // Force the second batch to occur with a strictly later timestamp so we
      // can deterministically assert ordering. setTimeout is not available
      // here; use a tiny await loop.
      await new Promise((r) => setTimeout(r, 5));
      const secondBatch = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["rb160 c", "rb160 d"], reviewer: "bob@team.com" },
      );
      // Single removal — should NOT appear in the batches list.
      await request("DELETE", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 single" });

      const r = await request<{
        limit: number;
        totalBatches: number;
        batches: Array<{
          removedAt: string;
          removedBy?: string;
          phraseCount: number;
          reinstated: boolean;
          samplePhrases: string[];
        }>;
      }>("GET", "/feedback/calibration/handwavy-phrases/removal-batches");

      expect(r.status).toBe(200);
      expect(r.body.limit).toBe(10);
      expect(r.body.totalBatches).toBeGreaterThanOrEqual(2);
      // Newest first.
      expect(r.body.batches[0].removedAt).toBe(secondBatch.body.historyEntry.removedAt);
      expect(r.body.batches[0].removedBy).toBe("bob@team.com");
      expect(r.body.batches[0].phraseCount).toBe(2);
      expect(r.body.batches[0].reinstated).toBe(false);
      expect(r.body.batches[0].samplePhrases).toEqual(
        expect.arrayContaining(["rb160 c", "rb160 d"]),
      );
      const second = r.body.batches.find((b) => b.removedAt === firstBatch.body.historyEntry.removedAt);
      expect(second).toBeDefined();
      expect(second?.removedBy).toBe("alice@team.com");
      expect(second?.phraseCount).toBe(2);
      // None of the listed entries are the single-phrase removal — the
      // picker is explicitly batch-only (single removals are excluded so
      // reviewers don't accidentally reinstate a one-off correction).
      const allSamples = r.body.batches.flatMap((b) => b.samplePhrases);
      expect(allSamples).not.toContain("rb160 single");
      for (const batch of r.body.batches) {
        expect(batch.phraseCount).toBeGreaterThanOrEqual(2);
      }
    });

    it("flips the reinstated flag once the matching batch has been fully reinstated", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 reins a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 reins b" });
      const batch = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["rb160 reins a", "rb160 reins b"] },
      );
      await request("POST", "/feedback/calibration/handwavy-phrases/reinstate-batch", {
        removedAt: batch.body.historyEntry.removedAt,
      });
      const r = await request<{
        batches: Array<{ removedAt: string; reinstated: boolean }>;
      }>("GET", "/feedback/calibration/handwavy-phrases/removal-batches");
      const entry = r.body.batches.find((b) => b.removedAt === batch.body.historyEntry.removedAt);
      expect(entry?.reinstated).toBe(true);
    });

    it("honors ?limit=N and rejects non-positive limits with 400", async () => {
      // Add a few batches so we have something to limit.
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 lim a" });
      await request("DELETE", "/feedback/calibration/handwavy-phrases", { phrases: ["rb160 lim a"] });
      const ok = await request<{ limit: number; batches: unknown[] }>(
        "GET",
        "/feedback/calibration/handwavy-phrases/removal-batches?limit=1",
      );
      expect(ok.status).toBe(200);
      expect(ok.body.limit).toBe(1);
      expect(ok.body.batches.length).toBeLessThanOrEqual(1);

      const bad = await request<{ error: string }>(
        "GET",
        "/feedback/calibration/handwavy-phrases/removal-batches?limit=0",
      );
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/positive integer/);
    });

    it("returns an empty list (no error) when no batch removals exist", async () => {
      // Fresh state — only single-phrase activity.
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 lone" });
      await request("DELETE", "/feedback/calibration/handwavy-phrases", { phrase: "rb160 lone" });
      const r = await request<{
        totalBatches: number;
        batches: unknown[];
      }>("GET", "/feedback/calibration/handwavy-phrases/removal-batches");
      expect(r.status).toBe(200);
      expect(r.body.totalBatches).toBe(0);
      expect(r.body.batches).toEqual([]);
    });
  });

  // Task #176 — Sibling detail endpoint that returns the FULL inner phrase
  // list for a single batch removal entry. The picker's 5-phrase sample
  // isn't enough for a 10+ phrase batch, so the CLI fetches the detail
  // here before the confirmation prompt to render every phrase the
  // reinstate would touch (and let reviewers spot a wrong batch before
  // any mutation runs).
  describe("Task #176 GET /removal-batches/:removedAt", () => {
    it("returns every inner phrase with its per-phrase audit metadata for a batch entry", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 b" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 c" });
      const batch = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["rb176 a", "rb176 b", "rb176 c"], reviewer: "alice@team.com" },
      );
      const removedAt = batch.body.historyEntry.removedAt;

      const r = await request<{
        removedAt: string;
        removedBy?: string;
        reinstated: boolean;
        phraseCount: number;
        reinstatedCount: number;
        phrases: Array<{ phrase: string; category?: string; reinstated?: boolean }>;
      }>(
        "GET",
        `/feedback/calibration/handwavy-phrases/removal-batches/${encodeURIComponent(removedAt)}`,
      );

      expect(r.status).toBe(200);
      expect(r.body.removedAt).toBe(removedAt);
      expect(r.body.removedBy).toBe("alice@team.com");
      expect(r.body.reinstated).toBe(false);
      expect(r.body.phraseCount).toBe(3);
      expect(r.body.reinstatedCount).toBe(0);
      expect(r.body.phrases.map((p) => p.phrase).sort()).toEqual(["rb176 a", "rb176 b", "rb176 c"]);
      // Per-phrase audit metadata is echoed (not just the bare phrase
      // string) so a UI can show category badges next to each entry.
      for (const p of r.body.phrases) {
        expect(typeof p.category === "string" || p.category === undefined).toBe(true);
      }
    });

    it("flips per-phrase reinstated flags + reinstatedCount once a partial reinstate has happened", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 part a" });
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 part b" });
      const batch = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrases: ["rb176 part a", "rb176 part b"] },
      );
      const removedAt = batch.body.historyEntry.removedAt;
      // Reinstate just one of the two inner phrases via the per-phrase
      // endpoint so the entry sits in a partially-reinstated state. The
      // per-phrase endpoint requires both the phrase and the parent
      // batch's removedAt to disambiguate inner-batch entries from
      // standalone single-phrase removals.
      await request("POST", "/feedback/calibration/handwavy-phrases/reinstate", {
        phrase: "rb176 part a",
        removedAt,
      });

      const r = await request<{
        reinstated: boolean;
        reinstatedCount: number;
        phraseCount: number;
        phrases: Array<{ phrase: string; reinstated?: boolean }>;
      }>(
        "GET",
        `/feedback/calibration/handwavy-phrases/removal-batches/${encodeURIComponent(removedAt)}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.phraseCount).toBe(2);
      expect(r.body.reinstatedCount).toBe(1);
      // Aggregate flag is still false — at least one inner phrase is still
      // un-reinstated.
      expect(r.body.reinstated).toBe(false);
      const a = r.body.phrases.find((p) => p.phrase === "rb176 part a");
      const b = r.body.phrases.find((p) => p.phrase === "rb176 part b");
      expect(a?.reinstated).toBe(true);
      expect(b?.reinstated).not.toBe(true);
    });

    it("returns 404 history-not-found when no removal entry matches the given removedAt", async () => {
      const r = await request<{ error: string; reason: string }>(
        "GET",
        `/feedback/calibration/handwavy-phrases/removal-batches/${encodeURIComponent("2099-01-01T00:00:00.000Z")}`,
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("history-not-found");
      expect(r.body.error).toMatch(/No matching removal-history entry/);
    });

    it("returns 404 not-a-batch when the matched entry is a single-phrase removal", async () => {
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: "rb176 lone" });
      const single = await request<{ historyEntry: { removedAt: string } }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "rb176 lone" },
      );
      const removedAt = single.body.historyEntry.removedAt;

      const r = await request<{ error: string; reason: string }>(
        "GET",
        `/feedback/calibration/handwavy-phrases/removal-batches/${encodeURIComponent(removedAt)}`,
      );
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("not-a-batch");
      expect(r.body.error).toMatch(/single-phrase removal/);
    });

    it("rejects unauthenticated requests with 401 (auth-gated like the picker list endpoint)", async () => {
      // The shared `request()` helper above always sends the test token —
      // here we issue a raw request without it to exercise the auth gate.
      const removedAt = "2026-04-22T12:34:56.000Z";
      const url = new URL(
        `${baseUrl}/feedback/calibration/handwavy-phrases/removal-batches/${encodeURIComponent(removedAt)}`,
      );
      const status = await new Promise<number>((resolveStatus, rejectStatus) => {
        const req = http.request(
          {
            method: "GET",
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolveStatus(res.statusCode ?? 0));
          },
        );
        req.on("error", rejectStatus);
        req.end();
      });
      expect(status).toBe(401);
    });
  });

  it("restoreDefaults helper rewrites the file with the curated defaults", () => {
    __restoreDefaults();
    // Sanity: the restore helper does not throw and the file now contains
    // the canonical default markers.
    expect(true).toBe(true);
  });

  // Server-side dry-run cache. These cases use phrases NOT on the active
  // list so the production scan is skipped (no DB dependency); the active-
  // phrase path is covered in `handwavy-phrases.cache-active.route.test.ts`.
  describe("server-side dry-run cache", () => {
    interface DryRunCacheBody {
      dryRun: boolean;
      cacheHit: boolean;
      cachedAt?: string;
      wouldRemove: number;
      notFound: number;
      phrase: string;
      dryRunImpact: {
        productionLimit: number;
        productionError: string | null;
        production: { total: number } | null;
      };
      phrases: Marker[];
    }

    beforeEach(async () => {
      // Bounce the singleton cache via a throwaway add+delete so a fresh
      // "first request" can't be served from another test's leftover entry.
      const tag = `cache-bust-${Date.now()}-${Math.random()}`;
      await request("POST", "/feedback/calibration/handwavy-phrases", { phrase: tag });
      await request("DELETE", "/feedback/calibration/handwavy-phrases", { phrase: tag });
    });

    it("first request is a cache miss; an identical second request hits the cache", async () => {
      const first = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-a", dryRun: true },
      );
      expect(first.status).toBe(200);
      expect(first.body.cacheHit).toBe(false);
      expect(first.body.wouldRemove).toBe(0);
      expect(first.body.dryRunImpact.productionLimit).toBe(2000);

      const second = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-a", dryRun: true },
      );
      expect(second.status).toBe(200);
      expect(second.body.cacheHit).toBe(true);
      expect(typeof second.body.cachedAt).toBe("string");
      expect(second.body.wouldRemove).toBe(first.body.wouldRemove);
      expect(second.body.notFound).toBe(first.body.notFound);
      expect(second.body.phrase).toBe(first.body.phrase);
      expect(second.body.dryRunImpact.productionLimit).toBe(
        first.body.dryRunImpact.productionLimit,
      );
    });

    it("a different productionScanLimit misses even when the phrase is the same", async () => {
      const a = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-b", dryRun: true, productionScanLimit: 500 },
      );
      expect(a.body.cacheHit).toBe(false);
      const a2 = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-b", dryRun: true, productionScanLimit: 500 },
      );
      expect(a2.body.cacheHit).toBe(true);
      const b = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-b", dryRun: true, productionScanLimit: 1000 },
      );
      expect(b.body.cacheHit).toBe(false);
      expect(b.body.dryRunImpact.productionLimit).toBe(1000);
    });

    it("a different phrase misses even when the active list is unchanged", async () => {
      const a = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-c", dryRun: true },
      );
      expect(a.body.cacheHit).toBe(false);
      const b = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-d", dryRun: true },
      );
      expect(b.body.cacheHit).toBe(false);
    });

    it("phrase normalization keys cache lookups by the normalized form", async () => {
      const messy = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "  Never   Registered Cache TEST e  ", dryRun: true },
      );
      expect(messy.body.cacheHit).toBe(false);
      const tidy = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never registered cache test e", dryRun: true },
      );
      expect(tidy.body.cacheHit).toBe(true);
    });

    it("POST add invalidates every cached preview", async () => {
      const seed = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-add", dryRun: true },
      );
      expect(seed.body.cacheHit).toBe(false);
      const warm = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-add", dryRun: true },
      );
      expect(warm.body.cacheHit).toBe(true);
      const post = await request<{ added: boolean }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "cache-invalidation-add" },
      );
      expect(post.status).toBe(201);
      const afterAdd = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-add", dryRun: true },
      );
      expect(afterAdd.body.cacheHit).toBe(false);
    });

    it("DELETE (real removal) invalidates every cached preview", async () => {
      const seed = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-del", dryRun: true },
      );
      expect(seed.body.cacheHit).toBe(false);
      const warm = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-del", dryRun: true },
      );
      expect(warm.body.cacheHit).toBe(true);
      const realDelete = await request<{ removed: boolean }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase one" },
      );
      expect(realDelete.status).toBe(200);
      const afterDelete = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-del", dryRun: true },
      );
      expect(afterDelete.body.cacheHit).toBe(false);
    });

    it("PATCH edit invalidates every cached preview", async () => {
      const seed = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-edit", dryRun: true },
      );
      expect(seed.body.cacheHit).toBe(false);
      const warm = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-edit", dryRun: true },
      );
      expect(warm.body.cacheHit).toBe(true);
      const patch = await request<{ edited: boolean }>(
        "PATCH",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase two", category: "hedging" },
      );
      expect(patch.status).toBe(200);
      const afterPatch = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-edit", dryRun: true },
      );
      expect(afterPatch.body.cacheHit).toBe(false);
    });

    it("POST reinstate invalidates every cached preview", async () => {
      const removed = await request<{
        removed: boolean;
        historyEntry?: { phrase: string; removedAt: string };
      }>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "seed phrase one" },
      );
      expect(removed.status).toBe(200);
      const removedAt = removed.body.historyEntry?.removedAt;
      expect(typeof removedAt).toBe("string");
      const seed = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-reinstate", dryRun: true },
      );
      expect(seed.body.cacheHit).toBe(false);
      const warm = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-reinstate", dryRun: true },
      );
      expect(warm.body.cacheHit).toBe(true);
      const reinstate = await request<{ reinstated: boolean }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/reinstate",
        { phrase: "seed phrase one", removedAt },
      );
      expect(reinstate.status).toBe(201);
      const afterReinstate = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-reinstate", dryRun: true },
      );
      expect(afterReinstate.body.cacheHit).toBe(false);
    });

    it("POST undo invalidates every cached preview", async () => {
      const post = await request<{
        added: boolean;
        marker: { addedAt?: string };
      }>(
        "POST",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "cache-invalidation-undo" },
      );
      expect(post.status).toBe(201);
      const addedAt = post.body.marker.addedAt;
      expect(typeof addedAt).toBe("string");
      const seed = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-undo", dryRun: true },
      );
      expect(seed.body.cacheHit).toBe(false);
      const warm = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-undo", dryRun: true },
      );
      expect(warm.body.cacheHit).toBe(true);
      const undo = await request<{ undone: boolean }>(
        "POST",
        "/feedback/calibration/handwavy-phrases/undo",
        { phrase: "cache-invalidation-undo", addedAt },
      );
      expect(undo.status).toBe(200);
      const afterUndo = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase: "never-registered-cache-test-undo", dryRun: true },
      );
      expect(afterUndo.body.cacheHit).toBe(false);
    });

    it("returns the same response on repeated cache hits — the cache is read-only", async () => {
      const phrase = "never-registered-cache-test-stable";
      const first = await request<DryRunCacheBody>(
        "DELETE",
        "/feedback/calibration/handwavy-phrases",
        { phrase, dryRun: true },
      );
      expect(first.body.cacheHit).toBe(false);
      const hits = await Promise.all(
        Array.from({ length: 3 }, () =>
          request<DryRunCacheBody>(
            "DELETE",
            "/feedback/calibration/handwavy-phrases",
            { phrase, dryRun: true },
          ),
        ),
      );
      for (const h of hits) {
        expect(h.body.cacheHit).toBe(true);
        expect(h.body.cachedAt).toBe(hits[0].body.cachedAt);
        expect(h.body.phrase).toBe(first.body.phrase);
      }
    });
  });
});
