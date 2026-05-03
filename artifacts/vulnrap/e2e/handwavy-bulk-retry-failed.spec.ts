import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #238 — End-to-end coverage for the "Retry failed" action that lives
// on the bulk-remove and bulk-undo results banners. The reviewer kicks off
// a bulk batch, one or more rows fail with a transient error, and the
// new banner button re-runs ONLY those failed rows through the same
// endpoint and replaces the banner with the fresh per-phrase outcomes.

const REVIEWER = "e2e-task238";
const CLEANUP_REVIEWER = "e2e-task238-cleanup";

test.describe("Retry failed on bulk results banner (Task #238)", () => {
  test("Bulk-remove banner exposes Retry failed and re-runs only the failed phrase", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task238 retry remove-mixed");
    const [, transientPhrase] = phrases;

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Stub the destructive single-phrase DELETE for `transientPhrase` to
      // return 500 the FIRST time and pass through every time after, so the
      // initial bulk-remove ends with 1 removed + 1 error and the retry
      // click then succeeds against the real server. Dry-run DELETEs and
      // every DELETE for the other phrase fall through to the live server.
      let transientFailUsed = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun) {
            await route.fallback();
            return;
          }
          if (!transientFailUsed && body?.phrase === transientPhrase) {
            transientFailUsed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic transient failure" }),
            });
            return;
          }
          await route.fallback();
        },
      );

      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-kind", "remove");
      // Mixed outcome: 1 removed + 1 error → Retry failed shows up.
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="error"]`,
        ),
      ).toHaveCount(1);

      const retryBtn = banner.getByTestId("handwavy-bulk-retry-failed");
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toContainText(/Retry failed \(1\)/);

      await retryBtn.click();

      // Banner now reflects the retry-only batch (1 row, REMOVED) — the
      // original successful row is gone because the banner is replaced
      // with the new per-phrase outcomes from the retry pass.
      await expect(banner).toHaveAttribute("data-kind", "remove");
      await expect(banner).toContainText("1 / 1 removed");
      await expect(
        banner.locator(`[data-testid="handwavy-bulk-result-row"]`),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(1);
      // No retryable failures left → Retry failed disappears.
      await expect(
        banner.getByTestId("handwavy-bulk-retry-failed"),
      ).toHaveCount(0);

      // Both phrases are now off the active list.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("Retry failed is hidden on an all-success bulk-remove banner", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task238 retry all-success");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      // All rows REMOVED — no error / auth-failed → no Retry button.
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(phrases.length);
      await expect(
        banner.getByTestId("handwavy-bulk-retry-failed"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("Retry failed honors the calibration cooldown after a 429 lands mid-batch (Task #335)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task238 retry retry-cooldown");
    const [, transientPhrase] = phrases;
    const COOLDOWN_SECONDS = 5;

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // First DELETE for `transientPhrase` returns 500 so the initial
      // bulk-remove ends with 1 removed + 1 error (same setup as the
      // happy-path retry test). After that, the very next DELETE for
      // `transientPhrase` (which the Retry button would trigger) returns
      // 429 with the standard rate-limit headers — that 429 is what
      // trips the wrong-token cooldown store. Once the cooldown is
      // active the Retry button must bail with the shared "wait Ns"
      // message and NOT issue any further DELETEs.
      let transientFailUsed = false;
      let cooldownTripped = false;
      let postCooldownDeletes = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun) {
            await route.fallback();
            return;
          }
          if (cooldownTripped) {
            // Defense-in-depth: count any DELETE that sneaks past the
            // cooldown gate so the assertion below catches a regression
            // where the Retry button bypasses bailOnCooldown.
            postCooldownDeletes += 1;
            await route.fallback();
            return;
          }
          if (!transientFailUsed && body?.phrase === transientPhrase) {
            transientFailUsed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic transient failure" }),
            });
            return;
          }
          if (transientFailUsed && body?.phrase === transientPhrase) {
            // The retry click would issue this DELETE. Return 429 with
            // the standard rate-limit headers so the shared API client
            // forwards the notice into the cooldown store.
            cooldownTripped = true;
            await route.fulfill({
              status: 429,
              headers: {
                "content-type": "application/json",
                "ratelimit-limit": "10",
                "ratelimit-remaining": "0",
                "ratelimit-reset": String(COOLDOWN_SECONDS),
                "retry-after": String(COOLDOWN_SECONDS),
              },
              body: JSON.stringify({
                error:
                  "Too many failed calibration auth attempts. Please wait a minute before trying again.",
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveAttribute("data-kind", "remove");

      // First retry click — drives a single DELETE for `transientPhrase`
      // which our stub answers with 429. The shared API client surfaces
      // that to the cooldown store, which then trips `cooldown.active`.
      const retryBtn = banner.getByTestId("handwavy-bulk-retry-failed");
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toContainText(/Retry failed \(1\)/);
      await expect(retryBtn).toHaveAttribute("data-cooldown-active", "false");
      await retryBtn.click();

      // Cooldown banner appears (one in the calibration card, one in the
      // hand-wavy admin) and the Retry button flips to disabled with the
      // shared "Cooldown — Ns" label.
      await expect(
        page.getByTestId("calibration-cooldown-banner").first(),
      ).toBeVisible({ timeout: 5_000 });
      await expect(retryBtn).toBeDisabled();
      await expect(retryBtn).toHaveAttribute("data-cooldown-active", "true");
      await expect(retryBtn).toContainText(/Cooldown\s+—\s+\d+s/i);

      const deletesBeforeForceClick = postCooldownDeletes;

      // Defense-in-depth: even forcing a click while the button is
      // disabled must NOT fire another DELETE. This pins down both
      // halves of the gate — `disabled={... || cooldown.active}` and
      // the `bailOnCooldown("Bulk removal")` guard at the top of
      // `confirmBulkRemove` itself (Task #469 centralized the bail
      // inside the helper so any future caller is automatically
      // protected — the original Task #335 per-caller guard is no
      // longer needed in the Retry handler). A regression that drops
      // either half would let the forced click through and bump the
      // post-cooldown DELETE counter.
      await retryBtn.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(300);
      expect(postCooldownDeletes).toBe(deletesBeforeForceClick);
    } finally {
      await page.unroute("**/api/feedback/calibration/handwavy-phrases");
      await cleanup(apiCtx, phrases, { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("Bulk-undo banner exposes Retry failed and re-runs only the failed reinstate", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task238 retry undo-mixed");
    const [, transientPhrase] = phrases;

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // First, drive both phrases through the bulk-remove preview/confirm
      // flow (no routing yet so the live server records the history rows
      // both phrases need for reinstate).
      for (const p of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-bulk-preview-confirm").click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });

      const banner = page.getByTestId("handwavy-bulk-results");
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="removed"]`,
        ),
      ).toHaveCount(phrases.length);

      // Now stub the reinstate endpoint to fail with 500 the FIRST time
      // for `transientPhrase` only, and pass through every other call.
      let transientReinstateFailUsed = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases/reinstate",
        async (route) => {
          const req = route.request();
          const body = req.postDataJSON() as { phrase?: string } | undefined;
          if (!transientReinstateFailUsed && body?.phrase === transientPhrase) {
            transientReinstateFailUsed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({
                error: "Synthetic transient reinstate failure",
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      // Click "Undo this batch" — one row succeeds, one errors.
      await banner.getByTestId("handwavy-bulk-undo").click();
      await expect(banner).toHaveAttribute("data-kind", "undo");
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="reinstated"]`,
        ),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="error"]`,
        ),
      ).toHaveCount(1);

      // Retry failed appears on the post-undo banner with the failed-row
      // count.
      const retryBtn = banner.getByTestId("handwavy-bulk-retry-failed");
      await expect(retryBtn).toBeVisible();
      await expect(retryBtn).toContainText(/Retry failed \(1\)/);

      await retryBtn.click();

      // Retry runs the previously-failed reinstate against the now-passing
      // route and replaces the banner with just the retry's outcomes.
      await expect(banner).toHaveAttribute("data-kind", "undo");
      await expect(banner).toContainText("1 / 1 reinstated");
      await expect(
        banner.locator(`[data-testid="handwavy-bulk-result-row"]`),
      ).toHaveCount(1);
      await expect(
        banner.locator(
          `[data-testid="handwavy-bulk-result-row"][data-status="reinstated"]`,
        ),
      ).toHaveCount(1);
      // Both phrases are back on the active list (one from the first undo
      // pass, the other from the retry).
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      // No more retryable failures.
      await expect(
        banner.getByTestId("handwavy-bulk-retry-failed"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });
});
