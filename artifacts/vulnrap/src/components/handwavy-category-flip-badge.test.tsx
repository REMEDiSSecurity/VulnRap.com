import { describe, it, expect } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HandwavyEditEntry } from "@workspace/api-client-react";
import {
  HandwavyCategoryFlipBadge,
  HANDWAVY_CATEGORY_FLIP_MIN,
  getCategoryFlips,
} from "./handwavy-category-flip-badge";

// Task #338 pulled the FLAT hand-wavy phrase panel's "N category flips"
// badge into a shared component + a single `getCategoryFlips` helper. The
// only coverage that exists today is the e2e spec
// (`handwavy-history-category-flip.spec.ts`), which is slow and only
// exercises the removed-history call site. This Vitest suite locks in the
// helper's filter contract, the threshold gate, and both testIdPrefix
// renderings so the shared module can't drift in milliseconds-per-run
// instead of waiting for a full browser run.

describe("getCategoryFlips", () => {
  it("returns an empty list for missing or empty edit arrays so callers don't have to special-case undefined", () => {
    expect(getCategoryFlips(undefined)).toEqual([]);
    expect(getCategoryFlips(null)).toEqual([]);
    expect(getCategoryFlips([])).toEqual([]);
  });

  it("ignores rationale-only edits — the audit log omits `category` when only the rationale changed, so those entries must not count as flips", () => {
    const edits: HandwavyEditEntry[] = [
      {
        editedAt: "2026-04-22T10:00:00.000Z",
        rationale: { from: "first take", to: "second take" },
      },
      {
        editedAt: "2026-04-23T10:00:00.000Z",
        editedBy: "alice@team.com",
        rationale: { from: "second take", to: "third take" },
      },
    ];
    expect(getCategoryFlips(edits)).toEqual([]);
  });

  it("ignores entries with no category block at all (rename-only or empty edits)", () => {
    const edits: HandwavyEditEntry[] = [
      {
        editedAt: "2026-04-24T10:00:00.000Z",
        phrase: { from: "we plan to look", to: "we plan to investigate" },
      },
      { editedAt: "2026-04-25T10:00:00.000Z" },
    ];
    expect(getCategoryFlips(edits)).toEqual([]);
  });

  it("ignores defensive no-op category entries where from === to so a malformed audit row never inflates the count", () => {
    const edits: HandwavyEditEntry[] = [
      {
        editedAt: "2026-04-26T10:00:00.000Z",
        category: { from: "absence", to: "absence" },
      },
    ];
    expect(getCategoryFlips(edits)).toEqual([]);
  });

  it("keeps only the entries whose category.from differs from category.to, preserving order so tooltips render chronologically", () => {
    const flipA: HandwavyEditEntry = {
      editedAt: "2026-04-22T10:00:00.000Z",
      editedBy: "alice@team.com",
      category: { from: "absence", to: "hedging" },
    };
    const rationaleOnly: HandwavyEditEntry = {
      editedAt: "2026-04-22T11:00:00.000Z",
      rationale: { from: "x", to: "y" },
    };
    const flipB: HandwavyEditEntry = {
      editedAt: "2026-04-23T10:00:00.000Z",
      editedBy: "bob@team.com",
      category: { from: "hedging", to: "buzzword" },
    };
    expect(getCategoryFlips([flipA, rationaleOnly, flipB])).toEqual([
      flipA,
      flipB,
    ]);
  });
});

