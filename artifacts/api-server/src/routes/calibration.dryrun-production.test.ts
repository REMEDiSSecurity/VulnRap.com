// Task #119 — unit tests for the production-archive scoring step of the FLAT
// hand-wavy phrase dry-run. Exercises the pure helper directly so we don't
// need a DB to verify the bucket mapping, false-positive accounting, sample
// match cap, and warning copy.
import { describe, it, expect } from "vitest";
import { __testing } from "./calibration";

const { scoreProductionRows, productionLabelToTier, PRODUCTION_PREVIEW_LIMIT } = __testing;

describe("productionLabelToTier", () => {
  it("maps STRONG/PROMISING to T1_LEGIT", () => {
    expect(productionLabelToTier("STRONG")).toBe("T1_LEGIT");
    expect(productionLabelToTier("PROMISING")).toBe("T1_LEGIT");
  });
  it("maps NEUTRAL labels to T2_BORDERLINE", () => {
    expect(productionLabelToTier("REASONABLE")).toBe("T2_BORDERLINE");
    expect(productionLabelToTier("NEEDS REVIEW")).toBe("T2_BORDERLINE");
  });
  it("splits LIKELY INVALID / HIGH RISK into T3 vs T4", () => {
    expect(productionLabelToTier("LIKELY INVALID")).toBe("T3_SLOP");
    expect(productionLabelToTier("HIGH RISK")).toBe("T4_HALLUCINATED");
  });
  it("returns null for null/unknown labels so they're skipped, not bucketed", () => {
    expect(productionLabelToTier(null)).toBeNull();
    expect(productionLabelToTier("FOO")).toBeNull();
    expect(productionLabelToTier("")).toBeNull();
  });
});

describe("scoreProductionRows", () => {
  const rows = [
    { id: 1, label: "STRONG", contentText: "Use of unsafe FOO function in handler" },
    { id: 2, label: "PROMISING", contentText: "Memory corruption via unsafe FOO copy" },
    { id: 3, label: "REASONABLE", contentText: "Possibly unsafe foo path with limited evidence" },
    { id: 4, label: "NEEDS REVIEW", contentText: "Reviewer flagged unsafe FOO behavior" },
    { id: 5, label: "LIKELY INVALID", contentText: "comprehensive zero-trust assessment" },
    { id: 6, label: "HIGH RISK", contentText: "fabricated CVE chain with no proof" },
    // skipped: null label
    { id: 7, label: null, contentText: "should be ignored" },
    // skipped: null content
    { id: 8, label: "STRONG", contentText: null },
    // skipped: unknown label
    { id: 9, label: "WAT", contentText: "should also be ignored" },
  ];

  it("buckets matched rows into the same T1–T4 shape as the curated cohorts", () => {
    const out = scoreProductionRows("unsafe foo", rows);
    expect(out.total).toBe(4);
    expect(out.byTier).toEqual({
      t1Legit: 2, // rows 1, 2
      t2Borderline: 2, // rows 3, 4
      t3Slop: 0,
      t4Hallucinated: 0,
    });
    expect(out.falsePositives).toBe(4);
    expect(out.warning).not.toBeNull();
    expect(out.warning).toMatch(/legitimate report/);
    expect(out.warning).toMatch(/production reports/);
  });

  it("counts T3/T4 hits without inflating falsePositives", () => {
    const out = scoreProductionRows("comprehensive zero-trust", rows);
    expect(out.byTier.t3Slop).toBe(1);
    expect(out.byTier.t4Hallucinated).toBe(0);
    expect(out.falsePositives).toBe(0);
    expect(out.warning).toBeNull();
  });

  it("matches case-insensitively with collapsed whitespace, like the engine matcher", () => {
    const out = scoreProductionRows("UNSAFE   FOO", rows);
    expect(out.total).toBe(4);
  });

  it("excludes rows with null label or null contentText from the corpus size", () => {
    const out = scoreProductionRows("xxx-no-match-xxx", rows);
    // 6 eligible rows out of 9 (3 dropped: null label, null content, unknown label).
    expect(out.corpusSize).toBe(6);
    expect(out.total).toBe(0);
  });

  it("caps sampleMatches at 12 entries even when many rows match", () => {
    const wide = Array.from({ length: 50 }, (_, i) => ({
      id: 100 + i,
      label: "STRONG",
      contentText: "every row contains the marker phrase here",
    }));
    const out = scoreProductionRows("marker phrase", wide);
    expect(out.total).toBe(50);
    expect(out.sampleMatches).toHaveLength(12);
    // Each sample carries the report id (stringified) and a valid tier.
    for (const s of out.sampleMatches) {
      expect(typeof s.id).toBe("string");
      expect(s.tier).toBe("T1_LEGIT");
    }
  });

  it("returns an empty result with corpusSize=0 when there are no eligible rows", () => {
    const out = scoreProductionRows("anything", []);
    expect(out).toEqual({
      total: 0,
      byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
      falsePositives: 0,
      corpusSize: 0,
      sampleMatches: [],
      warning: null,
    });
  });

  it("uses singular 'legitimate report' copy when exactly one false positive fires", () => {
    const out = scoreProductionRows("unsafe foo", [
      { id: 1, label: "STRONG", contentText: "unsafe FOO once" },
    ]);
    expect(out.falsePositives).toBe(1);
    expect(out.warning).toMatch(/1 legitimate report \(/);
  });

  it("PRODUCTION_PREVIEW_LIMIT is set to a bounded value so the route stays fast", () => {
    expect(PRODUCTION_PREVIEW_LIMIT).toBe(2000);
  });
});
