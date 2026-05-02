import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #254 — End-to-end coverage for the per-row "skip" / × control on the
// batch reinstate confirm dialog. Mirrors the bulk-REMOVE preview's drop
// affordance (Task #178): clicking the × removes that phrase from the
// pending reinstate set without cancelling the whole dialog. Confirm then
// reinstates only the rows the reviewer left checked; the dropped phrases
// stay on the removal-history list as removed.

const REVIEWER = "e2e-task254";
const REVIEWER_OPTS = { reviewer: REVIEWER };

async function openHistoryAndFindBatch(
  page: Page,
  batchRemovedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${batchRemovedAt}"]`,
  );
  await expect(
    group,
    `expected to find a batch group with data-batch-removed-at="${batchRemovedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
}

test.describe("FLAT hand-wavy phrase panel — batch reinstate confirm 'drop one' control (Task #254)", () => {
  test("dropping one phrase via × reinstates only the remaining rows; the dropped phrase stays on the removal-history list", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task254 drop one");
    const droppedPhrase = phrases[1];
    const remainingPhrases = phrases.filter((p) => p !== droppedPhrase);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toHaveText(new RegExp(`Reinstate all ${phrases.length}\\b`));

      await batchBtn.click();
      const dialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // The summary lists every phrase from the batch and exposes a
      // per-row drop button keyed by data-phrase.
      const summary = dialog.getByTestId("handwavy-reinstate-batch-confirm-summary");
      await expect(summary).toBeVisible();
      for (const p of phrases) {
        await expect(summary).toContainText(p);
      }
      const dropButtons = dialog.getByTestId("handwavy-reinstate-batch-confirm-drop");
      await expect(dropButtons).toHaveCount(phrases.length);

      // Drop the middle phrase. The dialog title + count update, the row
      // disappears from the summary, and a "will stay on the removal-history
      // list" note appears so the reviewer knows confirm won't act on it.
      const dropBtn = dialog.locator(
        `[data-testid="handwavy-reinstate-batch-confirm-drop"][data-phrase="${droppedPhrase}"]`,
      );
      await expect(dropBtn).toHaveCount(1);
      await dropBtn.click();

      await expect(
        dialog.locator(
          `[data-testid="handwavy-reinstate-batch-confirm-drop"][data-phrase="${droppedPhrase}"]`,
        ),
      ).toHaveCount(0);
      await expect(dropButtons).toHaveCount(remainingPhrases.length);
      await expect(summary).not.toContainText(droppedPhrase);
      for (const p of remainingPhrases) {
        await expect(summary).toContainText(p);
      }
      await expect(
        page.getByRole("alertdialog").getByRole("heading"),
      ).toContainText(
        `Reinstate ${remainingPhrases.length} phrase${remainingPhrases.length === 1 ? "" : "s"} from this batch?`,
      );
      await expect(
        dialog.getByTestId("handwavy-reinstate-batch-confirm-dropped-note"),
      ).toContainText("1 phrase will stay on the removal-history list");

      // Task #479 — once at least one row has been dropped via the trim
      // chips, the Confirm button surfaces the remaining count instead
      // of the generic "Reinstate batch" label, mirroring the picker
      // preview dialog (Task #341).
      const confirmBtn = dialog.getByTestId(
        "handwavy-reinstate-batch-confirm-confirm",
      );
      await expect(confirmBtn).toHaveText(
        `Reinstate ${remainingPhrases.length} remaining phrase${remainingPhrases.length === 1 ? "" : "s"}`,
      );

      // Confirm. Per-phrase reinstates fire for the remaining rows; the
      // dropped phrase is left as removed.
      await confirmBtn.click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });

      // The remaining phrases should reappear in the active list and flip to
      // "Reinstated" inside the batch group, while the dropped phrase stays
      // as a still-removed inner row (no Reinstated badge yet).
      for (const p of remainingPhrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: droppedPhrase }),
      ).toHaveCount(0);

      // Inside the history group the partial-counter header should reflect
      // "(2 of 3 reinstated)" and the batch button should still be present
      // for the one remaining (dropped) phrase.
      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toContainText(
        `${remainingPhrases.length} of ${phrases.length} reinstated`,
      );
      const batchBtnAfter = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtnAfter).toBeVisible();
      await expect(batchBtnAfter).toHaveText(/Reinstate all 1\b/);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("dropping the last remaining phrase closes the dialog without reinstating anything", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task254 drop all");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await batchBtn.click();
      const dialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Drop every phrase one at a time. Dropping the last one closes the
      // dialog (same end state as Cancel) — no reinstates fire.
      for (const p of phrases) {
        await dialog
          .locator(
            `[data-testid="handwavy-reinstate-batch-confirm-drop"][data-phrase="${p}"]`,
          )
          .click();
      }
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });

      // Active list still does NOT contain any of these phrases — nothing
      // was reinstated.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }
      // The batch group still offers "Reinstate all 2" — the batch was
      // untouched.
      const batchBtnAfter = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtnAfter).toBeVisible();
      await expect(batchBtnAfter).toHaveText(/Reinstate all 2\b/);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("with no rows dropped, confirm still uses the single-round-trip batch reinstate path", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task254 no drop");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await batchBtn.click();
      const dialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // The "X will stay on the removal-history list" note should NOT be
      // rendered when nothing has been dropped.
      await expect(
        dialog.getByTestId("handwavy-reinstate-batch-confirm-dropped-note"),
      ).toHaveCount(0);

      // Watch for the single-round-trip /reinstate-batch call so we can
      // prove the unchanged path still goes through the batched route
      // (not per-phrase /reinstate calls).
      const batchRequest = page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          /\/feedback\/calibration\/handwavy-phrases\/reinstate-batch(?:\?|$)/.test(
            req.url(),
          ),
        { timeout: 10_000 },
      );

      await dialog.getByTestId("handwavy-reinstate-batch-confirm-confirm").click();
      await batchRequest;
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });

      await expect(
        group.getByTestId("handwavy-history-batch-reinstated"),
      ).toBeVisible({ timeout: 15_000 });
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
