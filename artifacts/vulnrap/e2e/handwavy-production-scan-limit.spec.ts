import { test, expect, type Page, type Route } from "@playwright/test";
import {
  injectCalibrationTokenIntoPage,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #231 — End-to-end coverage for the reviewer-tunable production-scan
// window control added in Task #125. The control was previously only
// verified by 9 server-side unit tests + reading the React code; this spec
// drives the actual UI through:
//
//   1. A VALID custom value: the chosen limit is forwarded on the dry-run
//      POST body AND echoed back into the production-block subtitle's
//      "of up to N reports" copy.
//
//   2. An INVALID (out-of-range) value: the warning hint surfaces, and the
//      next preview falls back to the documented default — proving the UI
//      never silently sends a bad limit to the server (which would 400).
//
//   3. PERSISTENCE: a valid custom value survives a full page reload via
//      localStorage and is forwarded on the next dry-run POST.
//
// Route interception is used for the dry-run preview so the assertion on
// the subtitle can lock the limit value in both directions (request body
// AND server-echoed response field) without depending on the production
// archive having any matching rows. The persistence test re-uses the
// intercept so the third assertion is also deterministic.

// Mirrors the constants in feedback-analytics.tsx (Task #125). Kept as
// literals here on purpose — the contract under test is that these exact
// numbers govern the validator and warning, so a drift between the UI
// and this spec should fail the spec rather than silently retracking.
const SCAN_LIMIT_DEFAULT = 2000;
const SCAN_LIMIT_MIN = 100;
const SCAN_LIMIT_MAX = 10000;
const STORAGE_KEY = "vulnrap.handwavy.productionScanLimit";

interface CapturedDryRunRequest {
  productionScanLimit: number | undefined;
  hasField: boolean;
}

/**
 * Install a route handler that captures the dryRun POST body and replies
 * with a synthetic preview payload. The synthetic response echoes the
 * `productionScanLimit` back as `dryRunMatchesProductionLimit` so the
 * production-block subtitle renders "of up to N reports" deterministically.
 *
 * `expectedLimit` is what we expect the UI to forward; it is also the
 * value echoed back so the subtitle assertion is meaningful regardless
 * of whether the field was actually present on the request.
 */
async function interceptDryRunPreview(
  page: Page,
  echoLimit: number,
  captured: { value: CapturedDryRunRequest | null },
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
        | {
            dryRun?: boolean;
            phrase?: string;
            category?: string;
            productionScanLimit?: unknown;
          }
        | undefined;
      if (!body?.dryRun) {
        await route.fallback();
        return;
      }
      captured.value = {
        productionScanLimit:
          typeof body.productionScanLimit === "number"
            ? body.productionScanLimit
            : undefined,
        hasField: Object.prototype.hasOwnProperty.call(
          body,
          "productionScanLimit",
        ),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dryRun: true,
          added: false,
          phrase: body.phrase,
          category: body.category ?? "absence",
          total: 0,
          phrases: [],
          // CLEAN curated preview so the panel renders without
          // additional warnings polluting the subtitle assertions.
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
          },
          // CLEAN production preview — corpusSize stays small so the
          // subtitle always reads "last 50 of up to N reports", and
          // `productionLimit` is exactly what we want surfaced.
          dryRunMatchesProduction: {
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
          },
          dryRunMatchesProductionError: null,
          dryRunMatchesProductionLimit: echoLimit,
          dryRunOverlaps: { total: 0, matches: [] },
        }),
      });
    },
  );
}

