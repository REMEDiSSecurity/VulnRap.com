import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #126 — End-to-end coverage for the side-by-side single-add preview
// in the calibration UI. Mirrors the bulk-removal preview spec
// (`handwavy-bulk-preview.spec.ts`) but for the POST add-phrase dryRun flow:
//
//   1. Typing a phrase that flags the curated benchmark and pressing
//      "Preview impact" must render BOTH `handwavy-preview-curated` and
//      `handwavy-preview-production` — the production block must never
//      silently disappear when the API returns a populated production
//      DryRunMatches payload (Task #119 contract).
//
//   2. The destructive "Add anyway" copy (and `variant="destructive"`
//      styling) on the confirm button must kick in when EITHER signal
//      flips red — including the case where curated has zero false
//      positives but the production scan flags legitimate reports.
//      A regression that only watched the curated block would let a
//      catastrophic-against-production phrase look like a clean add.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN ||
  process.env.CALIBRATION_TOKEN ||
  process.env.VITE_CALIBRATION_TOKEN ||
  "e2e-calibration-token";

function authHeaders(): Record<string, string> {
  return { "X-Calibration-Token": CALIBRATION_TOKEN };
}

function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: authHeaders(),
  });
}

// Mirrors the safety net used in the bulk-preview spec: in dev modes where
// the Vite bundle was built without `VITE_CALIBRATION_TOKEN`, the page's
// own mutation calls would 401. We don't actually rely on this for the
// add-preview path (we drive the form through the UI which always uses
// the bundled token), but keep parity so the spec works in any dev mode.
async function injectCalibrationTokenIntoPage(page: Page): Promise<void> {
  if (!CALIBRATION_TOKEN) return;
  await page.addInitScript((token) => {
    (window as unknown as { __VULNRAP_CALIBRATION_TOKEN__?: string })
      .__VULNRAP_CALIBRATION_TOKEN__ = token;
  }, CALIBRATION_TOKEN);
}

async function cleanupPhrase(
  api: APIRequestContext,
  phrase: string,
): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrase, reviewer: "e2e-task126-cleanup" },
    })
    .catch(() => undefined);
}

