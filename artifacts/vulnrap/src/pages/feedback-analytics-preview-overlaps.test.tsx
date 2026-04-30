import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type {
  HandwavyPhraseDryRunOverlaps,
  HandwavyPhraseDryRunOverlapsMatchesItem,
} from "@workspace/api-client-react";
import {
  PreviewOverlapsBlock,
  describeOverlapRelation,
  PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD,
} from "./feedback-analytics";

// Task #228 — focused component coverage for the curated-overlap preview
// callout that Task #128 added. The backend response shape is exercised in
// `handwavy-phrases.route.test.ts`, but the React component itself was only
// covered by a one-shot e2e run. These tests pin the human-readable phrasing
// for each relation so a regression in the wording (or a dropped
// `dryRunOverlaps` field) trips on every PR instead of waiting for an e2e
// sweep.

function makeMatch(
  overrides: Partial<HandwavyPhraseDryRunOverlapsMatchesItem> = {},
): HandwavyPhraseDryRunOverlapsMatchesItem {
  return {
    phrase: "do not have a reproducer",
    category: "absence",
    relation: "equal",
    ...overrides,
  };
}

function makeOverlaps(
  matches: HandwavyPhraseDryRunOverlapsMatchesItem[],
): HandwavyPhraseDryRunOverlaps {
  return { total: matches.length, matches };
}

describe("PreviewOverlapsBlock (Task #228)", () => {
  it("renders the 'exact duplicate of' phrasing for the equal relation", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "do not have a reproducer", relation: "equal" }),
    ]);

    render(
      <PreviewOverlapsBlock overlaps={overlaps} candidate="do not have a reproducer" />,
    );

    expect(screen.getByTestId("handwavy-preview-overlaps")).toBeInTheDocument();
    const rows = screen.getAllByTestId("handwavy-preview-overlap-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("exact duplicate of");
    expect(rows[0]).toHaveTextContent("\u201Cdo not have a reproducer\u201D");
    // Header reflects the candidate string and the singular "entry" noun.
    expect(
      screen.getByText(
        /Overlaps with 1 existing curated entry — adding may be redundant/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\u201Cdo not have a reproducer\u201D matches phrases already on the active list/i),
    ).toBeInTheDocument();
  });

  it("renders the 'broader than (would supersede)' phrasing for candidate-contains-existing", () => {
    const overlaps = makeOverlaps([
      makeMatch({
        phrase: "no reproducer",
        relation: "candidate-contains-existing",
      }),
    ]);

    render(
      <PreviewOverlapsBlock overlaps={overlaps} candidate="no reproducer at all" />,
    );

    const rows = screen.getAllByTestId("handwavy-preview-overlap-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("broader than (would supersede)");
    expect(rows[0]).toHaveTextContent("\u201Cno reproducer\u201D");
  });

  it("renders the 'already covered by' phrasing for existing-contains-candidate", () => {
    const overlaps = makeOverlaps([
      makeMatch({
        phrase: "no reproducer at all",
        relation: "existing-contains-candidate",
      }),
    ]);

    render(
      <PreviewOverlapsBlock overlaps={overlaps} candidate="no reproducer" />,
    );

    const rows = screen.getAllByTestId("handwavy-preview-overlap-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("already covered by");
    expect(rows[0]).toHaveTextContent("\u201Cno reproducer at all\u201D");
  });

  it("renders one row per match, preserving each relation's phrasing, with plural 'entries' in the header", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "narrower one",
        relation: "candidate-contains-existing",
      }),
      makeMatch({
        phrase: "broader one",
        relation: "existing-contains-candidate",
      }),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="something" />);

    const rows = screen.getAllByTestId("handwavy-preview-overlap-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("exact duplicate of");
    expect(rows[1]).toHaveTextContent("broader than (would supersede)");
    expect(rows[2]).toHaveTextContent("already covered by");
    // Plural "entries" used when total != 1.
    expect(
      screen.getByText(
        /Overlaps with 3 existing curated entries — adding may be redundant/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders nothing when overlaps is null", () => {
    const { container } = render(
      <PreviewOverlapsBlock overlaps={null} candidate="anything" />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("handwavy-preview-overlaps")).not.toBeInTheDocument();
  });

  it("renders nothing when matches array is empty", () => {
    const { container } = render(
      <PreviewOverlapsBlock
        overlaps={{ total: 0, matches: [] }}
        candidate="anything"
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("handwavy-preview-overlaps")).not.toBeInTheDocument();
  });
});

