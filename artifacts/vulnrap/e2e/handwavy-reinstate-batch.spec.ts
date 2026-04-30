import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  reinstate,
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

      // Task #366 — fresh batch defaults collapsed; expand to interact.
      const rowsDetails = group.getByTestId("handwavy-history-batch-rows-details");
      if (!(await rowsDetails.evaluate((el) => (el as HTMLDetailsElement).open))) {
        await group.getByTestId("handwavy-history-batch-rows-summary").click();
      }
      await expect(rowsDetails).toHaveAttribute("open", /.*/);

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

  // Picker preview dialog (>5-phrase batch with one phrase already reinstated).
  test("picker 'Reinstate this batch' opens a preview dialog listing every phrase and per-phrase 'already reinstated' flags after a partial reinstate", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    // 8 > the 5-phrase picker sample cap.
    const phrases = uniquePhrases(8, "task244 picker");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const reinstatedPhrase = phrases[0];
      await reinstate(apiCtx, reinstatedPhrase, removedAt, REVIEWER_OPTS);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const pickerRow = page.locator(
        `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${removedAt}"]`,
      );
      await expect(pickerRow).toHaveCount(1, { timeout: 15_000 });

      // Picker samples are capped at 5; the dialog must close that gap.
      const samples = pickerRow.getByTestId("handwavy-removal-batches-samples");
      await expect(samples).toBeVisible();
      const samplesText = (await samples.innerText()) ?? "";
      const phrasesPresentInPickerRow = phrases.filter((p) =>
        samplesText.includes(p),
      );
      expect(phrasesPresentInPickerRow.length).toBeLessThan(phrases.length);

      const pickerBtn = pickerRow.getByTestId("handwavy-removal-batches-reinstate");
      await expect(pickerBtn).toBeVisible();
      await expect(pickerBtn).toBeEnabled();
      await pickerBtn.click();

      const previewDialog = page.getByTestId(
        "handwavy-removal-batches-preview-confirm",
      );
      await expect(previewDialog).toBeVisible({ timeout: 10_000 });
      await expect(previewDialog).toHaveAttribute("data-status", "ready", {
        timeout: 10_000,
      });

      const previewList = previewDialog.getByTestId(
        "handwavy-removal-batches-preview-list",
      );
      await expect(previewList).toBeVisible();
      for (const p of phrases) {
        await expect(previewList).toContainText(p);
      }

      const reinstatedRow = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-row"][data-already-reinstated="true"]`,
      );
      await expect(reinstatedRow).toHaveCount(1);
      await expect(reinstatedRow).toContainText(reinstatedPhrase);
      await expect(
        reinstatedRow.getByTestId("handwavy-removal-batches-preview-row-already"),
      ).toBeVisible();

      const pendingRows = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-row"][data-already-reinstated="false"]`,
      );
      await expect(pendingRows).toHaveCount(phrases.length - 1);

      await expect(
        previewDialog.getByTestId("handwavy-removal-batches-preview-already-note"),
      ).toBeVisible();
      await expect(
        previewDialog.getByTestId("handwavy-removal-batches-preview-remaining"),
      ).toHaveText(String(phrases.length - 1));

      // Task #341 — the Confirm button label itself must surface the
      // *remaining* phrase count (not the original batch total) on a
      // partial batch so reviewers can see exactly how many phrases will
      // actually be reinstated before they click. Here 1 of 8 has been
      // individually reinstated, so 7 are pending.
      const confirmBtn = previewDialog.getByTestId(
        "handwavy-removal-batches-preview-confirm-confirm",
      );
      await expect(confirmBtn).toHaveText(
        `Reinstate ${phrases.length - 1} remaining phrases`,
      );
      await expect(confirmBtn).toBeEnabled();

      // Cancel must NOT fire the mutation.
      await previewDialog
        .getByTestId("handwavy-removal-batches-preview-cancel")
        .click();
      await expect(previewDialog).toHaveCount(0, { timeout: 5_000 });
      await expect(
        pickerRow.getByTestId("handwavy-removal-batches-reinstated"),
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrases[1] }),
      ).toHaveCount(0);

      // Re-open and confirm.
      await pickerBtn.click();
      const previewDialog2 = page.getByTestId(
        "handwavy-removal-batches-preview-confirm",
      );
      await expect(previewDialog2).toBeVisible({ timeout: 10_000 });
      await expect(previewDialog2).toHaveAttribute("data-status", "ready", {
        timeout: 10_000,
      });
      await previewDialog2
        .getByTestId("handwavy-removal-batches-preview-confirm-confirm")
        .click();
      await expect(previewDialog2).toHaveCount(0, { timeout: 5_000 });

      await expect(
        pickerRow.getByTestId("handwavy-removal-batches-reinstated"),
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

  // Task #342 — picker preview groups phrases by category with a per-
  // category subtotal so reviewers triaging a mixed batch (e.g. some
  // hedging + some absence) can see the breakdown at a glance instead
  // of mentally tagging each row.
  test("picker preview groups phrases by category with per-category subtotals for a mixed batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const hedgingPhrases = uniquePhrases(3, "task342 hedging");
    const absencePhrases = uniquePhrases(2, "task342 absence");
    const buzzwordPhrases = uniquePhrases(1, "task342 buzzword");
    const allPhrases = [
      ...hedgingPhrases,
      ...absencePhrases,
      ...buzzwordPhrases,
    ];

    try {
      for (const p of hedgingPhrases) {
        await addPhrase(apiCtx, p, { ...REVIEWER_OPTS, category: "hedging" });
      }
      for (const p of absencePhrases) {
        await addPhrase(apiCtx, p, { ...REVIEWER_OPTS, category: "absence" });
      }
      for (const p of buzzwordPhrases) {
        await addPhrase(apiCtx, p, { ...REVIEWER_OPTS, category: "buzzword" });
      }
      const batch = await batchRemove(apiCtx, allPhrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const pickerRow = page.locator(
        `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${removedAt}"]`,
      );
      await expect(pickerRow).toHaveCount(1, { timeout: 15_000 });

      const pickerBtn = pickerRow.getByTestId(
        "handwavy-removal-batches-reinstate",
      );
      await expect(pickerBtn).toBeEnabled();
      await pickerBtn.click();

      const previewDialog = page.getByTestId(
        "handwavy-removal-batches-preview-confirm",
      );
      await expect(previewDialog).toBeVisible({ timeout: 10_000 });
      await expect(previewDialog).toHaveAttribute("data-status", "ready", {
        timeout: 10_000,
      });

      const previewList = previewDialog.getByTestId(
        "handwavy-removal-batches-preview-list",
      );
      await expect(previewList).toBeVisible();

      // Three category groups must render: one per category present in
      // the batch. Empty categories must NOT appear.
      const groups = previewList.getByTestId(
        "handwavy-removal-batches-preview-group",
      );
      await expect(groups).toHaveCount(3);

      // Each group should carry the matching count attribute and
      // contain only its own phrases.
      const absenceGroup = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-group"][data-category="absence"]`,
      );
      await expect(absenceGroup).toHaveCount(1);
      await expect(absenceGroup).toHaveAttribute(
        "data-category-count",
        String(absencePhrases.length),
      );
      await expect(
        absenceGroup.getByTestId(
          "handwavy-removal-batches-preview-group-count",
        ),
      ).toHaveText(String(absencePhrases.length));
      await expect(
        absenceGroup.getByTestId("handwavy-removal-batches-preview-row"),
      ).toHaveCount(absencePhrases.length);
      for (const p of absencePhrases) {
        await expect(absenceGroup).toContainText(p);
      }
      for (const p of [...hedgingPhrases, ...buzzwordPhrases]) {
        await expect(absenceGroup).not.toContainText(p);
      }

      const hedgingGroup = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-group"][data-category="hedging"]`,
      );
      await expect(hedgingGroup).toHaveCount(1);
      await expect(hedgingGroup).toHaveAttribute(
        "data-category-count",
        String(hedgingPhrases.length),
      );
      await expect(
        hedgingGroup.getByTestId(
          "handwavy-removal-batches-preview-group-count",
        ),
      ).toHaveText(String(hedgingPhrases.length));
      await expect(
        hedgingGroup.getByTestId("handwavy-removal-batches-preview-row"),
      ).toHaveCount(hedgingPhrases.length);
      for (const p of hedgingPhrases) {
        await expect(hedgingGroup).toContainText(p);
      }

      const buzzwordGroup = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-group"][data-category="buzzword"]`,
      );
      await expect(buzzwordGroup).toHaveCount(1);
      await expect(buzzwordGroup).toHaveAttribute(
        "data-category-count",
        String(buzzwordPhrases.length),
      );
      await expect(
        buzzwordGroup.getByTestId("handwavy-removal-batches-preview-row"),
      ).toHaveCount(buzzwordPhrases.length);

      // Sections render in the canonical order: absence → hedging →
      // buzzword (matching the CATEGORY_LABELS ordering in the page),
      // regardless of the batch's submission order.
      const renderedCategories = await groups.evaluateAll((nodes) =>
        nodes.map(
          (n) => (n as HTMLElement).getAttribute("data-category") ?? "",
        ),
      );
      expect(renderedCategories).toEqual(["absence", "hedging", "buzzword"]);

      // Per-row "will reinstate" badges still render on every row in
      // every group — grouping must NOT drop the existing flag.
      const willReinstate = previewList.locator(
        `[data-testid="handwavy-removal-batches-preview-row"][data-already-reinstated="false"]`,
      );
      await expect(willReinstate).toHaveCount(allPhrases.length);

      await previewDialog
        .getByTestId("handwavy-removal-batches-preview-cancel")
        .click();
      await expect(previewDialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, allPhrases, {
        reviewer: `${REVIEWER}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });
});
