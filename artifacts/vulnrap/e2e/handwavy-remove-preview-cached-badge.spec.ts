import { test, expect } from "@playwright/test";
import {
  addPhrase,
  addPhraseViaUi,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #493 — End-to-end coverage for the per-row Trash impact preview's
// fresh-vs-cached badge added by Task #349. The unit test in
// `feedback-analytics.test.tsx` pins the helper's branching logic; this
// spec verifies the integration in a real browser:
//
//   * The badge is actually rendered in the DOM (with the
//     `handwavy-remove-preview-source` testid + `data-source` /
//     `data-scanned-at` attributes the page exposes for automation).
//   * On the first Trash click the badge reads "Fresh scan" and carries
//     `data-source="fresh"`.
//   * After Back-out → re-Trash on the same phrase, the cache from
//     Task #246 short-circuits the second dryRun and the badge flips to
//     "Reused scan · Ns ago" with `data-source="cached"`.
//   * The relative-time text advances while the panel stays open (the
//     1Hz tick in `feedback-analytics.tsx` updates the cached badge).
//   * Bumping the active-list version between the two Trash clicks (by
//     adding an unrelated phrase) invalidates the cache, so the second
//     click re-fetches and the badge stays "Fresh scan".
//
// All Trash dryRun + live DELETE traffic for the phrase under test is
// stubbed via `page.route` so the panel is forced to render
// (validDetectionsLost > 0 keeps it open for inspection — a zero-impact
// dryRun would short-circuit to a one-click DELETE and never show the
// badge). Other DELETE traffic falls through to the real api-server.

const REVIEWER = "e2e-task493";

interface InterceptCounters {
  dryRunForPhrase: number;
  liveDeleteForPhrase: number;
}

/**
 * Stub `DELETE /api/feedback/calibration/handwavy-phrases` for the given
 * phrase only. Dry-run requests are answered with a synthetic
 * `validDetectionsLost: 1` impact response (so the preview panel renders);
 * live DELETEs for the same phrase fall through to the real server so the
 * row actually disappears at the end of the test. The returned counters
 * let the spec assert that the cache short-circuited (or didn't) the
 * expected number of dryRun fetches.
 */
async function stubDryRunForPhrase(
  page: import("@playwright/test").Page,
  phrase: string,
): Promise<InterceptCounters> {
  const counters: InterceptCounters = {
    dryRunForPhrase: 0,
    liveDeleteForPhrase: 0,
  };
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
      if (body?.dryRun && body.phrase === phrase) {
        counters.dryRunForPhrase += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dryRun: true,
            batch: false,
            wouldRemove: 1,
            notFound: 0,
            duplicateInBatch: 0,
            phrase,
            raw: phrase,
            removed: true,
            reason: null,
            total: 99,
            projectedTotal: 98,
            results: [{ raw: phrase, phrase, removed: true }],
            dryRunImpact: {
              corpus: {
                total: 2,
                validDetectionsLost: 1,
                falsePositivesDropped: 1,
                byTier: {
                  t1Legit: 1,
                  t2Borderline: 0,
                  t3Slop: 1,
                  t4Hallucinated: 0,
                },
                sampleMatches: [
                  { id: "fixture-task493-001", tier: "T1_LEGIT" },
                ],
                warning:
                  "1 legitimate detection would be lost from the curated benchmark",
                corpusSize: 47,
                oldestCreatedAt: null,
                newestCreatedAt: null,
              },
              production: null,
              productionError:
                "Production scan stubbed out for the cached-badge spec",
              productionLimit: 200,
            },
            phrases: [],
          }),
        });
        return;
      }
      if (
        !body?.dryRun &&
        (body?.phrase === phrase || body?.phrases?.includes(phrase))
      ) {
        counters.liveDeleteForPhrase += 1;
      }
      await route.fallback();
    },
  );
  return counters;
}

