import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #361 — Coverage for the per-row × drop control on the dry-run
// REINSTATE preview panel (parity with Task #254 on the direct-click
// confirm dialog and Task #178 on the bulk-REMOVE preview).

const REVIEWER = "e2e-task361";
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

test.describe("FLAT hand-wavy phrase panel — batch reinstate dry-run preview 'drop one' control (Task #361)", () => {
  test("dropping one would-reinstate row via × reinstates only the remaining rows; the dropped phrase stays on the removal-history list", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task361 drop one");
    const droppedPhrase = phrases[1];
    const remainingPhrases = phrases.filter((p) => p !== droppedPhrase);

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
      const dropButtons = panel.getByTestId(
        "handwavy-reinstate-preview-result-drop",
      );
      await expect(dropButtons).toHaveCount(phrases.length);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toHaveCount(0);

      const confirmBtn = panel.getByTestId(
        "handwavy-reinstate-batch-preview-confirm",
      );
      await expect(confirmBtn).toContainText(
        `Confirm reinstate (${phrases.length})`,
      );

      // Drop the middle row and verify the row flips to "dropped",
      // counts/copy update, and the dropped-rows hint appears.
      const dropBtn = panel.locator(
        `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
      );
      await expect(dropBtn).toHaveCount(1);
      await dropBtn.click();

      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        ),
      ).toHaveCount(0);
      await expect(dropButtons).toHaveCount(remainingPhrases.length);
      await expect(wouldRows).toHaveCount(remainingPhrases.length);
      await expect(
        panel.locator(
          `[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="dropped"][data-phrase="${droppedPhrase}"]`,
        ),
      ).toHaveCount(1);
      await expect(panel).toContainText(
        `${remainingPhrases.length} of ${phrases.length}`,
      );
      await expect(confirmBtn).toContainText(
        `Confirm reinstate (${remainingPhrases.length})`,
      );
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toContainText("1 phrase will stay on the removal-history list");

      // With at least one row dropped, confirm must use per-phrase
      // /reinstate (the /reinstate-batch route has no allow-list).
      const subsetRequests: string[] = [];
      let sawBatchRequest = false;
      page.on("request", (req) => {
        if (req.method() !== "POST") return;
        const url = req.url();
        if (
          /\/feedback\/calibration\/handwavy-phrases\/reinstate-batch(?:\?|$)/.test(
            url,
          )
        ) {
          sawBatchRequest = true;
        } else if (
          /\/feedback\/calibration\/handwavy-phrases\/reinstate(?:\?|$)/.test(
            url,
          )
        ) {
          subsetRequests.push(url);
        }
      });

      await confirmBtn.click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      expect(sawBatchRequest).toBe(false);
      expect(subsetRequests.length).toBe(remainingPhrases.length);

      for (const p of remainingPhrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: droppedPhrase }),
      ).toHaveCount(0);

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

  test("with no rows dropped, confirm still uses the single-round-trip /reinstate-batch path", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task361 no drop");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toHaveCount(0);

      // No drops -> confirm should still hit /reinstate-batch.
      const batchRequest = page.waitForRequest(
        (req) =>
          req.method() === "POST" &&
          /\/feedback\/calibration\/handwavy-phrases\/reinstate-batch(?:\?|$)/.test(
            req.url(),
          ),
        { timeout: 10_000 },
      );

      await panel
        .getByTestId("handwavy-reinstate-batch-preview-confirm")
        .click();
      await batchRequest;
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

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

  test("dropping every would-reinstate row disables the confirm button so the empty preview can't accidentally fire", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task361 drop all");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      for (const p of phrases) {
        await panel
          .locator(
            `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${p}"]`,
          )
          .click();
      }

      // All rows dropped -> confirm becomes disabled; the panel stays open.
      await expect(
        panel.locator(
          '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
        ),
      ).toHaveCount(0);
      await expect(
        panel.getByTestId("handwavy-reinstate-preview-result-drop"),
      ).toHaveCount(0);

      const confirmBtn = panel.getByTestId(
        "handwavy-reinstate-batch-preview-confirm",
      );
      await expect(confirmBtn).toBeDisabled();
      await expect(confirmBtn).toContainText("Nothing to reinstate");
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toContainText(
        `${phrases.length} phrases will stay on the removal-history list`,
      );

      // Cancel — none of the phrases should have been reinstated.
      await panel
        .getByTestId("handwavy-reinstate-batch-preview-cancel")
        .click();
      await expect(panel).toHaveCount(0);
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }
      const batchBtnAfter = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtnAfter).toBeVisible();
      await expect(batchBtnAfter).toHaveText(
        new RegExp(`Reinstate all ${phrases.length}\\b`),
      );
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
