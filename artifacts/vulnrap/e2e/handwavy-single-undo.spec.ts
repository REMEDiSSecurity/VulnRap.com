import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #237 — End-to-end coverage for the post-Trash Undo banner that
// rolls back a single per-row removal in one click. Symmetric to the
// per-batch "Undo this batch" affordance from Task #142, but anchored to
// a single phrase + history-row identifier so the reviewer doesn't have
// to scroll into the removal-history panel for one mistaken click.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function uniquePhrase(label = "synthetic"): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `task237 undo ${id} ${label}`;
}

function authHeaders(): Record<string, string> {
  return CALIBRATION_TOKEN
    ? { "X-Calibration-Token": CALIBRATION_TOKEN }
    : {};
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: authHeaders(),
    data: { phrase, category: "hedging", reviewer: "e2e-task237" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function cleanup(api: APIRequestContext, phrase: string): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      headers: authHeaders(),
      data: { phrase, reviewer: "e2e-task237-cleanup" },
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

async function trashRow(page: Page, phrase: string): Promise<void> {
  const row = page
    .locator(`[data-testid="handwavy-row"]`)
    .filter({ hasText: phrase });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  // The per-row Trash button has an aria-label that includes "Remove".
  // Both the standard and confirm-gated paths route through the same
  // button; for a freshly-added phrase with zero remove/reinstate cycles
  // and zero valid detections the click fires the live DELETE in one
  // step, which is exactly the path Task #237 surfaces an Undo for.
  await row.locator('button[aria-label*="Remove"]').first().click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Per-row post-Trash Undo banner (Task #237)", () => {
  test("Undo banner appears after a single-phrase Trash and reinstates the phrase via the existing endpoint", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("happy");

    try {
      await addPhrase(apiCtx, phrase);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // No Undo banner before any per-row removal happens.
      await expect(page.getByTestId("handwavy-single-undo")).toHaveCount(0);

      await trashRow(page, phrase);

      const banner = page.getByTestId("handwavy-single-undo");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText("Phrase removed");
      await expect(banner).toContainText(phrase);
      await expect(banner).toHaveAttribute("data-phrase", phrase);

      const undoBtn = banner.getByTestId("handwavy-single-undo-button");
      await expect(undoBtn).toBeVisible();
      await expect(undoBtn).toContainText("Undo");

      await undoBtn.click();

      // Banner clears once the reinstate completes — the affordance must
      // not be clickable twice against the same history identifier.
      await expect(banner).toHaveCount(0, { timeout: 15_000 });

      // The reinstate restored the phrase to the active list — the
      // reviewer never had to open the removal-history panel.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, phrase);
      await apiCtx.dispose();
    }
  });

  test("Dismiss clears the banner without reinstating the phrase", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("dismiss");

    try {
      await addPhrase(apiCtx, phrase);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await trashRow(page, phrase);

      const banner = page.getByTestId("handwavy-single-undo");
      await expect(banner).toBeVisible({ timeout: 15_000 });

      await banner.getByTestId("handwavy-single-undo-dismiss").click();
      await expect(banner).toHaveCount(0, { timeout: 5_000 });

      // Phrase stays removed — Dismiss is non-destructive on the active
      // list because the row is already gone, and explicitly does NOT
      // reinstate.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, phrase);
      await apiCtx.dispose();
    }
  });

  test("A second per-row Trash replaces the banner so it always points at the most-recent removal", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const first = uniquePhrase("first");
    const second = uniquePhrase("second");

    try {
      await addPhrase(apiCtx, first);
      await addPhrase(apiCtx, second);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      await trashRow(page, first);
      const banner = page.getByTestId("handwavy-single-undo");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-phrase", first);

      await trashRow(page, second);
      // Same banner element, but now anchored to the SECOND removal so
      // clicking Undo would roll back the most-recent click — the older
      // one stays in the removal-history panel as before.
      await expect(banner).toBeVisible();
      await expect(banner).toHaveAttribute("data-phrase", second);
    } finally {
      await cleanup(apiCtx, first);
      await cleanup(apiCtx, second);
      await apiCtx.dispose();
    }
  });
});
