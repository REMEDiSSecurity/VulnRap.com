import { test, expect, type Page, type Route } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #414 — End-to-end coverage for the bulk-removal staleness amber
// notice. Mirrors `handwavy-preview-production-stale.spec.ts` (Task #292)
// which covers the same notice on the add-time `PreviewMatchBlock`.
//
// Strategy mirrors the add-time spec: intercept the bulk dryRun DELETE so
// the production block's `newestCreatedAt` is deterministic. Stale path
// uses a 30-day-old timestamp, fresh path uses a 1-hour-old timestamp.

const REVIEWER = "e2e-task414";

// Mirror feedback-analytics.tsx's `PRODUCTION_SCAN_FRESHNESS_DAYS`. Kept
// as a literal here on purpose — the contract under test is that this
// exact number governs the rendered copy.
const FRESHNESS_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface InterceptOptions {
  newestCreatedAt: string;
  oldestCreatedAt: string;
}

/**
 * Install a route handler that captures the bulk dryRun DELETE and replies
 * with a synthetic preview whose production block has `newestCreatedAt`
 * set to the supplied ISO timestamp. Both blocks return CLEAN signals so
 * the only thing under test is the staleness amber notice.
 */
async function interceptBulkDryRunWithProductionTimestamp(
  page: Page,
  opts: InterceptOptions,
): Promise<void> {
  await page.route(
    "**/api/feedback/calibration/handwavy-phrases",
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "DELETE") {
        await route.fallback();
        return;
      }
      const body = req.postDataJSON() as
        | { dryRun?: boolean; phrases?: string[] }
        | undefined;
      if (!body?.dryRun) {
        await route.fallback();
        return;
      }
      const requested = body.phrases ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dryRun: true,
          wouldRemove: requested.length,
          notFound: 0,
          duplicateInBatch: 0,
          total: 99,
          projectedTotal: 99 - requested.length,
          results: requested.map((raw: string) => ({
            raw,
            phrase: raw,
            removed: true,
          })),
          dryRunImpact: {
            corpus: {
              total: 0,
              validDetectionsLost: 0,
              falsePositivesDropped: 0,
              byTier: {
                t1Legit: 0,
                t2Borderline: 0,
                t3Slop: 0,
                t4Hallucinated: 0,
              },
              sampleMatches: [],
              warning: null,
              corpusSize: 47,
              oldestCreatedAt: null,
              newestCreatedAt: null,
            },
            production: {
              total: 0,
              validDetectionsLost: 0,
              falsePositivesDropped: 0,
              byTier: {
                t1Legit: 0,
                t2Borderline: 0,
                t3Slop: 0,
                t4Hallucinated: 0,
              },
              sampleMatches: [],
              warning: null,
              corpusSize: 1234,
              oldestCreatedAt: opts.oldestCreatedAt,
              newestCreatedAt: opts.newestCreatedAt,
              archiveTotal: 1234,
            },
            productionError: null,
            productionLimit: 2000,
          },
        }),
      });
    },
  );
}

async function selectRowsAndOpenPreview(
  page: Page,
  phrases: string[],
): Promise<void> {
  for (const phrase of phrases) {
    const row = page
      .locator(`[data-testid="handwavy-row"]`)
      .filter({ hasText: phrase });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByTestId("handwavy-select").check();
  }
  await page.getByTestId("handwavy-bulk-remove").click();
}

test.describe("Bulk-removal preview production-sample staleness notice (Task #414)", () => {
  test("Amber stale notice renders with the threshold + day count when the bulk preview's production sample is older than the freshness window", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task414 stale");
    // 30 days is well past the 14-day threshold; computed once before
    // the page loads so wall-clock drift between intercept setup and
    // render can't perturb the floored day count.
    const newest = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    const oldest = new Date(Date.now() - 60 * MS_PER_DAY).toISOString();

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await interceptBulkDryRunWithProductionTimestamp(page, {
        newestCreatedAt: newest,
        oldestCreatedAt: oldest,
      });
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const productionBlock = panel.getByTestId(
        "handwavy-bulk-preview-production",
      );
      await expect(productionBlock).toBeVisible();

      const staleNotice = productionBlock.getByTestId(
        "handwavy-bulk-preview-production-stale",
      );
      await expect(staleNotice).toBeVisible();

      // Threshold appears verbatim so a regression that swaps the
      // constant for a magic number would surface here.
      await expect(staleNotice).toContainText(
        `${FRESHNESS_DAYS}-day freshness window`,
      );

      // Allow 29 or 30 to absorb rare wall-clock drift between intercept
      // setup and render.
      await expect(staleNotice).toContainText(/\b(?:29|30) days old/);

      const days = await staleNotice.getAttribute("data-stale-days");
      expect(days).toBeTruthy();
      const parsed = Number(days);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(29);
      expect(parsed).toBeLessThanOrEqual(30);

      // Curated block must NEVER render the stale notice.
      const curatedBlock = panel.getByTestId("handwavy-bulk-preview-curated");
      await expect(curatedBlock).toBeVisible();
      await expect(
        curatedBlock.getByTestId("handwavy-bulk-preview-curated-stale"),
      ).toHaveCount(0);
      await expect(
        curatedBlock.getByTestId("handwavy-bulk-preview-production-stale"),
      ).toHaveCount(0);

      await panel.getByTestId("handwavy-bulk-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("Amber stale notice is NOT rendered when the bulk preview's production sample is fresh (within the freshness window)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task414 fresh");
    const newest = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldest = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await interceptBulkDryRunWithProductionTimestamp(page, {
        newestCreatedAt: newest,
        oldestCreatedAt: oldest,
      });
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const productionBlock = panel.getByTestId(
        "handwavy-bulk-preview-production",
      );
      await expect(productionBlock).toBeVisible();

      // Scan-range subtitle still renders (proves the synthetic payload
      // landed); the stale amber notice must NOT appear.
      await expect(
        productionBlock.getByTestId("handwavy-bulk-preview-production-range"),
      ).toBeVisible();
      await expect(
        productionBlock.getByTestId("handwavy-bulk-preview-production-stale"),
      ).toHaveCount(0);

      await panel.getByTestId("handwavy-bulk-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
