import { describe, it, expect } from "vitest";
import { fuseScores, getSlopTier, loadThresholds } from "./score-fusion.js";
import type { LinguisticResult } from "./linguistic-analysis.js";
import type { FactualResult } from "./factual-verification.js";
import type { LLMSlopResult } from "./llm-slop.js";

function makeLinguistic(overrides: Partial<LinguisticResult> = {}): LinguisticResult {
  return {
    score: 10,
    lexicalScore: 10,
    statisticalScore: 10,
    templateScore: 5,
    evidence: [],
    ...overrides,
  };
}

function makeFactual(overrides: Partial<FactualResult> = {}): FactualResult {
  return {
    score: 5,
    severityInflationScore: 0,
    placeholderScore: 0,
    fabricatedOutputScore: 0,
    evidence: [],
    ...overrides,
  };
}

function makeFabricatedLlm(): LLMSlopResult {
  return {
    llmSlopScore: 70,
    llmFeedback: ["Fabricated report"],
    llmBreakdown: {
      claimSpecificity: 5,
      evidenceQuality: 5,
      internalConsistency: 10,
      hallucinationSignals: 5,
      validityScore: 25,
      redFlags: ["PoC does not test claimed library"],
      greenFlags: [],
      verdict: "LIKELY_FABRICATED",
    },
    llmRedFlags: ["PoC mismatch"],
    llmTriageGuidance: null,
    llmReproRecipe: null,
    llmClaims: {
      claimedProject: "curl",
      claimedVersion: "8.13.0",
      claimedFiles: ["lib/ws.c"],
      claimedFunctions: ["ws_frame_handshake"],
      claimedLineNumbers: [],
      claimedCVEs: [],
      claimedImpact: "RCE",
      cvssScore: 9.8,
      hasPoC: true,
      pocTargetsClaimedLibrary: false,
      hasAsanOutput: false,
      asanFromClaimedProject: false,
      selfDisclosesAI: false,
      complianceBuzzwords: [],
      complianceRelevance: "none",
    },
    llmSubstance: {
      pocValidity: 10,
      claimSpecificity: 15,
      domainCoherence: 15,
      substanceScore: 13,
      coherenceScore: 20,
    },
  };
}

function makeLegitLlm(): LLMSlopResult {
  return {
    llmSlopScore: 15,
    llmFeedback: ["Legitimate report"],
    llmBreakdown: {
      claimSpecificity: 22,
      evidenceQuality: 20,
      internalConsistency: 22,
      hallucinationSignals: 20,
      validityScore: 82,
      redFlags: [],
      greenFlags: ["Real PoC", "Valid domain knowledge"],
      verdict: "LIKELY_VALID",
    },
    llmRedFlags: [],
    llmTriageGuidance: null,
    llmReproRecipe: null,
    llmClaims: {
      claimedProject: "curl",
      claimedVersion: "8.11.0",
      claimedFiles: ["lib/urldata.h"],
      claimedFunctions: ["Curl_setopt"],
      claimedLineNumbers: [245],
      claimedCVEs: ["CVE-2024-12345"],
      claimedImpact: "info_disclosure",
      cvssScore: 5.3,
      hasPoC: true,
      pocTargetsClaimedLibrary: true,
      hasAsanOutput: false,
      asanFromClaimedProject: false,
      selfDisclosesAI: false,
      complianceBuzzwords: [],
      complianceRelevance: "none",
    },
    llmSubstance: {
      pocValidity: 85,
      claimSpecificity: 80,
      domainCoherence: 78,
      substanceScore: 81,
      coherenceScore: 85,
    },
  };
}

