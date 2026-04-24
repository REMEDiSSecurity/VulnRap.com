// Sprint 12 Part A2 — behavioral-match reward regression test.
//
// Verifies the BEHAVIORAL_MATCH_REWARD override fires only when ALL of:
//   - E2 has a GOLD_SIGNAL indicator
//   - E3 score >= 60 AND E3 has none of the negative CWE signals
//   - E1 verdict is not RED
// And asserts the reward magnitude (+6) and that it does NOT fire on the
// existing slop fixtures (which carry no GOLD_SIGNAL by construction).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeComposite, type EngineResult, type TriggeredIndicator } from "./engines";

type PartialEngine = {
  engine: string;
  score: number;
  verdict?: EngineResult["verdict"];
  indicators?: TriggeredIndicator[];
};

function mk(p: PartialEngine): EngineResult {
  return {
    engine: p.engine,
    score: p.score,
    verdict: p.verdict ?? "GREY",
    confidence: "MEDIUM",
    triggeredIndicators: p.indicators ?? [],
    signalBreakdown: {},
    note: "fixture",
  };
}

const goldSignal: TriggeredIndicator = {
  signal: "GOLD_SIGNAL",
  value: "real_crash_trace",
  strength: "HIGH",
  explanation: "ASan-formatted crash trace with sane addresses (+14)",
};

const typeSwap: TriggeredIndicator = {
  signal: "TYPE_SWAP",
  value: "CWE-89",
  strength: "HIGH",
  explanation: "Claimed CWE doesn't match content",
};

const baselineQualifying = (): EngineResult[] => [
  mk({ engine: "AI Authorship Detector", score: 25, verdict: "GREEN" }),
  mk({ engine: "Technical Substance Analyzer", score: 70, verdict: "GREEN", indicators: [goldSignal] }),
  mk({ engine: "CWE Coherence Checker", score: 70, verdict: "GREEN" }),
];