test.describe("Per-row Trash preview — fresh-vs-cached badge (Task #493)", () => {
  test("badge flips from 'Fresh scan' to 'Reused scan · Ns ago' on Back-out → re-Trash and the relative-time text advances while the panel stays open", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task493 cached badge", "phrase");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

      const counters = await stubDryRunForPhrase(page, phrase);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // First Trash click → fresh scan badge.
      await row.getByTestId("handwavy-remove").click();
      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const badge = panel.getByTestId("handwavy-remove-preview-source");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAttribute("data-source", "fresh");
      await expect(badge).toHaveText("Fresh scan");
      const freshScannedAt = await badge.getAttribute("data-scanned-at");
      expect(
        freshScannedAt,
        "fresh badge must expose the write-time scannedAt for automation",
      ).not.toBeNull();
      expect(Number.isFinite(Number(freshScannedAt))).toBe(true);
      expect(
        counters.dryRunForPhrase,
        "first Trash click must fetch a dryRun against the server",
      ).toBe(1);

      // Back out without confirming, then immediately re-Trash. The
      // active-list version is unchanged so the cache from Task #246
      // serves the stored response and the badge flips to "cached".
      await panel.getByTestId("handwavy-remove-preview-cancel").click();
      await expect(panel).toHaveCount(0);

      await row.getByTestId("handwavy-remove").click();
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(badge).toHaveAttribute("data-source", "cached");
      // The cached `scannedAt` must equal the original fresh fetch's
      // anchor — the cache is keyed off the original write-time stamp.
      await expect(badge).toHaveAttribute(
        "data-scanned-at",
        freshScannedAt as string,
      );
      // Sub-5s diff collapses to "just now" so the back-to-back re-Trash
      // doesn't flicker "0s" → "1s". On a slow CI worker the >=5s boundary
      // may have already elapsed by the time we assert here, so accept the
      // post-boundary "Ns ago" form too — the explicit advancement check
      // below still pins the 1Hz tick contract.
      await expect(badge).toHaveText(
        /^Reused scan · (just now|\d+s ago)$/,
      );
      expect(
        counters.dryRunForPhrase,
        "re-Trash within the same active-list version must reuse the cache (no second dryRun)",
      ).toBe(1);

      // Wait past the 5s "just now" boundary. The 1Hz tick in
      // `feedback-analytics.tsx` (`removePreviewNow`) advances the
      // relative-time text; once `scannedAt` is at least 5s old the
      // badge must read "Reused scan · Ns ago" with N >= 5.
      await expect(badge).toHaveText(/^Reused scan · \d+s ago$/, {
        timeout: 15_000,
      });
      const advancedLabel = await badge.textContent();
      const match = advancedLabel?.match(/Reused scan · (\d+)s ago/);
      expect(
        match,
        `expected 'Reused scan · Ns ago' after the 'just now' window, got: ${advancedLabel}`,
      ).not.toBeNull();
      const seconds = Number(match?.[1]);
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(5);

      // The re-Trash never issued a fresh server fetch — the assertion
      // above already pinned the dryRun count, but make the contract
      // explicit at the end of the cached-flow body.
      expect(counters.dryRunForPhrase).toBe(1);
      expect(
        counters.liveDeleteForPhrase,
        "no live DELETE should fire while the reviewer is just opening the preview",
      ).toBe(0);
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("changing the active list between the two Trash clicks invalidates the cache and the badge stays 'Fresh scan'", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task493 invalidation", "phrase");
    const sentinelPhrase = uniquePhrase("task493 invalidation", "sentinel");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

      const counters = await stubDryRunForPhrase(page, phrase);

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // The two-step UI add (used to bump the active-list version
      // mid-test) requires the reviewer field to be filled — without
      // it the "Confirm add" button stays disabled.
      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill(REVIEWER);

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // First Trash click → fresh badge.
      await row.getByTestId("handwavy-remove").click();
      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const badge = panel.getByTestId("handwavy-remove-preview-source");
      await expect(badge).toHaveAttribute("data-source", "fresh");
      await expect(badge).toHaveText("Fresh scan");
      const firstScannedAt = await badge.getAttribute("data-scanned-at");
      expect(firstScannedAt).not.toBeNull();
      expect(counters.dryRunForPhrase).toBe(1);

      // Back out, then bump the active-list version by adding an
      // unrelated phrase through the UI. `addPhraseViaUi` drives the
      // two-step add (Preview impact → Confirm add) so the page's
      // `refresh()` runs and the new phrase lands in `phrases`,
      // changing `computeHandwavyActiveListVersion` and evicting every
      // cached single-phrase dryRun entry.
      await panel.getByTestId("handwavy-remove-preview-cancel").click();
      await expect(panel).toHaveCount(0);

      await addPhraseViaUi(page, sentinelPhrase);
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: sentinelPhrase }),
      ).toHaveCount(1, { timeout: 15_000 });

      // Re-Trash the original phrase. The active-list version no
      // longer matches the cached entry's tag, so the page must
      // re-fetch and the badge must stay "Fresh scan".
      await row.getByTestId("handwavy-remove").click();
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(badge).toHaveAttribute("data-source", "fresh");
      await expect(badge).toHaveText("Fresh scan");
      // The fresh re-fetch produced a new write-time `scannedAt`, so
      // the data attribute must NOT match the previous fresh fetch's
      // value (otherwise the cache silently leaked across versions).
      const reFetchedScannedAt = await badge.getAttribute("data-scanned-at");
      expect(reFetchedScannedAt).not.toBeNull();
      expect(reFetchedScannedAt).not.toBe(firstScannedAt);
      expect(
        counters.dryRunForPhrase,
        "active-list invalidation must force a second dryRun fetch",
      ).toBe(2);
    } finally {
      await cleanup(apiCtx, [phrase, sentinelPhrase], {
        reviewer: `${REVIEWER}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });
});
