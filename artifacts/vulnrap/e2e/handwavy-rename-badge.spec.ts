import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Locator,
} from "@playwright/test";
import {
  newApiContext,
  uniquePhrases,
  addPhrase,
  removeSingle,
  batchRemove,
  cleanup,
} from "./helpers/handwavy";

// Task #505 — End-to-end coverage for the "Renamed N×" badge that Task #357
// added to the FLAT hand-wavy phrase panel. The renderer for the per-row
// edit-history rename block and the badge component itself already have
// unit tests, but no end-to-end test drives the full rename flow against
// the live API and asserts that:
//   1. the active row mounts the rename badge after a real PATCH rename,
//      and the tooltip lists the prior phrase text + the reviewer who
//      performed the rename;
//   2. once the renamed phrase is removed, the same rename badge appears
//      on the corresponding row inside the removed-history panel; and
//   3. inside a batch removal whose inner phrases include one that was
//      renamed, the badge appears on the renamed inner row only — never
//      aggregated across the batch — so a partial reinstate still sees
//      the per-phrase signal.
//
// Modeled on `handwavy-history-category-flip.spec.ts` (the sibling badge
// for category churn). The renames are applied through a direct PATCH
// against the calibration endpoint; the helper module doesn't expose a
// rename helper today, so it lives inline here. Everything else
// (newApiContext / addPhrase / removeSingle / batchRemove / cleanup /
// uniquePhrases) goes through the shared `helpers/handwavy.ts` module so
// the parallel-safety contract documented there continues to hold.

interface PatchRenameResponse {
  edited: boolean;
  phrase: string;
  editEntry?: {
    phrase?: { from: string; to: string };
    editedBy?: string;
  };
}

// Drive a rename against the live PATCH endpoint. The API normalizes both
// `phrase` (lookup key) and `newPhrase` (rename target), records the edit
// as `{ phrase: { from, to }, editedBy }` on the marker's `edits` array,
// and rewrites the marker's identity in place — so subsequent
// active-list / history GETs key off the new phrase. Returns the parsed
// response so callers can sanity-check the audit metadata before driving
// the page assertions.
async function patchRename(
  api: APIRequestContext,
  phrase: string,
  newPhrase: string,
  reviewer: string,
): Promise<PatchRenameResponse> {
  const res = await api.patch("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, newPhrase, reviewer },
  });
  expect(
    res.ok(),
    `PATCH handwavy-phrases (rename) failed for "${phrase}" → "${newPhrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as PatchRenameResponse;
  expect(
    body.edited,
    `PATCH rename should report edited:true for "${phrase}" → "${newPhrase}"`,
  ).toBe(true);
  expect(
    body.editEntry?.phrase,
    "PATCH rename response should carry an editEntry.phrase {from,to} block",
  ).toBeTruthy();
  return body;
}

async function openHistory(page: Page): Promise<void> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();
}

// Locate an active row by its current (post-rename) phrase. The row
// renders a `data-handwavy-phrase` hook so we can match exactly without
// being thrown off by tooltip text in portals.
function findActiveRowFor(page: Page, phrase: string): Locator {
  return page.locator(
    `[data-testid="handwavy-row"][data-handwavy-phrase="${cssEscape(phrase)}"]`,
  );
}

function findHistoryRowFor(page: Page, phrase: string): Locator {
  return page.locator(
    `[data-testid="handwavy-history-row"][data-handwavy-history-phrase="${cssEscape(phrase)}"]`,
  );
}

function findBatchGroup(page: Page, removedAt: string): Locator {
  return page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${cssEscape(removedAt)}"]`,
  );
}

// Minimal CSS attribute-value escaper. Phrases come from `uniquePhrases`
// (alphanumerics + spaces) so the surface is small, but we still escape
// the few characters that would break a `[data-…="…"]` selector.
function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

