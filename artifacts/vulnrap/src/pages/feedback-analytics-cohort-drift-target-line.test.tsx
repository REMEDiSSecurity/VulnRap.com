// Task #520 — render coverage for the dashed `gapTarget` reference line and
// the red breach markers that Task #370 wired into the T1−T3 gap sparkline
// inside `DatasetCohortDriftSection`. The pure summarisation helper
// (`summarizeDatasetHistory`) already has unit coverage in
// feedback-analytics.test.tsx, but nothing pinned the actual rendered
// behaviour: that the section mounts against a live `/api/test/dataset-history`
// + `/api/test/run` pair, draws the dashed reference line at the calibration
// target, and red-flags points that fall below it. A future refactor of the
// sparkline could quietly drop the line and reviewers would lose the at-a-
// glance breach signal — these tests are the safety net that catches that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatasetCohortDriftSection } from "./feedback-analytics";

// Three timestamps so the gap sparkline renders the SVG path (a single
// gap point falls back to an italic span and never draws the dashed
// reference line). Cohort rows are deliberately minimal — the component
// only needs the per-tier compositeMean to render the per-tier tiles
// alongside the gap sparkline; what we actually care about pinning is
// the gap series.
const T1 = "2026-04-27T10:00:00.000Z";
const T2 = "2026-04-28T10:00:00.000Z";
const T3 = "2026-04-29T10:00:00.000Z";

const GAP_TARGET = 15;

// Build a /api/test/dataset-history payload with three runs, one row per
// cohort per run. The middle run sits at gap=10 (below target) and the
// remaining two sit comfortably above, so we get exactly one non-latest
// breach point regardless of which run lands at the right edge.
function buildDatasetHistoryResponse(args: {
  gapsByRunInChronologicalOrder: [number, number, number];
}): unknown {
  const [g1, g2, g3] = args.gapsByRunInChronologicalOrder;
  function runRows(timestamp: string, gap: number, t1Mean: number, t3Mean: number) {
    return [
      { timestamp, tier: "T1_LEGIT", label: "Legit", count: 25, compositeMean: t1Mean, gap },
      { timestamp, tier: "T2_BORDERLINE", label: "Borderline", count: 25, compositeMean: 50, gap },
      { timestamp, tier: "T3_SLOP", label: "Slop", count: 25, compositeMean: t3Mean, gap },
    ];
  }
  const rowsByTier = new Map<string, ReturnType<typeof runRows>[number][]>([
    ["T1_LEGIT", []],
    ["T2_BORDERLINE", []],
    ["T3_SLOP", []],
  ]);
  // T1/T3 means are picked so (t1 − t3) === gap, matching how /api/test/run
  // would persist things in real life (keeps the data internally consistent
  // even though the gap sparkline only reads the gap field).
  for (const [ts, gap] of [[T1, g1], [T2, g2], [T3, g3]] as const) {
    for (const row of runRows(ts, gap, 60, 60 - gap)) {
      rowsByTier.get(row.tier)!.push(row);
    }
  }
  return {
    totalSnapshots: rowsByTier.get("T1_LEGIT")!.length * 3,
    cohorts: Array.from(rowsByTier.entries()).map(([tier, snapshots]) => ({
      tier,
      snapshots,
    })),
  };
}

