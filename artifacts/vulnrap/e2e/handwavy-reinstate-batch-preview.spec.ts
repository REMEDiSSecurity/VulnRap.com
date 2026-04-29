import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #177 — End-to-end coverage for the per-batch "Preview reinstate"
// affordance on the FLAT hand-wavy phrase audit panel. The button calls
// POST /feedback/calibration/handwavy-phrases/reinstate-batch with
// dryRun: true (Task #159) so the reviewer can inspect the per-phrase
// outcome (would reinstate / already reinstated / already active) before
// committing. A "Confirm reinstate" button inside the rendered panel
// then runs the real (non-dry-run) call.
//
// The backend dry-run path already has unit coverage; this spec exercises
// the rendered button + panel, the per-phrase row outcomes, and the
// transition from preview → confirm → "All reinstated".

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext() {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

interface BatchRemovalResponse {
  batch: true;
  removed: number;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

function uniquePhrases(count: number): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from({ length: count }, (_, i) => `task177 preview ${id} phrase ${i + 1}`);
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task177" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function batchRemove(
  api: APIRequestContext,
  phrases: string[],
): Promise<BatchRemovalResponse> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrases, reviewer: "e2e-task177" },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (batch) failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as BatchRemovalResponse;
  expect(body.batch).toBe(true);
  expect(body.removed).toBe(phrases.length);
  expect(body.historyEntry?.removedAt, "batch removal should produce a history entry").toBeTruthy();
  return body;
}

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task177-cleanup" },
    })
    .catch(() => undefined);
}

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

test.describe("FLAT hand-wavy phrase panel — 'Preview reinstate' batch button", () => {
  test("clicking 'Preview reinstate' opens an inline panel of per-phrase outcomes without mutating anything, and 'Confirm reinstate' commits the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toBeVisible();

      // Both the existing "Reinstate all" and the new "Preview reinstate"
      // buttons should be available in the header before any interaction.
      const previewBtn = group.getByTestId("handwavy-reinstate-batch-preview");
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(previewBtn).toBeVisible();
      await expect(previewBtn).toHaveText(/Preview reinstate/);
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toHaveText(new RegExp(`Reinstate all ${phrases.length}\\b`));

      // None of the phrases are on the active list before the click.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // Open the dry-run preview panel.
      await previewBtn.click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toHaveAttribute("data-batch-removed-at", removedAt);

      // The panel renders one outcome row per inner phrase, and every row
      // is marked "would-reinstate" since none of these phrases are
      // already active or already reinstated.
      const rows = panel.getByTestId("handwavy-reinstate-batch-preview-row");
      await expect(rows).toHaveCount(phrases.length);
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      for (const p of phrases) {
        await expect(rows.filter({ hasText: p })).toHaveCount(1);
      }

      // Critically: nothing has been mutated by the dry-run. The batch
      // header must NOT have flipped to "All reinstated" and the active
      // list must still be empty for these phrases.
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);
      await expect(batchBtn).toBeVisible();
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // Press the panel's "Confirm reinstate" button to fire the real call.
      const confirmBtn = panel.getByTestId("handwavy-reinstate-batch-preview-confirm");
      await expect(confirmBtn).toBeEnabled();
      await expect(confirmBtn).toContainText(`Confirm reinstate (${phrases.length})`);
      await confirmBtn.click();

      // After the round-trip the header swaps to "All reinstated", the
      // preview panel goes away (cleared by the success path), and every
      // phrase reappears on the active list.
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      await expect(group.getByTestId("handwavy-reinstate-batch-preview-panel")).toHaveCount(0);
      await expect(group.getByTestId("handwavy-reinstate-batch")).toHaveCount(0);
      await expect(group.getByTestId("handwavy-reinstate-batch-preview")).toHaveCount(0);

      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("'Cancel' on the preview panel closes it without committing the reinstate", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();

      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      await panel.getByTestId("handwavy-reinstate-batch-preview-cancel").click();
      await expect(group.getByTestId("handwavy-reinstate-batch-preview-panel")).toHaveCount(0);

      // Nothing should have been mutated — the batch button is still there
      // and none of the phrases are on the active list.
      await expect(group.getByTestId("handwavy-reinstate-batch")).toBeVisible();
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("the preview panel surfaces 'already reinstated' rows when one inner phrase has already been per-phrase reinstated", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Reinstate the first phrase via the per-phrase API so the dry-run
      // preview classifies it as "already-reinstated".
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate",
        {
          data: { phrase: phrases[0], removedAt, reviewer: "e2e-task177-pre" },
        },
      );
      expect(
        reinstateRes.ok(),
        `per-phrase reinstate failed: ${reinstateRes.status()} ${await reinstateRes.text()}`,
      ).toBeTruthy();

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // 1 row marked "already-reinstated", 2 rows marked "would-reinstate".
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      const alreadyReinstatedRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="already-reinstated"]',
      );
      await expect(wouldRows).toHaveCount(2);
      await expect(alreadyReinstatedRows).toHaveCount(1);
      await expect(alreadyReinstatedRows.first()).toContainText(phrases[0]);

      // Confirm count reflects only the would-reinstate rows.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toContainText("Confirm reinstate (2)");
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });
});
