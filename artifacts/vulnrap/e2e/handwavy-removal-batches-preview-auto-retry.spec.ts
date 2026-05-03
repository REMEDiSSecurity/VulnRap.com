import { test, expect } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #489 — when the picker-preview GET hits a transient blip
// (transport error or 5xx) it now silently retries once before flipping
// the dialog into the error state added by Task #343. This spec
// fault-injects a one-shot 503 on the FIRST detail call and asserts
// (a) the dialog never visibly enters the "error" status — only loading
// → ready — and (b) the underlying GET was issued twice (the seeded
// 503 + the silent recovery).

const REVIEWER = "e2e-task489";

test.describe("FLAT hand-wavy phrase picker preview — silent auto-retry", () => {
  test("silently retries once on a transient 503 and lands in ready", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task489 batch");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      const batch = await batchRemove(apiCtx, phrases, { reviewer: REVIEWER });
      const removedAt = batch.historyEntry!.removedAt;
      // The generated client interpolates removedAt straight into the
      // URL without encoding (see getGetHandwavyPhraseRemovalBatchUrl);
      // the browser may or may not percent-encode the colons depending
      // on the runtime, so match BOTH forms by URL substring.
      const encoded = encodeURIComponent(removedAt);

      // Track every status the dialog passes through so we can assert it
      // never visibly entered "error" state (i.e. no loading → error →
      // loading → ready flicker, only loading → ready).
      const seenStatuses: string[] = [];

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
            // One-shot 503 — exactly the kind of transient blip the
            // silent auto-retry is meant to absorb.
            await route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "service unavailable" }),
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

      // Start observing the dialog's data-status attribute via a
      // MutationObserver wired up before the click, so we don't miss
      // any short-lived intermediate state.
      await page.evaluate(() => {
        (
          window as unknown as { __task489Statuses: string[] }
        ).__task489Statuses = [];
        const seen = (window as unknown as { __task489Statuses: string[] })
          .__task489Statuses;
        const observer = new MutationObserver(() => {
          const dlg = document.querySelector(
            '[data-testid="handwavy-removal-batches-preview-confirm"]',
          ) as HTMLElement | null;
          if (!dlg) return;
          const status = dlg.getAttribute("data-status");
          if (status && seen[seen.length - 1] !== status) seen.push(status);
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-status"],
        });
        (
          window as unknown as { __task489Observer: MutationObserver }
        ).__task489Observer = observer;
      });

      // Open the preview — first GET 503s, silent retry succeeds.
      await row.getByTestId("handwavy-removal-batches-reinstate").click();
      const dialog = page.getByTestId(
        "handwavy-removal-batches-preview-confirm",
      );
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog).toHaveAttribute("data-status", "ready", {
        timeout: 10_000,
      });

      // Assert the dialog populated normally — same shape as the
      // happy-path assertions in handwavy-removal-batches-preview-error.
      const previewList = dialog.getByTestId(
        "handwavy-removal-batches-preview-list",
      );
      await expect(previewList).toBeVisible();
      for (const p of phrases) {
        await expect(previewList).toContainText(p);
      }

      // The error block must NEVER have rendered — the auto-retry is
      // supposed to absorb the blip silently.
      await expect(
        dialog.getByTestId("handwavy-removal-batches-preview-error"),
      ).toHaveCount(0);
      await expect(
        dialog.getByTestId("handwavy-removal-batches-preview-retry"),
      ).toHaveCount(0);

      // The status sequence must be loading → ready, never visiting
      // "error" in between. Pull the recorded statuses back out of the
      // page context.
      const statusSequence = await page.evaluate(() => {
        return (window as unknown as { __task489Statuses: string[] })
          .__task489Statuses;
      });
      seenStatuses.push(...statusSequence);
      expect(seenStatuses).not.toContain("error");
      expect(seenStatuses[seenStatuses.length - 1]).toBe("ready");

      // Sanity: the route was exercised exactly twice (seeded 503 +
      // silent retry). If it fired more than twice the auto-retry has
      // started looping; if it fired once the retry didn't happen.
      expect(detailCalls).toBe(2);

      // Cancel the dialog so the test doesn't actually mutate state on
      // the way out.
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
