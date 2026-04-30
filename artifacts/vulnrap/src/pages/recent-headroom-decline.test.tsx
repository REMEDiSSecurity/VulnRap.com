import { describe, it, expect } from "vitest";
import {
  recentHeadroomDecline,
  type ArchetypeHistorySnapshot,
} from "./feedback-analytics";

const snap = (
  minDistanceToCeiling: number,
  overrides: Partial<ArchetypeHistorySnapshot> = {},
): ArchetypeHistorySnapshot => ({
  timestamp: "2026-04-22T00:00:00.000Z",
  archetype: "test-archetype",
  count: 1,
  avriOnMean: 0,
  avriOnMax: 0,
  minDistanceToCeiling,
  ceiling: 30,
  ...overrides,
});

describe("recentHeadroomDecline (Task #261 — calibration headroom-decline math)", () => {
  it("returns 0 when there are fewer than 2 snapshots", () => {
    expect(recentHeadroomDecline([])).toBe(0);
    expect(recentHeadroomDecline([snap(10)])).toBe(0);
  });

  it("returns 0 for a flat series (no movement vs. earlier-half best)", () => {
    expect(
      recentHeadroomDecline([snap(10), snap(10), snap(10), snap(10)]),
    ).toBe(0);
  });

  it("returns 0 or negative for an improving series (headroom growing)", () => {
    // Earlier half = [5, 6] → max 6. Latest = 12. Decline = 6 - 12 = -6.
    expect(
      recentHeadroomDecline([snap(5), snap(6), snap(9), snap(12)]),
    ).toBe(-6);
  });

  it("returns the expected positive delta for a clearly regressing series", () => {
    // Earlier half = [20, 18] → max 20. Latest = 8. Decline = 20 - 8 = 12.
    expect(
      recentHeadroomDecline([snap(20), snap(18), snap(12), snap(8)]),
    ).toBe(12);
  });

  it("uses the MAX of the earlier half as the baseline (not the latest of that half)", () => {
    // Earlier half (first 2 of 4) = [25, 10]. If the helper compared to the
    // latest of that half (10), the decline would be 10 - 9 = 1. The helper
    // must instead pick the MAX (25), giving 25 - 9 = 16.
    expect(
      recentHeadroomDecline([snap(25), snap(10), snap(11), snap(9)]),
    ).toBe(16);
  });

  it("always slices at least one snapshot for the earlier-half baseline (n=2 case)", () => {
    // Math.floor(2/2) = 1, so the earlier half is just the first snapshot.
    // Decline = 14 - 6 = 8.
    expect(recentHeadroomDecline([snap(14), snap(6)])).toBe(8);
  });

  it("rounds the result to one decimal place via toFixed(1)", () => {
    // Earlier half = [10] → max 10. Latest = 4.13. Raw delta = 5.87 →
    // toFixed(1) → "5.9" → 5.9. Confirms the rounding step is preserved
    // (without it, callers would see 5.87 / 5.870000000000001).
    expect(recentHeadroomDecline([snap(10), snap(4.13)])).toBe(5.9);
  });

  it("ignores later-half values when computing the baseline (only earlier half counts)", () => {
    // 5 snapshots → earlier half = first 2 = [5, 6] → max 6. The huge values
    // in positions 2 and 3 belong to the later half and must be ignored.
    // Latest = 4. Decline = 6 - 4 = 2.
    expect(
      recentHeadroomDecline([snap(5), snap(6), snap(99), snap(99), snap(4)]),
    ).toBe(2);
  });
});
