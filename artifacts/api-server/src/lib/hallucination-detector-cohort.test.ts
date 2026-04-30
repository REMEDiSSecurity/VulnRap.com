// Task #267 — lock the per-fixture hallucination detector totalWeight
// across the full TEST_FIXTURE_COHORTS battery.
//
// Task #192 tightened `incomplete_asan` and `fabricated_pid` so that the
// canonical legit fixtures (T1-01-uaf-libfoo, T1-AVRI-firefox-uaf,
// T1-AVRI-cve-2025-0725-curl) accumulate **0** hallucination weight while
// every T4 fabrication fixture that *the hallucination detector is the
// arbiter for* still trips the composite `HALLUCINATION_FABRICATED_EVIDENCE`
// override. That trio plus a few T4 ids are pinned by
// `hallucination-detector.test.ts`, but every other fixture in T1/T2/T3/T4
// was only checked indirectly via downstream composite-score ranges —
// those ranges can absorb several points of detector drift before they
// fail.
//
// This file pins the per-fixture `detectHallucinationSignals(text).totalWeight`
// itself so any regex tweak that re-introduces a false positive on a legit
// report (or stops firing on a known-fabricated one) is caught immediately,
// not after a downstream calibration sweep.
//
// Two layers of guard:
//   1. Tier-floor invariants (always-on, do NOT require a snapshot update):
//        - every T1 fixture: totalWeight < 12 (under the moderate-tier floor)
//        - every applicable T4 fixture: totalWeight >= 12 (clears the
//          moderate-tier floor)
//     Two T4 fixtures are intentionally excluded from the T4 floor because
//     the *hallucination detector* is not the engine that condemns them
//     (see HALLUCINATION_DETECTOR_NOT_APPLICABLE_T4 below). Their weights
//     are still pinned by the snapshot in (2), so any drift is still
//     caught — they just aren't required to clear the moderate floor.
//   2. Per-fixture exact-weight snapshot: a maintainer can intentionally
//      update the snapshot with `pnpm --filter @workspace/api-server test -u`
//      (or `pnpm test -u` from the api-server directory). Accidental drift
//      fails CI.

import { describe, it, expect } from "vitest";
import { detectHallucinationSignals } from "./hallucination-detector";
import { TEST_FIXTURE_COHORTS } from "../routes/test-fixtures";

type Cohort = "T1" | "T2" | "T3" | "T4";
const COHORTS: Cohort[] = ["T1", "T2", "T3", "T4"];

// T4 fixtures the hallucination detector is NOT the arbiter for. These are
// flagged T4 by other engines (plagiarism heuristics, CWE Coherence
// Checker), so they legitimately accumulate near-zero hallucination weight
// and must not be required to clear the moderate-tier floor:
//   - T4-03-plagiarized-nvd: a plagiarized NVD-style writeup. The
//     hallucination detector targets fabricated *evidence* (round
//     addresses, magic PIDs, repeated stack frames, etc.); it does not
//     attempt plagiarism detection.
//   - T4-05-fake-cwe-mismatch: a CWE-79 (XSS) writeup that actually
//     describes a SQL-injection bypass. This mismatch is caught by the
//     CWE Coherence Checker engine, not by the hallucination detector.
const HALLUCINATION_DETECTOR_NOT_APPLICABLE_T4 = new Set<string>([
  "T4-03-plagiarized-nvd",
  "T4-05-fake-cwe-mismatch",
]);

describe("Task #267: per-fixture hallucination detector totalWeight is pinned", () => {
  describe("tier-floor invariants (T1 < 12, T4 >= 12 where applicable)", () => {
    for (const f of TEST_FIXTURE_COHORTS.T1) {
      it(`T1 fixture ${f.id} stays under the moderate-tier floor`, () => {
        const r = detectHallucinationSignals(f.text);
        expect(r.totalWeight).toBeLessThan(12);
      });
    }
    for (const f of TEST_FIXTURE_COHORTS.T4) {
      if (HALLUCINATION_DETECTOR_NOT_APPLICABLE_T4.has(f.id)) continue;
      it(`T4 fixture ${f.id} clears the moderate-tier floor`, () => {
        const r = detectHallucinationSignals(f.text);
        expect(r.totalWeight).toBeGreaterThanOrEqual(12);
      });
    }
  });

  describe("per-fixture totalWeight snapshot (update with `pnpm test -u`)", () => {
    for (const cohort of COHORTS) {
      it(`${cohort} cohort totalWeights match snapshot`, () => {
        const weights: Record<string, number> = {};
        for (const f of TEST_FIXTURE_COHORTS[cohort]) {
          weights[f.id] = detectHallucinationSignals(f.text).totalWeight;
        }
        expect(weights).toMatchSnapshot();
      });
    }
  });
});
