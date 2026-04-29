import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #156 — End-to-end coverage for the FLAT hand-wavy phrase audit panel's
// "Reinstate all N" batch button. The backend helper + route already have
// unit tests, but nothing was exercising the rendered group structure
// (header row + indented inner rows), the disabled/loading state on the
// batch button, or the badge swaps between "All reinstated" /
// "Nothing to reinstate" / "X of N reinstated".
//
// This spec drives the real UI: it seeds a few unique phrases through the
// API, batch-removes them, then opens /feedback-analytics, expands the
// removal-history panel, finds the batch group by its data-batch-removed-at
// attribute, and verifies the button + badge swaps before/after clicking
// "Reinstate all".

const REVIEWER = "e2e-task156";
const REVIEWER_OPTS = { reviewer: REVIEWER };

async function openHistoryAndFindBatch(
  page: Page,
  batchRemovedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

  // The panel may need a beat to fetch. Wait for the toggle, then expand.
  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

  // Each batch group carries the parent removedAt ISO timestamp on the
  // wrapper, which uniquely identifies the group we just created.
  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${batchRemovedAt}"]`,
  );
  await expect(
    group,
    `expected to find a batch group with data-batch-removed-at="${batchRemovedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
}

test.describe("FLAT hand-wavy phrase panel — 'Reinstate all' batch button", () => {
  test("clicking 'Reinstate all N' brings every inner phrase back and flips the header to 'All reinstated'", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task156 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toBeVisible();

      // Inner rows: one per phrase, each rendered indented inside the batch
      // group with line-through formatting on the phrase span. They must be
      // present BEFORE the click so we know we're looking at the right group.
      const innerRows = group.getByTestId("handwavy-history-row");
      await expect(innerRows).toHaveCount(phrases.length);
      for (const p of phrases) {
        await expect(innerRows.filter({ hasText: p })).toHaveCount(1);
      }

      // The header should currently offer the batch reinstate button (and
      // NOT the "All reinstated" or "Nothing to reinstate" badges).
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toBeEnabled();
      await expect(batchBtn).toHaveText(new RegExp(`Reinstate all ${phrases.length}\\b`));
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);
      await expect(group.getByTestId("handwavy-history-batch-nothing-to-do")).toHaveCount(0);

      // None of these phrases should currently appear in the active list.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // Task #180 — the batch reinstate now goes through a confirm dialog
      // (mirroring Task #153's per-row reinstate confirm) so a misclick
      // doesn't re-enable an entire batch removal at once. The actual
      // reinstate only fires once the reviewer presses the Confirm button
      // inside that dialog.
      await batchBtn.click();
      const batchDialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(batchDialog).toBeVisible({ timeout: 5_000 });
      // The dialog should list every phrase that's about to come back so a
      // misclick is obvious before the reviewer confirms.
      const summary = batchDialog.getByTestId("handwavy-reinstate-batch-confirm-summary");
      await expect(summary).toBeVisible();
      for (const p of phrases) {
        await expect(summary).toContainText(p);
      }
      await batchDialog.getByTestId("handwavy-reinstate-batch-confirm-confirm").click();
      await expect(batchDialog).toHaveCount(0, { timeout: 5_000 });

      // After the round-trip the header swaps to "All reinstated" and the
      // batch button itself is gone.
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      await expect(group.getByTestId("handwavy-reinstate-batch")).toHaveCount(0);

      // Each inner row should now show the per-phrase "Reinstated" badge
      // and the active list should once again contain every phrase.
      await expect(group.getByTestId("handwavy-history-reinstated")).toHaveCount(phrases.length);
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

  test("per-phrase reinstate still works for a partial undo and the header tracks 'X of N reinstated' until the last one", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task156 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      const innerRows = group.getByTestId("handwavy-history-row");
      await expect(innerRows).toHaveCount(phrases.length);

      // Click the per-phrase reinstate on the first inner row only. Task #153
      // wraps this button in a confirmation dialog (mirroring the Revert
      // confirm), so we have to click through the dialog's Confirm button to
      // actually trigger the reinstate.
      const firstRow = innerRows.filter({ hasText: phrases[0] });
      await expect(firstRow).toHaveCount(1);
      await firstRow.getByTestId("handwavy-reinstate").click();
      const reinstateDialog = page.getByTestId("handwavy-reinstate-confirm");
      await expect(reinstateDialog).toBeVisible({ timeout: 5_000 });
      await reinstateDialog.getByTestId("handwavy-reinstate-confirm-confirm").click();
      await expect(reinstateDialog).toHaveCount(0, { timeout: 5_000 });

      // The first phrase shows up in the active list…
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrases[0] }),
      ).toHaveCount(1, { timeout: 15_000 });
      // …and the same row inside the history group flips to the
      // "Reinstated" badge.
      await expect(firstRow.getByTestId("handwavy-history-reinstated")).toBeVisible({
        timeout: 15_000,
      });

      // The header should now read "(1 of 3 reinstated)" and the batch
      // button should still be present, offering "Reinstate all 2".
      await expect(header).toContainText(`1 of ${phrases.length} reinstated`);
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toHaveText(/Reinstate all 2\b/);
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);

      // Reinstate the remaining two via the batch button. Task #180 wraps
      // this button in the same confirm dialog as the per-row reinstate, so
      // we have to click through Confirm to actually trigger the reinstate.
      await batchBtn.click();
      const batchDialog2 = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(batchDialog2).toBeVisible({ timeout: 5_000 });
      const summary2 = batchDialog2.getByTestId("handwavy-reinstate-batch-confirm-summary");
      await expect(summary2).toBeVisible();
      // Only the not-yet-reinstated phrases should be listed; the first
      // phrase has already been individually reinstated above so it must
      // NOT appear in the dialog summary.
      await expect(summary2).not.toContainText(phrases[0]);
      for (const p of phrases.slice(1)) {
        await expect(summary2).toContainText(p);
      }
      await batchDialog2.getByTestId("handwavy-reinstate-batch-confirm-confirm").click();
      await expect(batchDialog2).toHaveCount(0, { timeout: 5_000 });

      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      // Once the last one is reinstated, the "(X of N reinstated)" partial
      // counter is replaced by the "All reinstated" badge — the partial
      // text should NOT still be in the header.
      await expect(header).not.toContainText(`of ${phrases.length} reinstated`);
      await expect(group.getByTestId("handwavy-reinstate-batch")).toHaveCount(0);

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
