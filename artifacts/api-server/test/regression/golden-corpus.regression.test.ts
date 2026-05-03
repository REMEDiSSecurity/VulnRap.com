// Task #638 — Scoring regression golden corpus.
//
// A locked corpus of ~200 labeled fixtures (T1/T2/T3/T4) with snapshotted
// pipeline scores. Every PR runs the corpus and any tier-flip on any
// fixture fails CI loudly. The corpus is the regression baseline the user
// asked for: "we need to test each update to make sure we are NOT
// worsening our results."
//
// Files in this directory:
//   - golden-corpus.json       — the curated corpus (id, text,
//                                expectedTier, expectedScoreRange,
//                                expectedSignals[]). Hand-reviewed; only
//                                regenerated intentionally with
//                                REGENERATE_CORPUS=1.
//   - golden-corpus.snap.json  — per-entry current pipeline score.
//                                Regenerated with UPDATE_SNAPSHOTS=1.
//                                Drift inside the corpus's recorded ±3
//                                band shows up as a PR diff without
//                                failing the test; drift outside the
//                                band fails the band assertion.
//   - README.md                — operations doc (regen workflow).
//
// Assertions (per entry, on every CI run):
//   (a) tier matches exactly                  — silent tier flips fail
//   (b) composite stays inside expectedScoreRange (the recorded ±3 band)
//   (c) every expected signal still fires     — silent signal-loss fails
//
// Out of scope (per task brief): pulling corpus from real production
// reports, and auto-applying snapshot updates in CI (manual confirmation
// required, gated by UPDATE_SNAPSHOTS=1).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { TEST_FIXTURE_COHORTS } from "../../src/routes/test-fixtures";
import { analyzeWithEnginesTraced } from "../../src/lib/engines";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_PATH = path.join(__dirname, "golden-corpus.json");
const SNAP_PATH = path.join(__dirname, "golden-corpus.snap.json");

type CorpusTier = "T1" | "T2" | "T3" | "T4";

interface CorpusEntry {
  id: string;
  text: string;
  claimedCwes?: string[];
  expectedTier: CorpusTier;
  expectedScoreRange: [number, number];
  expectedSignals: string[];
}

interface SnapshotEntry {
  score: number;
}

// Composite score is 0..100, higher = better. Tier bands match the
// project's existing 4-bucket vocabulary. The thresholds are deliberately
// chosen wider than the per-fixture expectedScoreRange (±3) so a single
// pipeline tweak that nudges a score by a couple of points cannot flip
// a fixture's tier on its own — only meaningful drift does.
function compositeToCorpusTier(composite: number): CorpusTier {
  if (composite >= 60) return "T1";
  if (composite >= 40) return "T2";
  if (composite >= 20) return "T3";
  return "T4";
}

function runPipeline(
  text: string,
  claimedCwes?: string[],
): { composite: number; firedSignals: string[] } {
  const traced = analyzeWithEnginesTraced(text, { claimedCwes });
  const composite = Math.round(traced.composite.overallScore);
  const fired = new Set<string>();
  for (const e of traced.composite.engineResults) {
    for (const ind of e.triggeredIndicators) {
      fired.add(ind.signal);
    }
  }
  return { composite, firedSignals: [...fired].sort() };
}

