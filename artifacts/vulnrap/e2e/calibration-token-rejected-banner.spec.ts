import { randomUUID } from "node:crypto";
import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";

// Task #420 — End-to-end coverage for the Task #297 token-rejected banner.
//
// Mirrors `calibration-cooldown-banner.spec.ts`: stub the network response
// for the FIRST POST to /api/feedback/calibration/handwavy-phrases so the
// shared API client publishes a 401 to the unauthorized observer that
// `calibration-token-rejection.ts` subscribes to. Then stub the next POST
// with a 429 to verify the documented "cooldown wins" short-circuit in
// CalibrationTokenRejectedBanner.

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
  return `task420 token-rejected ${id}`;
}

test.describe("Calibration token-rejected banner (Task #420)", () => {
  test("flips on the first 401, names VITE_CALIBRATION_TOKEN, and steps aside when a cooldown 429 lands", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase();
    const COOLDOWN_SECONDS = 7;

    // Single route handler keyed off a POST counter:
    //   POST #1 → 401 (rejection banner path)
    //   POST #2 → 429 (cooldown wins; rejection should hide)
    let postCount = 0;
    await page.route(
      "**/api/feedback/calibration/handwavy-phrases",
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") {
          await route.continue();
          return;
        }
        postCount += 1;
        if (postCount === 1) {
          await route.fulfill({
            status: 401,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: "Unauthorized: reviewer token rejected by api-server.",
            }),
          });
          return;
        }
        if (postCount === 2) {
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

      const adminCard = page.getByTestId("handwavy-admin");
      await expect(adminCard).toBeVisible();
      await expect(
        page.getByTestId("calibration-token-rejected-banner"),
      ).toHaveCount(0);
      await expect(page.getByTestId("calibration-cooldown-banner")).toHaveCount(
        0,
      );

      // Phase 1: first add → 401 → rejection banner appears in both
      // render locations (calibration card + FLAT admin card).
      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const rejectionBanners = page.getByTestId(
        "calibration-token-rejected-banner",
      );
      await expect(rejectionBanners).toHaveCount(2);
      // Both render locations must be visible, not just the first — the
      // banner's whole point is that reviewers see the diagnosis from
      // either context (calibration card OR FLAT admin card).
      await expect(rejectionBanners.nth(0)).toBeVisible();
      await expect(rejectionBanners.nth(1)).toBeVisible();
      await expect(
        page.getByTestId("calibration-token-rejected-headline").first(),
      ).toContainText(/Reviewer token rejected/i);
      // The body copy (not the headline) must name the env var. Scope the
      // assertion to the explanatory paragraph so a regression that drops
      // VITE_CALIBRATION_TOKEN from the body is not masked by the
      // headline (which only mentions the env var by name today; this
      // spec shouldn't depend on that).
      await expect(
        rejectionBanners
          .first()
          .locator("p")
          .filter({ hasText: /Confirm the reviewer token/i }),
      ).toContainText("VITE_CALIBRATION_TOKEN");
      await expect(page.getByTestId("calibration-cooldown-banner")).toHaveCount(
        0,
      );

      // Phase 2: second add → 429 → cooldown banner takes over,
      // rejection banner is suppressed by the cooldownActive guard.
      await page.getByTestId("handwavy-add").click();

      // Assert at least one cooldown banner is visible rather than pinning
      // an exact count: CalibrationCooldownBanner is currently rendered in
      // three locations on this page, and adding more shouldn't break this
      // spec — the contract under test is "cooldown wins over rejection."
      await expect(
        page.getByTestId("calibration-cooldown-banner").first(),
      ).toBeVisible();
      await expect(
        page.getByTestId("calibration-token-rejected-banner"),
      ).toHaveCount(0);
    } finally {
      await page.unroute("**/api/feedback/calibration/handwavy-phrases");
      await apiCtx
        .delete("/api/feedback/calibration/handwavy-phrases", {
          data: { phrases: [phrase], reviewer: "e2e-task420-cleanup" },
        })
        .catch(() => undefined);
      await apiCtx.dispose();
    }
  });

  // Task #750 — reviewers who fix VITE_CALIBRATION_TOKEN (or paste in a
  // runtime override) but don't want to re-trigger the failed mutation
  // need an in-product way to silence the sticky banner without reloading
  // the page. The Task #421 auto-clear only fires on the next 2xx
  // calibration mutation, so we expose a dismiss button that resets the
  // rejection store directly.
  test("can be dismissed manually without reloading or retrying", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase();

    // Single 401 — no follow-up mutations. The dismiss path must work
    // without depending on a successful mutation landing first.
    await page.route(
      "**/api/feedback/calibration/handwavy-phrases",
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 401,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            error: "Unauthorized: reviewer token rejected by api-server.",
          }),
        });
      },
    );

    try {
      await page.goto("/feedback-analytics");

      const adminCard = page.getByTestId("handwavy-admin");
      await expect(adminCard).toBeVisible();

      await page.getByTestId("handwavy-input").fill(phrase);
      await page.getByTestId("handwavy-add").click();

      const rejectionBanners = page.getByTestId(
        "calibration-token-rejected-banner",
      );
      await expect(rejectionBanners).toHaveCount(2);

      // Click the dismiss button on the first banner — the rejection store
      // is global, so dismissing one location must clear every render.
      await page
        .getByTestId("calibration-token-rejected-dismiss")
        .first()
        .click();

      await expect(rejectionBanners).toHaveCount(0);
      // Cooldown banner is unaffected by the dismiss — it owns its own state.
      await expect(page.getByTestId("calibration-cooldown-banner")).toHaveCount(
        0,
      );
    } finally {
      await page.unroute("**/api/feedback/calibration/handwavy-phrases");
      await apiCtx
        .delete("/api/feedback/calibration/handwavy-phrases", {
          data: { phrases: [phrase], reviewer: "e2e-task750-cleanup" },
        })
        .catch(() => undefined);
      await apiCtx.dispose();
    }
  });
});
