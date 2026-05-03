// Task #617 — Pin the public drift summary projection. The single
// most important property is that no reviewer-only field from the
// internal AvriDriftReport ever leaks into the public DTO. The lib
// layer is unit-tested separately for the actual drift compute; this
// file feeds a synthetic AvriDriftReport into `toPublicDriftSummary`
// so the projection contract can't silently regress on a refactor.
import { describe, it, expect } from "vitest";
import { toPublicDriftSummary } from "./avri-drift-public";
import type { AvriDriftReport, WeekBucket } from "./avri-drift";

function week(
  weekStart: string,
  gap: number | null,
  gapEligible: boolean,
): WeekBucket {
  return {
    weekStart,
    reportCount: 42,
    t1: { count: 5, mean: gap == null ? null : 70 },
    t3: { count: 5, mean: gap == null ? null : 70 - gap },
    gap,
    perFamily: {
      t1: [{ family: "INJECTION", count: 5, mean: 70 }],
      t3: [{ family: "INJECTION", count: 5, mean: 30 }],
    },
    gapEligible,
  };
}

function buildReport(weeks: WeekBucket[]): AvriDriftReport {
  return {
    generatedAt: "2026-04-30T12:00:00.000Z",
    weeksRequested: 16,
    totalReportsScanned: 999,
    cohort: "avri_on_only",
    bucketingNote: "REVIEWER ONLY — should never appear in public DTO",
    thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
    weeks,
    flags: [
      {
        weekStart: weeks[0]?.weekStart ?? "2026-01-01",
        kind: "GAP_BELOW_45",
        detail: "REVIEWER ONLY DETAIL — must be stripped",
      },
    ],
    runbookPath: "docs/avri-drift-runbook.md",
  };
}

describe("toPublicDriftSummary", () => {
  it("strips every reviewer-only field from the projection", () => {
    const report = buildReport([
      week("2026-04-13", 50, true),
      week("2026-04-20", 48, true),
    ]);

    const summary = toPublicDriftSummary(report, new Date("2026-04-22T00:00:00Z"));

    // Whitelist of public-safe top-level keys; anything else is a leak.
    expect(Object.keys(summary).sort()).toEqual(
      ["currentSpread", "delta", "generatedAt", "hasCurrentWeek", "previousSpread", "weeks"].sort(),
    );

    // Per-week keys must only carry weekStart + spread.
    for (const w of summary.weeks) {
      expect(Object.keys(w).sort()).toEqual(["spread", "weekStart"]);
    }

    // None of the reviewer-only sentinel strings should appear anywhere
    // in the serialized DTO.
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain("REVIEWER ONLY");
    expect(blob).not.toContain("perFamily");
    expect(blob).not.toContain("INJECTION");
    expect(blob).not.toContain("flags");
    expect(blob).not.toContain("thresholds");
    expect(blob).not.toContain("runbookPath");
    expect(blob).not.toContain("bucketingNote");
    expect(blob).not.toContain("cohort");
    expect(blob).not.toContain("totalReportsScanned");
    expect(blob).not.toContain("reportCount");
    // Drift flag detail strings carry counts like "n=5"; ensure none leak.
    expect(blob).not.toMatch(/n=\d+/);
  });

  it("drops ineligible weeks and computes current/previous/delta", () => {
    const report = buildReport([
      week("2026-04-06", 60, true),
      week("2026-04-13", 55, true),
      week("2026-04-20", 30, false), // ineligible — must be dropped
      week("2026-04-27", 50, true),
    ]);

    const summary = toPublicDriftSummary(report, new Date("2026-04-30T00:00:00Z"));

    expect(summary.weeks.map((w) => w.weekStart)).toEqual([
      "2026-04-06",
      "2026-04-13",
      "2026-04-27",
    ]);
    expect(summary.currentSpread).toBe(50);
    expect(summary.previousSpread).toBe(55);
    expect(summary.delta).toBe(-5);
    // 2026-04-27 is the UTC Monday for `now=2026-04-30`.
    expect(summary.hasCurrentWeek).toBe(true);
  });

  it("renders a clean empty state when no eligible weeks exist", () => {
    const report = buildReport([
      week("2026-04-13", null, false),
      week("2026-04-20", 30, false),
    ]);

    const summary = toPublicDriftSummary(report, new Date("2026-04-22T00:00:00Z"));

    expect(summary.weeks).toEqual([]);
    expect(summary.currentSpread).toBeNull();
    expect(summary.previousSpread).toBeNull();
    expect(summary.delta).toBeNull();
    expect(summary.hasCurrentWeek).toBe(false);
  });

  it("caps the public sparkline at 12 weeks (oldest dropped)", () => {
    const weeks: WeekBucket[] = [];
    for (let i = 0; i < 16; i++) {
      // 16 consecutive Mondays starting 2026-01-05.
      const d = new Date(Date.UTC(2026, 0, 5 + i * 7));
      weeks.push(week(d.toISOString().slice(0, 10), 50 + i, true));
    }
    const summary = toPublicDriftSummary(buildReport(weeks), new Date("2026-04-30T00:00:00Z"));
    expect(summary.weeks).toHaveLength(12);
    // Newest 12 retained, oldest 4 dropped.
    expect(summary.weeks[0].weekStart).toBe("2026-02-02");
    expect(summary.weeks[11].weekStart).toBe("2026-04-20");
  });
});
