import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #214 — End-to-end coverage for the "calibration mutations blocked"
// gate. When the un-gated `/feedback/calibration/auth-status` probe reports
// that the server requires a reviewer token AND the UI is sending the
// wrong one (or no token at all), `useCalibrationAuthState()` flips
// `mutationsAllowed` to false. Every mutating control on both the
// Scoring Calibration card and the FLAT hand-wavy phrase admin panel
// should then render disabled, with the shared MUTATIONS_BLOCKED_TITLE
// tooltip pointing reviewers back at the warning banner above the card.
//
// We intercept the auth-status probe via `page.route` and return a
// `tokenPresented: true, tokenValid: false` payload so the page sees the
// "invalid" branch even though the Playwright bundle's real token would
// be accepted by the api-server. This keeps the spec hermetic — no need
// to flip the api-server's CALIBRATION_TOKEN at runtime — and it
// exercises the same render path a real misconfigured deploy would hit.

test.describe("FLAT hand-wavy phrase panel + calibration card — mutations blocked when token invalid (Task #214)", () => {
  test("disables all mutating controls and exposes the shared blocked-title tooltip when auth-status reports invalid token", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task214 blocked");

    try {
      // Seed one active phrase via the API (with the real token) so the
      // panel has at least one row whose per-row Edit/Remove/Revert
      // buttons we can assert against. Without a row the per-row
      // controls don't render.
      await addPhrase(apiCtx, phrase, { reviewer: "e2e-task214-seed" });

      // Force the auth-status probe to report "invalid token" for every
      // call (initial load + the 60s refetch). This must be installed
      // before navigation so the React Query first-fetch sees the mock.
      await page.route(
        "**/api/feedback/calibration/auth-status",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              serverRequiresToken: true,
              tokenPresented: true,
              tokenValid: false,
            }),
          });
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row, "seeded phrase should appear in the active list").toHaveCount(
        1,
        { timeout: 15_000 },
      );

      // Per-row controls (Edit / Remove) on the seeded phrase should be
      // disabled with the shared blocked-title tooltip + the
      // data-mutations-blocked="true" stamp the renderer adds.
      const editBtn = row.getByTestId("handwavy-edit");
      const removeBtn = row.getByTestId("handwavy-remove");
      await expect(editBtn).toBeDisabled();
      await expect(editBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(editBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );
      await expect(removeBtn).toBeDisabled();
      await expect(removeBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(removeBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );

      // The "add a new phrase" button at the top of the panel must also
      // disable — even with a typed-in input value the click would 401.
      // We don't need to type anything; the button reads the
      // mutationsAllowed flag directly.
      const addBtn = page.getByTestId("handwavy-add");
      await expect(addBtn).toBeDisabled();
      await expect(addBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(addBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );

      // The Scoring Calibration card may render zero or more
      // SuggestionCard rows depending on the seeded data. If any are
      // present, every Apply button must be disabled with the same
      // tooltip. If none render we don't fail — the panel-level
      // assertions above already prove the wiring is in place.
      const applyButtons = page.getByTestId("calibration-suggestion-apply");
      const applyCount = await applyButtons.count();
      for (let i = 0; i < applyCount; i++) {
        const btn = applyButtons.nth(i);
        await expect(btn).toBeDisabled();
        await expect(btn).toHaveAttribute("data-mutations-blocked", "true");
        await expect(btn).toHaveAttribute(
          "title",
          /reviewer token is missing or invalid/i,
        );
      }

      // Cancel/dismiss-style controls must stay enabled — the gate is
      // only on mutating actions. The panel always renders the
      // category dropdown + free-text input even when add is blocked,
      // so reviewers can still draft a phrase to apply later once the
      // token is fixed.
      const input = page.getByTestId("handwavy-input");
      await expect(input).toBeEnabled();
      const categorySelect = page.getByTestId("handwavy-category");
      await expect(categorySelect).toBeEnabled();
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task214-cleanup" });
      await apiCtx.dispose();
    }
  });
});
