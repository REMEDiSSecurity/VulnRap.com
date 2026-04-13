import { describe, it, expect } from "vitest";
import { fuseScores, getSlopTier, loadThresholds } from "./score-fusion.js";
import type { LinguisticResult } from "./linguistic-analysis.js";
import type { FactualResult } from "./factual-verification.js";

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

  it("applies fabrication boost for fabricated CVEs", () => {
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

  it("returns breakdown with all axis scores", () => {
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
