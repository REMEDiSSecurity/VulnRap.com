import { describe, expect, it } from "vitest";
import { TEST_FIXTURE_COHORTS } from "./test-fixtures";
import { runAvriComposite } from "../lib/engines/avri";

describe("test-fixtures structural guards", () => {
  const tiers = ["T1", "T2", "T3", "T4"] as const;

  for (const tier of tiers) {
    it(`${tier} has at least 10 fixtures`, () => {
      expect(TEST_FIXTURE_COHORTS[tier].length).toBeGreaterThanOrEqual(10);
    });

    it(`${tier} has no duplicate fixture text bodies`, () => {
      const texts = TEST_FIXTURE_COHORTS[tier].map(f => f.text.trim());
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const t of texts) {
        if (seen.has(t)) dupes.push(t.slice(0, 60));
        seen.add(t);
      }
      expect(dupes, `duplicate text bodies in ${tier}: ${dupes.join("; ")}`).toEqual([]);
    });

    it(`${tier} has no duplicate fixture ids`, () => {
      const ids = TEST_FIXTURE_COHORTS[tier].map(f => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it(`${tier} fixtures all carry the matching tier label`, () => {
      const expected =
        tier === "T1" ? "T1_LEGIT" :
        tier === "T2" ? "T2_BORDERLINE" :
        tier === "T3" ? "T3_SLOP" : "T4_HALLUCINATED";
      for (const f of TEST_FIXTURE_COHORTS[tier]) {
        expect(f.tier, `${f.id} should be tagged ${expected}`).toBe(expected);
      }
    });
  }

  it("T4 fixtures all assert the calibrated 0–35 composite band", () => {
    for (const f of TEST_FIXTURE_COHORTS.T4) {
      expect(f.expectedComposite[0], `${f.id} lower bound`).toBeGreaterThanOrEqual(0);
      expect(f.expectedComposite[1], `${f.id} upper bound`).toBeLessThanOrEqual(35);
    }
  });

  // Sprint 12 — emerging slop archetypes T3-11..T3-15 must each carry an
  // archetype label so /api/test/run can group them for calibration.
  it("Sprint 12 emerging slop fixtures (T3-11..T3-15) carry distinct archetype labels", () => {
    const expected: Record<string, string> = {
      "T3-11-fabricated-diff-no-proof": "fabricated_diff",
      "T3-12-paraphrased-cve-renamed-fn": "paraphrased_cve",
      "T3-13-narrated-curl-no-evidence": "narrated_curl",
      "T3-14-pseudo-asan-symbolless": "pseudo_asan",
      "T3-15-prose-poc-no-payload": "prose_poc",
    };
    const byId = new Map(TEST_FIXTURE_COHORTS.T3.map(f => [f.id, f]));
    for (const [id, archetype] of Object.entries(expected)) {
      const f = byId.get(id);
      expect(f, `expected fixture ${id} in T3 cohort`).toBeDefined();
      expect(f!.archetype, `${id} archetype label`).toBe(archetype);
    }
    const labels = Object.values(expected);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // Task #77 — cross-family fixtures for the AVRI_FABRICATED_PATCH detector.
  // Each one must (a) carry the shared "fabricated_diff" archetype label so
  // calibration groups them with T3-11, and (b) actually surface the
  // AVRI_FABRICATED_PATCH override under AVRI-on. Asserting the override
  // string directly locks the detector to the fixture text — a future
  // weakening that lets a family slip through trips this guard, even if
  // the composite score still happens to land in band.
  it("Task #77 cross-family fabricated_diff fixtures (T3-16..T3-18) carry the shared archetype", () => {
    const expected: Record<string, string> = {
      "T3-16-fabricated-diff-injection": "fabricated_diff",
      "T3-17-fabricated-diff-web-client": "fabricated_diff",
      "T3-18-fabricated-diff-memory-corruption": "fabricated_diff",
    };
    const byId = new Map(TEST_FIXTURE_COHORTS.T3.map(f => [f.id, f]));
    for (const [id, archetype] of Object.entries(expected)) {
      const f = byId.get(id);
      expect(f, `expected fixture ${id} in T3 cohort`).toBeDefined();
      expect(f!.archetype, `${id} archetype label`).toBe(archetype);
    }
  });

  it("Task #77 cross-family fixtures surface AVRI_FABRICATED_PATCH under AVRI-on", () => {
    const ids = [
      "T3-16-fabricated-diff-injection",
      "T3-17-fabricated-diff-web-client",
      "T3-18-fabricated-diff-memory-corruption",
    ];
    const byId = new Map(TEST_FIXTURE_COHORTS.T3.map(f => [f.id, f]));
    for (const id of ids) {
      const f = byId.get(id);
      expect(f, `expected fixture ${id} in T3 cohort`).toBeDefined();
      const result = runAvriComposite(f!.text, { claimedCwes: f!.claimedCwes });
      expect(
        result.overridesApplied.some(o => o.includes("AVRI_FABRICATED_PATCH")),
        `${id} should surface AVRI_FABRICATED_PATCH override (got: ${result.overridesApplied.join(" | ")})`,
      ).toBe(true);
    }
  });
});
