import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #234 — End-to-end coverage for the "N category flips" badge on
// removed-history rows. Task #149 added the badge to the active-phrase
// list so reviewers spot phrases that have bounced between
// absence/hedging/buzzword. The same churn signal is just as useful on
// the removed-history list (where the Reinstate buttons live), so a
// reviewer about to bring a phrase back can see at a glance that it has
// a history of being re-categorized — not just removed and reinstated.
//
// We exercise three shapes:
//   1. A single-removal row whose preserved `edits` array contains >= 2
//      category transitions — badge MUST appear, tooltip MUST list each
//      transition with the editor + timestamp.
//   2. A single-removal row whose preserved `edits` array has only ONE
//      category transition — badge MUST NOT appear (one-off corrections
//      are noise, not churn).
//   3. A batch-removal group with one inner phrase that has flips and one
//      that has none — only the flippy inner row gets the badge so a
//      partial reinstate still sees the per-phrase signal (badges are
//      per-inner-phrase, not aggregated across the batch).

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext() {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

interface SingleRemovalResponse {
  historyEntry?: { removedAt: string } | null;
}

interface BatchRemovalResponse {
  batch: true;
  removed: number;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

function uniquePhrases(prefix: string, count: number): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from({ length: count }, (_, i) => `task234 ${prefix} ${id} phrase ${i + 1}`);
}

async function addPhrase(
  api: APIRequestContext,
  phrase: string,
  category: "absence" | "hedging" | "buzzword",
  reviewer: string,
): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category, reviewer },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function patchCategory(
  api: APIRequestContext,
  phrase: string,
  category: "absence" | "hedging" | "buzzword",
  reviewer: string,
): Promise<void> {
  const res = await api.patch("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category, reviewer },
  });
  expect(
    res.ok(),
    `PATCH handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function removeSingle(api: APIRequestContext, phrase: string, reviewer: string): Promise<string> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, reviewer },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (single) failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as SingleRemovalResponse;
  const removedAt = body.historyEntry?.removedAt;
  expect(typeof removedAt, "single removal should produce a removedAt").toBe("string");
  return removedAt as string;
}

async function batchRemove(
  api: APIRequestContext,
  phrases: string[],
  reviewer: string,
): Promise<BatchRemovalResponse> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrases, reviewer },
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

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task234-cleanup" },
    })
    .catch(() => undefined);
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

async function findHistoryRowFor(page: Page, phrase: string): Promise<Locator> {
  const row = page.getByTestId("handwavy-history-row").filter({ hasText: phrase });
  await expect(
    row,
    `expected exactly one history row for "${phrase}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return row;
}

async function findBatchGroup(page: Page, removedAt: string): Promise<Locator> {
  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${removedAt}"]`,
  );
  await expect(
    group,
    `expected to find a batch group with data-batch-removed-at="${removedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
}

test.describe("FLAT hand-wavy phrase panel — removed-history category-flip badge (Task #234)", () => {
  test("single-removal row with >= 2 category transitions shows the badge and lists transitions in the tooltip", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [phrase] = uniquePhrases("single-flippy", 1);

    try {
      // Two distinct category transitions on the SAME phrase, then remove
      // it. The remove path preserves the marker's `edits` array on the
      // history entry so the badge has data to count after the row leaves
      // the active list.
      await addPhrase(apiCtx, phrase, "absence", "alice@team.com");
      await patchCategory(apiCtx, phrase, "hedging", "bob@team.com");
      await patchCategory(apiCtx, phrase, "buzzword", "carol@team.com");
      await removeSingle(apiCtx, phrase, "dave@team.com");

      await openHistory(page);
      const row = await findHistoryRowFor(page, phrase);

      // Badge is present, scoped to this row, with the right count.
      const badge = row.getByTestId("handwavy-history-category-flip-badge");
      await expect(badge).toHaveCount(1);
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("2 category flips");

      // Hovering the badge surfaces a tooltip listing each transition with
      // the reviewer + timestamp, mirroring the active-row tooltip from
      // Task #149.
      await badge.hover();
      const tooltip = page.getByTestId("handwavy-history-category-flip-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("Category changed 2 times");
      // Both transitions appear in chronological order with their editors.
      await expect(tooltip).toContainText(/absence\s*→\s*hedging/);
      await expect(tooltip).toContainText(/hedging\s*→\s*buzzword/);
      await expect(tooltip).toContainText("bob@team.com");
      await expect(tooltip).toContainText("carol@team.com");
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("single-removal row with only ONE category transition does NOT show the badge", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [phrase] = uniquePhrases("single-onehop", 1);

    try {
      // ONE category transition is a one-off correction, not churn — the
      // badge threshold matches the active list (>= 2) so this row must
      // render exactly as it did before #234.
      await addPhrase(apiCtx, phrase, "absence", "alice@team.com");
      await patchCategory(apiCtx, phrase, "hedging", "bob@team.com");
      await removeSingle(apiCtx, phrase, "dave@team.com");

      await openHistory(page);
      const row = await findHistoryRowFor(page, phrase);

      await expect(
        row.getByTestId("handwavy-history-category-flip-badge"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("batch-removal group shows the flip badge per inner phrase, not aggregated across the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [flippy, calm] = uniquePhrases("batch-mixed", 2);

    try {
      // `flippy` racks up 2 category transitions; `calm` is added once
      // and never re-categorized. Batch-removing both produces one batch
      // group whose inner rows mirror those two phrases.
      await addPhrase(apiCtx, flippy, "absence", "alice@team.com");
      await patchCategory(apiCtx, flippy, "hedging", "bob@team.com");
      await patchCategory(apiCtx, flippy, "buzzword", "carol@team.com");

      await addPhrase(apiCtx, calm, "hedging", "alice@team.com");

      const batch = await batchRemove(apiCtx, [flippy, calm], "dave@team.com");
      const removedAt = batch.historyEntry!.removedAt;

      await openHistory(page);
      const group = await findBatchGroup(page, removedAt);

      const innerRows = group.getByTestId("handwavy-history-row");
      const flippyRow = innerRows.filter({ hasText: flippy });
      const calmRow = innerRows.filter({ hasText: calm });
      await expect(flippyRow).toHaveCount(1);
      await expect(calmRow).toHaveCount(1);

      // Per-inner-phrase badge: flippy gets it, calm doesn't.
      const flipBadgeOnFlippy = flippyRow.getByTestId(
        "handwavy-history-category-flip-badge",
      );
      await expect(flipBadgeOnFlippy).toHaveCount(1);
      await expect(flipBadgeOnFlippy).toContainText("2 category flips");

      await expect(
        calmRow.getByTestId("handwavy-history-category-flip-badge"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [flippy, calm]);
      await apiCtx.dispose();
    }
  });
});
