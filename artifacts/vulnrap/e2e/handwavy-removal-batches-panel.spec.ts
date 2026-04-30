import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #175 — End-to-end coverage for the inline "Recent batch removals"
// picker on /feedback-analytics. The panel is sourced from
// GET /feedback/calibration/handwavy-phrases/removal-batches and lets a
// reviewer reinstate a recent batch without scrolling the full removal-
// history panel. After the round-trip the row should swap to the
// "Already reinstated" badge and the active list should once again contain
// every phrase.

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
  return Array.from({ length: count }, (_, i) => `task175 batch ${id} phrase ${i + 1}`);
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task175" },
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
    data: { phrases, reviewer: "e2e-task175" },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (batch) failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as BatchRemovalResponse;
  expect(body.batch).toBe(true);
  expect(body.historyEntry?.removedAt).toBeTruthy();
  return body;
}

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task175-cleanup" },
    })
    .catch(() => undefined);
}

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
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
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

      await btn.click();

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
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("rows for already-reinstated batches show the badge and no reinstate button", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Reinstate the whole batch directly through the API so the panel sees
      // it as "already reinstated" on first load.
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate-batch",
        { data: { removedAt, reviewer: "e2e-task175-pre" } },
      );
      expect(reinstateRes.ok()).toBeTruthy();

      const row = await openPanelAndFindBatch(page, removedAt);
      await expect(row.getByTestId("handwavy-removal-batches-reinstated")).toBeVisible();
      await expect(row.getByTestId("handwavy-removal-batches-reinstate")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases);
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
    const phrases = uniquePhrases(3);

    try {
      // Add three, then remove all three as one batch. This is the row we
      // want the chip to appear on later.
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Re-add two of the three phrases AFTER the batch removal so the
      // active list now once again contains them. Reinstating the batch
      // would silently merge the historical state on top of these edits.
      await addPhrase(apiCtx, phrases[0]);
      await addPhrase(apiCtx, phrases[1]);

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
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("counts a phrase as conflicting when it has a newer removal entry than the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2);

    try {
      // Add both phrases and remove them as one batch — this is the
      // "older" batch the chip should warn about.
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Now exercise the "newer history entry" branch (no re-adds left
      // on the active list at the moment of inspection): re-add ONE of
      // the two phrases and immediately remove it again. After this the
      // active list contains neither phrase, but one of them owns a
      // removal-history row whose removedAt is strictly newer than the
      // batch's removedAt — so it should still be flagged as a conflict.
      await addPhrase(apiCtx, phrases[0]);
      const followUp = await batchRemove(apiCtx, [phrases[0]]);
      expect(followUp.historyEntry!.removedAt > removedAt).toBe(true);

      const row = await openPanelAndFindBatch(page, removedAt);
      const chip = row.getByTestId("handwavy-removal-batches-conflict-chip");
      await expect(chip).toBeVisible({ timeout: 15_000 });
      await expect(chip).toContainText("1 of 2 may overwrite recent edits");
      await expect(chip).toHaveAttribute("data-conflict-count", "1");
      await expect(chip).toHaveAttribute("data-conflict-total", "2");
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("does not show a conflict chip when no phrases have been touched since the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const row = await openPanelAndFindBatch(page, removedAt);
      // The chip is omitted entirely (not just hidden) when the conflict
      // count is zero.
      await expect(
        row.getByTestId("handwavy-removal-batches-conflict-chip"),
      ).toHaveCount(0);
      await expect(row).toHaveAttribute("data-batch-conflict-count", "0");
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });
});
