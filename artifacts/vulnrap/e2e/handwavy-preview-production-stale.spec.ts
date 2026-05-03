import { randomUUID } from "node:crypto";
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
} from "./helpers/handwavy";

// Task #292 — End-to-end coverage for the production-sample staleness amber
// notice added in Task #219. The helper math
// (`productionScanStalenessDays`, `isProductionScanStale`) is exercised by
// unit tests, but the actual React render — that the amber block appears
// with the right copy and `data-testid="handwavy-preview-production-stale"`
// when the sample is older than `PRODUCTION_SCAN_FRESHNESS_DAYS`, and is
// hidden when the sample is fresh — was not yet driven through the browser.
//
// The sibling "production scan UNAVAILABLE" amber notice
// (`handwavy-preview-production-error`) already has its own e2e in
// handwavy-preview-side-by-side.spec.ts; this spec is for the *separate*
// amber notice that surfaces when the production probe SUCCEEDED but the
// newest row in the scanned sample is older than the freshness window
// (default 14 days).
//
// Strategy:
//   - Intercept the dry-run POST so we can deterministically choose the
//     `newestCreatedAt` timestamp on `dryRunMatchesProduction`. This avoids
//     coupling to the dev DB's actual freshness (which moves with wall-clock
//     time and would flake) and avoids needing to mock the browser clock.
//   - Stale case: pick `newestCreatedAt` 30 days in the past — well past
//     the documented 14-day threshold and large enough that minor
//     wall-clock skew between Date.now() at intercept-construction time and
//     Date.now() at render time can never push it back into the fresh
//     window during the test.
//   - Fresh case: pick `newestCreatedAt` 1 hour in the past — guaranteed
//     under the 14-day threshold.

const REVIEWER = "e2e-task292";

// Mirror feedback-analytics.tsx's `PRODUCTION_SCAN_FRESHNESS_DAYS`. Kept as
// a literal here on purpose — the contract under test is that this exact
// number governs the rendered copy, so any drift between the UI and this
// spec should fail the spec rather than silently retracking.
const FRESHNESS_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface InterceptOptions {
  /**
   * ISO timestamp to put on the production-block sample's `newestCreatedAt`.
   * Choose a value well past `PRODUCTION_SCAN_FRESHNESS_DAYS` for the
   * stale path, or well under it for the fresh path.
   */
  newestCreatedAt: string;
  /**
   * ISO timestamp for `oldestCreatedAt`. The freshness predicate only
   * inspects `newestCreatedAt`, but the production block's "Scanned N
   * reports …" range subtitle requires both timestamps to be set, and
   * picking a value strictly older than `newestCreatedAt` keeps the
   * synthetic payload internally consistent.
   */
  oldestCreatedAt: string;
}

/**
 * Install a route handler that captures the dryRun POST and replies with a
 * synthetic preview whose production block has `newestCreatedAt` set to
 * the supplied ISO timestamp. Both curated and production blocks return
 * CLEAN signals (zero false positives) so the only thing under test is the
 * staleness amber notice.
 */
async function interceptDryRunPreviewWithProductionTimestamp(
  page: Page,
  opts: InterceptOptions,
): Promise<void> {
  await page.route(
    "**/api/feedback/calibration/handwavy-phrases",
    async (route: Route) => {
      const req = route.request();
      if (req.method() !== "POST") {
        await route.fallback();
        return;
      }
      const body = req.postDataJSON() as
        | { dryRun?: boolean; phrase?: string; category?: string }
        | undefined;
      if (!body?.dryRun) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dryRun: true,
          added: false,
          phrase: body.phrase,
          category: body.category ?? "absence",
          total: 42,
          phrases: [],
          // Curated block returns a CLEAN preview — no FPs and no scan
          // window (curated fixtures have no wall-clock timestamps), so
          // the curated block can never render the production-stale
          // notice (`kind === "production"` gate in PreviewMatchBlock).
          dryRunMatches: {
            total: 0,
            byTier: {
              t1Legit: 0,
              t2Borderline: 0,
              t3Slop: 0,
              t4Hallucinated: 0,
            },
            falsePositives: 0,
            corpusSize: 50,
            sampleMatches: [],
            warning: null,
            oldestCreatedAt: null,
            newestCreatedAt: null,
          },
          // Production block returns a CLEAN preview but with the chosen
          // sample window. The freshness predicate (`isProductionScanStale`)
          // only inspects `newestCreatedAt`, so flipping that one field
          // is what drives the amber notice on/off.
          dryRunMatchesProduction: {
            total: 0,
            byTier: {
              t1Legit: 0,
              t2Borderline: 0,
              t3Slop: 0,
              t4Hallucinated: 0,
            },
            falsePositives: 0,
            corpusSize: 1234,
            sampleMatches: [],
            warning: null,
            oldestCreatedAt: opts.oldestCreatedAt,
            newestCreatedAt: opts.newestCreatedAt,
          },
          dryRunMatchesProductionError: null,
          dryRunMatchesProductionLimit: 2000,
          dryRunOverlaps: { total: 0, matches: [] },
        }),
      });
    },
  );
}

