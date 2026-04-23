import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

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

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;

interface BatchRemovalResponse {
  batch: true;
  removed: number;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

function uniquePhrases(count: number): string[] {
  // Using randomUUID keeps each test run independent of any data left over
  // in the dev DB / handwavy-phrases.json from prior runs or manual usage.
  // The "task156" prefix just makes them easy to spot during debugging.
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from({ length: count }, (_, i) => `task156 batch ${id} phrase ${i + 1}`);
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task156" },
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
    data: { phrases, reviewer: "e2e-task156" },
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

// Cleans up anything we left behind so a re-run doesn't accumulate audit
// rows. We try to remove every phrase the test added; not-found is fine.
async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task156-cleanup" },
    })
    .catch(() => undefined);
}

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
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
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

      await batchBtn.click();

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
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("per-phrase reinstate still works for a partial undo and the header tracks 'X of N reinstated' until the last one", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      const innerRows = group.getByTestId("handwavy-history-row");
      await expect(innerRows).toHaveCount(phrases.length);

      // Click the per-phrase reinstate on the first inner row only.
      const firstRow = innerRows.filter({ hasText: phrases[0] });
      await expect(firstRow).toHaveCount(1);
      await firstRow.getByTestId("handwavy-reinstate").click();

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

      // Reinstate the remaining two via the batch button.
      await batchBtn.click();

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
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });
});
