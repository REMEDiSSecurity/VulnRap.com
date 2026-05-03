import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HandwavyRenameBadge, getRenameEdits } from "./handwavy-rename-badge";
import type { HandwavyEditEntry } from "@workspace/api-client-react";

// Task #357 — focused unit coverage for the rename audit badge. The badge
// mirrors `HandwavyCategoryFlipBadge` (Task #338) so the active-row list and
// the removed-history list always agree on what counts as a rename and how
// the badge looks. These tests pin the filter contract, the empty-state
// behavior, and the visible label so future tweaks can't silently break
// either consumer.

describe("getRenameEdits", () => {
  it("returns an empty list for missing or empty edit arrays so callers don't have to special-case undefined", () => {
    expect(getRenameEdits(undefined)).toEqual([]);
    expect(getRenameEdits(null)).toEqual([]);
    expect(getRenameEdits([])).toEqual([]);
  });

  it("filters out edits that did not touch the phrase field (category- or rationale-only edits)", () => {
    const edits: HandwavyEditEntry[] = [
      {
        editedAt: "2026-04-22T10:00:00.000Z",
        category: { from: "absence", to: "buzzword" },
      },
      {
        editedAt: "2026-04-23T10:00:00.000Z",
        rationale: { from: "first", to: "second" },
      },
    ];
    expect(getRenameEdits(edits)).toEqual([]);
  });

  it("keeps entries whose phrase.from differs from phrase.to", () => {
    const renameEntry: HandwavyEditEntry = {
      editedAt: "2026-04-24T10:00:00.000Z",
      editedBy: "alice@team.com",
      phrase: { from: "we plan to look", to: "we plan to investigate" },
    };
    expect(getRenameEdits([renameEntry])).toEqual([renameEntry]);
  });

  it("ignores phrase entries where from === to (defensive: a no-op rename should never have been recorded but must not show as a rename either)", () => {
    const noopRename: HandwavyEditEntry = {
      editedAt: "2026-04-24T10:00:00.000Z",
      phrase: { from: "we plan to investigate", to: "we plan to investigate" },
    };
    expect(getRenameEdits([noopRename])).toEqual([]);
  });
});

describe("HandwavyRenameBadge", () => {
  const oneRename: HandwavyEditEntry[] = [
    {
      editedAt: "2026-04-24T10:00:00.000Z",
      editedBy: "alice@team.com",
      phrase: { from: "we plan to look", to: "we plan to investigate" },
    },
  ];

  const twoRenames: HandwavyEditEntry[] = [
    ...oneRename,
    {
      editedAt: "2026-04-25T10:00:00.000Z",
      editedBy: "bob@team.com",
      phrase: { from: "we plan to investigate", to: "we plan to dig in" },
    },
  ];

  it("renders nothing for an empty rename list (no badge means no rename has happened)", () => {
    const { container } = render(
      <HandwavyRenameBadge renames={[]} testIdPrefix="handwavy" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a single 'Renamed' label (no count) when exactly one rename has happened — pluralization stays clean for the common case", () => {
    render(<HandwavyRenameBadge renames={oneRename} testIdPrefix="handwavy" />);
    const badge = screen.getByTestId("handwavy-rename-badge");
    expect(badge).toBeVisible();
    expect(badge).toHaveTextContent("Renamed");
    // The "Nx" suffix MUST NOT show for the single-rename case so reviewers
    // don't see an awkward "Renamed 1x" badge.
    expect(badge).not.toHaveTextContent(/1×|1x/);
  });

  it("renders the count suffix when the phrase has been renamed multiple times", () => {
    render(
      <HandwavyRenameBadge renames={twoRenames} testIdPrefix="handwavy" />,
    );
    const badge = screen.getByTestId("handwavy-rename-badge");
    expect(badge).toHaveTextContent("Renamed 2×");
  });

  it("uses the testIdPrefix so the active-list badge and the removed-history badge can be selected independently", () => {
    const { unmount } = render(
      <HandwavyRenameBadge renames={oneRename} testIdPrefix="handwavy" />,
    );
    expect(screen.getByTestId("handwavy-rename-badge")).toBeVisible();
    unmount();

    render(
      <HandwavyRenameBadge
        renames={oneRename}
        testIdPrefix="handwavy-history"
      />,
    );
    expect(screen.getByTestId("handwavy-history-rename-badge")).toBeVisible();
  });
});
