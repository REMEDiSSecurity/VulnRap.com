// Task #429 — route-level integration test for the reviewer-curated AI
// self-disclosure phrase endpoints. Mounts the calibration router on an
// isolated express app and exercises GET / POST end-to-end so any regression
// in the JSON wiring (status codes, body shape, list refresh) surfaces here
// instead of at runtime in production.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

const TEST_TOKEN = "ai-self-disclosure-route-test-token";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let phrasesPath: string;
let __resetForTests: () => void;
let __restoreDefaults: () => void;
let detectFn: (text: string) => {
  detected: boolean;
  matches: Array<{ id: string }>;
  penalty: number;
};

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ai-self-disclosure-route-"),
  );
  phrasesPath = path.join(tmpDir, "ai-self-disclosure-phrases.json");

  // Pin the loader to our tmpdir copy so the test cannot accidentally
  // mutate the real shipped phrase list.
  process.env.AI_SELF_DISCLOSURE_PHRASES_PATH = phrasesPath;
  process.env.CALIBRATION_TOKEN = TEST_TOKEN;

  const calibrationRouter = (await import("./calibration")).default;
  const mod = await import("../lib/engines/avri/ai-self-disclosure");
  __resetForTests = mod.__resetAiSelfDisclosurePhrasesForTests;
  __restoreDefaults = mod.__restoreAiSelfDisclosureDefaultsForTests;
  detectFn = mod.detectAiSelfDisclosure as typeof detectFn;

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
  delete process.env.AI_SELF_DISCLOSURE_PHRASES_PATH;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  __resetForTests();
  __restoreDefaults();
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
    const data =
      body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(data.length),
              }
            : {}),
          "X-Calibration-Token": TEST_TOKEN,
          ...headers,
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

interface PhraseRow {
  id: string;
  pattern: string;
  flags?: string;
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  editedBy?: string;
  editedAt?: string;
}

interface ListBody {
  phrases: PhraseRow[];
  total: number;
  penalty: number;
}

interface AddBody {
  added: boolean;
  phrase: PhraseRow;
  total: number;
  penalty: number;
  phrases: PhraseRow[];
}

interface EditBody {
  edited: boolean;
  phrase: PhraseRow;
  total: number;
  penalty: number;
  phrases: PhraseRow[];
}

interface RemoveBody {
  removed: boolean;
  phrase?: PhraseRow;
  total: number;
  penalty: number;
  phrases: PhraseRow[];
}

interface ErrBody {
  error: string;
}

