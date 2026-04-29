import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #158 — End-to-end coverage for the FLAT hand-wavy phrase panel's
// add + undo path. The "Undo" affordance appears on every phrase added
// within a 5-minute window (UNDO_WINDOW_MS in feedback-analytics.tsx —
// originally just the single most-recent add, broadened by Task #141 to
// every still-in-window add). It is critical for keeping the audit trail
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

function uniquePhrase(suffix = "phrase"): string {
  // randomUUID keeps each run independent of leftover data in the dev DB /
  // handwavy-phrases.json. The "task158" prefix makes it easy to spot
  // during debugging.
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `task158 undo ${id} ${suffix}`;
}

// Helper for the two-step add (type + Preview impact + Confirm add). The
// add flow is identical for every phrase the spec creates so we factor it
// out to keep the test bodies focused on the undo contract.
async function addPhrase(
  page: import("@playwright/test").Page,
  phrase: string,
): Promise<void> {
  const input = page.getByTestId("handwavy-input");
  await input.fill(phrase);
  await page.getByTestId("handwavy-category").selectOption("hedging");
  await page.getByTestId("handwavy-add").click();
  const confirmBtn = page.getByTestId("handwavy-preview-confirm");
  await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  // Wait for the row to appear so subsequent typing in the input field
  // doesn't race against the refresh cycle.
  await expect(
    page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
  ).toHaveCount(1, { timeout: 15_000 });
}

// Cleans up anything we left behind so a re-run doesn't accumulate audit
// rows. We try to remove the phrase via the bulk DELETE endpoint;
// not-found is fine.
async function cleanup(
  api: APIRequestContext,
  phrases: string | string[],
): Promise<void> {
  const list = Array.isArray(phrases) ? phrases : [phrases];
  if (list.length === 0) return;
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases: list, reviewer: "e2e-task158-cleanup" },
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
      await addPhrase(page, phrase);

      // The "Undo" button should be visible on the new row because it
      // was just added and is well within the 5-minute UNDO_WINDOW_MS.
      // Curated defaults and older reviewer-added phrases that have
      // aged out must NOT carry an undo button.
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible();
      await expect(undoBtn).toBeEnabled();

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

  // Task #141 — the Undo affordance used to live only on the single
  // most-recently-added marker, which forced reviewers to drop older
  // mistakes into the regular Trash flow (recording them as manual
  // removals in the audit trail). After Task #141 every still-in-window
  // add carries its own Undo button. This test seeds two adds back-to-
  // back, confirms BOTH rows expose Undo, then undoes the OLDER one and
  // verifies it lands in history as "undone" rather than as a manual
  // removal — the exact contract the task is meant to deliver.
  test("two consecutive adds both expose Undo, and undoing the older one is still tagged as 'undone' in the audit trail", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const olderPhrase = uniquePhrase("older");
    const newerPhrase = uniquePhrase("newer");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task141");

      await addPhrase(page, olderPhrase);
      await addPhrase(page, newerPhrase);

      const olderRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: olderPhrase });
      const newerRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: newerPhrase });

      // BOTH adds should now carry their own Undo affordance. This is
      // the core Task #141 behaviour — under the old single-best memo
      // the older row's Undo would have disappeared the moment the
      // newer add landed and the reviewer would have had to use Trash.
      await expect(olderRow.getByTestId("handwavy-undo")).toBeVisible();
      await expect(olderRow.getByTestId("handwavy-undo")).toBeEnabled();
      await expect(newerRow.getByTestId("handwavy-undo")).toBeVisible();
      await expect(newerRow.getByTestId("handwavy-undo")).toBeEnabled();

      // Undo the OLDER add specifically — under the old behaviour the
      // older row would not have had this button at all.
      await olderRow.getByTestId("handwavy-undo").click();

      // The older phrase disappears from the active list; the newer
      // one stays put (and keeps its own Undo button — its window
      // hasn't elapsed either).
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: olderPhrase }),
        "older phrase should disappear from the active list after undo",
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: newerPhrase }),
        "newer phrase should still be present after undoing the older one",
      ).toHaveCount(1);
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: newerPhrase })
          .getByTestId("handwavy-undo"),
      ).toBeVisible();

      // The history row for the older phrase MUST be tagged "undone"
      // (data-history-kind="undone" + the handwavy-history-undone
      // badge), proving the older add went through the audit-friendly
      // undo path rather than being recorded as a manual removal.
      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: olderPhrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });
      await expect(historyRow).toHaveAttribute("data-history-kind", "undone");
      await expect(historyRow.getByTestId("handwavy-history-undone")).toBeVisible();
    } finally {
      await cleanup(apiCtx, [olderPhrase, newerPhrase]);
      await apiCtx.dispose();
    }
  });
});
