import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArchetypeRowView, type ArchetypeRow } from "./feedback-analytics";
import type { ArchetypeHistorySnapshot } from "@/lib/archetype-history";

// Task #508 — guard the red "Tight headroom" badge that `ArchetypeRowView`
// renders when `row.minDistanceToCeiling < threshold`. Task #364 already
// covers the sibling orange "Headroom shrinking" badge, but the `tight`
// branch had no test, so a regression like swapping `<` for `<=` or wiring
// the wrong threshold prop wouldn't surface in the unit suite (both badges
// share the row-level `(tight || shrinking)` highlight, which masks the
// signal further).

const TIGHT_BADGE_PATTERN = /Tight headroom/;

// Empty history keeps `shrinking` false (it requires `history.length >= 2`),
// so each assertion is unambiguously about the `tight` branch.
const NO_HISTORY: ArchetypeHistorySnapshot[] = [];

function makeRow(
  minDistanceToCeiling: number,
  overrides: Partial<ArchetypeRow> = {},
): ArchetypeRow {
  return {
    archetype: "fabricated_diff",
    count: 1,
    avriOnMean: 0,
    avriOnMax: 0,
    minDistanceToCeiling,
    ceiling: 30,
    fixtures: [
      {
        id: "fixture-1",
        tier: "T1",
        composite: 50,
        avriOnScore: 50,
        avriOffScore: 0,
        distanceToCeiling: minDistanceToCeiling,
        triage: "TP",
        passed: true,
      },
    ],
    ...overrides,
  };
}

describe("ArchetypeRowView 'Tight headroom' badge (Task #508)", () => {
  it("hides the badge at the exact threshold (< boundary, must NOT fire)", () => {
    // Boundary case — the consumer compares with `<`, not `<=`, so equal
    // values must leave the badge hidden. A regression to `<=` would flip
    // this assertion.
    render(
      <ArchetypeRowView
        row={makeRow(5)}
        threshold={5}
        history={NO_HISTORY}
        declineThreshold={1}
      />,
    );

    expect(screen.queryByText(TIGHT_BADGE_PATTERN)).toBeNull();
  });

  it("hides the badge when the distance is above the threshold", () => {
    render(
      <ArchetypeRowView
        row={makeRow(10)}
        threshold={5}
        history={NO_HISTORY}
        declineThreshold={1}
      />,
    );

    expect(screen.queryByText(TIGHT_BADGE_PATTERN)).toBeNull();
  });

  it("shows the badge when the distance is below the threshold", () => {
    render(
      <ArchetypeRowView
        row={makeRow(4)}
        threshold={5}
        history={NO_HISTORY}
        declineThreshold={1}
      />,
    );

    expect(screen.getByText(TIGHT_BADGE_PATTERN)).toBeInTheDocument();
  });
});
