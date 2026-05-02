import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #513 — Coverage for the per-row undo affordance on a dropped row in
// the dry-run REINSTATE preview panel. Reviewers can drop a row by mistake
// and recover it without re-previewing the whole batch (which would wipe
// any other drop selections they've made on the same snapshot).

const REVIEWER = "e2e-task513";
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

test.describe("FLAT hand-wavy phrase panel — batch reinstate dry-run preview 'undo drop' control (Task #513)", () => {
  test("undoing a dropped row restores it to the pending reinstate set without re-previewing, preserving the other drop selections; confirm reinstates the restored row alongside the remaining undropped rows", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    // Three phrases: drop one then undo it, drop another and keep it dropped,
    // leave the third pending throughout. Confirm should reinstate two: the
    // restored phrase and the always-pending phrase, leaving the still-dropped
    // phrase on the removal-history list.
    const phrases = uniquePhrases(3, "task513 undo");
    const restoredPhrase = phrases[0];
    const stillDroppedPhrase = phrases[1];
    const alwaysPendingPhrase = phrases[2];
    const expectedReinstated = [restoredPhrase, alwaysPendingPhrase];

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const previewBtn = group.getByTestId("handwavy-reinstate-batch-preview");
      await expect(previewBtn).toBeVisible();
      await previewBtn.click();

      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      await expect(
        panel.getByTestId("handwavy-reinstate-preview-result-restore"),
      ).toHaveCount(0);

      const confirmBtn = panel.getByTestId(
        "handwavy-reinstate-batch-preview-confirm",
      );
      await expect(confirmBtn).toContainText(
        `Confirm reinstate (${phrases.length})`,
      );

      // Drop two of the three rows to set up the undo scenario.
      for (const p of [restoredPhrase, stillDroppedPhrase]) {
        await panel
          .locator(
            `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${p}"]`,
          )
          .click();
      }

      await expect(wouldRows).toHaveCount(1);
      await expect(
        panel.locator(
          '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="dropped"]',
        ),
      ).toHaveCount(2);
      await expect(confirmBtn).toContainText(`Confirm reinstate (1)`);
      await expect(panel).toContainText(`1 of ${phrases.length}`);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toContainText(`2 phrases will stay on the removal-history list`);

      // The dropped rows expose an undo affordance; the still-pending row
      // does not (it's already in the reinstate set).
      const restoreButtons = panel.getByTestId(
        "handwavy-reinstate-preview-result-restore",
      );
      await expect(restoreButtons).toHaveCount(2);
      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-preview-result-restore"][data-phrase="${alwaysPendingPhrase}"]`,
        ),
      ).toHaveCount(0);

      // Task #513's whole point: undo must be in-place on the open dry-run
      // snapshot — no second /reinstate-batch/dry-run round-trip should fire
      // when the reviewer clicks the restore button. Capture dry-run POSTs
      // so we can assert the count stays at zero from this point on.
      const previewRequests: string[] = [];
      page.on("request", (req) => {
        if (req.method() !== "POST") return;
        const url = req.url();
        if (
          /\/feedback\/calibration\/handwavy-phrases\/reinstate-batch\/dry-run(?:\?|$)/.test(
            url,
          )
        ) {
          previewRequests.push(url);
        }
      });

      // Undo the drop on the first phrase. The row should flip back to
      // "would reinstate", counts/copy should bump back accordingly, and
      // we must NOT have re-run the dry-run preview (Task #513's whole
      // point is that undo is in-place on the existing snapshot).
      await panel
        .locator(
          `[data-testid="handwavy-reinstate-preview-result-restore"][data-phrase="${restoredPhrase}"]`,
        )
        .click();

      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"][data-phrase="${restoredPhrase}"]`,
        ),
      ).toHaveCount(1);
      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-preview-result-restore"][data-phrase="${restoredPhrase}"]`,
        ),
      ).toHaveCount(0);
      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${restoredPhrase}"]`,
        ),
      ).toHaveCount(1);
      await expect(wouldRows).toHaveCount(2);
      await expect(
        panel.locator(
          '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="dropped"]',
        ),
      ).toHaveCount(1);
      await expect(confirmBtn).toContainText(`Confirm reinstate (2)`);
      await expect(panel).toContainText(`2 of ${phrases.length}`);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toContainText(`1 phrase will stay on the removal-history list`);
      expect(previewRequests).toEqual([]);

      await confirmBtn.click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      // Confirm itself must not have re-run the dry-run preview either —
      // it should reinstate straight from the in-memory drop selection.
      expect(previewRequests).toEqual([]);

      for (const p of expectedReinstated) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: stillDroppedPhrase }),
      ).toHaveCount(0);

      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toContainText(
        `${expectedReinstated.length} of ${phrases.length} reinstated`,
      );
      const batchBtnAfter = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtnAfter).toBeVisible();
      await expect(batchBtnAfter).toHaveText(/Reinstate all 1\b/);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
