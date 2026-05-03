import { test, expect } from "@playwright/test";

// Task #404 — UI coverage for the Task #289 "Recent rollups: 0, 0, 14,
// 0, 8" cadence line on the calibration dashboard.
//
// Same harness pattern as last-compacted-indicator.spec.ts: the api-
// server's /api/test/* surface 404s under NODE_ENV=production (which
// the playwright webServer runs against, mirroring the deployed env),
// so we mock the three endpoints EmergingArchetypesSection consumes
// with page.route() rather than flipping the shared api-server out of
// production mode. Backend behaviour for the recentRuns ring buffer is
// already covered by archetype-history-stats unit tests; this spec
// guards the UI render path.

const COMPACTED_AT = new Date(Date.now() - 30 * 60 * 1000).toISOString();

// One-fixture TestRunResponse keeps the section visible — its early
// return triggers when archetypes is empty.
async function stubTestRun(page: import("@playwright/test").Page) {
  await page.route("**/api/test/run", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        archetypes: [
          {
            archetype: "task404-fixture-archetype",
            count: 1,
            avriOnMean: 60,
            avriOnMax: 60,
            minDistanceToCeiling: 25,
            ceiling: 35,
            fixtures: [
              {
                id: "task404-fixture",
                tier: "T2_BORDERLINE",
                composite: 60,
                avriOnScore: 60,
                avriOffScore: 55,
                distanceToCeiling: 25,
                triage: "review",
                passed: true,
              },
            ],
          },
        ],
      }),
    });
  });

  await page.route("**/api/test/archetype-history", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ totalSnapshots: 0, archetypes: [] }),
    });
  });
}

interface CompactionRun {
  at: string;
  removed: number;
}

async function stubConfig(
  page: import("@playwright/test").Page,
  recentRuns: CompactionRun[] | null,
) {
  await page.route("**/api/test/archetype-history/config", async (route) => {
    const lastCompaction =
      recentRuns && recentRuns.length > 0
        ? {
            lastCompactedAt: recentRuns[recentRuns.length - 1].at,
            lastRemovedCount: recentRuns[recentRuns.length - 1].removed,
            recentRuns,
          }
        : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        effectiveDays: 30,
        source: "default",
        envOverride: null,
        persistedDays: null,
        defaultDays: 30,
        min: 7,
        max: 365,
        lastCompaction,
        historyFile: null,
      }),
    });
  });
}

test.describe("EmergingArchetypesSection — Recent rollups cadence (Task #289)", () => {
  test("renders Recent rollups line with comma-separated removed counts in oldest -> newest order", async ({
    page,
  }) => {
    // Five entries — non-symmetric values let an oldest/newest flip
    // surface as "8, 0, 14, 0, 0" instead of the asserted ordering.
    const recentRuns: CompactionRun[] = [
      {
        at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        removed: 0,
      },
      {
        at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        removed: 0,
      },
      {
        at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        removed: 14,
      },
      {
        at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        removed: 0,
      },
      {
        at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        removed: 8,
      },
    ];

    await stubTestRun(page);
    await stubConfig(page, recentRuns);

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    await expect(page.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });

    // Anchor on the stable `title` attribute; disambiguates the span
    // from any sibling and is independent of Tailwind class churn.
    const recentRollupsLine = page.locator(
      `span[title="Removed counts from the last ${recentRuns.length} compaction passes (oldest first)."]`,
    );
    await expect(recentRollupsLine).toBeVisible({ timeout: 15_000 });
    await expect(recentRollupsLine).toHaveText(
      `Recent rollups: ${recentRuns.map((r) => r.removed).join(", ")}`,
    );
  });

  test("hides the Recent rollups line when only one compaction pass has been recorded", async ({
    page,
  }) => {
    const recentRuns: CompactionRun[] = [{ at: COMPACTED_AT, removed: 14 }];

    await stubTestRun(page);
    await stubConfig(page, recentRuns);

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    // Wait for the section + sibling "Last compacted" line so the
    // negative assertion isn't vacuous against a still-pending fetch.
    await expect(page.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator(`span[title="Last compacted at ${COMPACTED_AT}"]`),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.locator('span[title^="Removed counts from the last "]'),
    ).toHaveCount(0);
  });

  test("hides the Recent rollups line when no compaction passes have been recorded", async ({
    page,
  }) => {
    await stubTestRun(page);
    await stubConfig(page, null);

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    await expect(page.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });
    // Absence of the "Last compacted" sibling proves the config
    // response landed with lastCompaction:null, not still pending.
    await expect(page.locator('span[title^="Last compacted at "]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('span[title^="Removed counts from the last "]'),
    ).toHaveCount(0);
  });
});
