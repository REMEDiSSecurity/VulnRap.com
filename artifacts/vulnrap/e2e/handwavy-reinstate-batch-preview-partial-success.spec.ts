import { test, expect, type Page, type Locator } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #514 — Coverage for the partial-success outcome panel that
// surfaces below a batch group when the dry-run preview's subset
// confirm comes back with a mix of `reinstated: true` and
// `reinstated: false` results from the server.
//
// Background: post-Task #360, dropping at least one row in the
// reinstate dry-run preview routes confirm through
// `handleReinstateBatchSubset`, which collapses the surviving rows
// into a single /reinstate-batch round-trip with a `phrases`
// allow-list. If a teammate re-adds one of those allow-listed
// phrases between preview and confirm (or per-phrase reinstates one
// elsewhere), the server's `results[]` will contain a mix of
// reinstated/skipped entries — the existing toast/banner mentions
// the count but the preview panel itself just disappears, leaving
// no panel-side acknowledgement of which rows actually landed.
// This spec drives that mid-flight failure and asserts the new
// outcome panel renders the per-row outcomes.

const REVIEWER = "e2e-task514";
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

test.describe("FLAT hand-wavy phrase panel — batch reinstate subset confirm partial-success outcome panel (Task #514)", () => {
  test("subset confirm with a mid-flight re-add of one allow-listed phrase surfaces a per-row outcome panel listing the failed phrase by name", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    // Three phrases so we can drop one (subset path) AND have one of
    // the remaining two re-added between preview and confirm — leaving
    // exactly one reinstated + one failed in the server's results.
    const phrases = uniquePhrases(3, "task514 partial");
    const droppedPhrase = phrases[0];
    const reAddedPhrase = phrases[1];
    const landedPhrase = phrases[2];

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);

      // Open the dry-run preview panel.
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Drop one row via the × control so confirm routes through
      // `handleReinstateBatchSubset` (the allow-list /reinstate-batch
      // path), which is what populates the partial-success outcome
      // state when the server returns mixed results.
      await panel
        .locator(
          `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        )
        .click();
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-dropped-note"),
      ).toBeVisible();

      // Mid-flight failure injection: re-add `reAddedPhrase` to the
      // active list directly via the API. From the server's POV the
      // upcoming /reinstate-batch confirm call will see this phrase
      // as already-active and return `reinstated: false, reason:
      // "already-active"` for it, while still successfully reinstating
      // `landedPhrase`. The browser's `phrases` cache still shows the
      // pre-injection state at the moment of confirm — that's exactly
      // the race the new outcome panel is meant to surface.
      await addPhrase(apiCtx, reAddedPhrase, {
        reviewer: `${REVIEWER}-midflight`,
      });

      // The outcome panel must not exist before confirm — only the
      // mutating round-trip populates it.
      await expect(
        group.getByTestId("handwavy-reinstate-batch-outcome-panel"),
      ).toHaveCount(0);

      await panel
        .getByTestId("handwavy-reinstate-batch-preview-confirm")
        .click();

      // The dry-run preview panel collapses (its job is done).
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      // The new partial-success outcome panel takes its place,
      // scoped to the same batch group, with one reinstated and
      // one failed result.
      const outcomePanel = group.getByTestId(
        "handwavy-reinstate-batch-outcome-panel",
      );
      await expect(outcomePanel).toBeVisible({ timeout: 15_000 });
      await expect(outcomePanel).toHaveAttribute(
        "data-batch-removed-at",
        removedAt,
      );
      await expect(outcomePanel).toHaveAttribute("data-reinstated-count", "1");
      await expect(outcomePanel).toHaveAttribute("data-failed-count", "1");
      await expect(
        outcomePanel.getByTestId("handwavy-reinstate-batch-outcome-title"),
      ).toContainText("Partial reinstate: 1 of 2 landed");

      // Per-row outcomes — `landedPhrase` reinstated; `reAddedPhrase`
      // failed with reason `already-active`. The dropped phrase was
      // never sent to the server (allow-list excluded it), so it
      // must NOT appear in the outcome rows.
      const outcomeRows = outcomePanel.getByTestId(
        "handwavy-reinstate-batch-outcome-row",
      );
      await expect(outcomeRows).toHaveCount(2);

      const landedRow = outcomePanel.locator(
        `[data-testid="handwavy-reinstate-batch-outcome-row"][data-phrase="${landedPhrase}"]`,
      );
      await expect(landedRow).toHaveCount(1);
      await expect(landedRow).toHaveAttribute("data-outcome", "reinstated");
      await expect(landedRow).toContainText("reinstated");

      const failedRow = outcomePanel.locator(
        `[data-testid="handwavy-reinstate-batch-outcome-row"][data-phrase="${reAddedPhrase}"]`,
      );
      await expect(failedRow).toHaveCount(1);
      await expect(failedRow).toHaveAttribute("data-outcome", "already-active");
      await expect(failedRow).toContainText("failed: already active");

      await expect(
        outcomePanel.locator(
          `[data-testid="handwavy-reinstate-batch-outcome-row"][data-phrase="${droppedPhrase}"]`,
        ),
      ).toHaveCount(0);

      // The summary line must list the failed phrase by name so a
      // reviewer skimming the panel can spot exactly which row
      // didn't land without parsing the per-row badges.
      const failedSummary = outcomePanel.getByTestId(
        "handwavy-reinstate-batch-outcome-failed-summary",
      );
      await expect(failedSummary).toBeVisible();
      await expect(failedSummary).toContainText(reAddedPhrase);
      await expect(failedSummary).not.toContainText(landedPhrase);

      // The reinstated phrase + the mid-flight re-added phrase are
      // both in the active list now; the dropped phrase stays
      // removed.
      for (const p of [landedPhrase, reAddedPhrase]) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: droppedPhrase }),
      ).toHaveCount(0);

      // Dismiss collapses the outcome panel without firing any
      // further requests; the batch header stays around because the
      // dropped phrase is still removed.
      await outcomePanel
        .getByTestId("handwavy-reinstate-batch-outcome-dismiss")
        .click();
      await expect(outcomePanel).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("subset confirm where every allow-listed phrase still lands keeps today's behavior — no outcome panel rendered", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task514 success");
    const droppedPhrase = phrases[0];
    const remainingPhrase = phrases[1];

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      await panel
        .locator(
          `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        )
        .click();
      await panel
        .getByTestId("handwavy-reinstate-batch-preview-confirm")
        .click();

      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      // The success-only path must NOT render the outcome panel —
      // the existing toast/refresh is sufficient when every
      // allow-listed phrase landed.
      await expect(
        group.getByTestId("handwavy-reinstate-batch-outcome-panel"),
      ).toHaveCount(0);

      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: remainingPhrase }),
      ).toHaveCount(1, { timeout: 15_000 });
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: droppedPhrase }),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("re-previewing after a partial-success confirm clears the outcome panel and reflects the post-confirm state", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task514 repreview");
    const droppedPhrase = phrases[0];
    const reAddedPhrase = phrases[1];
    const landedPhrase = phrases[2];

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, REVIEWER_OPTS);
      const batch = await batchRemove(apiCtx, phrases, REVIEWER_OPTS);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      await panel
        .locator(
          `[data-testid="handwavy-reinstate-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        )
        .click();
      await addPhrase(apiCtx, reAddedPhrase, {
        reviewer: `${REVIEWER}-midflight`,
      });

      await panel
        .getByTestId("handwavy-reinstate-batch-preview-confirm")
        .click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const outcomePanel = group.getByTestId(
        "handwavy-reinstate-batch-outcome-panel",
      );
      await expect(outcomePanel).toBeVisible({ timeout: 15_000 });

      // Re-preview from the outcome panel should drop the outcome
      // panel and reopen the dry-run preview reflecting the
      // post-confirm state (only the dropped phrase is still on the
      // removal-history list and not currently active, so it's the
      // sole would-reinstate row).
      await outcomePanel
        .getByTestId("handwavy-reinstate-batch-outcome-repreview")
        .click();
      await expect(outcomePanel).toHaveCount(0, { timeout: 15_000 });

      const repreviewPanel = group.getByTestId(
        "handwavy-reinstate-batch-preview-panel",
      );
      await expect(repreviewPanel).toBeVisible({ timeout: 15_000 });

      const wouldRows = repreviewPanel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(1);
      await expect(wouldRows.first()).toContainText(droppedPhrase);

      // The reinstated row from the prior confirm shows up as
      // "already-reinstated" in the new dry-run; the mid-flight
      // re-added row shows up as "already-active".
      await expect(
        repreviewPanel.locator(
          `[data-testid="handwavy-reinstate-batch-preview-row"][data-phrase="${landedPhrase}"]`,
        ),
      ).toHaveAttribute("data-outcome", "already-reinstated");
      await expect(
        repreviewPanel.locator(
          `[data-testid="handwavy-reinstate-batch-preview-row"][data-phrase="${reAddedPhrase}"]`,
        ),
      ).toHaveAttribute("data-outcome", "already-active");
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