describe("/feedback/calibration/ai-self-disclosure-phrases", () => {
  it("GET returns the active list and the bounded-penalty constant", async () => {
    const r = await request<ListBody>(
      "GET",
      "/feedback/calibration/ai-self-disclosure-phrases",
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(r.body.phrases.length);
    expect(r.body.total).toBeGreaterThanOrEqual(7);
    expect(r.body.penalty).toBe(15);
    const ids = r.body.phrases.map((p) => p.id);
    expect(ids).toContain("prepared_using_ai");
    expect(ids).toContain("ai_generated_adjective");
  });

  it("GET requires the calibration token", async () => {
    const r = await request<ErrBody>(
      "GET",
      "/feedback/calibration/ai-self-disclosure-phrases",
      undefined,
      { "X-Calibration-Token": "" },
    );
    expect([401, 403]).toContain(r.status);
  });

  it("POST appends a new pattern and returns 201 with the refreshed list", async () => {
    const r = await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "mistral_generated",
        pattern: "\\bgenerated\\s+by\\s+mistral",
        reviewer: "reviewer@example.com",
        rationale: "Spotted in 4 recent slop reports referencing Mistral.",
      },
    );
    expect(r.status).toBe(201);
    expect(r.body.added).toBe(true);
    expect(r.body.phrase.id).toBe("mistral_generated");
    expect(r.body.phrase.addedBy).toBe("reviewer@example.com");
    expect(r.body.phrase.addedAt).toBeDefined();
    expect(r.body.phrases.map((p) => p.id)).toContain("mistral_generated");
    // The detector starts firing on the new pattern immediately.
    const det = detectFn(
      "This report was generated by Mistral-7B via tooling.",
    );
    expect(det.detected).toBe(true);
    expect(det.matches.map((m) => m.id)).toContain("mistral_generated");
    expect(det.penalty).toBe(15);
  });

  it("POST is idempotent on id: re-posting the same id returns 200 added=false", async () => {
    const first = await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "dup_pattern",
        pattern: "\\bfoobar\\b",
      },
    );
    expect(first.status).toBe(201);
    const second = await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "dup_pattern",
        pattern: "\\bsomething-else\\b",
      },
    );
    expect(second.status).toBe(200);
    expect(second.body.added).toBe(false);
    // Active pattern is the original (first wins).
    const dup = second.body.phrases.find((p) => p.id === "dup_pattern");
    expect(dup?.pattern).toBe("\\bfoobar\\b");
  });

  it("POST rejects malformed input with 400 + a field-prefixed error", async () => {
    const cases: Array<{ body: Record<string, unknown>; field: RegExp }> = [
      { body: { id: "", pattern: "\\bfoo\\b" }, field: /^id / },
      { body: { id: "spaces in id", pattern: "\\bfoo\\b" }, field: /^id / },
      { body: { id: "ok_id", pattern: "" }, field: /^pattern / },
      { body: { id: "ok_id", pattern: "(unbalanced" }, field: /^pattern / },
      {
        body: { id: "ok_id", pattern: "\\bfoo\\b", flags: "Z" },
        field: /^flags /,
      },
      {
        body: { id: "ok_id", pattern: "\\bfoo\\b", rationale: "ab" },
        field: /^rationale /,
      },
    ];
    for (const c of cases) {
      const r = await request<ErrBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        c.body,
      );
      expect(r.status, `case=${JSON.stringify(c.body)}`).toBe(400);
      expect(r.body.error).toMatch(c.field);
    }
  });

  it("POST preserves the bounded-penalty contract after the list grows (Task #429)", async () => {
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "extra_one",
        pattern: "\\bfirst-extra-marker\\b",
      },
    );
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "extra_two",
        pattern: "\\bsecond-extra-marker\\b",
      },
    );
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "extra_three",
        pattern: "\\bthird-extra-marker\\b",
      },
    );
    // A report that hits both the original defaults AND the three new
    // patterns must still be docked exactly once.
    const det = detectFn(
      `This report was prepared using an AI security assistant.
This is AI-generated. ChatGPT-assisted summary follows.
first-extra-marker second-extra-marker third-extra-marker.`,
    );
    expect(det.detected).toBe(true);
    expect(det.matches.length).toBeGreaterThanOrEqual(5);
    expect(det.penalty).toBe(15);
  });

  it("PUT edits an existing phrase (Task #751): pattern recompiles, addedAt preserved, editedAt stamped", async () => {
    // Reviewer fat-fingered the original — missed a word boundary so the
    // pattern matches "harpoon" but not "poon" alone. We add it, observe
    // the typo, then PUT a corrected pattern under the same id.
    const add = await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "typo_pattern",
        pattern: "\\bgenerated by groq",
        reviewer: "alice@example.com",
        rationale: "Initial add — typo in the trailing boundary.",
      },
    );
    expect(add.status).toBe(201);
    const originalAddedAt = add.body.phrase.addedAt;
    expect(originalAddedAt).toBeDefined();
    // Make sure the wall clock advances at least 1 ms before the edit so
    // editedAt > addedAt is observable.
    await new Promise((r) => setTimeout(r, 5));

    const edit = await request<EditBody>(
      "PUT",
      "/feedback/calibration/ai-self-disclosure-phrases/typo_pattern",
      {
        pattern: "\\bgenerated\\s+by\\s+groq\\b",
        reviewer: "bob@example.com",
        rationale: "Fixed: added word boundaries around 'groq'.",
      },
    );
    expect(edit.status).toBe(200);
    expect(edit.body.edited).toBe(true);
    expect(edit.body.phrase.id).toBe("typo_pattern");
    expect(edit.body.phrase.pattern).toBe("\\bgenerated\\s+by\\s+groq\\b");
    // Original add provenance preserved; edit provenance stamped.
    expect(edit.body.phrase.addedBy).toBe("alice@example.com");
    expect(edit.body.phrase.addedAt).toBe(originalAddedAt);
    expect(edit.body.phrase.editedBy).toBe("bob@example.com");
    expect(edit.body.phrase.editedAt).toBeDefined();
    expect(edit.body.phrase.rationale).toMatch(/word boundaries/);

    // Active detector picks up the corrected pattern immediately.
    const det = detectFn("This report was generated by Groq inference.");
    expect(det.detected).toBe(true);
    expect(det.matches.map((m) => m.id)).toContain("typo_pattern");
  });

  it("PUT returns 404 when the id does not exist", async () => {
    const r = await request<ErrBody & { edited?: boolean }>(
      "PUT",
      "/feedback/calibration/ai-self-disclosure-phrases/nonexistent_id",
      { pattern: "\\bnope\\b" },
    );
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it("PUT validates pattern/flags and surfaces field-prefixed 400s", async () => {
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      { id: "edit_me", pattern: "\\boriginal\\b" },
    );
    const cases: Array<{ body: Record<string, unknown>; field: RegExp }> = [
      { body: { pattern: "" }, field: /^pattern / },
      { body: { pattern: "(unbalanced" }, field: /^pattern / },
      { body: { pattern: "\\bok\\b", flags: "Z" }, field: /^flags / },
      {
        body: { pattern: "\\bok\\b", rationale: "ab" },
        field: /^rationale /,
      },
    ];
    for (const c of cases) {
      const r = await request<ErrBody>(
        "PUT",
        "/feedback/calibration/ai-self-disclosure-phrases/edit_me",
        c.body,
      );
      expect(r.status, `case=${JSON.stringify(c.body)}`).toBe(400);
      expect(r.body.error).toMatch(c.field);
    }
  });

  it("PUT requires the calibration token (mutation gate)", async () => {
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      { id: "guarded_edit", pattern: "\\bbefore\\b" },
    );
    const r = await request<ErrBody>(
      "PUT",
      "/feedback/calibration/ai-self-disclosure-phrases/guarded_edit",
      { pattern: "\\bafter\\b" },
      { "X-Calibration-Token": "wrong-token" },
    );
    expect([401, 403]).toContain(r.status);
    const list = await request<ListBody>(
      "GET",
      "/feedback/calibration/ai-self-disclosure-phrases",
    );
    const ph = list.body.phrases.find((p) => p.id === "guarded_edit");
    expect(ph?.pattern).toBe("\\bbefore\\b");
  });

  it("DELETE removes a phrase by id (Task #751) and the detector stops firing on it", async () => {
    await request<AddBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      {
        id: "doomed_marker",
        pattern: "\\bunique-doomed-marker-xyz\\b",
      },
    );
    const before = detectFn("Contains a unique-doomed-marker-xyz string.");
    expect(before.matches.map((m) => m.id)).toContain("doomed_marker");

    const del = await request<RemoveBody>(
      "DELETE",
      "/feedback/calibration/ai-self-disclosure-phrases/doomed_marker",
    );
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
    expect(del.body.phrase?.id).toBe("doomed_marker");
    expect(del.body.phrases.find((p) => p.id === "doomed_marker")).toBeUndefined();

    const after = detectFn("Contains a unique-doomed-marker-xyz string.");
    expect(after.matches.map((m) => m.id)).not.toContain("doomed_marker");
  });

  it("DELETE returns 404 when the id does not exist", async () => {
    const r = await request<ErrBody>(
      "DELETE",
      "/feedback/calibration/ai-self-disclosure-phrases/never_existed",
    );
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it("DELETE requires the calibration token (mutation gate)", async () => {
    const r = await request<ErrBody>(
      "DELETE",
      "/feedback/calibration/ai-self-disclosure-phrases/prepared_using_ai",
      undefined,
      { "X-Calibration-Token": "wrong-token" },
    );
    expect([401, 403]).toContain(r.status);
    const list = await request<ListBody>(
      "GET",
      "/feedback/calibration/ai-self-disclosure-phrases",
    );
    expect(
      list.body.phrases.find((p) => p.id === "prepared_using_ai"),
    ).toBeDefined();
  });


  // Task #752 — dry-run preview. Reviewers can POST `dryRun: true` to score a
  // candidate AI self-disclosure regex against (a) the curated benchmark
  // corpus and (b) the most recent N production reports BEFORE persisting it,
  // mirroring the long-standing curated hand-wavy phrase preview.
  describe("Task #752 dry-run preview", () => {
    interface DryRunBody {
      dryRun: boolean;
      added: boolean;
      phrase: { id: string; pattern: string; flags: string };
      total: number;
      penalty: number;
      phrases: PhraseRow[];
      dryRunMatches: {
        total: number;
        byTier: {
          t1Legit: number;
          t2Borderline: number;
          t3Slop: number;
          t4Hallucinated: number;
        };
        falsePositives: number;
        corpusSize: number;
        sampleMatches: Array<{
          id: string;
          tier: string;
          snippet: { before: string; match: string; after: string } | null;
        }>;
        warning: string | null;
        oldestCreatedAt: string | null;
        newestCreatedAt: string | null;
      };
      dryRunMatchesProduction: {
        total: number;
        byTier: {
          t1Legit: number;
          t2Borderline: number;
          t3Slop: number;
          t4Hallucinated: number;
        };
        falsePositives: number;
        corpusSize: number;
        sampleMatches: Array<{ id: string; tier: string }>;
        warning: string | null;
        oldestCreatedAt: string | null;
        newestCreatedAt: string | null;
      } | null;
      dryRunMatchesProductionError: string | null;
      dryRunMatchesProductionLimit: number;
      dryRunOverlaps: {
        total: number;
        matches: Array<{
          id: string;
          pattern: string;
          flags: string;
          relation: "id-equal" | "pattern-equal";
        }>;
      };
    }

    it("dryRun=true returns a corpus + production preview and does NOT persist the pattern", async () => {
      const r = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "novel_marker",
          pattern: "\\bnovel-pattern-xyzzy-marker-7q\\b",
          dryRun: true,
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.added).toBe(false);
      expect(r.body.phrase.id).toBe("novel_marker");
      expect(r.body.phrase.pattern).toBe("\\bnovel-pattern-xyzzy-marker-7q\\b");
      expect(r.body.phrase.flags).toBe("i");
      expect(r.body.penalty).toBe(15);
      expect(r.body.dryRunMatches.total).toBe(0);
      expect(r.body.dryRunMatches.falsePositives).toBe(0);
      expect(r.body.dryRunMatches.warning).toBeNull();
      expect(r.body.dryRunMatches.corpusSize).toBeGreaterThan(0);
      expect(r.body.dryRunMatches.sampleMatches).toHaveLength(0);
      // Production block must always be present (either populated or
      // null+error so the UI can render a "scan unavailable" notice).
      expect(r.body).toHaveProperty("dryRunMatchesProduction");
      expect(r.body).toHaveProperty("dryRunMatchesProductionError");
      expect(r.body.dryRunMatchesProductionLimit).toBe(2000);
      // Overlap block must always be present.
      expect(r.body.dryRunOverlaps.total).toBe(0);
      // Confirm the dry-run did not slip the pattern into the active list.
      const list = await request<ListBody>(
        "GET",
        "/feedback/calibration/ai-self-disclosure-phrases",
      );
      expect(list.body.phrases.find((p) => p.id === "novel_marker")).toBe(
        undefined,
      );
      // Detector also must not start firing on the dry-run pattern.
      const det = detectFn("This contains novel-pattern-xyzzy-marker-7q here.");
      expect(det.matches.find((m) => m.id === "novel_marker")).toBe(undefined);
    });

    it("dryRun=true surfaces a warning when the pattern flags curated GREEN/YELLOW fixtures", async () => {
      // Match the literal word "the" — it is virtually guaranteed to appear
      // in T1 LEGIT and T2 BORDERLINE fixtures, exercising the false-positive
      // warning path without depending on any specific fixture wording.
      const r = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "matches_the",
          pattern: "\\bthe\\b",
          dryRun: true,
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.dryRun).toBe(true);
      expect(r.body.dryRunMatches.total).toBeGreaterThan(0);
      expect(r.body.dryRunMatches.falsePositives).toBeGreaterThan(0);
      expect(r.body.dryRunMatches.warning).not.toBeNull();
      expect(r.body.dryRunMatches.warning).toMatch(/legitimate/);
      // Sample list capped at 12 entries (mirrors hand-wavy preview).
      expect(r.body.dryRunMatches.sampleMatches.length).toBeLessThanOrEqual(12);
      // Each surfaced sample must carry an in-place context snippet so the
      // reviewer can judge the match without opening /verify/:id.
      for (const sm of r.body.dryRunMatches.sampleMatches) {
        if (sm.snippet) {
          expect(typeof sm.snippet.match).toBe("string");
          expect(sm.snippet.match.length).toBeGreaterThan(0);
        }
      }
    });

    it("dryRun=true rejects malformed input with the same field-prefixed errors as the real add path", async () => {
      const cases: Array<{ body: Record<string, unknown>; field: RegExp }> = [
        { body: { id: "", pattern: "\\bfoo\\b", dryRun: true }, field: /^id / },
        {
          body: { id: "spaces in id", pattern: "\\bfoo\\b", dryRun: true },
          field: /^id /,
        },
        {
          body: { id: "ok_id", pattern: "", dryRun: true },
          field: /^pattern /,
        },
        {
          body: { id: "ok_id", pattern: "(unbalanced", dryRun: true },
          field: /^pattern /,
        },
        {
          body: { id: "ok_id", pattern: "\\bfoo\\b", flags: "Z", dryRun: true },
          field: /^flags /,
        },
        {
          body: {
            id: "ok_id",
            pattern: "\\bfoo\\b",
            rationale: "ab",
            dryRun: true,
          },
          field: /^rationale /,
        },
      ];
      for (const c of cases) {
        const r = await request<ErrBody>(
          "POST",
          "/feedback/calibration/ai-self-disclosure-phrases",
          c.body,
        );
        expect(r.status, `case=${JSON.stringify(c.body)}`).toBe(400);
        expect(r.body.error).toMatch(c.field);
      }
      // None of the invalid dry-runs may have persisted anything.
      const list = await request<ListBody>(
        "GET",
        "/feedback/calibration/ai-self-disclosure-phrases",
      );
      expect(list.body.phrases.find((p) => p.id === "ok_id")).toBe(undefined);
    });

    it("dryRun=true surfaces an id-equal overlap when the candidate id collides with a curated default", async () => {
      const r = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "prepared_using_ai",
          pattern: "\\bsomething-completely-different\\b",
          dryRun: true,
        },
      );
      expect(r.status).toBe(200);
      expect(r.body.dryRunOverlaps.total).toBeGreaterThanOrEqual(1);
      const idCollision = r.body.dryRunOverlaps.matches.find(
        (m) => m.relation === "id-equal" && m.id === "prepared_using_ai",
      );
      expect(idCollision).toBeDefined();
    });

    it("dryRun=true surfaces a pattern-equal overlap when the candidate regex source matches an existing entry", async () => {
      // The default phrase `prepared_using_ai` ships with the pattern below.
      // Reusing the same source under a fresh id must surface a duplicate
      // pattern overlap.
      const dupPattern =
        "\\bprepared\\s+(?:using|with)\\s+(?:an?\\s+)?(?:ai|artificial intelligence|llm)\\b";
      const r = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "prepared_using_ai_clone",
          pattern: dupPattern,
          dryRun: true,
        },
      );
      expect(r.status).toBe(200);
      const dup = r.body.dryRunOverlaps.matches.find(
        (m) => m.relation === "pattern-equal" && m.pattern === dupPattern,
      );
      expect(dup).toBeDefined();
    });

    it("dryRun=true echoes the reviewer-supplied productionScanLimit back, falls back to 2000 when omitted", async () => {
      const tight = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "novel_marker_tight",
          pattern: "\\bnovel-marker-tight-xyz\\b",
          dryRun: true,
          productionScanLimit: 500,
        },
      );
      expect(tight.status).toBe(200);
      expect(tight.body.dryRunMatchesProductionLimit).toBe(500);

      const def = await request<DryRunBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "novel_marker_default",
          pattern: "\\bnovel-marker-default-xyz\\b",
          dryRun: true,
        },
      );
      expect(def.status).toBe(200);
      expect(def.body.dryRunMatchesProductionLimit).toBe(2000);
    });

    it("dryRun=true rejects a productionScanLimit outside the documented bounds with 400", async () => {
      const r = await request<ErrBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "novel_marker_bad_limit",
          pattern: "\\bnovel-marker-bad-limit\\b",
          dryRun: true,
          productionScanLimit: 50,
        },
      );
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/productionScanLimit/);
    });

    it("dryRun=true requires the calibration token (mutation gate)", async () => {
      const r = await request<ErrBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "should_not_be_added_dryrun",
          pattern: "\\bnope\\b",
          dryRun: true,
        },
        { "X-Calibration-Token": "wrong-token" },
      );
      expect([401, 403]).toContain(r.status);
    });

    it("dryRun=false (default) still persists the pattern as before", async () => {
      const r = await request<AddBody>(
        "POST",
        "/feedback/calibration/ai-self-disclosure-phrases",
        {
          id: "real_commit_marker",
          pattern: "\\breal-commit-marker-xyz\\b",
        },
      );
      expect(r.status).toBe(201);
      expect(r.body.added).toBe(true);
      const list = await request<ListBody>(
        "GET",
        "/feedback/calibration/ai-self-disclosure-phrases",
      );
      expect(
        list.body.phrases.find((p) => p.id === "real_commit_marker"),
      ).toBeDefined();
    });
  });

  it("POST requires the calibration token (mutation gate)", async () => {
    const r = await request<ErrBody>(
      "POST",
      "/feedback/calibration/ai-self-disclosure-phrases",
      { id: "should_not_be_added", pattern: "\\bnope\\b" },
      { "X-Calibration-Token": "wrong-token" },
    );
    expect([401, 403]).toContain(r.status);
    // Confirm the bad request did not slip a phrase into the active list.
    const list = await request<ListBody>(
      "GET",
      "/feedback/calibration/ai-self-disclosure-phrases",
    );
    expect(
      list.body.phrases.find((p) => p.id === "should_not_be_added"),
    ).toBeUndefined();
  });
});