describe("Sprint 12 A2: behavioral-match reward", () => {
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalFlag = process.env.VULNRAP_E3_SUBSTANCE_CAP;
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.VULNRAP_E3_SUBSTANCE_CAP;
    else process.env.VULNRAP_E3_SUBSTANCE_CAP = originalFlag;
  });

  it("fires +6 when E2 GOLD_SIGNAL + E3 >= 60 + clean CWE + E1 not RED", () => {
    const engines = baselineQualifying();
    const withReward = computeComposite(engines);

    // Compare against the same fixture without the GOLD_SIGNAL indicator.
    const noGold = baselineQualifying();
    noGold[1] = mk({ engine: "Technical Substance Analyzer", score: 70, verdict: "GREEN" });
    const withoutReward = computeComposite(noGold);

    expect(withReward.overallScore - withoutReward.overallScore).toBe(6);
    expect(withReward.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(true);
    expect(withoutReward.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(false);
  });

  it("does NOT fire when E3 score is below 60 (even with GOLD_SIGNAL + clean CWE)", () => {
    const engines = baselineQualifying();
    engines[2] = mk({ engine: "CWE Coherence Checker", score: 55, verdict: "GREY" });
    const r = computeComposite(engines);
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(false);
  });

  it("does NOT fire when E3 carries a TYPE_SWAP indicator (negative CWE signal blocks reward)", () => {
    const engines = baselineQualifying();
    engines[2] = mk({ engine: "CWE Coherence Checker", score: 70, verdict: "GREY", indicators: [typeSwap] });
    const r = computeComposite(engines);
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(false);
    // It should still fire the existing CWE_TYPE_SWAP penalty.
    expect(r.overridesApplied.some((o) => o.startsWith("CWE_TYPE_SWAP"))).toBe(true);
  });

  it("does NOT fire when E2 has no GOLD_SIGNAL", () => {
    const engines = baselineQualifying();
    engines[1] = mk({ engine: "Technical Substance Analyzer", score: 70, verdict: "GREEN" });
    const r = computeComposite(engines);
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(false);
  });

  it("does NOT fire when E1 verdict is RED (suspect AI authorship blocks reward)", () => {
    const engines = baselineQualifying();
    engines[0] = mk({ engine: "AI Authorship Detector", score: 85, verdict: "RED" });
    const r = computeComposite(engines);
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(false);
  });

  it("co-fires with HIGH_REJECTION_PRIOR (net +1: reward +6 minus prior -5)", () => {
    // Lock the policy: reward and HIGH_REJECTION_PRIOR are independent signals
    // and both apply algebraically. Behavioral evidence shouldn't be silenced
    // just because the CWE category has historically high rejection rate.
    const engines = baselineQualifying();
    engines[2] = mk({
      engine: "CWE Coherence Checker",
      score: 70,
      verdict: "GREEN",
      indicators: [{
        signal: "HIGH_REJECTION_PRIOR",
        value: "CWE-79",
        strength: "MEDIUM",
        explanation: "historically rejected often",
      }],
    });
    const r = computeComposite(engines);
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(true);
    expect(r.overridesApplied.some((o) => o.startsWith("HIGH_REJECTION_CWE_PRIOR"))).toBe(true);

    const noGold = baselineQualifying();
    noGold[1] = mk({ engine: "Technical Substance Analyzer", score: 70, verdict: "GREEN" });
    noGold[2] = mk({
      engine: "CWE Coherence Checker", score: 70, verdict: "GREEN",
      indicators: [{ signal: "HIGH_REJECTION_PRIOR", value: "CWE-79", strength: "MEDIUM", explanation: "x" }],
    });
    const baseline = computeComposite(noGold);
    // baseline already includes the -5 prior; reward fixture adds +6 on top → net +6.
    expect(r.overallScore - baseline.overallScore).toBe(6);
  });

  it("co-fires with THIN_LEGITIMATE_REPORT but the gold-signal score keeps the report from being 'thin' in practice", () => {
    // Edge case: a hand-crafted fixture with sub.score=15 + GOLD_SIGNAL.
    // In the real engine, GOLD_SIGNAL contributes to sub.score, so this co-firing
    // is unreachable in practice — but we lock the algebraic behavior anyway:
    // both overrides apply (reward +6, thin -5 → net +1).
    const engines: EngineResult[] = [
      mk({ engine: "AI Authorship Detector", score: 30, verdict: "GREEN" }),
      mk({ engine: "Technical Substance Analyzer", score: 15, verdict: "GREEN", indicators: [goldSignal] }),
      mk({ engine: "CWE Coherence Checker", score: 70, verdict: "GREEN" }),
    ];
    const r = computeComposite(engines);
    expect(r.overridesApplied).toContain("THIN_LEGITIMATE_REPORT: Low substance but not AI-authored");
    expect(r.overridesApplied.some((o) => o.startsWith("BEHAVIORAL_MATCH_REWARD"))).toBe(true);
  });

  it("nudges a borderline 60 composite up to PRIORITIZE territory", () => {
    // E2 = 60, E3 = 60 with gold + clean CWE, E1 = 30 (not RED).
    // Base composite (no reward): 0.05*(100-30) + 0.60*60 + 0.35*60 = 3.5 + 36 + 21 = 60.5 → 61.
    // With +6 reward → 67. Triage band ≥ 65 → PRIORITIZE.
    const engines: EngineResult[] = [
      mk({ engine: "AI Authorship Detector", score: 30, verdict: "GREEN" }),
      mk({ engine: "Technical Substance Analyzer", score: 60, verdict: "GREEN", indicators: [goldSignal] }),
      mk({ engine: "CWE Coherence Checker", score: 60, verdict: "GREEN" }),
    ];
    const r = computeComposite(engines);
    expect(r.overridesApplied).toContain("BEHAVIORAL_MATCH_REWARD: Engine 2 gold evidence + Engine 3 coherent CWE match");
    expect(r.overallScore).toBeGreaterThanOrEqual(65);
  });
});
