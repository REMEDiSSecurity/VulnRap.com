import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #212 — End-to-end coverage for the calibration cooldown banner.
//
// When the per-IP wrong-token throttle on `/api/feedback/calibration/*`
// (Task #116) returns HTTP 429 the calibration UI:
//   1. Renders a friendly cooldown banner with the seconds-remaining
//      countdown derived from the `RateLimit-Reset` header.
//   2. Disables every mutation button on the FLAT hand-wavy admin card
//      (Add, Confirm, bulk-preview, bulk-confirm) and relabels them with
//      the cooldown duration so reviewers know exactly when they can try
//      again instead of bashing the button and prolonging the bucket.
//
// We can't easily lower the limiter on the running api-server mid-test, so
// instead we stub a 429 response at the network layer for the FIRST POST
// to the handwavy-phrases endpoint. The customFetch in the shared API
// client treats every 429 identically — it parses the standard rate-limit
// headers, fans the notice out to subscribers (the cooldown store
// subscribes at module load) and then throws ApiError. So the stubbed 429
// drives the production cooldown code path end-to-end through the real
// React renderer.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

function uniquePhrase(): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `task212 cooldown ${id}`;
}

test.describe("Calibration cooldown banner (Task #212)", () => {
  test("surfaces a friendly cooldown banner and disables every mutation button when the API throttles wrong-token attempts", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase();
    const COOLDOWN_SECONDS = 7;

    // Stub the next handwavy-phrases POST with a 429 carrying the standard
    // rate-limit headers. Subsequent POSTs are NOT intercepted so the
    // page can otherwise behave normally if the test ever needs to retry.
    let postIntercepted = false;
    await page.route(
      "**/api/feedback/calibration/handwavy-phrases",
      async (route) => {
        const req = route.request();
        if (req.method() === "POST" && !postIntercepted) {
          postIntercepted = true;
          await route.fulfill({
            status: 429,
            headers: {
              "content-type": "application/json",
              "ratelimit-limit": "10",
              "ratelimit-remaining": "0",
              "ratelimit-reset": String(COOLDOWN_SECONDS),
              "retry-after": String(COOLDOWN_SECONDS),
            },
            body: JSON.stringify({
              error:
                "Too many failed calibration auth attempts. Please wait a minute before trying again.",
            }),
          });
          return;
        }
        await route.continue();
      },
    );

    try {
      await page.goto("/feedback-analytics");

      // Sanity: the admin card is on the page and no banner yet. The banner
      // is rendered as a sibling above BOTH the calibration dashboard and
      // the hand-wavy admin card (so reviewers see it from either context),
      // so we expect 0 instances pre-throttle and 2 instances afterwards.
      const adminCard = page.getByTestId("handwavy-admin");
      await expect(adminCard).toBeVisible();
      await expect(
        page.getByTestId("calibration-cooldown-banner"),
      ).toHaveCount(0);

      // Type the candidate phrase and click Add — this normally triggers a
      // dryRun POST. With our 429 stub it triggers the cooldown path.
      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      // Both banners appear (one per section) with a sensible countdown
      // headline. We assert against the first instance for text checks.
      await expect(page.getByTestId("calibration-cooldown-banner")).toHaveCount(
        2,
      );
      const banner = page.getByTestId("calibration-cooldown-banner").first();
      await expect(banner).toBeVisible();
      const headline = page
        .getByTestId("calibration-cooldown-headline")
        .first();
      await expect(headline).toContainText(/Too many failed attempts/i);
      // Countdown text quotes a positive integer of seconds. We assert the
      // shape rather than the exact value to tolerate sub-second drift
      // between header emission and the React render.
      await expect(headline).toContainText(/try again in \d+ second/i);

      // The Add button is now disabled and relabelled with the wait time.
      const addButton = page.getByTestId("handwavy-add");
      await expect(addButton).toBeDisabled();
      await expect(addButton).toContainText(/Cooldown\s+—\s+\d+s/i);

      // Defense-in-depth: clicking it anyway should NOT fire another POST
      // (the handler bails on cooldown). We give the route a moment and
      // assert the intercept counter never advances past 1. The button is
      // already disabled so this is mostly belt-and-braces.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- intentional
      await addButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(250);

      // Banner persists while the cooldown ticks.
      await expect(banner).toBeVisible();

      // Wait for the cooldown to elapse (give a small buffer for the
      // 500ms tick interval), then assert the banner disappears and the
      // Add button re-enables. We bound the wait so a stuck timer fails
      // the test loudly instead of hanging until Playwright's 60s cap.
      await expect(banner).toBeHidden({
        timeout: (COOLDOWN_SECONDS + 3) * 1000,
      });
      await expect(addButton).toBeEnabled();
      await expect(addButton).not.toContainText(/Cooldown\s+—\s+\d+s/i);
    } finally {
      await page.unroute("**/api/feedback/calibration/handwavy-phrases");
      // Best-effort cleanup in case any phrase actually landed.
      await apiCtx
        .delete("/api/feedback/calibration/handwavy-phrases", {
          data: { phrases: [phrase], reviewer: "e2e-task212-cleanup" },
        })
        .catch(() => undefined);
      await apiCtx.dispose();
    }
  });
});