// Minimal /api/test/run payload — only the fields the section reads off
// `datasetSamples` matter (`available` + `gapTarget`). When `available` is
// false the section should hide the dashed reference line entirely.
function buildTestRunResponse(args: { available: boolean }): unknown {
  if (!args.available) {
    return {
      archetypes: [],
      summary: [],
      datasetSamples: { available: false },
    };
  }
  return {
    archetypes: [],
    summary: [],
    datasetSamples: {
      available: true,
      sourcePath: "/mnt/vulnrap/data/vuln_reports_dataset_v2.json.gz",
      sampleDateKey: "2026-04-29",
      sampleSizeRequestedPerLabel: 25,
      sampleCount: 75,
      legitMean: 80,
      slopMean: 20,
      gap: 60,
      gapTarget: GAP_TARGET,
      gapMeetsTarget: true,
      cohorts: [],
      samples: [],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(args: {
  history: unknown;
  testRun: unknown;
}): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    // Order matters: the dataset-history config endpoint shares the
    // /api/test/dataset-history prefix, so check the more specific URL
    // first to avoid accidentally returning the trend response from the
    // config query.
    if (url.includes("/api/test/dataset-history/config")) {
      return jsonResponse({}, 404);
    }
    if (url.includes("/api/test/dataset-history")) {
      return jsonResponse(args.history);
    }
    if (url.includes("/api/test/run")) {
      return jsonResponse(args.testRun);
    }
    // Anything else gets a benign empty body so a missed mock doesn't
    // throw an unhandled rejection in the test.
    return jsonResponse({});
  });
  return spy;
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/feedback-analytics"]}>
        <DatasetCohortDriftSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DatasetCohortDriftSection — gap target line + breach markers (Task #520)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it("renders the dashed gapTarget reference line and a red breach marker for a non-latest below-target gap point", async () => {
    // Run 1: gap=20 (above), Run 2: gap=10 (below — breach), Run 3: gap=18 (above, latest).
    // Latest is above target so `dataset-cohort-drift-latest-gap-breach`
    // must NOT appear, but the middle run produces a non-latest breach
    // point that must carry `dataset-cohort-drift-gap-breach-point`.
    fetchSpy = installFetchMock({
      history: buildDatasetHistoryResponse({
        gapsByRunInChronologicalOrder: [20, 10, 18],
      }),
      testRun: buildTestRunResponse({ available: true }),
    });

    renderSection();

    // The gap tile only mounts after the dataset-history query resolves,
    // so wait for the section header rather than the tile (the section
    // itself is what un-skeletons first).
    await screen.findByTestId("dataset-cohort-drift-section");

    // Dashed reference line must be rendered at the calibration target.
    const targetLine = await screen.findByTestId(
      "dataset-cohort-drift-gap-target-line",
    );
    expect(targetLine).toBeInTheDocument();
    // Pin the dashed-stroke attributes so a refactor that switches to a
    // solid line (which would visually disappear into the polyline) is
    // caught here. `strokeDasharray` is what makes the line read as a
    // threshold rather than data.
    expect(targetLine.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(targetLine.tagName.toLowerCase()).toBe("line");

    // Header chip must call out the calibration target so reviewers
    // know what the dashed line represents without hovering.
    const chip = screen.getByTestId("dataset-cohort-drift-gap-target-chip");
    expect(chip).toHaveTextContent(`target ≥${GAP_TARGET}`);

    // Exactly one non-latest breach marker (the middle run at gap=10).
    // The latest point is above target so its data-testid is undefined
    // and it must NOT show up here.
    const breachMarkers = screen.getAllByTestId(
      "dataset-cohort-drift-gap-breach-point",
    );
    expect(breachMarkers).toHaveLength(1);
    expect(breachMarkers[0]!.tagName.toLowerCase()).toBe("circle");
    // And the latest-gap-breach text-id must be absent (latest is above).
    expect(
      screen.queryByTestId("dataset-cohort-drift-latest-gap-breach"),
    ).toBeNull();
  });

  it("flags the latest gap with the breach test-id when the most recent snapshot falls below the target", async () => {
    // Run 1: gap=20 (above), Run 2: gap=18 (above), Run 3: gap=8 (below — latest).
    // The latest point is the breach this time, so the latest-gap text
    // node must carry the `latest-gap-breach` test-id AND the latest
    // marker on the sparkline must use the breach-point test-id (the
    // sparkline reuses the same id for the latest dot when flagged).
    fetchSpy = installFetchMock({
      history: buildDatasetHistoryResponse({
        gapsByRunInChronologicalOrder: [20, 18, 8],
      }),
      testRun: buildTestRunResponse({ available: true }),
    });

    renderSection();

    await screen.findByTestId("dataset-cohort-drift-section");

    // Reference line still drawn.
    expect(
      await screen.findByTestId("dataset-cohort-drift-gap-target-line"),
    ).toBeInTheDocument();

    // Latest-gap text node carries the breach test-id and shows the
    // below-target value.
    const latestGap = screen.getByTestId(
      "dataset-cohort-drift-latest-gap-breach",
    );
    expect(latestGap).toHaveTextContent("8.0");

    // The sparkline's latest dot reuses the same `gap-breach-point` id
    // when it falls below target. With three points (none of the prior
    // two below target), exactly one breach marker is rendered: the
    // latest one.
    const breachMarkers = screen.getAllByTestId(
      "dataset-cohort-drift-gap-breach-point",
    );
    expect(breachMarkers).toHaveLength(1);
  });

  it("renders cleanly without the target overlay when /api/test/run reports datasetSamples.available === false", async () => {
    // No calibration target available — the section must still render
    // (the dataset-history endpoint succeeded), the gap sparkline must
    // still mount, but the dashed reference line, the target chip, and
    // the latest-gap-breach test-id must all be absent. Crucially this
    // exercises the `gapTarget == null` branch end-to-end so a future
    // refactor that crashes on `available: false` is caught here.
    fetchSpy = installFetchMock({
      history: buildDatasetHistoryResponse({
        // Pick gaps that would have been below the usual 15pt target so
        // a regression that defaults `gapTarget` to a hard-coded number
        // (instead of honouring `available: false`) would still light
        // up the breach markers and trip this test.
        gapsByRunInChronologicalOrder: [10, 8, 12],
      }),
      testRun: buildTestRunResponse({ available: false }),
    });

    renderSection();

    // Section + gap tile mount as normal.
    await screen.findByTestId("dataset-cohort-drift-section");
    expect(
      await screen.findByTestId("dataset-cohort-drift-tier-gap"),
    ).toBeInTheDocument();

    // No target overlay — neither the dashed line nor the header chip
    // should appear.
    expect(
      screen.queryByTestId("dataset-cohort-drift-gap-target-line"),
    ).toBeNull();
    expect(
      screen.queryByTestId("dataset-cohort-drift-gap-target-chip"),
    ).toBeNull();

    // And nothing should be flagged as a breach (no target → no
    // breach concept), which guards the `gapTarget != null && …`
    // gating on both the latest-gap text node and the per-point
    // breach markers.
    expect(
      screen.queryByTestId("dataset-cohort-drift-latest-gap-breach"),
    ).toBeNull();
    expect(
      screen.queryAllByTestId("dataset-cohort-drift-gap-breach-point"),
    ).toHaveLength(0);
  });
});
