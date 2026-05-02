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

describe("PreviewOverlapsBlock collapse persistence (Task #440)", () => {
  function makeBucketOfRelation(
    relation: HandwavyPhraseDryRunOverlapsMatchesItem["relation"],
    count: number,
    prefix = "phrase",
  ): HandwavyPhraseDryRunOverlapsMatchesItem[] {
    return Array.from({ length: count }, (_, i) =>
      makeMatch({ phrase: `${prefix}-${relation}-${i}`, relation }),
    );
  }

  it("preserves a manually-expanded bucket across overlap-snapshot rerenders for the same candidate", () => {
    // Auto-collapsed by default because the bucket is over the threshold.
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 2;
    const initialOverlaps = makeOverlaps(
      makeBucketOfRelation(
        "existing-contains-candidate",
        overflowingCount,
        "v1",
      ),
    );
    const { rerender } = render(
      <PreviewOverlapsBlock overlaps={initialOverlaps} candidate="the system" />,
    );

    // Reviewer expands the auto-collapsed bucket.
    fireEvent.click(
      screen.getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(overflowingCount);

    // Simulate the dry-run refresh that fires on every keystroke: same
    // relation, same bucket size (still over the threshold), but a
    // completely different set of matches. Before Task #440 the local
    // useState in the bucket child snapped back to the auto-collapse
    // default; the lifted state should keep it expanded.
    const refreshedOverlaps = makeOverlaps(
      makeBucketOfRelation(
        "existing-contains-candidate",
        overflowingCount,
        "v2",
      ),
    );
    rerender(
      <PreviewOverlapsBlock
        overlaps={refreshedOverlaps}
        candidate="the system!"
      />,
    );

    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    // All rows still rendered — and they're the new ones from the
    // refreshed snapshot, not the original ones.
    const rowsAfter = screen.getAllByTestId("handwavy-preview-overlap-row");
    expect(rowsAfter).toHaveLength(overflowingCount);
    expect(rowsAfter[0]).toHaveAttribute(
      "data-handwavy-overlap-phrase",
      "v2-existing-contains-candidate-0",
    );
  });

  it("preserves the choice when the bucket disappears and reappears in a later snapshot", () => {
    // The crucial regression: a bucket can be filtered out entirely if the
    // refreshed overlap snapshot has no matches for that relation, then
    // come back when the next refresh re-introduces one. Without lifted
    // state the keyed child remounts with fresh useState.
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 1;
    const initialOverlaps = makeOverlaps(
      makeBucketOfRelation("existing-contains-candidate", overflowingCount),
    );
    const { rerender } = render(
      <PreviewOverlapsBlock overlaps={initialOverlaps} candidate="the system" />,
    );

    fireEvent.click(
      screen.getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );

    // Refresh: the existing-contains-candidate bucket has zero matches now,
    // so it's filtered out and the only bucket is `equal`.
    rerender(
      <PreviewOverlapsBlock
        overlaps={makeOverlaps([
          makeMatch({ phrase: "exact one", relation: "equal" }),
        ])}
        candidate="the system "
      />,
    );
    const intermediate = screen.getAllByTestId(
      "handwavy-preview-overlap-bucket",
    );
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0]).toHaveAttribute("data-relation", "equal");

    // Refresh again: the previously-expanded bucket reappears with a
    // fresh set of matches (still over the threshold). The reviewer's
    // "expanded" choice for that relation must survive.
    rerender(
      <PreviewOverlapsBlock
        overlaps={makeOverlaps(
          makeBucketOfRelation(
            "existing-contains-candidate",
            overflowingCount,
            "v3",
          ),
        )}
        candidate="the system  "
      />,
    );
    const restored = screen.getByTestId("handwavy-preview-overlap-bucket");
    expect(restored).toHaveAttribute("data-relation", "existing-contains-candidate");
    expect(restored).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(overflowingCount);
  });

  it("preserves a manually-collapsed small bucket across rerenders, even though the auto-collapse default would expand it", () => {
    // Reverse direction: a small bucket starts expanded by default. If the
    // reviewer collapses it, that choice must also survive a refresh —
    // we shouldn't only persist "expand" overrides.
    const smallCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD;
    const { rerender } = render(
      <PreviewOverlapsBlock
        overlaps={makeOverlaps(makeBucketOfRelation("equal", smallCount, "v1"))}
        candidate="anything"
      />,
    );

    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    fireEvent.click(
      screen.getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );

    rerender(
      <PreviewOverlapsBlock
        overlaps={makeOverlaps(makeBucketOfRelation("equal", smallCount, "v2"))}
        candidate="anything else"
      />,
    );
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    expect(
      screen.queryAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(0);
  });

  it("survives a refresh that briefly empties the overlap snapshot and then re-populates it", () => {
    // Refresh paths can momentarily land an empty / null overlap snapshot
    // (the candidate edit no longer matches any curated phrase) and then
    // re-populate as the reviewer keeps typing. The block early-returns
    // null on empty input, so the parent's hooks must keep running across
    // that transition — both to avoid React's "rendered fewer hooks than
    // expected" crash AND to keep the override map alive so the bucket
    // re-mounts with the reviewer's prior choice when overlaps return.
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 2;
    const initialOverlaps = makeOverlaps(
      makeBucketOfRelation(
        "existing-contains-candidate",
        overflowingCount,
        "v1",
      ),
    );
    const { rerender } = render(
      <PreviewOverlapsBlock overlaps={initialOverlaps} candidate="the system" />,
    );

    fireEvent.click(
      screen.getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );
    expect(
      screen.getByTestId("handwavy-preview-overlap-bucket"),
    ).toHaveAttribute("data-handwavy-overlap-bucket-collapsed", "false");

    // Empty overlaps — block renders nothing. This is the hook-count
    // checkpoint: if the lifted hooks were below the early return the
    // rerender would throw here.
    expect(() =>
      rerender(
        <PreviewOverlapsBlock overlaps={null} candidate="the systemxx" />,
      ),
    ).not.toThrow();
    expect(
      screen.queryByTestId("handwavy-preview-overlaps"),
    ).not.toBeInTheDocument();

    // Same again with the explicit empty-matches shape — also a valid
    // input the early return handles.
    expect(() =>
      rerender(
        <PreviewOverlapsBlock
          overlaps={{ total: 0, matches: [] }}
          candidate="the systemyy"
        />,
      ),
    ).not.toThrow();
    expect(
      screen.queryByTestId("handwavy-preview-overlaps"),
    ).not.toBeInTheDocument();

    // Re-populate. The previously-expanded bucket comes back and must
    // remember the reviewer's choice — the override map outlived the
    // empty-overlap renders because the parent never unmounted.
    rerender(
      <PreviewOverlapsBlock
        overlaps={makeOverlaps(
          makeBucketOfRelation(
            "existing-contains-candidate",
            overflowingCount,
            "v2",
          ),
        )}
        candidate="the system"
      />,
    );
    expect(
      screen.getByTestId("handwavy-preview-overlap-bucket"),
    ).toHaveAttribute("data-handwavy-overlap-bucket-collapsed", "false");
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(overflowingCount);
  });

  it("resets to the auto-collapse default when the block fully unmounts (fresh session)", () => {
    // The override map is owned by `PreviewOverlapsBlock`, so when the
    // panel goes away (e.g. the reviewer dismisses the preview) the next
    // mount should start from the documented auto-collapse defaults
    // again — i.e. lifting must NOT persist beyond the panel's lifetime.
    const overflowingCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 1;
    const overlaps = makeOverlaps(
      makeBucketOfRelation("existing-contains-candidate", overflowingCount),
    );
    const { unmount } = render(
      <PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />,
    );
    fireEvent.click(
      screen.getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    unmount();

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);
    expect(screen.getByTestId("handwavy-preview-overlap-bucket")).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
  });
});

