// Task #516 — render coverage for the per-tier delta sparklines that
// Task #362 added inside each Curated Dataset Cohort Means tile.
//
// The pure helper (`summarizeDatasetHistory` → `deltaPoints`) and the
// standalone component (`DatasetCohortFixtureDeltaSparkline`) already
// have unit coverage, but nothing pinned the higher-level wiring:
// that mounting `DatasetCohortMeansSection` against fake `/api/test/run`
// + `/api/test/dataset-history` responses actually renders a sparkline
// inside each `dataset-cohort-tile-T1_LEGIT` / `-T2_BORDERLINE` /
// `-T3_SLOP` tile, that the per-tile current-point colour reflects the
// tier's `isDivergent` state (orange vs muted), and that an empty
// per-tier history falls back to the "no delta history" hint without
// dropping the trend slot. Without this, regressions like the history
// fetch silently failing, the per-tier `deltaPointsByTier` lookup
// breaking, or the tile no longer passing `isDivergent` through to
// the sparkline would slip past `pnpm vitest`.
//
// Sibling file (rather than appending to feedback-analytics.test.tsx)
// so the multi-fetch fixture stays localised — mirrors the layout
// chosen for feedback-analytics-cohort-samples.test.tsx alongside
// feedback-analytics-preview-overlap-refresh.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatasetCohortMeansSection } from "./feedback-analytics";

// /api/test/run payload. Tier means picked so the per-tile delta lands
// in three distinct buckets:
//   T1_LEGIT      dsMean 80, fxMean 80 → Δ  0   (calm)
//   T2_BORDERLINE dsMean 50, fxMean 38 → Δ+12   (divergent at default 5pt warn)
//   T3_SLOP       dsMean 20, fxMean 20 → Δ  0   (calm, but no history → empty fallback)
const TEST_RUN_RESPONSE = {
  archetypes: [],
  summary: [
    { tier: "T1_LEGIT", count: 10, compositeMean: 80 },
    { tier: "T2_BORDERLINE", count: 10, compositeMean: 38 },
    { tier: "T3_SLOP", count: 10, compositeMean: 20 },
  ],
  datasetSamples: {
    available: true,
    sourcePath: "/mnt/vulnrap/data/vuln_reports_dataset_v2.json.gz",
    sampleDateKey: "2026-04-29",
    sampleSizeRequestedPerLabel: 25,
    sampleCount: 30,
    legitMean: 80,
    slopMean: 20,
    gap: 60,
    gapTarget: 15,
    gapMeetsTarget: true,
    cohorts: [
      {
        tier: "T1_LEGIT",
        label: "Legit",
        count: 10,
        compositeMean: 80,
        compositeMin: 70,
        compositeMax: 90,
        engine2Mean: 78,
      },
      {
        tier: "T2_BORDERLINE",
        label: "Borderline",
        count: 10,
        compositeMean: 50,
        compositeMin: 40,
        compositeMax: 60,
        engine2Mean: 49,
      },
      {
        tier: "T3_SLOP",
        label: "Slop",
        count: 10,
        compositeMean: 20,
        compositeMin: 10,
        compositeMax: 30,
        engine2Mean: 22,
      },
    ],
    samples: [],
  },
};

