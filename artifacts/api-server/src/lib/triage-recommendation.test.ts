import { describe, it, expect } from "vitest";
import {
  generateTriageRecommendation,
  buildV36TriageContext,
  buildV36TriageContextFromComposite,
} from "./triage-recommendation";
import type { CompositeResult } from "./engines";
import type { VerificationResult } from "./active-verification";

function makeComposite(
  overall: number,
  e2Score: number,
  strongCount: number,
): CompositeResult {
  return {
    overallScore: overall,
    label: "TEST",
    engineResults: [
      {
        engine: "AI Authorship Detector",
        score: 50,
        verdict: "YELLOW",
        confidence: "MEDIUM",
        signalBreakdown: {},
        triggeredIndicators: [],
      },
      {
        engine: "Technical Substance Analyzer",
        score: e2Score,
        verdict: "YELLOW",
        confidence: "MEDIUM",
        signalBreakdown: { evidenceStrength: { strongCount } },
        triggeredIndicators: [],
      },
      {
        engine: "CWE Coherence Checker",
        score: 50,
        verdict: "YELLOW",
        confidence: "MEDIUM",
        signalBreakdown: {},
        triggeredIndicators: [],
      },
    ],
    overridesApplied: [],
    warnings: [],
    engineCount: 3,
    compositeBreakdown: {
      weightedSum: overall,
      totalWeight: 1,
      beforeOverride: overall,
      afterOverride: overall,
    },
  } as unknown as CompositeResult;
}

function storedRowFor(composite: CompositeResult) {
  return {
    vulnrapCompositeScore: composite.overallScore,
    vulnrapEngineResults: {
      engines: composite.engineResults.map(e => ({
        engine: e.engine,
        score: e.score,
        signalBreakdown: e.signalBreakdown,
      })),
    },
  };
}

describe("v3.6.0 triage matrix consolidation", () => {
  // The cached-report path reads composite/engine fields off the stored DB
  // row and feeds them through buildV36TriageContext. The live path runs the
  // engines fresh and feeds them through buildV36TriageContextFromComposite.
  // For the same underlying composite they MUST produce the same triage
  // decision; otherwise re-checking an existing report would silently flip
  // its recommendation.
  const verification: VerificationResult | null = null;
  const evidence: Array<{ type: string; description: string; weight: number }> = [];

  const cases: Array<{ label: string; composite: number; e2: number; strong: number }> = [
    { label: "high-quality (PRIORITIZE band)", composite: 78, e2: 70, strong: 3 },
    { label: "standard band", composite: 65, e2: 55, strong: 1 },
    { label: "mid band needing review", composite: 50, e2: 45, strong: 0 },
    { label: "low-mid band", composite: 35, e2: 30, strong: 0 },
    { label: "auto-close band", composite: 20, e2: 25, strong: 0 },
  ];

  for (const c of cases) {
    it(`cached and live paths agree for ${c.label}`, () => {
      const composite = makeComposite(c.composite, c.e2, c.strong);
      const stored = storedRowFor(composite);

      const liveCtx = buildV36TriageContextFromComposite(composite, verification);
      const cachedCtx = buildV36TriageContext(stored, verification);

      expect(cachedCtx).toEqual(liveCtx);

      const slopScore = Math.max(0, 100 - c.composite);
      const live = generateTriageRecommendation(slopScore, 0.7, verification, evidence, liveCtx);
      const cached = generateTriageRecommendation(slopScore, 0.7, verification, evidence, cachedCtx);

      expect(cached.action).toBe(live.action);
      expect(cached.reason).toBe(live.reason);
      expect(cached.note).toBe(live.note);
    });
  }

  it("legacy stored rows (no composite) fall through to the matrix's neutral baseline rather than the removed v3.5.0 branch", () => {
    const stored = { vulnrapCompositeScore: null, vulnrapEngineResults: null };
    const ctx = buildV36TriageContext(stored, null);
    expect(ctx).toBeUndefined();

    // The "high slop, high confidence" combination used to trigger AUTO_CLOSE
    // on the legacy single-axis branch. With the legacy branch removed, we
    // expect the matrix's neutral 50/50 fallback instead.
    const rec = generateTriageRecommendation(85, 0.9, null, [], ctx);
    expect(rec.action).not.toBe("AUTO_CLOSE");
    expect(["MANUAL_REVIEW", "STANDARD_TRIAGE"]).toContain(rec.action);
  });

  it("buildV36TriageContextFromComposite returns undefined when no composite was produced", () => {
    expect(buildV36TriageContextFromComposite(null, null)).toBeUndefined();
  });
});
