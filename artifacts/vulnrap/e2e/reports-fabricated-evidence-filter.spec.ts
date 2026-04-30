import { test, expect, type Route } from "@playwright/test";

// Task #392 — End-to-end coverage for the reports-feed fabricated-evidence
// filter introduced in Task #279.
//
// The filter chip lets reviewers slice the public reports feed by AVRI
// Engine 2's fabricated-evidence flags (FAKE_RAW_HTTP, STRIPPED_CRASH_TRACE,
// or either). The server logic was verified manually with curl + a one-off
// DB row, but until now nothing exercised the dropdown menu, the per-chip
// dismiss, or the "Clear filters" reset against a real React render of the
// reports page.
//
// We can't seed a deterministic three-row corpus into the live api-server
// from here (it has its own DB row whose flags vary), so instead we
// intercept the `/api/reports/feed` route and respond with a fixed three-row
// fixture — one row for each fabricated-flag bucket plus a clean control
// row. The mock inspects the request's `fabricatedEvidence` query param and
// returns only the rows that match, mirroring the server-side JSONB
// predicate. That keeps the test hermetic (independent of whatever rows the
// dev/prod-build api-server happens to have at the moment) while still
// driving the real production-bundle React UI through useGetReportFeed,
// useSearchParams, and the dropdown/chip components.

type FeedRow = {
  id: number;
  reportCode: string;
  slopScore: number;
  slopTier: string;
  matchCount: number;
  contentMode: "full" | "similarity_only";
  createdAt: string;
  avriFamily: string | null;
  fakeRawHttp: boolean;
  strippedCrashTrace: boolean;
};

const FIXTURE_ROWS: FeedRow[] = [
  {
    id: 9001,
    reportCode: "RPT-FAB-FAKE",
    slopScore: 78,
    slopTier: "Likely Slop",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T10:00:00.000Z",
    avriFamily: "REQUEST_SMUGGLING",
    fakeRawHttp: true,
    strippedCrashTrace: false,
  },
  {
    id: 9002,
    reportCode: "RPT-FAB-STRIP",
    slopScore: 64,
    slopTier: "Questionable",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T11:00:00.000Z",
    avriFamily: "MEMORY_CORRUPTION",
    fakeRawHttp: false,
    strippedCrashTrace: true,
  },
  {
    id: 9003,
    reportCode: "RPT-FAB-CLEAN",
    slopScore: 18,
    slopTier: "Likely Human",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T12:00:00.000Z",
    avriFamily: "INJECTION",
    fakeRawHttp: false,
    strippedCrashTrace: false,
  },
];

function filterRows(rows: FeedRow[], fabricated: string | null): FeedRow[] {
  switch (fabricated) {
    case "fake_raw_http":
      return rows.filter((r) => r.fakeRawHttp);
    case "stripped_trace":
      return rows.filter((r) => r.strippedCrashTrace);
    case "either":
      return rows.filter((r) => r.fakeRawHttp || r.strippedCrashTrace);
    default:
      return rows;
  }
}

