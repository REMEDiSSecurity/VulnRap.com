import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #142 — End-to-end coverage for the "Undo this batch" action that
// lives on the bulk-removal results banner. The reviewer ticks a few rows,
// drives them through the existing bulk preview / confirm flow, and the
// new banner button rolls the whole batch back in one click using the
// existing single-phrase reinstate endpoint. Per-phrase reinstate outcomes
// render in the same banner shape as the removals.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function uniquePhrases(count: number, label = "synthetic"): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from(
    { length: count },
    (_, i) => `task142 undo ${id} ${label} ${i + 1}`,
  );
}

function authHeaders(): Record<string, string> {
  return CALIBRATION_TOKEN
    ? { "X-Calibration-Token": CALIBRATION_TOKEN }
    : {};
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: authHeaders(),
    data: { phrase, category: "hedging", reviewer: "e2e-task142" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      headers: authHeaders(),
      data: { phrases, reviewer: "e2e-task142-cleanup" },
    })
    .catch(() => undefined);
}

// Mirror handwavy-bulk-preview.spec.ts: the calibration token has to be
// available to the page itself so the strict-auth GETs that hydrate the
// active list don't 401 in CI.
async function injectCalibrationTokenIntoPage(page: Page): Promise<void> {
  if (!CALIBRATION_TOKEN) return;
  await page.addInitScript((token) => {
    (window as unknown as { __VULNRAP_CALIBRATION_TOKEN__?: string })
      .__VULNRAP_CALIBRATION_TOKEN__ = token;
  }, CALIBRATION_TOKEN);
}

async function selectAndRemoveBatch(
  page: Page,
  phrases: string[],
): Promise<void> {
  for (const phrase of phrases) {
    const row = page
      .locator(`[data-testid="handwavy-row"]`)
      .filter({ hasText: phrase });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByTestId("handwavy-select").check();
  }
  await page.getByTestId("handwavy-bulk-remove").click();
  const panel = page.getByTestId("handwavy-bulk-preview");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Bulk-removal Undo this batch (Task #142)", () => {
  test("Undo button reinstates every removed phrase and reports per-phrase outcomes in the same banner", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(3, "happy");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectAndRemoveBatch(page, phrases);

      // The results banner now reports 3/3 removed and the rows are no
      // longer in the active list.
      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-kind", "remove");
      await expect(banner).toContainText(/Bulk removal results/);
      await expect(banner).toContainText(`${phrases.length} / ${phrases.length} removed`);
      const removedRows = banner.locator(
        `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
      );
      await expect(removedRows).toHaveCount(phrases.length);
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }

      // The Undo button is visible because at least one row reports
      // REMOVED. Its label includes the count of phrases that will be
      // rolled back.
      const undoBtn = banner.getByTestId("handwavy-bulk-undo");
      await expect(undoBtn).toBeVisible();
      await expect(undoBtn).toContainText(
        new RegExp(`Undo this batch \\(${phrases.length}\\)`),
      );

      await undoBtn.click();

      // Banner kind flips to "undo" and per-phrase rows re-render with
      // the REINSTATED status in the SAME banner shape as the removals.
      await expect(banner).toHaveAttribute("data-kind", "undo");
      await expect(banner).toContainText(/Bulk undo results/);
      await expect(banner).toContainText(
        `${phrases.length} / ${phrases.length} reinstated`,
      );
      const reinstatedRows = banner.locator(
        `[data-testid="handwavy-bulk-result-row"][data-status="reinstated"]`,
      );
      await expect(reinstatedRows).toHaveCount(phrases.length);
      // Undo button no longer renders on the post-undo banner.
      await expect(banner.getByTestId("handwavy-bulk-undo")).toHaveCount(0);

      // The single batched refresh restores every phrase to the active
      // list — no per-phrase Reinstate clicks needed.
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

  test("Undo button is hidden when no row reports REMOVED", async ({ page }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrases(1, "auth-failed-only")[0];

    try {
      await addPhrase(apiCtx, phrase);
      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Force every single-phrase DELETE that backs the bulk-remove flow to
      // fail with 401 so the resulting banner has zero REMOVED rows.
      // Dry-run DELETEs (the preview) must pass through unchanged so the
      // confirm button enables — the route is the same URL for both.
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as { dryRun?: boolean } | undefined;
          if (body?.dryRun) {
            await route.fallback();
            return;
          }
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: "Synthetic auth failure" }),
          });
        },
      );

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-select").check();
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      // Zero rows reported REMOVED → no Undo button on the banner at all.
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(0);
      await expect(banner.getByTestId("handwavy-bulk-undo")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });
});
