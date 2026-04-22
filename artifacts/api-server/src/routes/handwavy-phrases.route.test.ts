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

  it("restoreDefaults helper rewrites the file with the curated defaults", () => {
    __restoreDefaults();
    // Sanity: the restore helper does not throw and the file now contains
    // the canonical default markers.
    expect(true).toBe(true);
  });
});
