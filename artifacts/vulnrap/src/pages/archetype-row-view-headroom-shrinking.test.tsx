import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  recentHeadroomDecline,
  type ArchetypeHistorySnapshot,
} from "@/lib/archetype-history";
import { ArchetypeRowView, type ArchetypeRow } from "./feedback-analytics";

// Task #364 — guard the "Headroom shrinking −X.Xpt" badge that
// `ArchetypeRowView` renders when `recentHeadroomDecline(history) >=
// declineThreshold`. Task #261 already covers the helper itself, but the
// badge wiring (threshold prop, comparison operator, label formatting) had
// no test, so a regression like `>` instead of `>=` or a swapped
// `declineThreshold`/`threshold` prop wouldn't surface until an e2e run.

const HEADROOM_BADGE_PATTERN = /Headroom shrinking/;

function makeSnapshot(
  minDistanceToCeiling: number,
  overrides: Partial<ArchetypeHistorySnapshot> = {},
): ArchetypeHistorySnapshot {
  return {
    timestamp: "2026-04-22T00:00:00.000Z",
    archetype: "fabricated_diff",
    count: 1,
    avriOnMean: 0,
    avriOnMax: 0,
    minDistanceToCeiling,
    ceiling: 30,
    ...overrides,
  };
}

// Build a row whose own `minDistanceToCeiling` sits comfortably above the
// `threshold` prop so the unrelated "Tight headroom" badge never fires and
// the test is unambiguously about the shrinking badge.
function makeRow(overrides: Partial<ArchetypeRow> = {}): ArchetypeRow {
  return {
    archetype: "fabricated_diff",
    count: 1,
    avriOnMean: 0,
    avriOnMax: 0,
    minDistanceToCeiling: 100,
    ceiling: 30,
    fixtures: [
      {
        id: "fixture-1",
        tier: "T1",
        composite: 50,
        avriOnScore: 50,
        avriOffScore: 0,
        distanceToCeiling: 100,
        triage: "TP",
        passed: true,
      },
    ],
    ...overrides,
  };
}

describe("ArchetypeRowView 'Headroom shrinking' badge (Task #364)", () => {
  it("hides the badge when the computed decline is below the threshold", () => {
    // Earlier half = [10] → max 10. Latest = 5. decline = 5.
    const history = [makeSnapshot(10), makeSnapshot(5)];
    expect(recentHeadroomDecline(history)).toBe(5);

    render(
      <ArchetypeRowView
        row={makeRow()}
        threshold={1}
        history={history}
        declineThreshold={6}
      />,
    );

    expect(screen.queryByText(HEADROOM_BADGE_PATTERN)).toBeNull();
  });

  it("shows the badge at exactly the threshold (>= boundary)", () => {
    // Same series — decline = 5, threshold = 5 → boundary case must fire
    // because the consumer compares with `>=`, not `>`.
    const history = [makeSnapshot(10), makeSnapshot(5)];
    expect(recentHeadroomDecline(history)).toBe(5);

    render(
      <ArchetypeRowView
        row={makeRow()}
        threshold={1}
        history={history}
        declineThreshold={5}
      />,
    );

    expect(screen.getByText(HEADROOM_BADGE_PATTERN)).toBeInTheDocument();
  });

  it("renders the badge text using the helper's value formatted to one decimal place", () => {
    // Earlier half = [10] → max 10. Latest = 4.13. decline = 5.9 (the
    // helper rounds via toFixed(1) — covered in Task #261's helper tests).
    const history = [makeSnapshot(10), makeSnapshot(4.13)];
    const decline = recentHeadroomDecline(history);
    expect(decline).toBe(5.9);

    render(
      <ArchetypeRowView
        row={makeRow()}
        threshold={1}
        history={history}
        declineThreshold={5}
      />,
    );

    // The badge label uses a Unicode minus sign (−, U+2212), not a hyphen.
    expect(screen.getByText(/Headroom shrinking −5\.9pt/)).toBeInTheDocument();
  });
});
