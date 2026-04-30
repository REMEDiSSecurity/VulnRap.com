// Task #119 — unit tests for the production-archive scoring step of the FLAT
// hand-wavy phrase dry-run. Exercises the pure helper directly so we don't
// need a DB to verify the bucket mapping, false-positive accounting, sample
// match cap, and warning copy.
import { describe, it, expect } from "vitest";
import { __testing } from "./calibration";

const {
  scoreProductionRows,
  productionLabelToTier,
  PRODUCTION_PREVIEW_LIMIT,
  computeRemovalImpactOnRows,
  buildSnippetForMatch,
} = __testing;

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
      // Task #124 — empty scan means no createdAt window to report.
      oldestCreatedAt: null,
      newestCreatedAt: null,
    });
  });

  // Task #124 — date-range surface
  describe("createdAt window", () => {
    it("reports oldest/newest createdAt over rows that survive label/content filtering", () => {
      const out = scoreProductionRows("xxx-no-match-xxx", [
        { id: 1, label: "STRONG", contentText: "alpha", createdAt: new Date("2026-04-22T10:00:00Z") },
        { id: 2, label: "REASONABLE", contentText: "beta", createdAt: new Date("2026-02-01T08:30:00Z") },
        { id: 3, label: "HIGH RISK", contentText: "gamma", createdAt: new Date("2026-03-15T14:45:00Z") },
        // Filtered out — should NOT widen the window.
        { id: 4, label: null, contentText: "delta", createdAt: new Date("2020-01-01T00:00:00Z") },
        { id: 5, label: "STRONG", contentText: null, createdAt: new Date("2030-01-01T00:00:00Z") },
        { id: 6, label: "WAT", contentText: "epsilon", createdAt: new Date("2050-01-01T00:00:00Z") },
      ]);
      expect(out.corpusSize).toBe(3);
      expect(out.oldestCreatedAt).toBe("2026-02-01T08:30:00.000Z");
      expect(out.newestCreatedAt).toBe("2026-04-22T10:00:00.000Z");
    });

    it("collapses to a single instant when only one eligible row contributes", () => {
      const out = scoreProductionRows("anything", [
        { id: 1, label: "STRONG", contentText: "only one", createdAt: new Date("2026-04-22T10:00:00Z") },
      ]);
      expect(out.oldestCreatedAt).toBe("2026-04-22T10:00:00.000Z");
      expect(out.newestCreatedAt).toBe("2026-04-22T10:00:00.000Z");
    });

    it("accepts ISO-string createdAt values too (not just Date instances)", () => {
      const out = scoreProductionRows("anything", [
        { id: 1, label: "STRONG", contentText: "one", createdAt: "2026-04-22T10:00:00Z" },
        { id: 2, label: "STRONG", contentText: "two", createdAt: "2026-02-01T00:00:00Z" },
      ]);
      expect(out.oldestCreatedAt).toBe("2026-02-01T00:00:00.000Z");
      expect(out.newestCreatedAt).toBe("2026-04-22T10:00:00.000Z");
    });

    it("leaves the window null when eligible rows have no createdAt", () => {
      const out = scoreProductionRows("anything", [
        { id: 1, label: "STRONG", contentText: "no timestamp" },
      ]);
      expect(out.corpusSize).toBe(1);
      expect(out.oldestCreatedAt).toBeNull();
      expect(out.newestCreatedAt).toBeNull();
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

// Task #323 — verify the addressable-archive total threads through the
// shared removal-impact computer untouched. The route handler counts the
// label-bearing archive separately from the limited recent slice, then
// passes the total in via the new `archiveTotal` parameter so the UI can
// surface a coverage-gap banner. Curated callers omit it (the corpus IS
// the full fixture set, not a sample), so the field stays null there.
describe("computeRemovalImpactOnRows archiveTotal threading", () => {
  const rows = [
    { id: "1", tier: "T3_SLOP" as const, text: "obvious slop phrase" },
    { id: "2", tier: "T1_LEGIT" as const, text: "alpha beta" },
  ];

  it("propagates the supplied archiveTotal verbatim to the production block", () => {
    const out = computeRemovalImpactOnRows(
      ["obvious slop"],
      [],
      rows,
      "the most recent 2 production reports",
      8400,
    );
    expect(out.archiveTotal).toBe(8400);
    // Sanity: the existing fields are unaffected by the new parameter.
    expect(out.corpusSize).toBe(2);
    expect(out.validDetectionsLost).toBe(1);
  });

  it("defaults archiveTotal to null when omitted (curated benchmark caller)", () => {
    const out = computeRemovalImpactOnRows(
      ["obvious slop"],
      [],
      rows,
      "the curated benchmark corpus",
    );
    expect(out.archiveTotal).toBeNull();
  });

  it("preserves archiveTotal even on a no-op removal (nothing to remove)", () => {
    const out = computeRemovalImpactOnRows(
      [],
      ["alpha"],
      rows,
      "the most recent 2 production reports",
      100,
    );
    expect(out.archiveTotal).toBe(100);
    expect(out.validDetectionsLost).toBe(0);
  });
});

// Task #345 — context-snippet helper. Slices a ~80-char window centered on
// the matched phrase out of the row's ORIGINAL text so reviewers can judge
// the un-flag in place without opening /verify/:id.
describe("buildSnippetForMatch", () => {
  it("returns a {before, match, after} triple with the matched phrase preserving its original case", () => {
    const out = buildSnippetForMatch(
      "The reviewer noted that this is OBVIOUS slop and should be retired.",
      "obvious slop",
    );
    expect(out).not.toBeNull();
    expect(out!.match).toBe("OBVIOUS slop");
    expect(`${out!.before}${out!.match}${out!.after}`).toContain("OBVIOUS slop");
  });

  it("highlights the match where it actually occurs (substring positioning, not the start of the row)", () => {
    const out = buildSnippetForMatch(
      "alpha beta gamma the magic phrase here ends epsilon zeta",
      "magic phrase",
    );
    expect(out).not.toBeNull();
    expect(out!.match).toBe("magic phrase");
    // The phrase is mid-row, so context flanks it on both sides.
    expect(out!.before.length).toBeGreaterThan(0);
    expect(out!.after.length).toBeGreaterThan(0);
  });

  it("matches case-insensitively and treats collapsed whitespace in the needle as any-whitespace in the text", () => {
    const out = buildSnippetForMatch(
      "Lots of spaces and newlines\nbetween    UNSAFE\n\tFOO words here",
      "unsafe foo",
    );
    expect(out).not.toBeNull();
    // The original (multi-whitespace) match is collapsed to a single
    // space when emitted so the highlighted token reads naturally.
    expect(out!.match).toBe("UNSAFE FOO");
  });

  it("adds a leading ellipsis when the snippet does not reach the start of the source text", () => {
    const long = "x ".repeat(100) + "fishy claim about CVE-1234";
    const out = buildSnippetForMatch(long, "fishy claim");
    expect(out).not.toBeNull();
    expect(out!.before.startsWith("…")).toBe(true);
  });

  it("adds a trailing ellipsis when the snippet does not reach the end of the source text", () => {
    const long = "fishy claim about CVE-1234 " + "y ".repeat(100);
    const out = buildSnippetForMatch(long, "fishy claim");
    expect(out).not.toBeNull();
    expect(out!.after.endsWith("…")).toBe(true);
  });

  it("keeps the rendered snippet near the configured budget (matched phrase + side context)", () => {
    const long = "x ".repeat(50) + "MARKER PHRASE HERE" + " y".repeat(50);
    const out = buildSnippetForMatch(long, "marker phrase here", 80);
    expect(out).not.toBeNull();
    const rendered = `${out!.before}${out!.match}${out!.after}`;
    // 80 char target + ellipses + a wee bit of slack for word-boundary nudging.
    expect(rendered.length).toBeLessThanOrEqual(100);
  });

  it("returns null when the needle cannot be located in the original text (defensive fallback)", () => {
    const out = buildSnippetForMatch("nothing to see here", "obvious slop");
    expect(out).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(buildSnippetForMatch("", "phrase")).toBeNull();
    expect(buildSnippetForMatch("text here", "")).toBeNull();
  });

  it("escapes regex-special characters inside the needle so they are matched literally", () => {
    const out = buildSnippetForMatch(
      "the reviewer noted (probably) hand-wavy claim here",
      "(probably)",
    );
    expect(out).not.toBeNull();
    expect(out!.match).toBe("(probably)");
  });
});

// Task #345 — verify the snippet is threaded through to each pushed sample
// match by the shared removal-impact computer, and that it carries the
// original-cased, whitespace-collapsed matched phrase the row contained.
describe("computeRemovalImpactOnRows snippet threading", () => {
  it("attaches a snippet to every sample match identifying the removed phrase", () => {
    const out = computeRemovalImpactOnRows(
      ["obvious slop"],
      [],
      [
        { id: "a", tier: "T3_SLOP" as const, text: "definitely an OBVIOUS slop claim, no proof" },
        { id: "b", tier: "T4_HALLUCINATED" as const, text: "see also: obvious   slop here" },
      ],
      "the curated benchmark corpus",
    );
    expect(out.sampleMatches).toHaveLength(2);
    const a = out.sampleMatches.find((s) => s.id === "a");
    const b = out.sampleMatches.find((s) => s.id === "b");
    expect(a?.snippet?.match).toBe("OBVIOUS slop");
    expect(b?.snippet?.match).toBe("obvious slop");
    // The before/after carry the surrounding text from the original row.
    expect(`${a!.snippet!.before}${a!.snippet!.match}${a!.snippet!.after}`).toContain("no proof");
  });

  it("attributes the snippet to the SPECIFIC removed phrase that fired (not just any removed phrase)", () => {
    const out = computeRemovalImpactOnRows(
      ["alpha phrase", "beta phrase"],
      [],
      [
        { id: "row-1", tier: "T3_SLOP" as const, text: "the BETA phrase is what flagged this row" },
      ],
      "the curated benchmark corpus",
    );
    expect(out.sampleMatches).toHaveLength(1);
    expect(out.sampleMatches[0].snippet?.match).toBe("BETA phrase");
  });
});
