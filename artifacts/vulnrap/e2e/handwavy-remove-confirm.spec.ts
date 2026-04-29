import { test, expect, type Request } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  newApiContext,
  seedCycles,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #152 — End-to-end coverage for the high-thrash single-remove
// confirmation panel introduced in Task #139. The trash button on a phrase
// row routes through `requestRemove(phrase, cycles)` in
// feedback-analytics.tsx; when the phrase has >=2 completed remove+reinstate
// cycles in the audit history, the DELETE is paused behind a confirm panel
// (`handwavy-remove-confirm`) so the reviewer sees the prior cycles before
// triggering what's likely cycle #N+1. Lower-thrash phrases keep firing the
// DELETE immediately, exactly as before.
//
// This spec drives the real UI through three branches:
//   1. >=2 cycles → confirm panel appears with a cycle list, clicking
//      "Remove anyway" deletes the phrase and dismisses the panel.
//   2. >=2 cycles → "Back out" closes the panel without firing a DELETE
//      and the phrase stays on the active list.
//   3. 0 cycles → trash fires the DELETE immediately with no confirm panel.

const REVIEWER = "e2e-task152";
const REVIEWER_OPTS = { reviewer: REVIEWER };

test.describe("FLAT hand-wavy phrase panel — high-thrash remove confirmation (Task #139)", () => {
  test("phrase with >=2 completed cycles shows the confirm panel and 'Remove anyway' deletes it", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task152 thrashed", "phrase");

    try {
      await seedCycles(apiCtx, phrase, 2, REVIEWER_OPTS);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // The confirm panel is gated behind the click — it must not be open
      // before we press the trash button.
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);

      await row.getByTestId("handwavy-remove").click();

      const confirm = page.getByTestId("handwavy-remove-confirm");
      await expect(confirm).toBeVisible({ timeout: 10_000 });
      // The panel header echoes the phrase so the reviewer can't confuse it
      // with another row.
      await expect(confirm).toContainText(phrase);

      // The cycle list must render one <li> per completed remove+reinstate
      // cycle that we seeded (we did 2).
      const cycleItems = confirm
        .getByTestId("handwavy-remove-confirm-cycles")
        .locator("li");
      await expect(cycleItems).toHaveCount(2);

      // The DELETE has not fired yet — the phrase is still on the active
      // list while the confirm panel is open.
      await expect(row).toHaveCount(1);

      await confirm.getByTestId("handwavy-remove-confirm-go").click();

      // After the round-trip the panel goes away and the phrase is gone
      // from the active list.
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the high-thrash confirm panel closes it without firing a DELETE", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task152 backout", "phrase");

    try {
      await seedCycles(apiCtx, phrase, 2, REVIEWER_OPTS);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      await row.getByTestId("handwavy-remove").click();
      const confirm = page.getByTestId("handwavy-remove-confirm");
      await expect(confirm).toBeVisible({ timeout: 10_000 });

      // Watch network traffic from this point on so we can assert no DELETE
      // is issued when the reviewer backs out.
      const deleteCalls: string[] = [];
      const onRequest = (req: Request) => {
        if (
          req.method() === "DELETE" &&
          req.url().includes("/api/feedback/calibration/handwavy-phrases")
        ) {
          deleteCalls.push(req.url());
        }
      };
      page.on("request", onRequest);

      await confirm.getByTestId("handwavy-remove-confirm-cancel").click();
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0, {
        timeout: 10_000,
      });

      // Phrase must still be present.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);

      // Wait for the network to idle so any DELETE that the cancel handler
      // might have fired asynchronously would already be visible to the
      // request listener. This is more deterministic than a fixed sleep.
      await page.waitForLoadState("networkidle");
      page.off("request", onRequest);
      expect(
        deleteCalls,
        `Back out must not fire a DELETE; saw: ${deleteCalls.join(", ")}`,
      ).toEqual([]);
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("phrase with 0 cycles is removed immediately with no confirm panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task152 control", "phrase");

    try {
      // Control case: a freshly-added phrase has 0 completed cycles, so the
      // trash button must fire the DELETE immediately without showing the
      // confirm panel at all.
      await addPhrase(apiCtx, phrase, REVIEWER_OPTS);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);

      // Watch for any appearance of the confirm panel between the click
      // and the row vanishing — even a brief flash would be a regression.
      let confirmEverAppeared = false;
      const observer = page
        .getByTestId("handwavy-remove-confirm")
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => {
          confirmEverAppeared = true;
        })
        .catch(() => undefined);

      await row.getByTestId("handwavy-remove").click();

      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
      await observer;
      expect(
        confirmEverAppeared,
        "0-cycle phrase removal must not show the high-thrash confirm panel",
      ).toBe(false);
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
