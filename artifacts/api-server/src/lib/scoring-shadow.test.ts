// Task #639 — Pure-logic tests for the shadow scoring runner.
//
// Covers the deterministic surface that does NOT touch the DB:
//   - isShadowScoringEnabled() reads the SHADOW_SCORING_ENABLED gate.
//   - computeShadowScore() honours SHADOW_SCORING_SCORE_DELTA and
//     SHADOW_SCORING_TIER_OVERRIDES so reviewers can dry-run an
//     in-flight scoring rule change against the live pipeline.
//
// `runShadowScore` (the DB-writing wrapper) is exercised by the
// route-level test against a live Postgres; this suite stays offline
// so it runs on every CI sweep regardless of DATABASE_URL.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isShadowScoringEnabled,
  computeShadowScore,
} from "./scoring-shadow";

const ENABLED_ENV = "SHADOW_SCORING_ENABLED";
const DELTA_ENV = "SHADOW_SCORING_SCORE_DELTA";
const OVERRIDES_ENV = "SHADOW_SCORING_TIER_OVERRIDES";

function clearShadowEnv() {
  delete process.env[ENABLED_ENV];
  delete process.env[DELTA_ENV];
  delete process.env[OVERRIDES_ENV];
}

beforeEach(clearShadowEnv);
afterEach(clearShadowEnv);

const SAMPLE_INPUT = {
  breakdown: { linguistic: 30, factual: 40, template: 25, verification: 50 },
  evidence: [],
  originalText:
    "We discovered a buffer overflow in the foo function. It allows arbitrary memory writes when bar is invoked with crafted input.".repeat(
      4,
    ),
};

describe("isShadowScoringEnabled", () => {
  it("is false by default", () => {
    expect(isShadowScoringEnabled()).toBe(false);
  });
  it("is true only when SHADOW_SCORING_ENABLED is exactly '1'", () => {
    process.env[ENABLED_ENV] = "1";
    expect(isShadowScoringEnabled()).toBe(true);
    process.env[ENABLED_ENV] = "true";
    expect(isShadowScoringEnabled()).toBe(false);
    process.env[ENABLED_ENV] = "0";
    expect(isShadowScoringEnabled()).toBe(false);
    process.env[ENABLED_ENV] = " 1 ";
    expect(isShadowScoringEnabled()).toBe(true);
  });
});

describe("computeShadowScore", () => {
  it("returns the live recomputed score+tier when no overrides are set", () => {
    const out = computeShadowScore(SAMPLE_INPUT);
    expect(out.score).toBeGreaterThanOrEqual(0);
    expect(out.score).toBeLessThanOrEqual(100);
    expect(typeof out.tier).toBe("string");
  });

  it("applies SHADOW_SCORING_SCORE_DELTA to the recomputed score", () => {
    const baseline = computeShadowScore(SAMPLE_INPUT);
    process.env[DELTA_ENV] = "10";
    const harsher = computeShadowScore(SAMPLE_INPUT);
    expect(harsher.score).toBe(Math.min(100, baseline.score + 10));
    process.env[DELTA_ENV] = "-15";
    const softer = computeShadowScore(SAMPLE_INPUT);
    expect(softer.score).toBe(Math.max(0, baseline.score - 15));
  });

  it("clamps the delta-adjusted score into [0, 100]", () => {
    process.env[DELTA_ENV] = "1000";
    expect(computeShadowScore(SAMPLE_INPUT).score).toBe(100);
    process.env[DELTA_ENV] = "-1000";
    expect(computeShadowScore(SAMPLE_INPUT).score).toBe(0);
  });

  it("ignores a malformed SHADOW_SCORING_SCORE_DELTA", () => {
    const baseline = computeShadowScore(SAMPLE_INPUT);
    process.env[DELTA_ENV] = "not-a-number";
    expect(computeShadowScore(SAMPLE_INPUT).score).toBe(baseline.score);
  });

  it("uses SHADOW_SCORING_TIER_OVERRIDES to remap the tier", () => {
    // Overrides that consider every score >= 1 to be "Slop" prove
    // the tier cutover knob is being read.
    process.env[OVERRIDES_ENV] = JSON.stringify({
      slop: 1,
      likelySlop: 1,
      questionable: 1,
      likelyHuman: 1,
    });
    const out = computeShadowScore(SAMPLE_INPUT);
    expect(out.tier).toBe("Slop");
  });

  it("ignores malformed SHADOW_SCORING_TIER_OVERRIDES", () => {
    const baseline = computeShadowScore(SAMPLE_INPUT);
    process.env[OVERRIDES_ENV] = "{not-json";
    expect(computeShadowScore(SAMPLE_INPUT).tier).toBe(baseline.tier);
  });
});