describe("PreviewOverlapsBlock collapsible buckets (Task #308)", () => {
  function makeBucketOfRelation(
    relation: HandwavyPhraseDryRunOverlapsMatchesItem["relation"],
    count: number,
  ): HandwavyPhraseDryRunOverlapsMatchesItem[] {
    return Array.from({ length: count }, (_, i) =>
      makeMatch({
        phrase: `${relation}-phrase-${i}`,
        relation,
      }),
    );
  }

  it("auto-collapses buckets above the row threshold and keeps the count visible", () => {
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 1;
    const overlaps = makeOverlaps(
      makeBucketOfRelation("existing-contains-candidate", overflowingCount),
    );

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);

    const bucket = screen.getByTestId("handwavy-preview-overlap-bucket");
    expect(bucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    // Count is still visible while collapsed so the at-a-glance summary works.
    expect(
      within(bucket).getByTestId("handwavy-preview-overlap-bucket-header"),
    ).toHaveTextContent(`${overflowingCount} already covered`);
    // Show-all affordance is exposed both visually and via aria-label.
    expect(
      within(bucket).getByTestId("handwavy-preview-overlap-bucket-show-all"),
    ).toHaveTextContent(`Show all ${overflowingCount}`);
    const toggle = within(bucket).getByTestId(
      "handwavy-preview-overlap-bucket-toggle",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute(
      "aria-label",
      `Show all ${overflowingCount} already covered`,
    );
    // No rows rendered while collapsed.
    expect(
      screen.queryAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(0);
  });

  it("starts buckets at or below the threshold expanded, so existing per-row testids keep working", () => {
    const overlaps = makeOverlaps(
      makeBucketOfRelation("equal", PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD),
    );

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    const bucket = screen.getByTestId("handwavy-preview-overlap-bucket");
    expect(bucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(
      within(bucket).queryByTestId(
        "handwavy-preview-overlap-bucket-show-all",
      ),
    ).not.toBeInTheDocument();
    // All rows are present and discoverable by the existing row testid.
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD);
  });

  it("expands a collapsed bucket when the toggle is clicked, revealing every row", () => {
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 3;
    const overlaps = makeOverlaps(
      makeBucketOfRelation("existing-contains-candidate", overflowingCount),
    );

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);

    const bucket = screen.getByTestId("handwavy-preview-overlap-bucket");
    const toggle = within(bucket).getByTestId(
      "handwavy-preview-overlap-bucket-toggle",
    );
    fireEvent.click(toggle);

    expect(bucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute(
      "aria-label",
      `Hide ${overflowingCount} already covered`,
    );
    // Header still shows the count after expanding.
    expect(
      within(bucket).getByTestId("handwavy-preview-overlap-bucket-header"),
    ).toHaveTextContent(`${overflowingCount} already covered`);
    expect(
      within(bucket).queryByTestId(
        "handwavy-preview-overlap-bucket-show-all",
      ),
    ).not.toBeInTheDocument();
    // Every row is now rendered with its preserved testid.
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(overflowingCount);
  });

  it("re-collapses an expanded bucket when the toggle is clicked again", () => {
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 2;
    const overlaps = makeOverlaps(
      makeBucketOfRelation("existing-contains-candidate", overflowingCount),
    );

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);

    const bucket = screen.getByTestId("handwavy-preview-overlap-bucket");
    const toggle = within(bucket).getByTestId(
      "handwavy-preview-overlap-bucket-toggle",
    );
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(bucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    expect(
      screen.queryAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(0);
    expect(
      within(bucket).getByTestId("handwavy-preview-overlap-bucket-show-all"),
    ).toBeInTheDocument();
  });

  it("collapses each bucket independently when multiple buckets are over and under the threshold", () => {
    const bigCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 4;
    const smallCount = 2;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("existing-contains-candidate", bigCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);

    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    expect(buckets).toHaveLength(2);
    const equalBucket = buckets.find(
      (b) => b.getAttribute("data-relation") === "equal",
    );
    const coveredBucket = buckets.find(
      (b) =>
        b.getAttribute("data-relation") === "existing-contains-candidate",
    );
    expect(equalBucket).toBeDefined();
    expect(coveredBucket).toBeDefined();
    expect(equalBucket!).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(coveredBucket!).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    // The small bucket renders its rows; the big bucket hides its rows.
    expect(
      within(equalBucket!).getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(smallCount);
    expect(
      within(coveredBucket!).queryAllByTestId(
        "handwavy-preview-overlap-row",
      ),
    ).toHaveLength(0);
  });
});

describe("PreviewOverlapsBlock — Remove all overlapping (Task #315)", () => {
  it("renders the header bulk action when 2+ rows are eligible (equal + supersede)", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "narrower one",
        relation: "candidate-contains-existing",
      }),
      makeMatch({
        phrase: "broader one",
        relation: "existing-contains-candidate",
      }),
    ]);
    const onRequestRemoveAllOverlapping = vi.fn();

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        onRequestRemoveAllOverlapping={onRequestRemoveAllOverlapping}
      />,
    );

    const button = screen.getByTestId("handwavy-preview-overlap-remove-all");
    expect(button).toBeInTheDocument();
    // The label and the data attribute both reflect the eligible count
    // (2), NOT the total overlap count (3) — the broader-existing row is
    // excluded for the same reason the per-row "Remove existing" action
    // is hidden on it.
    expect(button).toHaveTextContent("Remove all overlapping (2)");
    expect(button.getAttribute("data-handwavy-overlap-remove-all-count")).toBe("2");

    fireEvent.click(button);

    expect(onRequestRemoveAllOverlapping).toHaveBeenCalledTimes(1);
    expect(onRequestRemoveAllOverlapping).toHaveBeenCalledWith([
      "exact one",
      "narrower one",
    ]);
  });

  it("hides the header bulk action when only one row is eligible (the per-row button is enough)", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "broader one",
        relation: "existing-contains-candidate",
      }),
    ]);

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        onRequestRemoveAllOverlapping={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("handwavy-preview-overlap-remove-all"),
    ).not.toBeInTheDocument();
  });

  it("hides the header bulk action when every overlap is broader-than-candidate", () => {
    const overlaps = makeOverlaps([
      makeMatch({
        phrase: "broader one",
        relation: "existing-contains-candidate",
      }),
      makeMatch({
        phrase: "broader two",
        relation: "existing-contains-candidate",
      }),
      makeMatch({
        phrase: "broader three",
        relation: "existing-contains-candidate",
      }),
    ]);

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        onRequestRemoveAllOverlapping={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("handwavy-preview-overlap-remove-all"),
    ).not.toBeInTheDocument();
  });

  it("hides the header bulk action when no handler is wired up (unit-test render)", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "narrower one",
        relation: "candidate-contains-existing",
      }),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="something" />);

    expect(
      screen.queryByTestId("handwavy-preview-overlap-remove-all"),
    ).not.toBeInTheDocument();
  });

  it("disables the header bulk action when mutations are blocked", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "narrower one",
        relation: "candidate-contains-existing",
      }),
    ]);
    const onRequestRemoveAllOverlapping = vi.fn();

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        mutationsAllowed={false}
        onRequestRemoveAllOverlapping={onRequestRemoveAllOverlapping}
      />,
    );

    const button = screen.getByTestId("handwavy-preview-overlap-remove-all");
    expect(button).toBeDisabled();
    expect(button.getAttribute("data-mutations-blocked")).toBe("true");

    fireEvent.click(button);
    expect(onRequestRemoveAllOverlapping).not.toHaveBeenCalled();
  });

  it("disables the header bulk action and shows the loading label while a bulk preview is in flight or open", () => {
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "exact one", relation: "equal" }),
      makeMatch({
        phrase: "narrower one",
        relation: "candidate-contains-existing",
      }),
    ]);
    const onRequestRemoveAllOverlapping = vi.fn();

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        bulkOverlappingBusy
        onRequestRemoveAllOverlapping={onRequestRemoveAllOverlapping}
      />,
    );

    const button = screen.getByTestId("handwavy-preview-overlap-remove-all");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/Loading/);

    fireEvent.click(button);
    expect(onRequestRemoveAllOverlapping).not.toHaveBeenCalled();
  });

  it("de-duplicates the eligible phrase list passed to the handler", () => {
    // Defensive: the server normally won't list the same phrase under two
    // relations, but the type allows it and the handler shouldn't ask the
    // dry-run endpoint to retire the same phrase twice.
    const overlaps = makeOverlaps([
      makeMatch({ phrase: "duped one", relation: "equal" }),
      makeMatch({
        phrase: "duped one",
        relation: "candidate-contains-existing",
      }),
      makeMatch({
        phrase: "narrower two",
        relation: "candidate-contains-existing",
      }),
    ]);
    const onRequestRemoveAllOverlapping = vi.fn();

    render(
      <PreviewOverlapsBlock
        overlaps={overlaps}
        candidate="something"
        onRequestRemoveAllOverlapping={onRequestRemoveAllOverlapping}
      />,
    );

    const button = screen.getByTestId("handwavy-preview-overlap-remove-all");
    expect(button).toHaveTextContent("Remove all overlapping (2)");

    fireEvent.click(button);
    expect(onRequestRemoveAllOverlapping).toHaveBeenCalledWith([
      "duped one",
      "narrower two",
    ]);
  });
});

describe("describeOverlapRelation (Task #228)", () => {
  it("returns the documented phrase for each known relation", () => {
    expect(describeOverlapRelation("equal")).toBe("exact duplicate of");
    expect(describeOverlapRelation("candidate-contains-existing")).toBe(
      "broader than (would supersede)",
    );
    expect(describeOverlapRelation("existing-contains-candidate")).toBe(
      "already covered by",
    );
  });
});
