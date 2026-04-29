import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  HandwavyPhraseDryRunOverlaps,
  HandwavyPhraseDryRunOverlapsMatchesItem,
} from "@workspace/api-client-react";
import {
  PreviewOverlapsBlock,
  describeOverlapRelation,
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