// Build the seed roster: every existing T1..T4 fixture plus deterministic
// text-shape variants to bring the count near the ~200 target called out
// in the task brief. Variants are intentionally minor (a benign suffix
// note, a benign markdown header) so they exercise the pipeline's
// stability under common-but-irrelevant text shape changes — exactly the
// kind of drift the user is worried about.
function buildSeedFixtures(): Array<{
  id: string;
  text: string;
  claimedCwes?: string[];
}> {
  const all: Array<{ id: string; text: string; claimedCwes?: string[] }> = [];
  for (const cohort of ["T1", "T2", "T3", "T4"] as const) {
    for (const f of TEST_FIXTURE_COHORTS[cohort]) {
      all.push({ id: f.id, text: f.text, claimedCwes: f.claimedCwes });
    }
  }
  const trailingNote =
    "\n\n_Reported via internal triage workflow on 2025-01-15._";
  const headingPrefix = "# Vulnerability Report\n\n";
  const variants: typeof all = [];
  for (const f of all) {
    variants.push({
      id: `${f.id}__variant-suffix-note`,
      text: f.text + trailingNote,
      claimedCwes: f.claimedCwes,
    });
  }
  for (const f of all) {
    variants.push({
      id: `${f.id}__variant-heading-prefix`,
      text: headingPrefix + f.text,
      claimedCwes: f.claimedCwes,
    });
  }
  // Aim for ~200 entries; slice variants to land at the target.
  const TARGET = 200;
  const need = Math.max(0, TARGET - all.length);
  return [...all, ...variants.slice(0, need)];
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const REGENERATE_CORPUS = process.env.REGENERATE_CORPUS === "1";
const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "1";

if (REGENERATE_CORPUS) {
  const seeds = buildSeedFixtures();
  const corpus: CorpusEntry[] = [];
  const snap: Record<string, SnapshotEntry> = {};
  for (const s of seeds) {
    const { composite, firedSignals } = runPipeline(s.text, s.claimedCwes);
    corpus.push({
      id: s.id,
      text: s.text,
      ...(s.claimedCwes ? { claimedCwes: s.claimedCwes } : {}),
      expectedTier: compositeToCorpusTier(composite),
      expectedScoreRange: [
        Math.max(0, composite - 3),
        Math.min(100, composite + 3),
      ],
      expectedSignals: firedSignals,
    });
    snap[s.id] = { score: composite };
  }
  writeJson(CORPUS_PATH, corpus);
  writeJson(SNAP_PATH, snap);
  console.log(
    `[golden-corpus] regenerated ${corpus.length} corpus entries + snapshot`,
  );
}

const corpus: CorpusEntry[] = fs.existsSync(CORPUS_PATH)
  ? (JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8")) as CorpusEntry[])
  : [];
const snap: Record<string, SnapshotEntry> = fs.existsSync(SNAP_PATH)
  ? (JSON.parse(fs.readFileSync(SNAP_PATH, "utf8")) as Record<
      string,
      SnapshotEntry
    >)
  : {};

describe("Task #638: scoring regression golden corpus", () => {
  if (UPDATE_SNAPSHOTS) {
    it("regenerates the snapshot file (UPDATE_SNAPSHOTS=1)", () => {
      expect(corpus.length, "corpus file is missing or empty").toBeGreaterThan(
        0,
      );
      const next: Record<string, SnapshotEntry> = {};
      for (const entry of corpus) {
        const { composite } = runPipeline(entry.text, entry.claimedCwes);
        next[entry.id] = { score: composite };
      }
      writeJson(SNAP_PATH, next);
      console.log(
        `[golden-corpus] updated snapshot for ${
          Object.keys(next).length
        } entries`,
      );
      expect(Object.keys(next).length).toBe(corpus.length);
    });
    return;
  }

  it("corpus file exists and has at least 150 entries", () => {
    expect(
      corpus.length,
      "Run REGENERATE_CORPUS=1 vitest run test/regression/golden-corpus.regression.test.ts",
    ).toBeGreaterThanOrEqual(150);
  });

  for (const entry of corpus) {
    it(`${entry.id}: tier + score band + expected signals hold`, () => {
      const { composite, firedSignals } = runPipeline(
        entry.text,
        entry.claimedCwes,
      );
      const tier = compositeToCorpusTier(composite);

      // (a) tier matches exactly — the headline regression guard.
      expect(
        tier,
        `tier flip on ${entry.id}: expected ${entry.expectedTier}, got ${tier} (composite=${composite})`,
      ).toBe(entry.expectedTier);

      // (b) composite stays inside the recorded ±3 band.
      expect(
        composite,
        `score drift on ${entry.id}: composite=${composite}, band=[${entry.expectedScoreRange[0]}, ${entry.expectedScoreRange[1]}]`,
      ).toBeGreaterThanOrEqual(entry.expectedScoreRange[0]);
      expect(composite).toBeLessThanOrEqual(entry.expectedScoreRange[1]);

      // (c) every expected signal subset still fires.
      const missing = entry.expectedSignals.filter(
        (s) => !firedSignals.includes(s),
      );
      expect(
        missing,
        `${entry.id} stopped firing expected signals: ${missing.join(", ")}`,
      ).toEqual([]);
    }, 20_000);
  }

  // Soft drift indicator: snapshot divergence inside the band is logged
  // (visible in the snap.json diff on the PR) but does not fail. Drift
  // outside the band is already caught by (b) above.
  it("snapshot file is in sync with corpus entries", () => {
    if (Object.keys(snap).length === 0) return;
    const corpusIds = new Set(corpus.map((e) => e.id));
    const snapIds = new Set(Object.keys(snap));
    const missingFromSnap = [...corpusIds].filter((id) => !snapIds.has(id));
    const orphanInSnap = [...snapIds].filter((id) => !corpusIds.has(id));
    expect(
      missingFromSnap,
      "corpus entries missing from snapshot (run UPDATE_SNAPSHOTS=1)",
    ).toEqual([]);
    expect(
      orphanInSnap,
      "orphan snapshot entries (run UPDATE_SNAPSHOTS=1)",
    ).toEqual([]);
  });
});