function buildFeedResponse(fabricated: string | null) {
  const visible = filterRows(FIXTURE_ROWS, fabricated);
  return {
    reports: visible,
    total: visible.length,
    hasMore: false,
    summary: {
      totalPublic: visible.length,
      avgScore:
        visible.length === 0
          ? 0
          : Math.round(
              (visible.reduce((acc, r) => acc + r.slopScore, 0) /
                visible.length) *
                10,
            ) / 10,
      tierCounts: visible.reduce<Record<string, number>>((acc, r) => {
        acc[r.slopTier] = (acc[r.slopTier] ?? 0) + 1;
        return acc;
      }, {}),
      familyCounts: visible.reduce<Record<string, number>>((acc, r) => {
        const key = r.avriFamily ?? "FLAT";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}

async function fulfillFeedRoute(route: Route) {
  const url = new URL(route.request().url());
  const fabricated = url.searchParams.get("fabricatedEvidence");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(buildFeedResponse(fabricated)),
  });
}

test.describe("Reports feed fabricated-evidence filter (Task #392)", () => {
  test("dropdown picks update the URL + chip + visible rows; chip dismiss and Clear filters both reset", async ({
    page,
  }) => {
    await page.route("**/api/reports/feed*", fulfillFeedRoute);

    await page.goto("/reports");

    const trigger = page.getByTestId("fabricated-evidence-trigger");
    await expect(trigger).toBeVisible();
    // Default state: all three fixture rows are visible, no chip, no
    // fabricatedEvidence in the URL, trigger label reads "All evidence".
    await expect(trigger).toHaveText(/All evidence/);
    await expect(page.getByTestId("fabricated-evidence-chip")).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has("fabricatedEvidence"));
    for (const row of FIXTURE_ROWS) {
      await expect(page.getByText(row.reportCode)).toBeVisible();
    }

    // --- Pick "Fake raw HTTP only" via the dropdown ---
    await trigger.click();
    await expect(page.getByTestId("fabricated-evidence-menu")).toBeVisible();
    await page.getByTestId("fabricated-evidence-option-fake_raw_http").click();
    await expect(page.getByTestId("fabricated-evidence-menu")).toHaveCount(0);

    // URL persists the new filter (so reviewers can bookmark/share it).
    await expect(page).toHaveURL((url) =>
      url.searchParams.get("fabricatedEvidence") === "fake_raw_http",
    );
    // The dismiss chip appears with the short label.
    const chip = page.getByTestId("fabricated-evidence-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Evidence:");
    await expect(chip).toContainText("Fake raw HTTP");
    // Trigger label now reads the short option label.
    await expect(trigger).toHaveText(/Fake raw HTTP/);
    // Only the fake-raw-HTTP row should be listed.
    await expect(page.getByText("RPT-FAB-FAKE")).toBeVisible();
    await expect(page.getByText("RPT-FAB-STRIP")).toHaveCount(0);
    await expect(page.getByText("RPT-FAB-CLEAN")).toHaveCount(0);
    // The FAKE_RAW_HTTP row badge is the visual companion to the filter; it
    // must remain visible so reviewers see why the row matched.
    await expect(page.getByTestId("badge-fake-raw-http")).toBeVisible();

    // --- Switch to "Stripped crash trace only" ---
    await trigger.click();
    await page.getByTestId("fabricated-evidence-option-stripped_trace").click();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get("fabricatedEvidence") === "stripped_trace",
    );
    await expect(chip).toContainText("Stripped trace");
    await expect(page.getByText("RPT-FAB-STRIP")).toBeVisible();
    await expect(page.getByText("RPT-FAB-FAKE")).toHaveCount(0);
    await expect(page.getByText("RPT-FAB-CLEAN")).toHaveCount(0);
    await expect(page.getByTestId("badge-stripped-crash-trace")).toBeVisible();

    // --- Switch to "Either fabricated flag" ---
    await trigger.click();
    await page.getByTestId("fabricated-evidence-option-either").click();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get("fabricatedEvidence") === "either",
    );
    await expect(chip).toContainText("Either flag");
    await expect(page.getByText("RPT-FAB-FAKE")).toBeVisible();
    await expect(page.getByText("RPT-FAB-STRIP")).toBeVisible();
    await expect(page.getByText("RPT-FAB-CLEAN")).toHaveCount(0);

    // --- Per-chip dismiss resets the filter back to "All" ---
    await chip.click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("fabricatedEvidence"));
    await expect(page.getByTestId("fabricated-evidence-chip")).toHaveCount(0);
    await expect(trigger).toHaveText(/All evidence/);
    for (const row of FIXTURE_ROWS) {
      await expect(page.getByText(row.reportCode)).toBeVisible();
    }

    // --- Re-apply a filter, then exercise the global "Clear filters" reset ---
    await trigger.click();
    await page.getByTestId("fabricated-evidence-option-fake_raw_http").click();
    await expect(page).toHaveURL((url) =>
      url.searchParams.get("fabricatedEvidence") === "fake_raw_http",
    );
    await expect(page.getByTestId("fabricated-evidence-chip")).toBeVisible();

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("fabricatedEvidence"));
    await expect(page.getByTestId("fabricated-evidence-chip")).toHaveCount(0);
    await expect(trigger).toHaveText(/All evidence/);
    await expect(
      page.getByRole("button", { name: "Clear filters" }),
    ).toHaveCount(0);
  });
});
