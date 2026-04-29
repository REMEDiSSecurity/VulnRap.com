import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #153 — End-to-end coverage for the per-row "Reinstate" confirmation
// dialog on the FLAT hand-wavy phrase removal-history list. Reinstating
// restores a phrase to active use, so an accidental click can re-enable a
// marker the team intentionally removed. The Reinstate button must now open
// an AlertDialog (mirroring the Revert confirm pattern from Task #146)
// summarizing the phrase, category, and original rationale; Cancel must
// leave the entry untouched, and Confirm must perform the reinstate and
// show the existing toast.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
// Task #163 — calibration mutation + read endpoints both require a token
// when CALIBRATION_TOKEN is configured on the API server. We pull it from
// the same env var the dev/prod deploys use, so this spec stays consistent
// regardless of whether the surrounding workflow has the gate enabled.
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || process.env.CALIBRATION_TOKEN || "";
const AUTH_HEADERS: Record<string, string> = CALIBRATION_TOKEN
  ? { "X-Calibration-Token": CALIBRATION_TOKEN }
  : {};

interface AddedPhrase {
  phrase: string;
  rationale: string;
}

function uniquePhrase(): AddedPhrase {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    phrase: `task153 reinstate ${id} phrase`,
    rationale: `task153 rationale ${id}`,
  };
}

async function addPhrase(api: APIRequestContext, p: AddedPhrase): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: AUTH_HEADERS,
    data: {
      phrase: p.phrase,
      category: "hedging",
      rationale: p.rationale,
      reviewer: "e2e-task153",
    },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${p.phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function removePhrase(api: APIRequestContext, p: AddedPhrase): Promise<void> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    headers: AUTH_HEADERS,
    data: { phrases: [p.phrase], reviewer: "e2e-task153" },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases failed for "${p.phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function cleanup(api: APIRequestContext, p: AddedPhrase): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      headers: AUTH_HEADERS,
      data: { phrases: [p.phrase], reviewer: "e2e-task153-cleanup" },
    })
    .catch(() => undefined);
}

test.describe("FLAT hand-wavy phrase panel — Reinstate confirmation dialog", () => {
  test("clicking 'Reinstate' opens a confirmation dialog summarizing the phrase, category, and rationale; Cancel leaves the entry untouched", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const seeded = uniquePhrase();

    try {
      // Seed: add then remove the phrase so it shows up on the removal
      // history list with a non-empty rationale and a Reinstate button.
      await addPhrase(apiCtx, seeded);
      await removePhrase(apiCtx, seeded);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      // Find the seeded phrase's history row and its per-row Reinstate
      // button. Filtering by the unique phrase text avoids picking up any
      // unrelated leftover dev data.
      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: seeded.phrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });

      const reinstateBtn = historyRow.getByTestId("handwavy-reinstate");
      await expect(reinstateBtn).toBeVisible();
      await expect(reinstateBtn).toBeEnabled();

      // Clicking Reinstate must NOT immediately reinstate — it should
      // open the confirmation dialog instead.
      await reinstateBtn.click();

      const dialog = page.getByTestId("handwavy-reinstate-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText("Reinstate this phrase?")).toBeVisible();
      // The dialog must mention the phrase being reinstated…
      await expect(dialog).toContainText(seeded.phrase);
      // …and surface the original category + rationale so the reviewer
      // can spot a misclick before the phrase is re-enabled.
      const summary = dialog.getByTestId("handwavy-reinstate-confirm-summary");
      await expect(summary).toBeVisible();
      await expect(summary).toContainText("Generic hedging");
      await expect(summary).toContainText(seeded.rationale);

      // Cancel: dialog closes, the row is unchanged (Reinstate button
      // still visible, phrase NOT on the active list).
      await dialog.getByTestId("handwavy-reinstate-confirm-cancel").click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
      await expect(reinstateBtn).toBeVisible();
      await expect(historyRow.getByTestId("handwavy-history-reinstated")).toHaveCount(0);
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: seeded.phrase }),
        "Cancel must NOT re-enable the phrase on the active list",
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, seeded);
      await apiCtx.dispose();
    }
  });

  test("confirming the dialog performs the reinstate, swaps the row badge, and the phrase reappears on the active list", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const seeded = uniquePhrase();

    try {
      await addPhrase(apiCtx, seeded);
      await removePhrase(apiCtx, seeded);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: seeded.phrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });

      await historyRow.getByTestId("handwavy-reinstate").click();

      const dialog = page.getByTestId("handwavy-reinstate-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await dialog.getByTestId("handwavy-reinstate-confirm-confirm").click();

      // Dialog closes…
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
      // …the row swaps to the "Reinstated" badge…
      await expect(historyRow.getByTestId("handwavy-history-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      await expect(historyRow.getByTestId("handwavy-reinstate")).toHaveCount(0);
      // …and the phrase reappears on the active list.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: seeded.phrase }),
      ).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, seeded);
      await apiCtx.dispose();
    }
  });
});
