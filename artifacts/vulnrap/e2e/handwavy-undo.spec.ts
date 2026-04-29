import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #158 — End-to-end coverage for the FLAT hand-wavy phrase panel's
// add + undo path. The "Undo" affordance only appears on the most recently
// added phrase for a 5-minute window (UNDO_WINDOW_MS in
// feedback-analytics.tsx) and is critical for keeping the audit trail
// honest: an add followed by an undo should pair into a single "added then
// undone" history row (rendered with the "Undone" badge), NOT a manual
// removal. This spec drives the real UI through the full preview ->
// confirm add -> undo flow and asserts both halves of that contract.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
// Mirror playwright.config.ts default so the strict-auth gate on the
// hand-wavy phrase routes (Task #163 + Task #152's CALIBRATION_TOKEN setup)
// accepts our direct API calls in seed/cleanup. CI overrides via
// E2E_CALIBRATION_TOKEN.
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext() {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

function uniquePhrase(): string {
  // randomUUID keeps each run independent of leftover data in the dev DB /
  // handwavy-phrases.json. The "task158" prefix makes it easy to spot
  // during debugging.
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `task158 undo ${id} phrase`;
}

// Cleans up anything we left behind so a re-run doesn't accumulate audit
// rows. We try to remove the phrase via the bulk DELETE endpoint;
// not-found is fine.
async function cleanup(api: APIRequestContext, phrase: string): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases: [phrase], reviewer: "e2e-task158-cleanup" },
    })
    .catch(() => undefined);
}

test.describe("FLAT hand-wavy phrase panel — add + undo flow", () => {
  test("adding a phrase shows the Undo button on its row, and clicking it logs an 'Undone' history entry instead of a manual removal", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase();

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // The reviewer field is required for the audit trail to attribute
      // the add to a non-anonymous user; the panel works without it but
      // setting it keeps this spec consistent with the other handwavy
      // specs and the manual review flow.
      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task158");

      // Add flow is two-step: type the phrase, click "Preview impact",
      // wait for the preview banner, then click "Confirm add".
      const input = page.getByTestId("handwavy-input");
      await input.fill(phrase);
      await page.getByTestId("handwavy-category").selectOption("hedging");
      await page.getByTestId("handwavy-add").click();

      const confirmBtn = page.getByTestId("handwavy-preview-confirm");
      await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();

      // Once the active list refreshes the new phrase shows up as a
      // handwavy-row. Filter by the unique phrase text so we don't pick
      // up unrelated rows from leftover dev data.
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(newRow).toHaveCount(1, { timeout: 15_000 });

      // The "Undo" button should be visible on this row because it's the
      // most recently added phrase and is well within the 5-minute
      // UNDO_WINDOW_MS. Other rows (older adds, curated defaults) must
      // NOT carry an undo button — only the freshest add should.
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible();
      await expect(undoBtn).toBeEnabled();
      await expect(
        page.locator(`[data-testid="handwavy-undo"]`),
        "Undo should only appear on the most recently added phrase",
      ).toHaveCount(1);

      await undoBtn.click();

      // After the undo round-trip the active list should no longer
      // contain our phrase…
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
        "phrase should disappear from the active list after undo",
      ).toHaveCount(0, { timeout: 15_000 });

      // …and the history panel should render an entry for the phrase
      // marked as "Undone" (data-history-kind="undone" + the
      // handwavy-history-undone badge), NOT as a manual removal. We
      // expand the history toggle if needed, then locate the row by the
      // unique phrase text.
      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: phrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });
      await expect(historyRow).toHaveAttribute("data-history-kind", "undone");
      await expect(historyRow.getByTestId("handwavy-history-undone")).toBeVisible();
    } finally {
      await cleanup(apiCtx, phrase);
      await apiCtx.dispose();
    }
  });
});
