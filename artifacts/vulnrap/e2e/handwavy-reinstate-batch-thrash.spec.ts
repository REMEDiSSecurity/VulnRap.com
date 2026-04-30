import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #179 — End-to-end coverage for the bulk-REINSTATE thrash warning.
// Task #151 already gated the bulk-REMOVE preview panel with a per-row
// amber badge + "N of M selected phrases have already cycled 2+ times"
// summary. This spec exercises the mirror operation: after a reviewer
// batch-removes a mix of high-thrash and fresh phrases, the batch group
// in the removal-history panel must surface the same thrash signal so a
// "Reinstate all N" click can't quietly start another cycle on a phrase
// that's already flipped twice.
//
// The spec also pins the no-op case: a batch containing zero high-thrash
// phrases must render exactly as it did before #179 — no summary banner,
// no per-row thrash badges.

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
  return Array.from({ length: count }, (_, i) => `task179 ${prefix} ${id} phrase ${i + 1}`);
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task179" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function removeSingle(api: APIRequestContext, phrase: string): Promise<string> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, reviewer: "e2e-task179" },
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

async function reinstate(
  api: APIRequestContext,
  phrase: string,
  removedAt: string,
): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases/reinstate", {
    data: { phrase, removedAt, reviewer: "e2e-task179" },
  });
  expect(
    res.ok(),
    `POST reinstate failed for "${phrase}" @ ${removedAt}: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function seedCycles(
  api: APIRequestContext,
  phrase: string,
  cycles: number,
): Promise<void> {
  await addPhrase(api, phrase);
  for (let i = 0; i < cycles; i++) {
    const removedAt = await removeSingle(api, phrase);
    await reinstate(api, phrase, removedAt);
  }
}

async function batchRemove(
  api: APIRequestContext,
  phrases: string[],
): Promise<BatchRemovalResponse> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrases, reviewer: "e2e-task179" },
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
      data: { phrases, reviewer: "e2e-task179-cleanup" },
    })
    .catch(() => undefined);
}

async function openHistoryAndFindBatch(
  page: Page,
  batchRemovedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();
  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${batchRemovedAt}"]`,
  );
  await expect(
    group,
    `expected to find a batch group with data-batch-removed-at="${batchRemovedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
}

test.describe("FLAT hand-wavy phrase panel — bulk-reinstate thrash warning (Task #179, #366)", () => {
  test("batch group with a high-thrash inner phrase shows the summary banner and per-row badge", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const [thrashy, fresh] = uniquePhrases("mixed", 2);

    try {
      // `thrashy` ends with 2 completed cycles (and is currently active);
      // `fresh` is added once and has 0 cycles. Batch-removing both gives
      // us one batch group whose remaining inner rows are exactly these
      // two phrases.
      await seedCycles(apiCtx, thrashy, 2);
      await addPhrase(apiCtx, fresh);
      const batch = await batchRemove(apiCtx, [thrashy, fresh]);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);

      // The summary banner must be present, scoped to the batch group
      // (not floating somewhere else on the page), and read "1 of 2 …
      // has already cycled 2+ times".
      const summary = group.getByTestId("handwavy-history-batch-thrash-summary");
      await expect(summary).toBeVisible();
      await expect(summary).toContainText(/1 of 2 selected phrases has already cycled 2\+ times/);

      // The thrashy inner row must carry the per-row amber badge.
      const innerRows = group.getByTestId("handwavy-history-row");
      const thrashyRow = innerRows.filter({ hasText: thrashy });
      const freshRow = innerRows.filter({ hasText: fresh });
      await expect(thrashyRow).toHaveCount(1);
      await expect(freshRow).toHaveCount(1);

      const thrashBadgeOnThrashy = thrashyRow.getByTestId("handwavy-history-batch-thrash-badge");
      await expect(thrashBadgeOnThrashy).toHaveCount(1);
      await expect(thrashBadgeOnThrashy).toContainText("2× cycles");

      // The fresh row (0 completed cycles) must NOT get a badge — the
      // thrash signal is supposed to single out the contentious row.
      await expect(freshRow.getByTestId("handwavy-history-batch-thrash-badge")).toHaveCount(0);

      // The "Reinstate all 2" button must still be the affordance — the
      // warning is informational, not a hard block.
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toBeEnabled();
      await expect(batchBtn).toHaveText(/Reinstate all 2\b/);
    } finally {
      await cleanup(apiCtx, [thrashy, fresh]);
      await apiCtx.dispose();
    }
  });

  test("batch group with zero high-thrash inner phrases renders no summary banner and no per-row badges", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases("clean", 2);

    try {
      // Both phrases are fresh — neither has been cycled.
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);

      // The summary banner must be absent — the visual layout for a
      // clean batch must be identical to the pre-#179 layout.
      await expect(
        group.getByTestId("handwavy-history-batch-thrash-summary"),
      ).toHaveCount(0);

      // Neither inner row should carry a per-row thrash badge.
      const innerRows = group.getByTestId("handwavy-history-row");
      await expect(innerRows).toHaveCount(phrases.length);
      await expect(
        group.getByTestId("handwavy-history-batch-thrash-badge"),
      ).toHaveCount(0);

      // The batch button is still wired up exactly as before.
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toHaveText(new RegExp(`Reinstate all ${phrases.length}\\b`));
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  // Task #366 — auto-expand the per-phrase rows of a batch group when ≥1
  // inner phrase is high-thrash; routine batches stay collapsed; manual
  // collapse sticks for the session. Mirrors Task #257's bulk-REMOVE
  // preview pattern.
  test(
    "high-thrash batch auto-expands per-phrase rows; routine batches collapsed; manual collapse sticks",
    async ({ page }) => {
      const apiCtx = await newApiContext();
      const [thrashy, fresh] = uniquePhrases("auto-expand mixed", 2);
      const cleanPhrases = uniquePhrases("auto-expand clean", 2);

      try {
        await seedCycles(apiCtx, thrashy, 2);
        await addPhrase(apiCtx, fresh);
        const mixedBatch = await batchRemove(apiCtx, [thrashy, fresh]);
        const mixedRemovedAt = mixedBatch.historyEntry!.removedAt;

        for (const p of cleanPhrases) await addPhrase(apiCtx, p);
        const cleanBatch = await batchRemove(apiCtx, cleanPhrases);
        const cleanRemovedAt = cleanBatch.historyEntry!.removedAt;

        const mixedGroup = await openHistoryAndFindBatch(page, mixedRemovedAt);
        const cleanGroup = page.locator(
          `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${cleanRemovedAt}"]`,
        );
        await expect(cleanGroup).toHaveCount(1, { timeout: 15_000 });

        const mixedDetails = mixedGroup.getByTestId(
          "handwavy-history-batch-rows-details",
        );
        await expect(mixedDetails).toHaveAttribute("data-default-open", "true");
        await expect(mixedDetails).toHaveAttribute("data-auto-expanded", "true");
        await expect(mixedDetails).toHaveAttribute("open", /.*/);

        const thrashyRow = mixedGroup
          .getByTestId("handwavy-history-row")
          .filter({ hasText: thrashy });
        await expect(thrashyRow).toHaveCount(1);
        await expect(
          thrashyRow.getByTestId("handwavy-history-batch-thrash-badge"),
        ).toBeVisible();

        const cleanDetails = cleanGroup.getByTestId(
          "handwavy-history-batch-rows-details",
        );
        await expect(cleanDetails).toHaveAttribute("data-default-open", "false");
        await expect(cleanDetails).toHaveAttribute("data-auto-expanded", "false");
        await expect(cleanDetails).not.toHaveAttribute("open", /.*/);

        // Manual collapse must stick: explicit override flips
        // data-auto-expanded to "false" so the auto-open won't re-fire.
        await mixedGroup
          .getByTestId("handwavy-history-batch-rows-summary")
          .click();
        await expect(mixedDetails).not.toHaveAttribute("open", /.*/);
        await expect(mixedDetails).toHaveAttribute("data-default-open", "true");
        await expect(mixedDetails).toHaveAttribute("data-auto-expanded", "false");
      } finally {
        await cleanup(apiCtx, [thrashy, fresh, ...cleanPhrases]);
        await apiCtx.dispose();
      }
    },
  );
});