describe("HandwavyCategoryFlipBadge", () => {
  const oneFlip: HandwavyEditEntry[] = [
    {
      editedAt: "2026-04-22T10:00:00.000Z",
      editedBy: "alice@team.com",
      category: { from: "absence", to: "hedging" },
    },
  ];

  const twoFlips: HandwavyEditEntry[] = [
    ...oneFlip,
    {
      editedAt: "2026-04-23T10:00:00.000Z",
      editedBy: "bob@team.com",
      category: { from: "hedging", to: "buzzword" },
    },
  ];

  it("exports a sensible threshold (>= 2 transitions) so a single re-categorization doesn't surface as churn", () => {
    // Sanity-check the constant so a typo (0, 1, or a huge number) doesn't
    // silently flip the gate to "always render" or "never render" globally.
    expect(HANDWAVY_CATEGORY_FLIP_MIN).toBe(2);
  });

  it("renders nothing for an empty flip list (no edits at all means no badge)", () => {
    const { container } = render(
      <HandwavyCategoryFlipBadge flips={[]} testIdPrefix="handwavy" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing below the HANDWAVY_CATEGORY_FLIP_MIN threshold — one transition is a one-off correction, not churn", () => {
    const { container } = render(
      <HandwavyCategoryFlipBadge flips={oneFlip} testIdPrefix="handwavy" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("handwavy-category-flip-badge")).toBeNull();
  });

  it("renders the badge with the right count once the flip list reaches the threshold", () => {
    render(
      <HandwavyCategoryFlipBadge flips={twoFlips} testIdPrefix="handwavy" />,
    );
    const badge = screen.getByTestId("handwavy-category-flip-badge");
    expect(badge).toBeVisible();
    expect(badge).toHaveTextContent("2 category flips");
    // The aria-label backs the visible count for screen-reader users.
    expect(badge).toHaveAttribute(
      "aria-label",
      "Category changed 2 times across edit history",
    );
  });

  it("uses the testIdPrefix so the active-list badge ('handwavy') and the removed-history badge ('handwavy-history') can be selected independently", () => {
    const { unmount } = render(
      <HandwavyCategoryFlipBadge flips={twoFlips} testIdPrefix="handwavy" />,
    );
    expect(screen.getByTestId("handwavy-category-flip-badge")).toBeVisible();
    expect(
      screen.queryByTestId("handwavy-history-category-flip-badge"),
    ).toBeNull();
    unmount();

    render(
      <HandwavyCategoryFlipBadge
        flips={twoFlips}
        testIdPrefix="handwavy-history"
      />,
    );
    expect(
      screen.getByTestId("handwavy-history-category-flip-badge"),
    ).toBeVisible();
    expect(screen.queryByTestId("handwavy-category-flip-badge")).toBeNull();
  });

  // The Radix tooltip body is portaled and only mounted while the trigger
  // is hovered/focused, so these tooltip-content assertions hover the badge
  // first and wait for the tooltip to attach. The same selector is what the
  // existing E2E spec latches onto.
  async function openTooltip(prefix: string) {
    const user = userEvent.setup();
    await user.hover(screen.getByTestId(`${prefix}-category-flip-badge`));
    return waitFor(() =>
      screen.getByTestId(`${prefix}-category-flip-tooltip`),
    );
  }

  it("renders each transition in the tooltip with the editor and the formatted timestamp injected via `formatTimestamp`", async () => {
    const formatTimestamp = (iso: string | undefined | null) =>
      iso ? `at ${iso}` : null;
    render(
      <HandwavyCategoryFlipBadge
        flips={twoFlips}
        testIdPrefix="handwavy"
        formatTimestamp={formatTimestamp}
      />,
    );

    const tooltip = await openTooltip("handwavy");
    expect(tooltip).toHaveTextContent("Category changed 2 times");

    // Each flip is rendered as a numbered <li> in chronological order. The
    // first <ol> in the tooltip is the visible body (Radix may also mount
    // an a11y-only mirror, which is harmless — we just inspect the visible
    // list to keep the assertion stable).
    const list = within(tooltip).getAllByRole("list")[0];
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    expect(items[0]).toHaveTextContent("#1:");
    expect(items[0]).toHaveTextContent(/absence\s*→\s*hedging/);
    expect(items[0]).toHaveTextContent("alice@team.com");
    expect(items[0]).toHaveTextContent("at 2026-04-22T10:00:00.000Z");

    expect(items[1]).toHaveTextContent("#2:");
    expect(items[1]).toHaveTextContent(/hedging\s*→\s*buzzword/);
    expect(items[1]).toHaveTextContent("bob@team.com");
    expect(items[1]).toHaveTextContent("at 2026-04-23T10:00:00.000Z");
  });

  it("falls back to 'anonymous' when an entry has no editedBy, and omits the timestamp when no formatter is provided", async () => {
    const anonFlips: HandwavyEditEntry[] = [
      {
        editedAt: "2026-04-22T10:00:00.000Z",
        category: { from: "absence", to: "hedging" },
      },
      {
        editedAt: "2026-04-23T10:00:00.000Z",
        category: { from: "hedging", to: "buzzword" },
      },
    ];
    render(
      <HandwavyCategoryFlipBadge flips={anonFlips} testIdPrefix="handwavy" />,
    );

    const tooltip = await openTooltip("handwavy");
    expect(tooltip).toHaveTextContent("anonymous");
    // No formatTimestamp prop → the raw ISO string must NOT leak into the
    // visible text. The badge passes `null` through when no formatter is
    // injected so we explicitly check for the absence of the ISO marker.
    expect(tooltip).not.toHaveTextContent("2026-04-22T10:00:00.000Z");
    expect(tooltip).not.toHaveTextContent("2026-04-23T10:00:00.000Z");
  });

  it("renders the tooltip with the prefixed test id when given testIdPrefix='handwavy-history' so the removed-history E2E spec selector still works", async () => {
    render(
      <HandwavyCategoryFlipBadge
        flips={twoFlips}
        testIdPrefix="handwavy-history"
      />,
    );

    const tooltip = await openTooltip("handwavy-history");
    expect(tooltip).toBeInTheDocument();
    // The active-list selector must NOT collide with the history selector
    // even when the same data shape is rendered.
    expect(screen.queryByTestId("handwavy-category-flip-tooltip")).toBeNull();
  });
});
