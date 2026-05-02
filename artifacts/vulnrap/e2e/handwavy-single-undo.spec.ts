import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { injectCalibrationTokenIntoPage } from "./helpers/handwavy";

// Task #237 / #332 — E2E coverage for the post-Trash Undo stack. Each
// successful per-row Trash pushes onto a bounded stack so the reviewer
// can roll back ANY of their recent per-row clicks (not just the
// latest) in one click. The third test below was flipped from the
// pre-#332 "second Trash replaces the banner" assertion to the new
// "second Trash stacks alongside the first"; the fourth covers undoing
// the OLDER stacked entry while leaving the newer one intact — the
// gap the original Task #237 banner couldn't close.

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

  test("A second per-row Trash STACKS alongside the first so both stay one-click reversible (Task #332)", async ({
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
      const stack = page.getByTestId("handwavy-single-undo-stack");
      await expect(stack).toBeVisible({ timeout: 15_000 });
      await expect(stack).toHaveAttribute("data-count", "1");

      // Pre-#332 the second Trash REPLACED the banner; with the stack
      // model both entries persist until each is undone or dismissed.
      await trashRow(page, second);
      await expect(stack).toHaveAttribute("data-count", "2", { timeout: 15_000 });

      // Each phrase has its own row + Undo button keyed by `removedAt`
      // so the reviewer can't roll back the wrong removal.
      const firstEntry = stack
        .locator('[data-testid="handwavy-single-undo"]')
        .filter({ hasText: first });
      const secondEntry = stack
        .locator('[data-testid="handwavy-single-undo"]')
        .filter({ hasText: second });
      await expect(firstEntry).toHaveCount(1);
      await expect(secondEntry).toHaveCount(1);
      await expect(firstEntry).toHaveAttribute("data-phrase", first);
      await expect(secondEntry).toHaveAttribute("data-phrase", second);
    } finally {
      await cleanup(apiCtx, first);
      await cleanup(apiCtx, second);
      await apiCtx.dispose();
    }
  });

  test('"Undo all" rolls back every stacked per-row Trash in one click and reports succeeded vs. skipped (Task #472)', async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const first = uniquePhrase("undoall-first");
    const second = uniquePhrase("undoall-second");
    const third = uniquePhrase("undoall-third");

    try {
      await addPhrase(apiCtx, first);
      await addPhrase(apiCtx, second);
      await addPhrase(apiCtx, third);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Single-entry stack must NOT show the "Undo all" button — the
      // per-row Undo already does the same thing in that case, so a
      // bulk affordance would just be visual clutter.
      await trashRow(page, first);
      const stack = page.getByTestId("handwavy-single-undo-stack");
      await expect(stack).toBeVisible({ timeout: 15_000 });
      await expect(stack).toHaveAttribute("data-count", "1");
      await expect(page.getByTestId("handwavy-single-undo-all")).toHaveCount(0);

      // Push two more entries onto the stack so we have ≥2 — this is
      // when the "Undo all" header surfaces.
      await trashRow(page, second);
      await trashRow(page, third);
      await expect(stack).toHaveAttribute("data-count", "3", { timeout: 15_000 });

      const undoAllBtn = page.getByTestId("handwavy-single-undo-all");
      await expect(undoAllBtn).toBeVisible();
      await expect(undoAllBtn).toContainText("Undo all (3)");

      await undoAllBtn.click();

      // Every entry leaves the stack as it succeeds — the whole panel
      // disappears once the loop finishes.
      await expect(stack).toHaveCount(0, { timeout: 30_000 });

      // Aggregate toast carries the succeeded count — locks in the
      // Task #233-shaped "Undid N phrases" summary so a future
      // refactor of the success path can't silently drop the
      // single-toast contract. `.first()` because the toast viewport
      // renders the text twice (visual + aria-live mirror).
      await expect(
        page.getByText("Undid 3 phrases", { exact: false }).first(),
      ).toBeVisible({ timeout: 15_000 });

      // All three phrases are back on the active list — the reviewer
      // got the entire batch back in one click instead of three.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: first }),
      ).toHaveCount(1, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: second }),
      ).toHaveCount(1, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: third }),
      ).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, first);
      await cleanup(apiCtx, second);
      await cleanup(apiCtx, third);
      await apiCtx.dispose();
    }
  });

  test("Undoing the OLDER stacked entry rolls back that specific Trash and leaves the newer entry intact (Task #332)", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const older = uniquePhrase("older");
    const newer = uniquePhrase("newer");

    try {
      await addPhrase(apiCtx, older);
      await addPhrase(apiCtx, newer);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      await trashRow(page, older);
      await trashRow(page, newer);

      const stack = page.getByTestId("handwavy-single-undo-stack");
      await expect(stack).toHaveAttribute("data-count", "2", { timeout: 15_000 });

      // Click Undo on the OLDER entry — the gap pre-#332 forced the
      // reviewer into the removal-history panel for.
      const olderEntry = stack
        .locator('[data-testid="handwavy-single-undo"]')
        .filter({ hasText: older });
      await olderEntry.getByTestId("handwavy-single-undo-button").click();

      // The older entry disappears once its reinstate completes...
      await expect(olderEntry).toHaveCount(0, { timeout: 15_000 });
      // ...and the older phrase is back on the active list.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: older }),
      ).toHaveCount(1, { timeout: 15_000 });

      // The newer entry stays — undoing the older click must NOT
      // wipe the rest of the stack.
      const newerEntry = stack
        .locator('[data-testid="handwavy-single-undo"]')
        .filter({ hasText: newer });
      await expect(newerEntry).toHaveCount(1);
      await expect(newerEntry).toHaveAttribute("data-phrase", newer);
      await expect(stack).toHaveAttribute("data-count", "1");

      // The newer phrase is still removed (its Undo was not clicked).
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: newer }),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, older);
      await cleanup(apiCtx, newer);
      await apiCtx.dispose();
    }
  });
});