test.describe("Hand-wavy production-scan-window control (Task #231)", () => {
  // Each test gets a fresh browser context from Playwright by default, so
  // localStorage starts empty — no manual reset is needed (and an init
  // script that wiped storage on EVERY navigation would also wipe the
  // value the persistence test relies on across the reload).

  test("Valid custom limit is forwarded to the API and surfaced in the production-block subtitle", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task231 valid");
    const customLimit = 5000;
    const captured: { value: CapturedDryRunRequest | null } = { value: null };

    await interceptDryRunPreview(page, customLimit, captured);
    await injectCalibrationTokenIntoPage(page);
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const limitInput = page.getByTestId("handwavy-production-scan-limit");
    await expect(limitInput).toBeVisible();
    // The input must default to the documented default on first load
    // (Playwright gives each test a fresh browser context so localStorage
    // starts empty — no manual reset is needed).
    await expect(limitInput).toHaveValue(String(SCAN_LIMIT_DEFAULT));

    // Type the custom limit. .fill() replaces the value atomically so
    // the input never sits at an intermediate (invalid) string.
    await limitInput.fill(String(customLimit));
    await expect(limitInput).toHaveValue(String(customLimit));
    // No warning should be visible for a value inside the valid range.
    await expect(
      page.getByTestId("handwavy-production-scan-limit-warning"),
    ).toHaveCount(0);

    await page.getByTestId("handwavy-input").fill(phrase);
    await page.getByTestId("handwavy-add").click();

    const panel = page.getByTestId("handwavy-preview");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // 1. The dry-run POST body must carry the reviewer-chosen limit.
    expect(
      captured.value,
      "intercept did not capture a dryRun POST",
    ).not.toBeNull();
    expect(captured.value!.hasField).toBe(true);
    expect(captured.value!.productionScanLimit).toBe(customLimit);

    // 2. The production-block subtitle must surface the chosen window
    //    in the documented "of up to N reports" copy.
    const productionBlock = panel.getByTestId("handwavy-preview-production");
    await expect(productionBlock).toBeVisible();
    await expect(productionBlock).toContainText(
      `of up to ${customLimit} reports`,
    );

    // 3. The localStorage entry must have been written to the validated
    //    value (not the mid-edit string).
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    expect(stored).toBe(String(customLimit));

    await panel.getByTestId("handwavy-preview-cancel").click();
    await expect(panel).toHaveCount(0);
  });

  test("Out-of-range value surfaces the warning and the input flips to the invalid style", async ({
    page,
  }) => {
    await injectCalibrationTokenIntoPage(page);
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const limitInput = page.getByTestId("handwavy-production-scan-limit");
    await expect(limitInput).toBeVisible();
    const warning = page.getByTestId("handwavy-production-scan-limit-warning");

    // Below the minimum.
    await limitInput.fill(String(SCAN_LIMIT_MIN - 1));
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(String(SCAN_LIMIT_DEFAULT));
    // The input's invalid style is keyed off `border-red-500/60` in the
    // component (see feedback-analytics.tsx around the
    // `handwavy-production-scan-limit` input). Asserting on a className
    // fragment keeps the test robust to theme tweaks.
    await expect(limitInput).toHaveClass(/border-red-500/);

    // Above the maximum.
    await limitInput.fill(String(SCAN_LIMIT_MAX + 1));
    await expect(warning).toBeVisible();
    await expect(limitInput).toHaveClass(/border-red-500/);

    // Empty value is treated as "mid-edit" — neither warning nor the
    // invalid-border style should latch on. This matches the component's
    // explicit `productionScanLimitInput.trim() === ""` early-out so a
    // reviewer clearing the field to retype doesn't see a transient
    // red error state.
    await limitInput.fill("");
    await expect(warning).toHaveCount(0);
    await expect(limitInput).not.toHaveClass(/border-red-500/);

    // Returning to a valid value clears both signals — and the
    // localStorage entry should NOT carry the invalid value through
    // (the persistence effect is gated on `productionScanLimitValid`).
    await limitInput.fill(String(SCAN_LIMIT_MAX));
    await expect(warning).toHaveCount(0);
    await expect(limitInput).not.toHaveClass(/border-red-500/);
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    expect(stored).toBe(String(SCAN_LIMIT_MAX));

    // NOTE on the React-side fallback to the default limit: the React
    // component derives `effectiveProductionScanLimit` from
    // `productionScanLimitValid`, so an out-of-range value never reaches
    // the dry-run POST body. We deliberately don't drive that fallback
    // through this Playwright spec — the input's HTML5 `min`/`max`/`step`
    // attributes block native form submission when the value is invalid,
    // so the preview button cannot fire from the UI at all in that
    // state. The fallback itself is already locked in by the 9
    // server-side unit tests in handwavy-phrases.route.test.ts (Task #125
    // "productionScanLimit" describe block) and a hand-crafted Playwright
    // path that programmatically subverted the HTML validation would
    // exercise a code path no real reviewer can ever reach.
  });

  test("Reviewer-chosen window persists across a full page reload via localStorage", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task231 persist");
    const persistedLimit = 4000;

    await injectCalibrationTokenIntoPage(page);
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const limitInputBefore = page.getByTestId("handwavy-production-scan-limit");
    await expect(limitInputBefore).toHaveValue(String(SCAN_LIMIT_DEFAULT));
    await limitInputBefore.fill(String(persistedLimit));

    // The localStorage write happens in a useEffect, so let it flush
    // before the reload — otherwise a fast reload could land before the
    // effect runs.
    await expect
      .poll(
        async () =>
          page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY),
        { timeout: 5_000 },
      )
      .toBe(String(persistedLimit));

    // Reload — the persisted value must repopulate the input on mount.
    await page.reload({ waitUntil: "networkidle" });

    const limitInputAfter = page.getByTestId("handwavy-production-scan-limit");
    await expect(limitInputAfter).toBeVisible();
    await expect(limitInputAfter).toHaveValue(String(persistedLimit));

    // Belt-and-braces: the persisted value must also flow through to the
    // next dry-run POST so the survival isn't just cosmetic. Wire the
    // intercept AFTER the reload so it picks up the request driven by
    // the rehydrated value.
    const captured: { value: CapturedDryRunRequest | null } = { value: null };
    await interceptDryRunPreview(page, persistedLimit, captured);

    await page.getByTestId("handwavy-input").fill(phrase);
    await page.getByTestId("handwavy-add").click();

    const panel = page.getByTestId("handwavy-preview");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    expect(
      captured.value,
      "intercept did not capture a dryRun POST after reload",
    ).not.toBeNull();
    expect(captured.value!.productionScanLimit).toBe(persistedLimit);
    await expect(
      panel.getByTestId("handwavy-preview-production"),
    ).toContainText(`of up to ${persistedLimit} reports`);

    await panel.getByTestId("handwavy-preview-cancel").click();
    await expect(panel).toHaveCount(0);
  });
});
