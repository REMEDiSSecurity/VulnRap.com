import { test, expect } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #343 — when GET
// /feedback/calibration/handwavy-phrases/removal-batches/{removedAt}
// fails the picker preview dialog used to leave the reviewer with no
// escape but Cancel. The dialog now (a) renders a friendly message keyed
// off the `reason` field returned by the detail endpoint and (b) exposes
// a "Try again" control that re-issues the GET without closing the
// dialog. This spec exercises the NOT_FOUND branch (`history-not-found`)
// because that's the easiest reason to fault-inject deterministically
// from page.route(), then confirms that retrying — once the route is
// removed and the underlying batch really does exist — recovers cleanly.

const REVIEWER = "e2e-task343";

test.describe("FLAT hand-wavy phrase picker preview — error recovery", () => {
  test("renders the reason-keyed message and recovers via Try again", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task343 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;
      // The generated client interpolates removedAt straight into the
      // URL without encoding (see getGetHandwavyPhraseRemovalBatchUrl);
      // the browser may or may not percent-encode the colons depending
      // on the runtime, so we match BOTH forms by URL substring inside
      // the handler instead of relying on a single literal pattern.
      const encoded = encodeURIComponent(removedAt);

      // Fault-inject a 404 with reason: "history-not-found" on the FIRST
      // matching detail call, then fall through to the real server on
      // every subsequent call so "Try again" actually recovers.
      let detailCalls = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases/removal-batches/**",
        async (route) => {
          const req = route.request();
          if (req.method() !== "GET") {
            await route.fallback();
            return;
          }
          const url = req.url();
          if (!url.includes(removedAt) && !url.includes(encoded)) {
            await route.fallback();
            return;
          }
          detailCalls += 1;
          if (detailCalls === 1) {
            await route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({
                error: "no removal-history entry matches removedAt",
                reason: "history-not-found",
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      const panel = page.getByTestId("handwavy-removal-batches-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const row = page.locator(
        `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${removedAt}"]`,
      );
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open the preview — first GET is intercepted and 404s.
      await row.getByTestId("handwavy-removal-batches-reinstate").click();
      const dialog = page.getByTestId("handwavy-removal-batches-preview-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toHaveAttribute("data-status", "error", {
        timeout: 10_000,
      });

      // The error block surfaces the reason and the friendly hint —
      // NOT just the raw fetch message — and the dialog stays open so
      // the reviewer can act without dismissing.
      const errorBlock = dialog.getByTestId(
        "handwavy-removal-batches-preview-error",
      );
      await expect(errorBlock).toBeVisible();
      await expect(errorBlock).toHaveAttribute(
        "data-error-reason",
        "history-not-found",
      );
      await expect(errorBlock).toContainText("no longer exists");

      // Try again re-issues the GET without closing the dialog. The
      // second call hits the real server (route falls back), the batch
      // exists, and the dialog flips to the ready state populated with
      // the seeded phrases.
      const retry = dialog.getByTestId("handwavy-removal-batches-preview-retry");
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      await retry.click();

      await expect(dialog).toHaveAttribute("data-status", "ready", {
        timeout: 10_000,
      });
      const previewList = dialog.getByTestId(
        "handwavy-removal-batches-preview-list",
      );
      await expect(previewList).toBeVisible();
      for (const p of phrases) {
        await expect(previewList).toContainText(p);
      }
      // Sanity: the route did get exercised twice — once for the seeded
      // 404 and once for the recovery — confirming "Try again" really
      // re-fired the same GET.
      expect(detailCalls).toBeGreaterThanOrEqual(2);

      // Cancel the dialog so the test doesn't actually mutate state on
      // the way out — cleanup() handles teardown via the API.
      await dialog
        .getByTestId("handwavy-removal-batches-preview-cancel")
        .click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #490 — sibling coverage for the `not-a-batch` reason. This is
  // the path the detail endpoint takes when the picker is somehow
  // pointed at a single-phrase removal entry; the dialog renders a
  // distinct hint pointing the reviewer at the per-phrase Removal
  // history panel rather than the generic transport error. We don't
  // exercise recovery here — by definition a retry against a
  // not-a-batch entry will keep returning 404 — but the "Try again"
  // button must still be present because the contract is "always
  // re-issue the GET on click", regardless of likely success.
  test("renders the not-a-batch hint and keeps Try again available", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task490 batch");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;
      const encoded = encodeURIComponent(removedAt);

      // Persistently fault-inject a 404 with reason: "not-a-batch" on
      // every matching detail GET. The underlying batch really exists
      // (we just seeded it above) so without this route the dialog
      // would happily load — the route is what forces the error
      // branch into the not-a-batch hint specifically.
      let detailCalls = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases/removal-batches/**",
        async (route) => {
          const req = route.request();
          if (req.method() !== "GET") {
            await route.fallback();
            return;
          }
          const url = req.url();
          if (!url.includes(removedAt) && !url.includes(encoded)) {
            await route.fallback();
            return;
          }
          detailCalls += 1;
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({
              error: "removal-history entry is a single-phrase removal, not a batch",
              reason: "not-a-batch",
            }),
          });
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      const panel = page.getByTestId("handwavy-removal-batches-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const row = page.locator(
        `[data-testid="handwavy-removal-batches-row"][data-batch-removed-at="${removedAt}"]`,
      );
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      await row.getByTestId("handwavy-removal-batches-reinstate").click();
      const dialog = page.getByTestId("handwavy-removal-batches-preview-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toHaveAttribute("data-status", "error", {
        timeout: 10_000,
      });

      const errorBlock = dialog.getByTestId(
        "handwavy-removal-batches-preview-error",
      );
      await expect(errorBlock).toBeVisible();
      await expect(errorBlock).toHaveAttribute(
        "data-error-reason",
        "not-a-batch",
      );
      // The reviewer-facing hint must point at the per-phrase Removal
      // history panel — that's the regression we're guarding against.
      await expect(errorBlock).toContainText(
        "per-phrase Removal history panel",
      );

      // "Try again" is part of the dialog contract regardless of
      // whether retrying is likely to succeed; assert it's present
      // and clickable, then confirm clicking it re-issues the GET
      // (the route stays installed, so we just see the call count
      // tick up and the dialog stays in the error state).
      const retry = dialog.getByTestId("handwavy-removal-batches-preview-retry");
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      const callsBeforeRetry = detailCalls;
      await retry.click();
      await expect
        .poll(() => detailCalls, { timeout: 10_000 })
        .toBeGreaterThan(callsBeforeRetry);
      await expect(dialog).toHaveAttribute("data-status", "error");
      await expect(errorBlock).toHaveAttribute(
        "data-error-reason",
        "not-a-batch",
      );

      await dialog
        .getByTestId("handwavy-removal-batches-preview-cancel")
        .click();
      await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
