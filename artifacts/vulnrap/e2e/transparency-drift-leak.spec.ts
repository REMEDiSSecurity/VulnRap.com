import { test, expect } from "@playwright/test";

const STUBBED_DRIFT_SUMMARY = {
  generatedAt: "2026-05-04T12:00:00.000Z",
  weeks: [
    { weekStart: "2026-04-07", spread: 52.3 },
    { weekStart: "2026-04-14", spread: 53.1 },
    { weekStart: "2026-04-21", spread: 51.8 },
    { weekStart: "2026-04-28", spread: 54.2 },
  ],
  currentSpread: 54.2,
  previousSpread: 51.8,
  delta: 2.4,
  hasCurrentWeek: true,
};

const REVIEWER_ONLY_FIELD_NAMES = [
  "perFamily",
  "bucketingNote",
  "runbookPath",
  "totalReportsScanned",
  "gapWarn",
  "familyShiftWarn",
  "minBucketSize",
  "gapEligible",
  "reportCount",
  "GAP_BELOW_45",
  "FAMILY_MEAN_SHIFT",
];

const REVIEWER_ONLY_SENTINEL_STRINGS = [
  "avri-drift-runbook",
  "docs/avri-drift-runbook.md",
  "avri_on_only",
  "AUTO_CLOSE-equivalent",
  "PRIORITIZE-equivalent",
];

test.describe("Transparency page — no reviewer-only drift field leakage (Task #943)", () => {
  test("rendered DOM contains none of the reviewer-only field names or sentinel strings", async ({
    page,
  }) => {
    await page.route("**/api/public/drift-summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(STUBBED_DRIFT_SUMMARY),
      });
    });

    const blockedRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (
        url.includes("/api/feedback/calibration/avri-drift")
      ) {
        blockedRequests.push(url);
      }
    });

    await page.goto("/transparency", { waitUntil: "networkidle" });

    const driftWidget = page.getByTestId("card-transparency-drift-widget");
    await expect(driftWidget).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByTestId("populated-drift-widget"),
    ).toBeVisible({ timeout: 10_000 });

    const bodyText = await page.locator("body").innerText();

    for (const field of REVIEWER_ONLY_FIELD_NAMES) {
      expect(
        bodyText,
        `reviewer-only field name "${field}" must not appear in the rendered page`,
      ).not.toContain(field);
    }

    for (const sentinel of REVIEWER_ONLY_SENTINEL_STRINGS) {
      expect(
        bodyText,
        `reviewer-only sentinel string "${sentinel}" must not appear in the rendered page`,
      ).not.toContain(sentinel);
    }

    expect(
      blockedRequests,
      "the transparency page must not request any /api/feedback/calibration/avri-drift* endpoint",
    ).toHaveLength(0);
  });

  test("page works with empty drift data and still leaks nothing", async ({
    page,
  }) => {
    await page.route("**/api/public/drift-summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generatedAt: "2026-05-04T12:00:00.000Z",
          weeks: [],
          currentSpread: null,
          previousSpread: null,
          delta: null,
          hasCurrentWeek: false,
        }),
      });
    });

    const blockedRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/feedback/calibration/avri-drift")) {
        blockedRequests.push(url);
      }
    });

    await page.goto("/transparency", { waitUntil: "networkidle" });

    const driftWidget = page.getByTestId("card-transparency-drift-widget");
    await expect(driftWidget).toBeVisible({ timeout: 15_000 });

    const bodyText = await page.locator("body").innerText();

    for (const field of REVIEWER_ONLY_FIELD_NAMES) {
      expect(
        bodyText,
        `reviewer-only field name "${field}" must not appear in the rendered page (empty state)`,
      ).not.toContain(field);
    }

    for (const sentinel of REVIEWER_ONLY_SENTINEL_STRINGS) {
      expect(
        bodyText,
        `reviewer-only sentinel string "${sentinel}" must not appear in the rendered page (empty state)`,
      ).not.toContain(sentinel);
    }

    expect(
      blockedRequests,
      "the transparency page must not request any /api/feedback/calibration/avri-drift* endpoint (empty state)",
    ).toHaveLength(0);
  });
});
