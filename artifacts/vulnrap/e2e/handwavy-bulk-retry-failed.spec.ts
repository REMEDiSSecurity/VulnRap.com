import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #238 — End-to-end coverage for the "Retry failed" action that lives
// on the bulk-remove and bulk-undo results banners. The reviewer kicks off
// a bulk batch, one or more rows fail with a transient error, and the
// new banner button re-runs ONLY those failed rows through the same
// endpoint and replaces the banner with the fresh per-phrase outcomes.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function uniquePhrases(count: number, label = "synthetic"): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from(
    { length: count },
    (_, i) => `task238 retry ${id} ${label} ${i + 1}`,
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
    data: { phrase, category: "hedging", reviewer: "e2e-task238" },
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
      data: { phrases, reviewer: "e2e-task238-cleanup" },
    })
    .catch(() => undefined);
}

async function injectCalibrationTokenIntoPage(page: Page): Promise<void> {
  if (!CALIBRATION_TOKEN) return;
  await page.addInitScript((token) => {
    (window as unknown as { __VULNRAP_CALIBRATION_TOKEN__?: string })
      .__VULNRAP_CALIBRATION_TOKEN__ = token;
  }, CALIBRATION_TOKEN);
}

test.describe("Retry failed on bulk results banner (Task #238)", () => {
  test("Bulk-remove banner exposes Retry failed and re-runs only the failed phrase", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(2, "remove-mixed");
    const [, transientPhrase] = phrases;

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Stub the destructive single-phrase DELETE for `transientPhrase` to
      // return 500 the FIRST time and pass through every time after, so the
      // initial bulk-remove ends with 1 removed + 1 error and the retry
      // click then succeeds against the real server. Dry-run DELETEs and
      // every DELETE for the other phrase fall through to the live server.
      let transientFailUsed = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun) {
            await route.fallback();
            return;
          }
          if (
            !transientFailUsed &&
            body?.phrase === transientPhrase
          ) {
            transientFailUsed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic transient failure" }),
            });
            return;
          }
          await route.fallback();
        },
      );

      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-kind", "remove");
      // Mixed outcome: 1 removed + 1 error → Retry failed shows up.
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="error"]`,
        ),
      ).toHaveCount(1);

      const retryBtn = banner.getByTestId("handwavy-bulk-retry-failed");
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toContainText(/Retry failed \(1\)/);

      await retryBtn.click();

      // Banner now reflects the retry-only batch (1 row, REMOVED) — the
      // original successful row is gone because the banner is replaced
      // with the new per-phrase outcomes from the retry pass.
      await expect(banner).toHaveAttribute("data-kind", "remove");
      await expect(banner).toContainText("1 / 1 removed");
      await expect(
        banner.locator(`[data-testid="handwavy-bulk-result-row"]`),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(1);
      // No retryable failures left → Retry failed disappears.
      await expect(banner.getByTestId("handwavy-bulk-retry-failed")).toHaveCount(0);

      // Both phrases are now off the active list.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("Retry failed is hidden on an all-success bulk-remove banner", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(2, "all-success");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      // All rows REMOVED — no error / auth-failed → no Retry button.
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(phrases.length);
      await expect(banner.getByTestId("handwavy-bulk-retry-failed")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("Bulk-undo banner exposes Retry failed and re-runs only the failed reinstate", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = uniquePhrases(2, "undo-mixed");
    const [, transientPhrase] = phrases;

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // First, drive both phrases through the bulk-remove preview/confirm
      // flow (no routing yet so the live server records the history rows
      // both phrases need for reinstate).
      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(phrases.length);

      // Now stub the reinstate endpoint to fail with 500 the FIRST time
      // for `transientPhrase` only, and pass through every other call.
      let transientReinstateFailUsed = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases/reinstate",
        async (route) => {
          const req = route.request();
          const body = req.postDataJSON() as
            | { phrase?: string }
            | undefined;
          if (
            !transientReinstateFailUsed &&
            body?.phrase === transientPhrase
          ) {
            transientReinstateFailUsed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: "Synthetic transient reinstate failure",
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      // Click "Undo this batch" — one row succeeds, one errors.
      await banner.getByTestId("handwavy-bulk-undo").click();
      await expect(banner).toHaveAttribute("data-kind", "undo");
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="reinstated"]`,
        ),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="error"]`,
        ),
      ).toHaveCount(1);

      // Retry failed appears on the post-undo banner with the failed-row
      // count.
      const retryBtn = banner.getByTestId("handwavy-bulk-retry-failed");
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toContainText(/Retry failed \(1\)/);

      await retryBtn.click();

      // Retry runs the previously-failed reinstate against the now-passing
      // route and replaces the banner with just the retry's outcomes.
      await expect(banner).toHaveAttribute("data-kind", "undo");
      await expect(banner).toContainText("1 / 1 reinstated");
      await expect(
        banner.locator(`[data-testid="handwavy-bulk-result-row"]`),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="reinstated"]`,
        ),
      ).toHaveCount(1);
      // Both phrases are back on the active list (one from the first undo
      // pass, the other from the retry).
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      // No more retryable failures.
      await expect(banner.getByTestId("handwavy-bulk-retry-failed")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });
});