// /api/test/dataset-history payload. Three runs of T1/T2 history so the
// per-tier delta series has ≥2 points and the sparkline renders the SVG
// (single-point / zero-point series fall back to italic hints instead).
// T3 is intentionally seeded with zero snapshots so the per-tile
// sparkline lands on the "no delta history" empty fallback — the third
// path the task asks us to pin.
const DATASET_HISTORY_RESPONSE = {
  totalSnapshots: 6,
  cohorts: [
    {
      tier: "T1_LEGIT",
      snapshots: [
        {
          timestamp: "2026-04-25T00:00:00.000Z",
          tier: "T1_LEGIT",
          label: "Legit",
          count: 10,
          compositeMean: 79,
          fixtureMean: 79,
          gap: 60,
        },
        {
          timestamp: "2026-04-26T00:00:00.000Z",
          tier: "T1_LEGIT",
          label: "Legit",
          count: 10,
          compositeMean: 80,
          fixtureMean: 79,
          gap: 60,
        },
        {
          timestamp: "2026-04-27T00:00:00.000Z",
          tier: "T1_LEGIT",
          label: "Legit",
          count: 10,
          compositeMean: 80,
          fixtureMean: 80,
          gap: 60,
        },
      ],
    },
    {
      tier: "T2_BORDERLINE",
      snapshots: [
        {
          timestamp: "2026-04-25T00:00:00.000Z",
          tier: "T2_BORDERLINE",
          label: "Borderline",
          count: 10,
          compositeMean: 48,
          fixtureMean: 45,
          gap: 60,
        },
        {
          timestamp: "2026-04-26T00:00:00.000Z",
          tier: "T2_BORDERLINE",
          label: "Borderline",
          count: 10,
          compositeMean: 50,
          fixtureMean: 42,
          gap: 60,
        },
        {
          timestamp: "2026-04-27T00:00:00.000Z",
          tier: "T2_BORDERLINE",
          label: "Borderline",
          count: 10,
          compositeMean: 50,
          fixtureMean: 38,
          gap: 60,
        },
      ],
    },
    // No T3_SLOP snapshots — exercises the empty-history fallback.
    { tier: "T3_SLOP", snapshots: [] },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    // Order the dataset-history check before /run so a future rename
    // that nests the latter inside the former still hits the right
    // handler.
    if (url.includes("/api/test/dataset-history")) {
      return jsonResponse(DATASET_HISTORY_RESPONSE);
    }
    if (url.includes("/api/test/run")) {
      return jsonResponse(TEST_RUN_RESPONSE);
    }
    // Anything else (report feed, scoring config, ...) gets a benign
    // empty body so a missed mock doesn't surface as an unhandled
    // rejection.
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
        <DatasetCohortMeansSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DatasetCohortMeansSection per-tier delta sparkline (Task #516)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("renders a delta sparkline inside each cohort tile, colours the latest point per the tier's isDivergent state, and falls back to 'no delta history' when the per-tier series is empty", async () => {
    renderSection();

    // Wait for the section to finish loading and surface all three tiles.
    // The trend container is rendered unconditionally inside each tile,
    // so finding it on T1 is a reliable signal that the live + history
    // fetches both resolved.
    const t1Trend = await screen.findByTestId(
      "dataset-cohort-fixture-delta-trend-T1_LEGIT",
      {},
      { timeout: 5_000 },
    );
    const t2Trend = screen.getByTestId(
      "dataset-cohort-fixture-delta-trend-T2_BORDERLINE",
    );
    const t3Trend = screen.getByTestId(
      "dataset-cohort-fixture-delta-trend-T3_SLOP",
    );

    // Each trend slot lives INSIDE its own cohort tile button — pin
    // the containment so a refactor that hoists the sparkline grid
    // out of the per-tile button (and accidentally drops the per-tier
    // wiring) trips this test.
    const t1Tile = screen.getByTestId("dataset-cohort-tile-T1_LEGIT");
    const t2Tile = screen.getByTestId("dataset-cohort-tile-T2_BORDERLINE");
    const t3Tile = screen.getByTestId("dataset-cohort-tile-T3_SLOP");
    expect(t1Tile).toContainElement(t1Trend);
    expect(t2Tile).toContainElement(t2Trend);
    expect(t3Tile).toContainElement(t3Trend);

    // T1 — calm path: dsMean 80, fxMean 80 → Δ 0, isDivergent=false.
    // Three history points with finite fixtureMean → the sparkline
    // renders the SVG, and the latest-point circle should pick up the
    // muted (slate) treatment rather than the orange divergent fill.
    const t1Sparkline = within(t1Trend).getByTestId(
      "dataset-cohort-fixture-delta-sparkline",
    );
    const t1Circle = t1Sparkline.querySelector("circle");
    expect(t1Circle).not.toBeNull();
    expect(t1Circle).toHaveAttribute("fill", "rgba(148,163,184,0.8)");

    // T2 — divergent path: dsMean 50, fxMean 38 → Δ+12 (>5pt default
    // warn), isDivergent=true. Same three-point history shape so the
    // SVG renders, but the latest-point circle should be the orange
    // (#fb923c) divergent fill that mirrors the per-tile numeric Δ
    // colour. This is the assertion that pins the `isDivergent`
    // hand-off from the tile down into the sparkline.
    const t2Sparkline = within(t2Trend).getByTestId(
      "dataset-cohort-fixture-delta-sparkline",
    );
    const t2Circle = t2Sparkline.querySelector("circle");
    expect(t2Circle).not.toBeNull();
    expect(t2Circle).toHaveAttribute("fill", "#fb923c");

    // T3 — empty-history fallback: zero snapshots in the
    // /api/test/dataset-history response → deltaPoints is empty →
    // the sparkline component renders the "no delta history" italic
    // hint instead of an SVG. Confirms the per-tier point lookup
    // didn't accidentally fall back to one of the populated tiers
    // (which would surface a sparkline SVG here too).
    expect(
      within(t3Trend).getByTestId(
        "dataset-cohort-fixture-delta-sparkline-empty",
      ),
    ).toHaveTextContent("no delta history");
    expect(
      within(t3Trend).queryByTestId("dataset-cohort-fixture-delta-sparkline"),
    ).toBeNull();

    // Sanity: both endpoints actually fired. A regression that skipped
    // the history fetch entirely (or coalesced it into the run query)
    // would otherwise still make the empty T3 assertion pass — but for
    // the wrong reason.
    const calls = fetchSpy.mock.calls.map(([input]: [unknown]) =>
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url,
    );
    expect(calls.some((u: string) => u.includes("/api/test/run"))).toBe(true);
    expect(
      calls.some((u: string) => u.includes("/api/test/dataset-history")),
    ).toBe(true);
  });
});
