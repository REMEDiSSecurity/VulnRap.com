// Task #372 — render coverage for the per-cohort sample drill-down table
// that Task #255 added to the calibration dashboard. The pure sort helper
// (`sortDatasetSamplesByDistanceFromMean`) already has unit coverage, but
// nothing pinned the actual rendered behaviour: that clicking a tile
// expands its sample table, that the rows surface in descending |Δ| from
// the cohort mean (so outliers come first), and that the triage column
// gets the colour-coded badge. A future refactor that quietly broke any
// of those would otherwise slip past `pnpm vitest`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DatasetCohortMeansSection } from "./feedback-analytics";

// Minimal /api/test/run payload: three cohorts (T1/T2/T3) plus a bag of
// sample rows. The T2_BORDERLINE cohort is the focus — its three samples
// are intentionally arranged so descending |Δ| ≠ upstream order, so a
// regression that drops the sort would land them in fixture order
// instead of outlier-first.
const T2_COHORT_MEAN = 50;
const TEST_RUN_RESPONSE = {
  archetypes: [],
  summary: [],
  datasetSamples: {
    available: true,
    sourcePath: "/mnt/vulnrap/data/vuln_reports_dataset_v2.json.gz",
    sampleDateKey: "2026-04-29",
    sampleSizeRequestedPerLabel: 25,
    sampleCount: 3,
    legitMean: 80,
    slopMean: 20,
    gap: 60,
    gapTarget: 15,
    gapMeetsTarget: true,
    cohorts: [
      {
        tier: "T1_LEGIT",
        label: "Legit",
        count: 0,
        compositeMean: null,
        compositeMin: null,
        compositeMax: null,
        engine2Mean: null,
      },
      {
        tier: "T2_BORDERLINE",
        label: "Borderline",
        count: 3,
        compositeMean: T2_COHORT_MEAN,
        compositeMin: 40,
        compositeMax: 80,
        engine2Mean: 50,
      },
      {
        tier: "T3_SLOP",
        label: "Slop",
        count: 0,
        compositeMean: null,
        compositeMin: null,
        compositeMax: null,
        engine2Mean: null,
      },
    ],
    // Order here is deliberately mid / near / far so the rendered table
    // can only end up far → mid → near if the sort actually ran.
    samples: [
      {
        id: "report-mid",
        label: "Borderline",
        tier: "T2_BORDERLINE",
        composite: 40,
        e1: 41,
        e2: 39,
        e3: 40,
        triage: "MANUAL_REVIEW",
      },
      {
        id: "report-near",
        label: "Borderline",
        tier: "T2_BORDERLINE",
        composite: 52,
        e1: 53,
        e2: 51,
        e3: 52,
        triage: "AUTO_CLOSE",
      },
      {
        id: "report-far",
        label: "Borderline",
        tier: "T2_BORDERLINE",
        composite: 80,
        e1: 79,
        e2: 81,
        e3: 80,
        triage: "PRIORITIZE",
      },
    ],
  },
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
    if (url.includes("/api/test/run")) {
      return jsonResponse(TEST_RUN_RESPONSE);
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
        <DatasetCohortMeansSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DatasetCohortSampleTable render (Task #372 — drill-down on cohort tiles)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // happy-dom doesn't ship localStorage by default, but the section
    // pokes window.localStorage when the warn-threshold defaults change.
    // It already guards with try/catch, so no extra setup is needed.
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("starts collapsed, expands on tile click, and renders sample rows in descending |Δ from cohort mean| order with triage colour badges", async () => {
    fetchSpy = installFetchMock();

    renderSection();

    // Wait for the section to finish loading and render the T2 tile.
    const tile = await screen.findByTestId(
      "dataset-cohort-tile-T2_BORDERLINE",
      {},
      { timeout: 5_000 },
    );
    expect(tile).toHaveAttribute("aria-expanded", "false");

    // Sanity: the expanded sample table is NOT in the DOM yet — only the
    // tile grid. We'd otherwise be testing the click as a no-op.
    expect(
      document.getElementById("dataset-cohort-samples-T2_BORDERLINE"),
    ).toBeNull();

    // Click the tile to reveal the sample table for the T2 cohort.
    await act(async () => {
      tile.click();
    });

    expect(tile).toHaveAttribute("aria-expanded", "true");
    const drilldown = document.getElementById(
      "dataset-cohort-samples-T2_BORDERLINE",
    );
    expect(drilldown).not.toBeNull();

    // The drill-down table should render exactly the three T2 samples
    // (the T1/T3 cohort tiles are also in the DOM, but their drill-downs
    // are not expanded so their rows must not leak into this table).
    const table = within(drilldown!).getByRole("table");
    const bodyRows = within(table).getAllByRole("row").slice(1); // drop <thead>
    expect(bodyRows).toHaveLength(3);

    // Rows must be in descending |Δ| from the cohort mean (50):
    //   report-far  composite 80 → |Δ|=30
    //   report-mid  composite 40 → |Δ|=10
    //   report-near composite 52 → |Δ|=2
    // The first <td> per row holds the report id, so reading the id
    // column gives a stable check on the order.
    const ids = bodyRows.map(
      (row) => within(row).getAllByRole("cell")[0].textContent?.trim(),
    );
    expect(ids).toEqual(["report-far", "report-mid", "report-near"]);

    // Δ-mean column (3rd cell) — sign + magnitude, formatted by the
    // table itself. Pin the formatting so a regression in the helper
    // (e.g. dropping the explicit + sign on positives, or losing the
    // unicode minus) trips the test.
    const deltaCells = bodyRows.map((row) =>
      within(row).getAllByRole("cell")[2].textContent?.trim(),
    );
    expect(deltaCells).toEqual(["+30.0", "−10.0", "+2.0"]);

    // Triage badge — last cell. Each row's badge text is the triage
    // action; the colour-coded class comes from DATASET_SAMPLE_TRIAGE_COLOR
    // in feedback-analytics.tsx. Check both the text and a representative
    // class fragment so a future palette tweak is at least localised, but
    // a missing colour mapping (which would fall through to the muted
    // default) gets caught.
    const triageBadges = bodyRows.map((row) => {
      const cells = within(row).getAllByRole("cell");
      return cells[cells.length - 1].querySelector("[class]");
    });
    expect(triageBadges[0]).not.toBeNull();
    expect(triageBadges[0]).toHaveTextContent("PRIORITIZE");
    expect(triageBadges[0]?.className).toMatch(/text-red-400/);
    expect(triageBadges[1]).toHaveTextContent("MANUAL_REVIEW");
    expect(triageBadges[1]?.className).toMatch(/text-yellow-400/);
    expect(triageBadges[2]).toHaveTextContent("AUTO_CLOSE");
    expect(triageBadges[2]?.className).toMatch(/text-muted-foreground/);

    // Toggling the same tile again collapses the drill-down — guards
    // against a regression that wires the click as "always expand".
    await act(async () => {
      tile.click();
    });
    expect(tile).toHaveAttribute("aria-expanded", "false");
    expect(
      document.getElementById("dataset-cohort-samples-T2_BORDERLINE"),
    ).toBeNull();
  });
});