test.describe("Hand-wavy production-sample staleness notice (Task #292)", () => {
  test("Amber stale notice renders with the threshold + day count when the sample is older than the freshness window", async ({
    page,
  }) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const phrase = `task292 stale ${id}`;
    // 30 days is well past the 14-day threshold; floor(30) is the value
    // the UI will render in the headline copy. Computed once, well before
    // the page even loads, so a slow CI machine drifting Date.now() by a
    // second or two between intercept setup and render can't perturb the
    // floored day count.
    const newest = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    const oldest = new Date(Date.now() - 60 * MS_PER_DAY).toISOString();
    const api = await newApiContext();

    try {
      await interceptDryRunPreviewWithProductionTimestamp(page, {
        newestCreatedAt: newest,
        oldestCreatedAt: oldest,
      });
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const panel = page.getByTestId("handwavy-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Production block must be visible (the probe "succeeded" in our
      // intercept) — the stale notice lives INSIDE this block.
      const productionBlock = panel.getByTestId("handwavy-preview-production");
      await expect(productionBlock).toBeVisible();

      const staleNotice = productionBlock.getByTestId(
        "handwavy-preview-production-stale",
      );
      await expect(staleNotice).toBeVisible();

      // Copy must mention the documented 14-day threshold verbatim. This
      // guards against a regression that swaps the threshold constant for
      // a magic number, or that drops the constant from the rendered
      // explanation entirely.
      await expect(staleNotice).toContainText(
        `${FRESHNESS_DAYS}-day freshness window`,
      );

      // Headline must include the floored day count. The intercept fixed
      // the timestamp at exactly 30 * MS_PER_DAY in the past; the helper
      // floors so the rendered value is exactly 30 (or 29 on the rare
      // boundary where wall-clock advanced past the 30-day mark between
      // intercept setup and render). Allowing both values keeps the
      // assertion non-flaky without weakening the "day count is in the
      // copy" contract.
      await expect(staleNotice).toContainText(/\b(?:29|30) days old/);

      // Belt-and-braces: the component also exposes the raw day count via
      // a `data-stale-days` attribute. Asserting on it pins the helper
      // math (not just the rendered string) and would catch a regression
      // that happened to keep the attribute correct while breaking the
      // headline copy or vice-versa.
      const days = await staleNotice.getAttribute("data-stale-days");
      expect(days).toBeTruthy();
      const parsed = Number(days);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(parsed).toBeGreaterThanOrEqual(29);
      expect(parsed).toBeLessThanOrEqual(30);

      // The curated block must NEVER render the stale notice: the helper
      // is gated on `kind === "production"` so a regression that drops
      // that gate (and starts warning on the curated benchmark, which has
      // no wall-clock timestamps) would surface here.
      const curatedBlock = panel.getByTestId("handwavy-preview-curated");
      await expect(curatedBlock).toBeVisible();
      await expect(
        curatedBlock.getByTestId("handwavy-preview-curated-stale"),
      ).toHaveCount(0);
      await expect(
        curatedBlock.getByTestId("handwavy-preview-production-stale"),
      ).toHaveCount(0);

      await panel.getByTestId("handwavy-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      // Belt-and-braces: the intercept means no real POST hits the server
      // (dryRun POSTs don't persist anyway), but cleanup is idempotent
      // and matches the pattern used by the other handwavy specs.
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });

  test("Amber stale notice is NOT rendered when the production sample is fresh (within the freshness window)", async ({
    page,
  }) => {
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const phrase = `task292 fresh ${id}`;
    // 1 hour ago — comfortably under the 14-day threshold. We deliberately
    // pick a value much smaller than the threshold so the test would still
    // pass even if the threshold were tweaked downward in a future task.
    const newest = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const oldest = new Date(Date.now() - 7 * MS_PER_DAY).toISOString();
    const api = await newApiContext();

    try {
      await interceptDryRunPreviewWithProductionTimestamp(page, {
        newestCreatedAt: newest,
        oldestCreatedAt: oldest,
      });
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const panel = page.getByTestId("handwavy-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const productionBlock = panel.getByTestId("handwavy-preview-production");
      await expect(productionBlock).toBeVisible();

      // The production block must still render its scan-range subtitle
      // (proves the synthetic payload landed and was processed) — but
      // the stale amber notice must NOT appear.
      await expect(
        productionBlock.getByTestId("handwavy-preview-production-range"),
      ).toBeVisible();
      await expect(
        productionBlock.getByTestId("handwavy-preview-production-stale"),
      ).toHaveCount(0);

      await panel.getByTestId("handwavy-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });
});
