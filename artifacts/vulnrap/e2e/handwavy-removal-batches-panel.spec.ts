import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #175 — End-to-end coverage for the inline "Recent batch removals"
// picker on /feedback-analytics. The panel is sourced from
// GET /feedback/calibration/handwavy-phrases/removal-batches and lets a
// reviewer reinstate a recent batch without scrolling the full removal-
// history panel. After the round-trip the row should swap to the
// "Already reinstated" badge and the active list should once again contain
// every phrase.

const REVIEWER = "e2e-task175";

// Spec-local helper: opens the panel and locates the row keyed by a known
// removedAt timestamp. Other handwavy specs don't have a panel like this
// (or look up rows by removedAt), so it stays out of the shared helper.
async function openPanelAndFindBatch(
  page: Page,
  removedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
  const panel = page.getByTestId("handwavy-removal-batches-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const row = page.locator(
    `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${removedAt}"]`,
  );
  await expect(
    row,
    `expected to find a removal-batches row with data-batch-removed-at="${removedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return row;
}

test.describe("FLAT hand-wavy phrase panel — 'Recent batch removals' picker", () => {
  test("renders a row per batch with samples and reinstates from a single click", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const row = await openPanelAndFindBatch(page, removedAt);

      // Sample list should include every phrase (batch size <= 5 sample cap).
      const samples = row.getByTestId("handwavy-removal-batches-samples");
      await expect(samples).toBeVisible();
      for (const p of phrases) {
        await expect(samples).toContainText(p);
      }

      // Active list should NOT yet contain any of these phrases.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // The reinstate button is present (no "already reinstated" badge yet).
      const btn = row.getByTestId("handwavy-removal-batches-reinstate");
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
      await expect(row.getByTestId("handwavy-removal-batches-reinstated")).toHaveCount(0);

      // The picker now opens a preview-and-confirm dialog before firing.
      await btn.click();
      const previewDialog = page.getByTestId(
        "handwavy-removal-batches-preview-confirm",
      );
      await expect(previewDialog).toBeVisible({ timeout: 5_000 });
      const previewList = previewDialog.getByTestId(
        "handwavy-removal-batches-preview-list",
      );
      await expect(previewList).toBeVisible();
      for (const p of phrases) {
        await expect(previewList).toContainText(p);
      }
      await previewDialog
        .getByTestId("handwavy-removal-batches-preview-confirm-confirm")
        .click();
      await expect(previewDialog).toHaveCount(0, { timeout: 5_000 });

      // After the round-trip the row swaps to the "Already reinstated" badge
      // and the button itself is gone.
      await expect(row.getByTestId("handwavy-removal-batches-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      await expect(row.getByTestId("handwavy-removal-batches-reinstate")).toHaveCount(0);

      // Every phrase should once again be on the active list.
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

  // Task #243 — when a batch is bigger than the 5-sample preview the
  // /removal-batches summary returns, the row should grow a "Show all" /
  // "Hide" toggle that reveals every phrase inline (sourced from the
  // existing handwavy-phrases history payload, no new endpoint).
  test("expands a >5-phrase row to reveal every phrase, then collapses again", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(7, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const row = await openPanelAndFindBatch(page, removedAt);

      // Collapsed state: still the truncated samples list with a "+N more"
      // hint, plus a toggle button. The samples list should not yet
      // contain the 6th/7th phrases.
      await expect(row).toHaveAttribute("data-batch-expanded", "false");
      const samples = row.getByTestId("handwavy-removal-batches-samples");
      await expect(samples).toBeVisible();
      await expect(samples).toContainText("+ 2 more");
      await expect(samples).toContainText(phrases[0]);
      await expect(samples).not.toContainText(phrases[5]);
      await expect(samples).not.toContainText(phrases[6]);
      await expect(row.getByTestId("handwavy-removal-batches-full")).toHaveCount(0);

      const toggle = row.getByTestId("handwavy-removal-batches-toggle");
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveText(/Show all \(7\)/);

      // Expand: every phrase should now render and the truncated list +
      // "+N more" hint should disappear.
      await toggle.click();
      await expect(row).toHaveAttribute("data-batch-expanded", "true");
      const full = row.getByTestId("handwavy-removal-batches-full");
      await expect(full).toBeVisible();
      for (const p of phrases) {
        await expect(full).toContainText(p);
      }
      await expect(row.getByTestId("handwavy-removal-batches-samples")).toHaveCount(0);
      await expect(toggle).toHaveText(/Hide/);

      // Collapse again — back to the samples preview.
      await toggle.click();
      await expect(row).toHaveAttribute("data-batch-expanded", "false");
      await expect(row.getByTestId("handwavy-removal-batches-samples")).toBeVisible();
      await expect(row.getByTestId("handwavy-removal-batches-full")).toHaveCount(0);
      await expect(toggle).toHaveText(/Show all \(7\)/);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #243 — small batches (<= 5 phrases, fully covered by the sample
  // preview) should NOT grow a "Show all" toggle; expanding would just
  // re-render the same list.
  test("does not render a toggle for batches that fit in the 5-sample preview", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const row = await openPanelAndFindBatch(page, removedAt);
      await expect(row.getByTestId("handwavy-removal-batches-samples")).toBeVisible();
      await expect(row.getByTestId("handwavy-removal-batches-toggle")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("rows for already-reinstated batches show the badge and no reinstate button", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Reinstate the whole batch directly through the API so the panel sees
      // it as "already reinstated" on first load.
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate-batch",
        { data: { removedAt, reviewer: `${REVIEWER}-pre` } },
      );
      expect(reinstateRes.ok()).toBeTruthy();

      const row = await openPanelAndFindBatch(page, removedAt);
      await expect(row.getByTestId("handwavy-removal-batches-reinstated")).toBeVisible();
      await expect(row.getByTestId("handwavy-removal-batches-reinstate")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #242 — when one or more phrases in a batch were re-added (or have
  // a newer removal entry) since the batch was first removed, the row
  // surfaces a small "N of M may overwrite recent edits" chip so the
  // reviewer is warned BEFORE clicking "Reinstate this batch". A clean
  // batch (no re-adds, no newer removals) shows no chip at all.
  test("surfaces a conflict chip when batch phrases were re-added since the removal", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task175 batch");

    try {
      // Add three, then remove all three as one batch. This is the row we
      // want the chip to appear on later.
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Re-add two of the three phrases AFTER the batch removal so the
      // active list now once again contains them. Reinstating the batch
      // would silently merge the historical state on top of these edits.
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });
      await addPhrase(apiCtx, phrases[1], { reviewer: REVIEWER });

      const row = await openPanelAndFindBatch(page, removedAt);
      const chip = row.getByTestId("handwavy-removal-batches-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("2 of 3 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "2");
      await expect(chip).toHaveAttribute("data-conflict-total", "3");

      // The chip is purely informational — the "Reinstate this batch"
      // button is still present and enabled.
      const btn = row.getByTestId("handwavy-removal-batches-reinstate");
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("counts a phrase as conflicting when it has a newer removal entry than the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task175 batch");

    try {
      // Add both phrases and remove them as one batch — this is the
      // "older" batch the chip should warn about.
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Now exercise the "newer history entry" branch (no re-adds left
      // on the active list at the moment of inspection): re-add ONE of
      // the two phrases and immediately remove it again. After this the
      // active list contains neither phrase, but one of them owns a
      // removal-history row whose removedAt is strictly newer than the
      // batch's removedAt — so it should still be flagged as a conflict.
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });
      const followUp = await batchRemove(apiCtx, [phrases[0]], { reviewer: REVIEWER });
      expect(followUp.historyEntry!.removedAt > removedAt).toBe(true);

      const row = await openPanelAndFindBatch(page, removedAt);
      const chip = row.getByTestId("handwavy-removal-batches-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("1 of 2 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "1");
      await expect(chip).toHaveAttribute("data-conflict-total", "2");
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("does not show a conflict chip when no phrases have been touched since the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const row = await openPanelAndFindBatch(page, removedAt);
      // The chip is omitted entirely (not just hidden) when the conflict
      // count is zero.
      await expect(
        row.getByTestId("handwavy-removal-batches-conflict-chip"),
      ).toHaveCount(0);
      await expect(row).toHaveAttribute("data-batch-conflict-count", "0");
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