describe("PreviewOverlapsBlock bulk expand/collapse (Task #441)", () => {
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

  it("hides the bulk toggle when only one bucket is rendered", () => {
    // The per-bucket toggle is already a one-click action when there's
    // only one bucket — a "bulk" affordance would be redundant.
    const overlaps = makeOverlaps(makeBucketOfRelation("equal", 2));

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    expect(
      screen.queryByTestId("handwavy-preview-overlap-bulk-toggle"),
    ).not.toBeInTheDocument();
  });

  it("shows 'Expand all' when ANY bucket is collapsed and flips every bucket open at once", () => {
    // One small (auto-expanded) bucket plus one oversized (auto-collapsed)
    // bucket — the panel starts in a mixed state, and the bulk toggle
    // must advertise the action that uniformly opens every bucket first.
    const bigCount = PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 4;
    const smallCount = 2;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("existing-contains-candidate", bigCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="the system" />);

    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    expect(bulkToggle).toHaveTextContent(/Expand all/i);
    expect(bulkToggle).toHaveAttribute(
      "data-handwavy-overlap-bulk-state",
      "any-collapsed",
    );
    expect(bulkToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(bulkToggle);

    // Every bucket is now expanded — both the previously-open small one
    // and the previously-collapsed large one expose all their rows.
    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b).toHaveAttribute(
        "data-handwavy-overlap-bucket-collapsed",
        "false",
      );
    }
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(smallCount + bigCount);
    // After flipping everything open, the toggle now offers the inverse.
    expect(bulkToggle).toHaveTextContent(/Collapse all/i);
    expect(bulkToggle).toHaveAttribute(
      "data-handwavy-overlap-bulk-state",
      "all-expanded",
    );
    expect(bulkToggle).toHaveAttribute("aria-expanded", "true");
  });

  it("shows 'Collapse all' when every bucket is open and flips every bucket closed at once", () => {
    // Two small buckets — both start expanded by the size-based default.
    const smallCount = 2;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("candidate-contains-existing", smallCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    expect(bulkToggle).toHaveTextContent(/Collapse all/i);
    expect(bulkToggle).toHaveAttribute(
      "data-handwavy-overlap-bulk-state",
      "all-expanded",
    );

    fireEvent.click(bulkToggle);

    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b).toHaveAttribute(
        "data-handwavy-overlap-bucket-collapsed",
        "true",
      );
    }
    // No rows are rendered when every bucket is collapsed.
    expect(
      screen.queryAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(0);
    // The toggle now offers the inverse.
    expect(bulkToggle).toHaveTextContent(/Expand all/i);
    expect(bulkToggle).toHaveAttribute(
      "data-handwavy-overlap-bulk-state",
      "any-collapsed",
    );
  });

  it("re-evaluates the label after a per-bucket toggle so the mixed state stays accurate", () => {
    // Start with two small buckets (both expanded → label is "Collapse all").
    // Collapse just one via its per-bucket toggle and confirm the bulk
    // label flips to "Expand all" because the panel is now mixed.
    const smallCount = 2;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("candidate-contains-existing", smallCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    expect(bulkToggle).toHaveTextContent(/Collapse all/i);

    const equalBucket = screen
      .getAllByTestId("handwavy-preview-overlap-bucket")
      .find((b) => b.getAttribute("data-relation") === "equal")!;
    fireEvent.click(
      within(equalBucket).getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );

    expect(equalBucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    // One bucket collapsed, one still open → bulk label advertises
    // the uniform-expand action.
    expect(bulkToggle).toHaveTextContent(/Expand all/i);
    expect(bulkToggle).toHaveAttribute(
      "data-handwavy-overlap-bulk-state",
      "any-collapsed",
    );
  });

  it("keeps per-bucket toggles working independently after a bulk flip", () => {
    // Bulk-collapse everything, then re-open just one bucket via its
    // own toggle — the other bucket must stay collapsed, proving that
    // per-bucket state isn't tied to (or reset by) bulk operations.
    const smallCount = 2;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("candidate-contains-existing", smallCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    fireEvent.click(bulkToggle); // Collapse all.

    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    const equalBucket = buckets.find(
      (b) => b.getAttribute("data-relation") === "equal",
    )!;
    const supersedeBucket = buckets.find(
      (b) =>
        b.getAttribute("data-relation") === "candidate-contains-existing",
    )!;

    fireEvent.click(
      within(equalBucket).getByTestId("handwavy-preview-overlap-bucket-toggle"),
    );

    expect(equalBucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "false",
    );
    expect(supersedeBucket).toHaveAttribute(
      "data-handwavy-overlap-bucket-collapsed",
      "true",
    );
    // Only the equal bucket's rows are visible.
    expect(
      within(equalBucket).getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(smallCount);
    expect(
      within(supersedeBucket).queryAllByTestId(
        "handwavy-preview-overlap-row",
      ),
    ).toHaveLength(0);
    // And the bulk label tracks the new mixed state.
    expect(bulkToggle).toHaveTextContent(/Expand all/i);
  });

  it("survives a rerender from null/empty overlaps to populated overlaps without hook-order errors", () => {
    // Regression: the bulk-toggle hook lives at the top of
    // `PreviewOverlapsBlock`, BEFORE the "no overlaps yet" early return.
    // The host page renders the block unconditionally and the dry-run
    // preview transitions `overlaps` from null → populated as the
    // request resolves, so the same component instance must be able to
    // mount with no overlaps and then re-render with overlaps without
    // tripping React's "Rendered more hooks than during the previous
    // render" runtime error.
    const { rerender } = render(
      <PreviewOverlapsBlock overlaps={null} candidate="anything" />,
    );
    expect(
      screen.queryByTestId("handwavy-preview-overlaps"),
    ).not.toBeInTheDocument();

    rerender(
      <PreviewOverlapsBlock
        overlaps={{ total: 0, matches: [] }}
        candidate="anything"
      />,
    );
    expect(
      screen.queryByTestId("handwavy-preview-overlaps"),
    ).not.toBeInTheDocument();

    const overlaps = makeOverlaps([
      ...makeBucketOfRelation(
        "existing-contains-candidate",
        PREVIEW_OVERLAP_BUCKET_COLLAPSE_THRESHOLD + 2,
      ),
      ...makeBucketOfRelation("equal", 2),
    ]);
    rerender(
      <PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />,
    );

    // The block now renders, the size-based default put the oversized
    // bucket into a collapsed state, and the bulk toggle is wired up
    // and clickable — proving hooks survived the null → populated
    // transition.
    expect(screen.getByTestId("handwavy-preview-overlaps")).toBeInTheDocument();
    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    expect(bulkToggle).toHaveTextContent(/Expand all/i);
    fireEvent.click(bulkToggle);
    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    for (const b of buckets) {
      expect(b).toHaveAttribute(
        "data-handwavy-overlap-bucket-collapsed",
        "false",
      );
    }
  });

  it("flips every bucket back open after a 'Collapse all' followed by 'Expand all'", () => {
    // Round-trip the bulk toggle: starts all-expanded → collapse all →
    // expand all. Confirms the second click reads the now-collapsed
    // state and uniformly re-opens every bucket (rather than stale
    // closure capturing the original state).
    const smallCount = 3;
    const overlaps = makeOverlaps([
      ...makeBucketOfRelation("equal", smallCount),
      ...makeBucketOfRelation("candidate-contains-existing", smallCount),
      ...makeBucketOfRelation("existing-contains-candidate", smallCount),
    ]);

    render(<PreviewOverlapsBlock overlaps={overlaps} candidate="anything" />);

    const bulkToggle = screen.getByTestId(
      "handwavy-preview-overlap-bulk-toggle",
    );
    fireEvent.click(bulkToggle); // Collapse all.
    fireEvent.click(bulkToggle); // Expand all again.

    const buckets = screen.getAllByTestId("handwavy-preview-overlap-bucket");
    expect(buckets).toHaveLength(3);
    for (const b of buckets) {
      expect(b).toHaveAttribute(
        "data-handwavy-overlap-bucket-collapsed",
        "false",
      );
    }
    expect(
      screen.getAllByTestId("handwavy-preview-overlap-row"),
    ).toHaveLength(smallCount * 3);
    expect(bulkToggle).toHaveTextContent(/Collapse all/i);
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
