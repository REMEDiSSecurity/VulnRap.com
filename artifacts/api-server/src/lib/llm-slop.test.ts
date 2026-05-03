// Task #442 — unit coverage for the composite-driven LLM cost gate.
// The Task #311 calibration audit found the gate's heuristic input was
// effectively zero across the entire 72-fixture battery, so 16 borderline-
// composite reports the gate was meant to second-guess were silently
// skipped. The fix in `evaluateLlmGate` makes composite the primary signal
// (heuristic acts as a tiebreaker). These tests pin the boundary
// conditions so a future regression in the gate logic can't quietly
// re-introduce the silent-skip bug — that's what Task #311's audit
// missed for so long.
//
// The tests intentionally avoid mocking `isLLMAvailable` by setting the
// env var directly in beforeEach: the gate has a "no provider configured"
// short-circuit (`skipped_unavailable`) that dominates every other branch,
// and we want to exercise the real composite-vs-heuristic decision tree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COST_GUARD_HIGH,
  COST_GUARD_LOW,
  evaluateLlmGate,
} from "./llm-slop.js";

describe("evaluateLlmGate — composite-driven cost gate (Task #442)", () => {
  const originalKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const originalOpenAi = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    // Force isLLMAvailable() === true so we exercise the real decision
    // tree rather than the short-circuit "skipped_unavailable" branch.
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-key-for-gate-unit-tests";
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    } else {
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY = originalKey;
    }
    if (originalOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAi;
    }
  });

  describe("composite path — primary borderline signal", () => {
    it("fires on a clearly borderline composite even when heuristic is ~0", () => {
      // The exact pathological case from the Task #311 audit: heuristic
      // 0 means the legacy gate would fall in the "below borderline"
      // branch and skip. With the composite-driven path, a borderline
      // composite must override that and fire the LLM substance pass.
      const decision = evaluateLlmGate(0, 1.0, 40);
      expect(decision.shouldCall).toBe(true);
      expect(decision.reason).toBe("fired_borderline_composite");
      expect(decision.compositeScore).toBe(40);
    });

    it("skips when composite is clearly above the borderline (T1 valid reports)", () => {
      const decision = evaluateLlmGate(0, 1.0, 80);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe("skipped_above_borderline_composite");
      expect(decision.compositeScore).toBe(80);
    });

    it("skips when composite is clearly below the borderline (T3/T4 cost guard)", () => {
      const decision = evaluateLlmGate(50, 1.0, 10);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe("skipped_below_borderline_composite");
      expect(decision.compositeScore).toBe(10);
    });

    it("uses heuristic as a tiebreaker when composite is borderline AND heuristic confirms slop", () => {
      // composite in [LOW,HIGH] is normally fire-by-default; heuristic >=
      // HIGH is the cost-guard exception so we don't waste an LLM call
      // when both axes agree the report looks slop-y.
      const decision = evaluateLlmGate(COST_GUARD_HIGH, 1.0, 40);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe(
        "skipped_composite_borderline_heuristic_confirms_slop",
      );
    });

    it("still fires when composite is borderline and heuristic is just below the tiebreaker", () => {
      const decision = evaluateLlmGate(COST_GUARD_HIGH - 1, 1.0, 40);
      expect(decision.shouldCall).toBe(true);
      expect(decision.reason).toBe("fired_borderline_composite");
    });

    it.each([
      ["lower bound", COST_GUARD_LOW, "fired_borderline_composite", true],
      ["upper bound", COST_GUARD_HIGH, "fired_borderline_composite", true],
      [
        "just above upper bound",
        COST_GUARD_HIGH + 1,
        "skipped_above_borderline_composite",
        false,
      ],
      [
        "just below lower bound",
        COST_GUARD_LOW - 1,
        "skipped_below_borderline_composite",
        false,
      ],
    ])(
      "composite boundary case %s (composite=%i)",
      (_label, composite, reason, shouldCall) => {
        const decision = evaluateLlmGate(0, 1.0, composite);
        expect(decision.shouldCall).toBe(shouldCall);
        expect(decision.reason).toBe(reason);
      },
    );

    it("low confidence overrides composite-skip (still fires)", () => {
      // Today reports.ts always passes confidence=1.0, so this branch is
      // dormant in production; pinning it here keeps the future "wire up
      // real fusion confidence" change a one-liner.
      const decision = evaluateLlmGate(0, 0.1, 80);
      expect(decision.shouldCall).toBe(true);
      expect(decision.reason).toBe("fired_low_confidence");
    });

    it("surfaces the composite verbatim on the decision payload", () => {
      const decision = evaluateLlmGate(50, 1.0, 47);
      expect(decision.compositeScore).toBe(47);
    });

    it("treats NaN / non-finite composite as missing and falls back to heuristic-only", () => {
      const decision = evaluateLlmGate(50, 1.0, Number.NaN);
      // heuristic 50 is in the legacy borderline band → fired_borderline
      expect(decision.reason).toBe("fired_borderline");
      expect(decision.compositeScore).toBeNull();
    });
  });

  describe("legacy heuristic-only path (composite=null)", () => {
    // These pin the backward-compat behavior so callers that haven't
    // wired the composite through (or pre-engine legacy reports) keep
    // their existing decision tree. Critical: shipping this fix must not
    // change behavior for any null-composite caller.
    it("fires on borderline heuristic when composite is null", () => {
      const decision = evaluateLlmGate(40, 1.0, null);
      expect(decision.shouldCall).toBe(true);
      expect(decision.reason).toBe("fired_borderline");
      expect(decision.compositeScore).toBeNull();
    });

    it("skips above-borderline heuristic when composite is null", () => {
      const decision = evaluateLlmGate(80, 1.0, null);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe("skipped_above_borderline");
    });

    it("skips below-borderline heuristic when composite is null", () => {
      const decision = evaluateLlmGate(10, 1.0, null);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe("skipped_below_borderline");
    });

    it("fires fired_borderline_and_low_confidence when both conditions hit (legacy compound reason)", () => {
      const decision = evaluateLlmGate(40, 0.1, null);
      expect(decision.shouldCall).toBe(true);
      expect(decision.reason).toBe("fired_borderline_and_low_confidence");
    });

    it("defaults compositeScore to null when the optional arg is omitted", () => {
      const decision = evaluateLlmGate(40, 1.0);
      expect(decision.compositeScore).toBeNull();
      expect(decision.reason).toBe("fired_borderline");
    });
  });

  describe("LLM-unavailable short-circuit", () => {
    it("returns skipped_unavailable when no provider key is configured, regardless of composite", () => {
      delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      const decision = evaluateLlmGate(0, 1.0, 40);
      expect(decision.shouldCall).toBe(false);
      expect(decision.reason).toBe("skipped_unavailable");
      // Composite is still surfaced for telemetry even when the gate
      // short-circuits — the diagnostics panel renders it either way.
      expect(decision.compositeScore).toBe(40);
    });
  });
});
