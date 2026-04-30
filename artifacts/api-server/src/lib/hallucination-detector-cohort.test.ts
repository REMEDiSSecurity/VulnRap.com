// Task #267 — lock the per-fixture hallucination detector totalWeight
// across the full TEST_FIXTURE_COHORTS battery.
//
// Task #382 — also lock the sorted set of signal types that fire per
// fixture. Pinning only the running total leaves a "compensating drift"
// hole: a regex shuffle that drops one signal and adds another with
// the same weight (e.g. -10 fabricated_addresses + +10 phantom_functions)
// keeps the totalWeight snapshot green even though the *reason* the
// detector condemns the fixture has silently swapped. The current T4
// snapshot already shows several fixtures sitting on the same total via
// different signal mixes, so the risk is real. The new per-fixture
// `signals` snapshot — sorted, deduplicated signal-type list — surfaces
// those swaps in the diff as soon as they happen.
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
// **and** the sorted list of fired signal types so any regex tweak that
// re-introduces a false positive on a legit report, stops firing on a
// known-fabricated one, or quietly swaps one signal for another with the
// same weight, is caught immediately — not after a downstream calibration
// sweep.
//
// Two layers of guard:
//   1. Tier-floor invariants (always-on, do NOT require a snapshot update):
//        - every T1 fixture: totalWeight < 12 (under the moderate-tier floor)
//        - every applicable T4 fixture: totalWeight >= 12 (clears the
//          moderate-tier floor)
//     Two T4 fixtures are intentionally excluded from the T4 floor because
//     the *hallucination detector* is not the engine that condemns them
//     — that is now declared per-fixture by the `condemnedBy` hint on each
//     T4 fixture in `routes/test-fixtures.ts` (Task #383). Their weights
//     are still pinned by the snapshot in (2), so any drift is still
//     caught — they just aren't required to clear the moderate floor.
//   2. Per-fixture exact-weight + sorted-signal-type snapshot: a maintainer
//      can intentionally update the snapshot with
//      `pnpm --filter @workspace/api-server test -u` (or `pnpm test -u`
//      from the api-server directory). Accidental drift in *either* the
//      total weight OR the fired-signal mix fails CI.
//
// Task #383 also adds an explicit hint-vs-reality cross-check: every T4
// fixture must declare a `condemnedBy` engine, and any fixture tagged
// `HallucinationDetector` must accumulate at least the moderate-tier floor
// of 12. That makes it impossible to silently move a fixture between
// engines without updating both the hint and the matching test.

import { describe, it, expect } from "vitest";
import { detectHallucinationSignals } from "./hallucination-detector";
import { TEST_FIXTURE_COHORTS } from "../routes/test-fixtures";

type Cohort = "T1" | "T2" | "T3" | "T4";
const COHORTS: Cohort[] = ["T1", "T2", "T3", "T4"];

describe("Task #267: per-fixture hallucination detector totalWeight is pinned", () => {
  describe("tier-floor invariants (T1 < 12, T4 >= 12 where applicable)", () => {
    for (const f of TEST_FIXTURE_COHORTS.T1) {
      it(`T1 fixture ${f.id} stays under the moderate-tier floor`, () => {
        const r = detectHallucinationSignals(f.text);
        expect(r.totalWeight).toBeLessThan(12);
      });
    }
    for (const f of TEST_FIXTURE_COHORTS.T4) {
      if (f.condemnedBy !== "HallucinationDetector") continue;
      it(`T4 fixture ${f.id} clears the moderate-tier floor`, () => {
        const r = detectHallucinationSignals(f.text);
        expect(r.totalWeight).toBeGreaterThanOrEqual(12);
      });
    }
  });

  describe("per-fixture totalWeight + signal-type snapshot (update with `pnpm test -u`)", () => {
    for (const cohort of COHORTS) {
      it(`${cohort} cohort totalWeight + sorted signal types match snapshot`, () => {
        // Per fixture, snapshot both the running total weight and the
        // sorted/deduplicated list of signal types that fired. The
        // sorted-list shape — rather than the raw `signals[]` array —
        // is intentional: it's stable under regex re-orderings inside
        // the detector, so the diff only flips when the *set* of rules
        // that condemned the fixture actually changes.
        const fixtures: Record<
          string,
          { totalWeight: number; signals: string[] }
        > = {};
        for (const f of TEST_FIXTURE_COHORTS[cohort]) {
          const r = detectHallucinationSignals(f.text);
          fixtures[f.id] = {
            totalWeight: r.totalWeight,
            signals: [...new Set(r.signals.map((s) => s.type))].sort(),
          };
        }
        expect(fixtures).toMatchSnapshot();
      });
    }
  });
});

// Task #383 — the `condemnedBy` hint on each T4 fixture is only useful if
// it matches reality. These tests assert:
//   1. Every T4 fixture declares a `condemnedBy`. Forgetting it on a new
//      fabricated fixture would make it impossible to tell which detector
//      the fixture is meant to exercise without rerunning the pipeline.
//   2. Every T4 fixture tagged `HallucinationDetector` actually accumulates
//      `totalWeight >= 12` (the moderate-tier hallucination floor) — i.e.
//      the engine the hint nominates really is doing the condemning work.
//
// Sibling-engine fixtures (`PlagiarismHeuristic`, `CWECoherenceChecker`)
// are intentionally NOT asserted to stay below the floor here: detector
// signals can legitimately overlap (e.g. a future plagiarism fixture that
// also happens to include a magic PID). Their actual hallucination
// weights are still pinned by the snapshot above, so any drift is still
// caught — it just isn't conflated with the hint-vs-reality check.
describe("Task #383: T4 HallucinationDetector hint matches detector reality", () => {
  for (const f of TEST_FIXTURE_COHORTS.T4) {
    it(`T4 fixture ${f.id} declares which engine condemns it`, () => {
      expect(f.condemnedBy, `T4 fixture ${f.id} is missing condemnedBy`).toBeDefined();
    });
  }

  for (const f of TEST_FIXTURE_COHORTS.T4) {
    if (f.condemnedBy !== "HallucinationDetector") continue;
    it(`T4 fixture ${f.id} (condemnedBy=HallucinationDetector) trips the moderate-tier floor`, () => {
      const r = detectHallucinationSignals(f.text);
      expect(r.totalWeight).toBeGreaterThanOrEqual(12);
    });
  }
});
