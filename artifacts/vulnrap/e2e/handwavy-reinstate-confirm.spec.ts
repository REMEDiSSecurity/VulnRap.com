import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  newApiContext,
  removeSingle,
} from "./helpers/handwavy";

// Task #153 — End-to-end coverage for the per-row "Reinstate" confirmation
// dialog on the FLAT hand-wavy phrase removal-history list. Reinstating
// restores a phrase to active use, so an accidental click can re-enable a
// marker the team intentionally removed. The Reinstate button must now open
// an AlertDialog (mirroring the Revert confirm pattern from Task #146)
// summarizing the phrase, category, and original rationale; Cancel must
// leave the entry untouched, and Confirm must perform the reinstate and
// show the existing toast.

const REVIEWER = "e2e-task153";

// Spec-local convenience type: the shared `addPhrase` helper takes phrase
// + opts (incl. rationale), but every assertion in this file checks the
// rationale text against the seeded value, so we bundle phrase + its
// rationale into a single object that flows through seed + assertion.
// Kept local because no other handwavy spec needs to round-trip the
// rationale string this way.
interface AddedPhrase {
  phrase: string;
  rationale: string;
}

function uniqueAddedPhrase(): AddedPhrase {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    phrase: `task153 reinstate ${id} phrase`,
    rationale: `task153 rationale ${id}`,
  };
}

test.describe("FLAT hand-wavy phrase panel — Reinstate confirmation dialog", () => {
  test("clicking 'Reinstate' opens a confirmation dialog summarizing the phrase, category, and rationale; Cancel leaves the entry untouched", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const seeded = uniqueAddedPhrase();

    try {
      // Seed: add then remove the phrase so it shows up on the removal
      // history list with a non-empty rationale and a Reinstate button.
      await addPhrase(apiCtx, seeded.phrase, {
        reviewer: REVIEWER,
        rationale: seeded.rationale,
      });
      await removeSingle(apiCtx, seeded.phrase, { reviewer: REVIEWER });

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
      await expect(
        historyRow.getByTestId("handwavy-history-reinstated"),
      ).toHaveCount(0);
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: seeded.phrase }),
        "Cancel must NOT re-enable the phrase on the active list",
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, seeded.phrase, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("confirming the dialog performs the reinstate, swaps the row badge, and the phrase reappears on the active list", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const seeded = uniqueAddedPhrase();

    try {
      await addPhrase(apiCtx, seeded.phrase, {
        reviewer: REVIEWER,
        rationale: seeded.rationale,
      });
      await removeSingle(apiCtx, seeded.phrase, { reviewer: REVIEWER });

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
      await expect(
        historyRow.getByTestId("handwavy-history-reinstated"),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(historyRow.getByTestId("handwavy-reinstate")).toHaveCount(0);
      // …and the phrase reappears on the active list.
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: seeded.phrase }),
      ).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, seeded.phrase, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