test.describe("Side-by-side dry-run preview panel (Task #126)", () => {
  test("Both curated AND production match blocks render when the API returns a populated production payload", async ({
    page,
  }) => {
    // "cvss" is the canonical phrase that flags multiple T1/T2 fixtures in
    // the curated benchmark corpus (see handwavy-phrases.route.test.ts:
    // "dryRun=true surfaces a reviewer warning when the phrase would flag
    // legitimate corpus reports"). Using it here gives us a realistic
    // "phrase known to flag the curated set" without coupling the test to
    // a specific fixture id.
    const phrase = "cvss";
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Typing "cvss" alone is fine — the form's preview button only
      // unlocks at >=3 chars, and 4 chars also passes the server-side
      // length validation.
      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const panel = page.getByTestId("handwavy-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Strict side-by-side assertion (Task #126 acceptance criterion):
      // both `handwavy-preview-curated` AND `handwavy-preview-production`
      // must be visible. The production block is gated on
      // `dryRunMatchesProduction != null` from the server response;
      // whenever the DB probe succeeds (the expected dev/CI state) the
      // route returns a populated DryRunMatches payload — even when the
      // production corpus has zero matches — so the side-by-side render
      // is guaranteed. If this assertion ever flakes, that itself is a
      // signal the production probe is broken and worth investigating
      // rather than masking. The amber-notice fallback for a failed
      // probe is covered by the route-level unit tests and is queued as
      // a dedicated follow-up Playwright test.
      await expect(panel.getByTestId("handwavy-preview-curated")).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-preview-production"),
      ).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-preview-production-error"),
      ).toHaveCount(0);

      // Curated block must surface the false-positive warning since
      // "cvss" hits T1/T2 fixtures.
      await expect(
        panel.getByTestId("handwavy-preview-curated-warning"),
      ).toContainText(/legitimate/i);

      // Curated has FPs > 0, so the confirm button must already be in
      // its destructive "Add anyway" form regardless of the production
      // signal.
      await expect(panel.getByTestId("handwavy-preview-confirm")).toHaveText(
        /Add anyway/,
      );

      // Back out — we don't want to actually persist "cvss" as a
      // hand-wavy phrase in the dev DB / phrases.json.
      await panel.getByTestId("handwavy-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      // Belt-and-braces in case anything slipped through (e.g. the
      // confirm fired due to a flaky test). Cleanup is idempotent.
      await cleanupPhrase(api, phrase);
      await api.dispose();
    }
  });

  test("Destructive 'Add anyway' button appears when ONLY the production block has false positives", async ({
    page,
  }) => {
    // Use a phrase guaranteed not to overlap with any curated fixture so
    // the curated block stays clean (falsePositives=0). Then intercept
    // the dryRun POST and inject a synthetic response where ONLY the
    // production block has GREEN/YELLOW false positives — this is the
    // exact signal split that the side-by-side preview was built to
    // catch and the confirm button must flip to its destructive
    // "Add anyway" form.
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const phrase = `task126 production only ${id}`;
    const api = await newApiContext();

    try {
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
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
          // Curated cohorts return a CLEAN preview (zero matches at all),
          // production block returns 4 false positives across GREEN
          // (T1_LEGIT) and YELLOW (T2_BORDERLINE). This is the exact
          // case where a regression in the destructive-styling logic
          // (e.g. one that only watched curated.falsePositives) would
          // mistakenly render "Confirm add" instead of "Add anyway".
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
              dryRunMatchesProduction: {
                total: 7,
                byTier: {
                  t1Legit: 3,
                  t2Borderline: 1,
                  t3Slop: 2,
                  t4Hallucinated: 1,
                },
                falsePositives: 4,
                corpusSize: 1234,
                sampleMatches: [
                  { id: "report-001", tier: "T1_LEGIT" },
                  { id: "report-002", tier: "T2_BORDERLINE" },
                ],
                warning:
                  "This phrase would have flagged 4 legitimate reports (3 GREEN, 1 YELLOW) in the most recent 1234 production reports — consider rewording.",
              },
              dryRunMatchesProductionError: null,
              dryRunMatchesProductionLimit: 2000,
              dryRunOverlaps: { total: 0, matches: [] },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const panel = page.getByTestId("handwavy-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Both side-by-side blocks must be visible — same shape as Test 1
      // — so the regression we're guarding against (the production
      // block silently disappearing) is also caught here.
      await expect(panel.getByTestId("handwavy-preview-curated")).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-preview-production"),
      ).toBeVisible();

      // Curated block must NOT surface a false-positive warning (clean
      // signal in the synthetic payload).
      await expect(
        panel.getByTestId("handwavy-preview-curated-warning"),
      ).toHaveCount(0);

      // Production block MUST surface the false-positive warning verbatim
      // from the synthetic payload.
      await expect(
        panel.getByTestId("handwavy-preview-production-warning"),
      ).toContainText("4 legitimate reports");

      // The destructive "Add anyway" copy must appear on the confirm
      // button even though only the production signal flipped red.
      // Match the destructive variant via the rendered class + text.
      const confirmBtn = panel.getByTestId("handwavy-preview-confirm");
      await expect(confirmBtn).toBeVisible();
      await expect(confirmBtn).toHaveText(/Add anyway/);
      // shadcn/ui's "destructive" Button variant renders a class containing
      // "destructive". Asserting on the class keeps the test robust to
      // theme tweaks (color hex changes) while still catching a
      // regression that flips back to the default variant.
      await expect(confirmBtn).toHaveClass(/destructive/);

      // The outer card flips to the red border/background when either
      // signal has FPs — assert via the same class hook (the curated +
      // production split paints the card with `border-red-500/40`).
      await expect(panel).toHaveClass(/border-red-500/);

      // Back out without committing.
      await panel.getByTestId("handwavy-preview-cancel").click();
      await expect(panel).toHaveCount(0);
    } finally {
      await cleanupPhrase(api, phrase);
      await api.dispose();
    }
  });
});
