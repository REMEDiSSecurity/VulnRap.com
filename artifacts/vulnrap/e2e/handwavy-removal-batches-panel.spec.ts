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

// Task #339 — sibling helper for the OLDER "Removal & undo history" panel
// below the picker. The history panel is collapsed by default behind a
// toggle; once expanded each batch becomes a `handwavy-history-batch-group`
// keyed by ISO `removedAt`.
async function openHistoryAndFindBatchGroup(
  page: Page,
  removedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();
  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${removedAt}"]`,
  );
  await expect(
    group,
    `expected to find a history batch group with data-batch-removed-at="${removedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
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

  // Task #340 — clicking the conflict chip should reveal an inline detail
  // panel that names every conflicting phrase, distinguishing "currently
  // active" entries from "removed again on <date>" entries. The previous
  // chip only surfaced a count ("3 of 5 may overwrite recent edits"), which
  // forced reviewers into the full removal-history panel to figure out
  // which phrases were actually conflicting.
  test("expands the conflict chip into a detail list with per-phrase status", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Set up a mixed-status conflict: phrase[0] is currently back on
      // the active list, phrase[1] was re-added then re-removed (so it
      // owns a newer removal-history entry), and phrase[2] is untouched
      // (no conflict — should not appear in the detail list).
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });
      await addPhrase(apiCtx, phrases[1], { reviewer: REVIEWER });
      const followUp = await batchRemove(apiCtx, [phrases[1]], {
        reviewer: REVIEWER,
      });
      expect(followUp.historyEntry!.removedAt > removedAt).toBe(true);

      const row = await openPanelAndFindBatch(page, removedAt);
      const chip = row.getByTestId("handwavy-removal-batches-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("2 of 3 may overwrite recent edits");

      // Detail panel is closed by default.
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(row).toHaveAttribute("data-batch-conflict-expanded", "false");
      await expect(
        row.getByTestId("handwavy-removal-batches-conflict-detail"),
      ).toHaveCount(0);

      // Click the chip → detail panel opens with one row per conflicting
      // phrase (the untouched phrase[2] should NOT appear).
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(row).toHaveAttribute("data-batch-conflict-expanded", "true");
      const detail = row.getByTestId("handwavy-removal-batches-conflict-detail");
      await expect(detail).toBeVisible();

      const conflictRows = detail.getByTestId(
        "handwavy-removal-batches-conflict-row",
      );
      await expect(conflictRows).toHaveCount(2);

      const activeRow = detail.locator(
        `[data-testid="handwavy-removal-batches-conflict-row"][data-conflict-phrase="${phrases[0]}"]`,
      );
      await expect(activeRow).toHaveAttribute("data-conflict-status", "active");
      await expect(activeRow).toContainText(phrases[0]);
      await expect(activeRow).toContainText("currently active");

      const removedAgainRow = detail.locator(
        `[data-testid="handwavy-removal-batches-conflict-row"][data-conflict-phrase="${phrases[1]}"]`,
      );
      await expect(removedAgainRow).toHaveAttribute(
        "data-conflict-status",
        "removed-again",
      );
      await expect(removedAgainRow).toContainText(phrases[1]);
      await expect(removedAgainRow).toContainText(/removed again on /);

      // Untouched phrase[2] should not appear in the detail list at all.
      await expect(detail).not.toContainText(phrases[2]);

      // Click again to collapse — the detail panel disappears.
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await expect(
        row.getByTestId("handwavy-removal-batches-conflict-detail"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #340 — each "currently active" phrase in the detail panel should
  // be a click target that scrolls + pulse-highlights the matching row in
  // the active phrase list (mirrors the existing draft-overlap hint
  // behavior backed by `jumpToActivePhrase`).
  test("clicking an active conflict phrase highlights the matching active-list row", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task175 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Re-add the first phrase so it conflicts as "currently active".
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });

      const row = await openPanelAndFindBatch(page, removedAt);
      const chip = row.getByTestId("handwavy-removal-batches-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await chip.click();

      const detail = row.getByTestId("handwavy-removal-batches-conflict-detail");
      await expect(detail).toBeVisible();

      const jumpButton = detail.getByTestId(
        "handwavy-removal-batches-conflict-jump",
      );
      await expect(jumpButton).toHaveCount(1);
      await expect(jumpButton).toContainText(phrases[0]);

      // Locate the matching active-list row by its stable phrase hook.
      const activeRow = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${phrases[0]}"]`,
      );
      await expect(activeRow).toHaveCount(1);
      await expect(activeRow).not.toHaveAttribute("data-highlighted", "true");

      // Click the phrase → the active row gets the pulse-highlight class.
      await jumpButton.click();
      await expect(activeRow).toHaveAttribute("data-highlighted", "true", {
        timeout: 5_000,
      });
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #339 — the same "N of M may overwrite recent edits" chip Task
  // #242 added to the picker rows must also surface on the OLDER
  // "Removal & undo history" panel's batch-group header (the row that
  // carries its own "Reinstate all" button). A reviewer scrolling into
  // the history panel should get the same warning before clicking the
  // batch reinstate, not silently overwrite recent edits. A clean
  // batch (no re-adds) shows no chip at all.
  test("history-panel batch group header shows the same conflict chip when phrases were re-added since the removal", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task339 history batch");

    try {
      // Add three, then remove all three as one batch — this is the
      // batch group whose header we want the chip to appear on.
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Re-add two of the three so the active list once again contains
      // them — reinstating the batch would silently merge the historical
      // state on top of those edits.
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });
      await addPhrase(apiCtx, phrases[1], { reviewer: REVIEWER });

      const group = await openHistoryAndFindBatchGroup(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toBeVisible();
      const chip = header.getByTestId("handwavy-history-batch-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("2 of 3 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "2");
      await expect(chip).toHaveAttribute("data-conflict-total", "3");
      await expect(group).toHaveAttribute("data-batch-conflict-count", "2");

      // The chip is purely informational — both the "Preview reinstate"
      // and "Reinstate all" buttons are still present and enabled.
      await expect(group.getByTestId("handwavy-reinstate-batch-preview")).toBeEnabled();
      await expect(group.getByTestId("handwavy-reinstate-batch")).toBeEnabled();
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("history-panel batch group header omits the conflict chip for a clean batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task339 history batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatchGroup(page, removedAt);
      await expect(
        group.getByTestId("handwavy-history-batch-conflict-chip"),
      ).toHaveCount(0);
      await expect(group).toHaveAttribute("data-batch-conflict-count", "0");
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #339 — the picker endpoint /removal-batches caps its response at
  // the 10 most recent batches by default. The history panel below it has
  // its own independent (much larger) cap and therefore commonly shows
  // batches that don't appear in the picker. The conflict chip on the
  // history panel header must NOT be silently dropped just because the
  // batch fell off the picker — it has to keep working from the
  // handwavy-phrases history payload alone.
  test("history-panel batch group shows the conflict chip even when the batch is older than the picker's recent-N cap", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const targetPhrases = uniquePhrases(3, "task339 older batch");
    // Pre-allocate the noise batches as 1-phrase batches so the picker fills
    // up with unrelated newer entries and our target falls off the end.
    // The default REMOVAL_BATCHES_DEFAULT_LIMIT is 10, so 11 newer batches
    // is enough to guarantee the target is excluded from the picker.
    const noiseBatches = Array.from({ length: 11 }, (_, i) =>
      uniquePhrases(1, `task339 noise ${i}`),
    );

    try {
      // 1) Set up the target batch — three phrases removed as one batch.
      for (const p of targetPhrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const targetBatch = await batchRemove(apiCtx, targetPhrases, { reviewer: REVIEWER });
      const targetRemovedAt = targetBatch.historyEntry!.removedAt;

      // 2) Re-add two of the three so the target batch carries a real
      //    conflict count.
      await addPhrase(apiCtx, targetPhrases[0], { reviewer: REVIEWER });
      await addPhrase(apiCtx, targetPhrases[1], { reviewer: REVIEWER });

      // 3) Push the target out of the picker by creating 11 newer
      //    1-phrase batches.
      for (const noise of noiseBatches) {
        for (const p of noise) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
        await batchRemove(apiCtx, noise, { reviewer: REVIEWER });
      }

      // Sanity: the picker really does NOT include the target batch.
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      const pickerRow = page.locator(
        `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${targetRemovedAt}"]`,
      );
      await expect(
        pickerRow,
        "target batch should have fallen off the picker's recent-N cap",
      ).toHaveCount(0, { timeout: 15_000 });

      // The history panel is below the picker and should still show the
      // group + the conflict chip.
      const group = await openHistoryAndFindBatchGroup(page, targetRemovedAt);
      const chip = group
        .getByTestId("handwavy-history-batch-header")
        .getByTestId("handwavy-history-batch-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("2 of 3 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "2");
      await expect(chip).toHaveAttribute("data-conflict-total", "3");
      await expect(group).toHaveAttribute("data-batch-conflict-count", "2");
    } finally {
      const everyPhrase = [
        ...targetPhrases,
        ...noiseBatches.flatMap((b) => b),
      ];
      await cleanup(apiCtx, everyPhrase, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #470 — the picker rows (#242) and history-panel batch group
  // headers (#339) both surface a "N of M may overwrite recent edits"
  // chip when phrases were re-added since the batch removal. The same
  // chip MUST also appear on the final `handwavy-reinstate-batch-confirm`
  // AlertDialog (the click-through that actually fires the batch
  // reinstate) so a reviewer who missed the header chip and clicks
  // "Reinstate all" still gets a last-chance warning before committing.
  // A clean batch (no re-adds) shows no chip on the dialog at all.
  test("reinstate-batch confirm dialog shows the same conflict chip when phrases were re-added since the removal", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task470 confirm chip");

    try {
      // Add three, then remove all three as one batch — this is the
      // batch whose confirm dialog we want the chip to appear on.
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      // Re-add two of the three so reinstating the batch would silently
      // merge the historical state on top of those edits.
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });
      await addPhrase(apiCtx, phrases[1], { reviewer: REVIEWER });

      const group = await openHistoryAndFindBatchGroup(page, removedAt);
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await batchBtn.click();

      const dialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toHaveAttribute("data-batch-conflict-count", "2");

      const chip = dialog.getByTestId(
        "handwavy-reinstate-batch-confirm-conflict-chip",
      );
      await expect(chip).toBeVisible();
      await expect(chip).toContainText("2 of 3 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "2");
      await expect(chip).toHaveAttribute("data-conflict-total", "3");

      // The chip is purely informational — the confirm button is still
      // present and enabled.
      await expect(
        dialog.getByTestId("handwavy-reinstate-batch-confirm-confirm"),
      ).toBeEnabled();

      await dialog.getByTestId("handwavy-reinstate-batch-confirm-cancel").click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("reinstate-batch confirm dialog omits the conflict chip for a clean batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task470 confirm clean");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatchGroup(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch").click();

      const dialog = page.getByTestId("handwavy-reinstate-batch-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toHaveAttribute("data-batch-conflict-count", "0");
      await expect(
        dialog.getByTestId("handwavy-reinstate-batch-confirm-conflict-chip"),
      ).toHaveCount(0);

      await dialog.getByTestId("handwavy-reinstate-batch-confirm-cancel").click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