test.describe("FLAT hand-wavy phrase panel — rename badge (Task #505)", () => {
  test("active row shows the rename badge after a PATCH rename and the tooltip lists the prior phrase + renamer", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [original, renamed] = uniquePhrases(2, "task505 active");

    try {
      await addPhrase(apiCtx, original, { reviewer: "alice@team.com" });
      await patchRename(apiCtx, original, renamed, "bob@team.com");

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Active row appears under the NEW phrase — rename rewrites the
      // marker identity in place, so the original is gone from the
      // active list entirely.
      const row = findActiveRowFor(page, renamed);
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(findActiveRowFor(page, original)).toHaveCount(0);

      // Badge is mounted on this row only, with the singular label for
      // a single rename ("Renamed", not "Renamed 1×").
      const badge = row.getByTestId("handwavy-rename-badge");
      await expect(badge).toHaveCount(1);
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("Renamed");
      await expect(badge).not.toContainText("×");

      // Hovering the badge surfaces the tooltip; it lives in a portal so
      // we resolve it from the page root, not the row.
      await badge.hover();
      const tooltip = page.getByTestId("handwavy-rename-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("Renamed once");
      // The transition shows the prior phrase text on the left and the
      // current phrase text on the right.
      await expect(tooltip).toContainText(original);
      await expect(tooltip).toContainText(renamed);
      // Renamer is attributed by reviewer email, not the original adder.
      await expect(tooltip).toContainText("bob@team.com");
      await expect(tooltip).not.toContainText("alice@team.com");
    } finally {
      // Cleanup the renamed phrase (the original no longer exists on the
      // active list); also pass the original so a stale row from a
      // previous failed run gets swept too.
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  test("removed-history row for a renamed-then-removed phrase shows the rename badge", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [original, renamed] = uniquePhrases(2, "task505 removed");

    try {
      await addPhrase(apiCtx, original, { reviewer: "alice@team.com" });
      await patchRename(apiCtx, original, renamed, "bob@team.com");
      // Remove the renamed phrase — the API preserves the marker's
      // `edits` array on the resulting history row, so the rename
      // entry is still visible to the badge after the row leaves the
      // active list.
      await removeSingle(apiCtx, renamed, { reviewer: "carol@team.com" });

      await openHistory(page);

      const historyRow = findHistoryRowFor(page, renamed);
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });

      // Removed-history badge uses the `handwavy-history-rename-badge`
      // testid — the active-row badge testid must NOT appear on this
      // row (the two are intentionally distinguishable so each list's
      // E2E specs can target their own badge).
      const badge = historyRow.getByTestId("handwavy-history-rename-badge");
      await expect(badge).toHaveCount(1);
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("Renamed");
      await expect(
        historyRow.getByTestId("handwavy-rename-badge"),
      ).toHaveCount(0);

      await badge.hover();
      const tooltip = page.getByTestId("handwavy-history-rename-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("Renamed once");
      await expect(tooltip).toContainText(original);
      await expect(tooltip).toContainText(renamed);
      await expect(tooltip).toContainText("bob@team.com");
    } finally {
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  test("batch-removal group shows the rename badge per inner phrase, not aggregated across the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [originalRenamed, renamed, calm] = uniquePhrases(3, "task505 batch");

    try {
      // `originalRenamed` gets renamed to `renamed` before the batch
      // remove; `calm` is added once and never renamed. Batch-removing
      // both produces a single batch history group whose inner rows
      // mirror the two phrases — the renamed one keyed by its NEW
      // phrase string, the calm one by its only phrase string.
      await addPhrase(apiCtx, originalRenamed, { reviewer: "alice@team.com" });
      await patchRename(apiCtx, originalRenamed, renamed, "bob@team.com");
      await addPhrase(apiCtx, calm, { reviewer: "alice@team.com" });

      const batch = await batchRemove(apiCtx, [renamed, calm], {
        reviewer: "carol@team.com",
      });
      const removedAt = batch.historyEntry!.removedAt as string;

      await openHistory(page);

      const group = findBatchGroup(page, removedAt);
      await expect(group).toHaveCount(1, { timeout: 15_000 });

      // Task #366 — the per-phrase rows inside a batch group live behind
      // a collapsed-by-default <details>. Expand it so the inner-row
      // badges are actually rendered visible (the DOM contains them
      // either way, but Playwright's hover requires visibility).
      const rowsDetails = group.getByTestId(
        "handwavy-history-batch-rows-details",
      );
      if ((await rowsDetails.getAttribute("open")) === null) {
        await group
          .getByTestId("handwavy-history-batch-rows-summary")
          .click();
      }
      await expect(rowsDetails).toHaveAttribute("open", /.*/);

      const renamedRow = group.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase="${cssEscape(renamed)}"]`,
      );
      const calmRow = group.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase="${cssEscape(calm)}"]`,
      );
      await expect(renamedRow).toHaveCount(1);
      await expect(calmRow).toHaveCount(1);

      // Per-inner-phrase badge: only the renamed inner row gets it.
      const badgeOnRenamed = renamedRow.getByTestId(
        "handwavy-history-rename-badge",
      );
      await expect(badgeOnRenamed).toHaveCount(1);
      await expect(badgeOnRenamed).toContainText("Renamed");

      await expect(
        calmRow.getByTestId("handwavy-history-rename-badge"),
      ).toHaveCount(0);

      // Tooltip on the renamed inner row still surfaces the prior name +
      // the reviewer who performed the rename, not the reviewer who
      // performed the batch removal.
      await badgeOnRenamed.hover();
      const tooltip = page.getByTestId("handwavy-history-rename-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("Renamed once");
      await expect(tooltip).toContainText(originalRenamed);
      await expect(tooltip).toContainText(renamed);
      await expect(tooltip).toContainText("bob@team.com");
      await expect(tooltip).not.toContainText("carol@team.com");
    } finally {
      await cleanup(apiCtx, [originalRenamed, renamed, calm]);
      await apiCtx.dispose();
    }
  });
});