describe("fuseScores", () => {
  it("produces a fused score between floor and ceiling", () => {
    const result = fuseScores(
      makeLinguistic(),
      makeFactual(),
      null,
      80,
      "Some test report text.",
    );
    expect(result.slopScore).toBeGreaterThanOrEqual(0);
    expect(result.slopScore).toBeLessThanOrEqual(100);
  });

  it("produces higher slop score when all axes are elevated", () => {
    const low = fuseScores(
      makeLinguistic({ score: 10, lexicalScore: 5, statisticalScore: 5, templateScore: 5 }),
      makeFactual({ score: 5 }),
      null,
      90,
      "Clean report.",
    );
    const high = fuseScores(
      makeLinguistic({ score: 80, lexicalScore: 70, statisticalScore: 60, templateScore: 50 }),
      makeFactual({ score: 60 }),
      null,
      30,
      "Sloppy report.",
    );
    expect(high.slopScore).toBeGreaterThan(low.slopScore);
  });

  it("substance axis independently drives score past detection for fabricated CVEs", () => {
    const withoutFab = fuseScores(
      makeLinguistic({ score: 30 }),
      makeFactual({ score: 30, evidence: [] }),
      null,
      70,
      "Report text.",
    );
    const withFab = fuseScores(
      makeLinguistic({ score: 30 }),
      makeFactual({
        score: 30,
        evidence: [{ type: "fabricated_cve", description: "CVE-2099-99999 does not exist", weight: 15 }],
      }),
      null,
      70,
      "Report text.",
    );
    expect(withFab.slopScore).toBeGreaterThan(withoutFab.slopScore);
  });

  it("substance axis with LLM pushes well-written fabricated report past 60 detection threshold", () => {
    const result = fuseScores(
      makeLinguistic({ score: 0, lexicalScore: 0, statisticalScore: 0, templateScore: 0 }),
      makeFactual({
        score: 40,
        evidence: [
          { type: "hallucinated_function", description: "References nonexistent function ws_frame_handshake()", weight: 25 },
        ],
      }),
      makeFabricatedLlm(),
      80,
      "Professional report text with no AI style signals.",
    );
    expect(result.slopScore).toBeGreaterThanOrEqual(60);
    expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(60);
  });

  it("heuristic-only: multiple fabrication signals push past 60 detection threshold", () => {
    const result = fuseScores(
      makeLinguistic({ score: 0, lexicalScore: 0, statisticalScore: 0, templateScore: 0 }),
      makeFactual({
        score: 50,
        evidence: [
          { type: "hallucinated_function", description: "References nonexistent function", weight: 25 },
          { type: "fabricated_cve", description: "CVE does not exist", weight: 15 },
        ],
      }),
      null,
      80,
      "Professional report text.",
    );
    expect(result.slopScore).toBeGreaterThanOrEqual(60);
    expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(60);
  });

  it("legitimate report with valid LLM substance scores low — no false positives", () => {
    const result = fuseScores(
      makeLinguistic({ score: 5, lexicalScore: 3, statisticalScore: 3, templateScore: 2 }),
      makeFactual({ score: 5, evidence: [] }),
      makeLegitLlm(),
      90,
      "Clean legitimate vulnerability report with real details and valid PoC.",
    );
    expect(result.slopScore).toBeLessThanOrEqual(30);
    expect(result.breakdown.substanceAxis).toBe(0);
  });

  it("legitimate report without LLM still scores low", () => {
    const result = fuseScores(
      makeLinguistic({ score: 5, lexicalScore: 3, statisticalScore: 3, templateScore: 2 }),
      makeFactual({ score: 5, evidence: [] }),
      null,
      90,
      "Clean legitimate vulnerability report with real details.",
    );
    expect(result.slopScore).toBeLessThanOrEqual(30);
    expect(result.breakdown.substanceAxis).toBe(0);
  });

  it("applies human indicator reduction", () => {
    const humanText = "I don't think this is right tbh. Found in commit a1b2c3d. Won't work without the race condition. Can't reproduce on v3. It's a really subtle issue that doesn't show up in testing.";
    const aiText = "It is important to note that this vulnerability represents a significant security concern in the realm of cybersecurity. A comprehensive analysis reveals multifaceted implications.";

    const humanResult = fuseScores(
      makeLinguistic({ score: 30 }),
      makeFactual({ score: 20 }),
      null,
      70,
      humanText,
    );
    const aiResult = fuseScores(
      makeLinguistic({ score: 30 }),
      makeFactual({ score: 20 }),
      null,
      70,
      aiText,
    );
    expect(humanResult.slopScore).toBeLessThan(aiResult.slopScore);
  });

  it("includes human indicators in the result", () => {
    const text = "Found this bug tbh. Commit abc1234 introduced it. It won't trigger unless you hit the endpoint repeatedly. The server can't handle the concurrent requests.";
    const result = fuseScores(
      makeLinguistic(),
      makeFactual(),
      null,
      80,
      text,
    );
    expect(result.humanIndicators).toBeDefined();
  });

  it("returns breakdown with all axis scores including substanceAxis", () => {
    const result = fuseScores(
      makeLinguistic(),
      makeFactual(),
      null,
      80,
      "Test report.",
    );
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.linguistic).toBeDefined();
    expect(result.breakdown.factual).toBeDefined();
    expect(result.breakdown.template).toBeDefined();
    expect(result.breakdown.quality).toBeDefined();
    expect(result.breakdown.substanceAxis).toBeDefined();
  });
});

describe("getSlopTier", () => {
  it("returns 'Clean' for low scores", () => {
    expect(getSlopTier(5)).toBe("Clean");
    expect(getSlopTier(0)).toBe("Clean");
  });

  it("returns 'Likely Human' for moderate-low scores", () => {
    expect(getSlopTier(25)).toBe("Likely Human");
  });

  it("returns 'Slop' for high scores", () => {
    expect(getSlopTier(90)).toBe("Slop");
  });

  it("respects custom thresholds for high boundary", () => {
    expect(getSlopTier(80, { low: 20, high: 70 })).toBe("Slop");
    expect(getSlopTier(60, { low: 20, high: 70 })).toBe("Likely Slop");
  });
});

describe("loadThresholds", () => {
  it("returns valid thresholds with low < high", () => {
    const t = loadThresholds();
    expect(t.low).toBeLessThan(t.high);
    expect(t.low).toBeGreaterThanOrEqual(0);
    expect(t.high).toBeLessThanOrEqual(100);
  });
});
