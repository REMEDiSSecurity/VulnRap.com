import { test, expect } from "@playwright/test";
import {
  addPhrase,
  batchRemove,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  removeSingle,
  uniquePhrase,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #412 — End-to-end coverage for the "jump to colliding row" affordance
// inside the Task #221 "Previously removed" pre-preview hint. The hint
// already names the colliding retired phrase + the audit metadata
// (reviewer, date, rationale); Task #412 makes the named phrase a
// clickable button that:
//   1. Expands the (collapsed-by-default) removal-history panel.
//   2. For batch entries: opens the per-phrase <details> inside the batch
//      group so the matching inner row is rendered.
//   3. Smooth-scrolls the matching `handwavy-history-row` into view.
//   4. Pulses it amber (data-highlighted="true") for ~2.5s before the
//      cleanup timer clears the attribute back to unset.
//
// We seed two scenarios (one test each) so a regression that breaks the
// batch-only case still trips a failure on the single-row case (and vice
// versa):
//   * single — addPhrase + removeSingle gives us a one-phrase
//     `handwavy-history-row` with `historyEntry.removedAt` matching the
//     hint's `top.removedAt`.
//   * batch — addPhrase x N + batchRemove gives us a
//     `handwavy-history-batch-group` whose inner per-phrase rows live
//     inside a collapsed-by-default <details>; clicking the hint must
//     also open that <details> (the row is removed from the DOM otherwise
//     and the scroll target wouldn't exist).
//
// Both tests hold to the parallel-safety contract documented in
// `helpers/handwavy.ts`: every assertion is scoped by the unique phrase
// the test seeded, so a sibling spec writing to the shared
// handwavy-phrases.json can't make us flake.

const REVIEWER = "e2e-task412";

test.describe("Pre-preview 'Previously removed' history hint — jump-to-row (Task #412)", () => {
  test("clicking the named phrase expands the history panel, scrolls the matching single-row entry into view, and pulse-highlights it", async ({
    page,
  }) => {
    // Use a short viewport so the removal-history panel reliably extends
    // below the fold even on a fresh dev DB. Keeps the "scrolls into view"
    // assertion meaningful without depending on a specific seeded row count.
    await page.setViewportSize({ width: 1280, height: 360 });

    const phrase = uniquePhrase("task412 single retired");
    const rationale = `task412 single rationale ${phrase.split(" ").pop()}`;
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);

      await addPhrase(api, phrase, {
        reviewer: REVIEWER,
        rationale,
        category: "hedging",
      });
      const removedAt = await removeSingle(api, phrase, { reviewer: REVIEWER });

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Wait for the history payload to land (the toggle only mounts once
      // the removal log has been fetched). We deliberately do NOT click
      // the toggle here — the jump button must expand the panel itself.
      const historyToggle = page.getByTestId("handwavy-history-toggle");
      await expect(historyToggle).toBeVisible({ timeout: 15_000 });
      await expect(
        historyToggle,
        "removal history panel should start collapsed so the jump button can prove it expands the panel",
      ).toHaveAttribute("aria-expanded", "false");

      // Type the same phrase into the add-form so
      // `detectHandwavyHistoryOverlaps` surfaces the hint.
      await page.getByTestId("handwavy-input").fill(phrase);

      const hint = page.getByTestId("handwavy-history-overlap-hint");
      await expect(hint).toBeVisible({ timeout: 15_000 });

      const jumpButton = page.getByTestId("handwavy-history-overlap-hint-jump");
      await expect(jumpButton).toBeVisible();
      await expect(
        jumpButton,
        "the jump button should name the colliding phrase",
      ).toContainText(phrase);

      // Identify the target history row by phrase + removedAt so a
      // parallel test's row (or a leftover dev-DB row matching the same
      // phrase substring) can't cause a false hit.
      const targetRow = page.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase=${JSON.stringify(phrase)}][data-handwavy-history-removed-at=${JSON.stringify(removedAt)}]`,
      );

      // Before clicking: the panel is collapsed, so the row is not in the
      // DOM at all. Asserting count 0 gives us a positive signal that the
      // post-click expansion is a real state flip and not a no-op.
      await expect(
        targetRow,
        "history row should not be rendered while the panel is collapsed",
      ).toHaveCount(0);

      await jumpButton.click();

      // The panel should now be expanded and the matching row mounted +
      // marked highlighted. The highlight flips synchronously in the
      // click handler; the smooth scroll is scheduled on the next animation
      // frame, so wait for both signals to avoid a flake on a slow scroll.
      await expect(historyToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: 2_000,
      });
      await expect(targetRow).toHaveCount(1, { timeout: 2_000 });
      await expect(
        targetRow,
        "clicking the jump button should mark the target row as highlighted",
      ).toHaveAttribute("data-highlighted", "true", { timeout: 2_000 });

      // The row should now be within the viewport. Playwright's
      // `toBeInViewport` checks that the requested ratio of the element
      // overlaps the visible area; smooth-scrollIntoView({block:'center'})
      // guarantees the row is fully on-screen once the animation settles.
      await expect(
        targetRow,
        "the target row should be scrolled into the viewport",
      ).toBeInViewport({ ratio: 0.1 });

      // After the 2.5s highlight timer expires the attribute should clear
      // back to unset (renderer omits it when highlightedHistoryRow is null).
      await expect(
        targetRow,
        "the highlight should fade after the cleanup timeout",
      ).not.toHaveAttribute("data-highlighted", "true", { timeout: 6_000 });
    } finally {
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });

  test("clicking the named phrase opens the batch group's per-phrase details and highlights the matching inner row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 360 });

    // Three phrases batch-removed together so the history panel renders a
    // `handwavy-history-batch-group` whose inner rows live inside a
    // collapsed-by-default <details>. The candidate we type matches the
    // SECOND phrase to make sure the jump opens the <details> and scrolls
    // to a specific inner row (not just the batch header).
    const phrases = uniquePhrases(3, "task412 batch retired");
    const targetPhrase = phrases[1];
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);

      for (const p of phrases) {
        await addPhrase(api, p, { reviewer: REVIEWER, category: "hedging" });
      }
      const batchResult = await batchRemove(api, phrases, {
        reviewer: REVIEWER,
      });
      const batchRemovedAt = batchResult.historyEntry?.removedAt;
      expect(
        typeof batchRemovedAt,
        "batch removal should produce a removedAt timestamp",
      ).toBe("string");

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const historyToggle = page.getByTestId("handwavy-history-toggle");
      await expect(historyToggle).toBeVisible({ timeout: 15_000 });
      await expect(historyToggle).toHaveAttribute("aria-expanded", "false");

      await page.getByTestId("handwavy-input").fill(targetPhrase);

      const hint = page.getByTestId("handwavy-history-overlap-hint");
      await expect(hint).toBeVisible({ timeout: 15_000 });

      const jumpButton = page.getByTestId("handwavy-history-overlap-hint-jump");
      await expect(jumpButton).toBeVisible();
      await expect(jumpButton).toContainText(targetPhrase);

      // Scope the batch group locator by its `data-batch-removed-at` so we
      // don't false-hit a sibling test's batch group on the same panel.
      const batchGroup = page.locator(
        `[data-testid="handwavy-history-batch-group"][data-batch-removed-at=${JSON.stringify(batchRemovedAt)}]`,
      );
      const innerDetails = batchGroup.getByTestId(
        "handwavy-history-batch-rows-details",
      );
      const targetRow = batchGroup.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase=${JSON.stringify(targetPhrase)}][data-handwavy-history-removed-at=${JSON.stringify(batchRemovedAt!)}]`,
      );

      // Before clicking: the panel is collapsed entirely; even if it were
      // open the batch's per-phrase <details> defaults to closed, so the
      // inner row wouldn't be in the DOM either.
      await expect(targetRow).toHaveCount(0);

      await jumpButton.click();

      await expect(historyToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: 2_000,
      });
      // The batch <details> should now be force-opened by the helper.
      await expect(
        innerDetails,
        "the per-phrase <details> for the matching batch should be opened",
      ).toHaveJSProperty("open", true, { timeout: 2_000 });
      await expect(targetRow).toHaveCount(1, { timeout: 2_000 });
      await expect(
        targetRow,
        "clicking the jump button should mark the matching inner row as highlighted",
      ).toHaveAttribute("data-highlighted", "true", { timeout: 2_000 });
      await expect(targetRow).toBeInViewport({ ratio: 0.1 });

      // The other two inner rows from the same batch must NOT receive the
      // highlight — the helper keys identity on phrase + removedAt and
      // batch siblings share the same removedAt, so this assertion is
      // what proves the per-phrase keying is wired through correctly.
      const otherPhrase = phrases[0];
      const otherRow = batchGroup.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase=${JSON.stringify(otherPhrase)}]`,
      );
      await expect(otherRow).toHaveCount(1);
      await expect(
        otherRow,
        "sibling batch rows should not be highlighted by the jump",
      ).not.toHaveAttribute("data-highlighted", "true");

      await expect(
        targetRow,
        "the highlight should fade after the cleanup timeout",
      ).not.toHaveAttribute("data-highlighted", "true", { timeout: 6_000 });
    } finally {
      await cleanup(api, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });

  test("force-renders and highlights the matching row even when it has been pushed past the 25-row history cap by newer removals", async ({
    page,
  }) => {
    // Wider viewport here: the older-than-cap row gets appended to the
    // bottom of the rendered history list, and the panel itself caps at
    // `max-h-64` with internal overflow. `scrollIntoView({block:'center'})`
    // walks all scrollable ancestors, but a generous viewport keeps the
    // assertion robust against subtle rendering differences in headless
    // chromium between runs.
    await page.setViewportSize({ width: 1280, height: 720 });

    // The history list caps at HISTORY_ROW_CAP = 25 rendered rows. We
    // seed a single-row removal as the OLDEST entry (the candidate the
    // jump button targets), then a NEWER batch removal of 30 phrases so
    // the cap is exceeded by a wide margin and the older single is
    // guaranteed to fall outside the visible window. This is the exact
    // scenario the cap-bypass logic in `visibleHistoryGroups` exists to
    // handle — without it, clicking the jump button would expand the
    // panel but find no row to scroll to / highlight.
    const targetPhrase = uniquePhrase("task412 capped retired");
    const fillerPhrases = uniquePhrases(30, "task412 capped filler");
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);

      // 1) Seed + remove the target FIRST so its removedAt is the oldest.
      await addPhrase(api, targetPhrase, {
        reviewer: REVIEWER,
        category: "hedging",
      });
      const targetRemovedAt = await removeSingle(api, targetPhrase, {
        reviewer: REVIEWER,
      });

      // 2) Seed + batch-remove 30 newer phrases. Their removedAt is newer
      // than the target's, so they sort ahead of it and exhaust the cap.
      for (const p of fillerPhrases) {
        await addPhrase(api, p, { reviewer: REVIEWER, category: "hedging" });
      }
      await batchRemove(api, fillerPhrases, { reviewer: REVIEWER });

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const historyToggle = page.getByTestId("handwavy-history-toggle");
      await expect(historyToggle).toBeVisible({ timeout: 15_000 });

      // Sanity: with the panel collapsed, the row is unrendered.
      const targetRow = page.locator(
        `[data-testid="handwavy-history-row"][data-handwavy-history-phrase=${JSON.stringify(targetPhrase)}][data-handwavy-history-removed-at=${JSON.stringify(targetRemovedAt)}]`,
      );
      await expect(targetRow).toHaveCount(0);

      // Manually expand the panel WITHOUT clicking the jump button to
      // confirm the row is NOT visible — proving the cap actually pushed
      // it out. This is the negative-control half of the assertion: if
      // the cap were misconfigured (or if the cap-bypass leaked into the
      // baseline render), this expect would fail and we'd know the test
      // was no longer covering the older-than-cap scenario.
      await historyToggle.click();
      await expect(historyToggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();
      await expect(
        targetRow,
        "older-than-cap row should NOT be rendered without an active jump",
      ).toHaveCount(0);

      // Re-collapse the panel so the jump's own expansion is observable.
      await historyToggle.click();
      await expect(historyToggle).toHaveAttribute("aria-expanded", "false");

      // Now type the colliding phrase to surface the hint and click jump.
      await page.getByTestId("handwavy-input").fill(targetPhrase);
      const hint = page.getByTestId("handwavy-history-overlap-hint");
      await expect(hint).toBeVisible({ timeout: 15_000 });

      const jumpButton = page.getByTestId("handwavy-history-overlap-hint-jump");
      await expect(jumpButton).toContainText(targetPhrase);
      await jumpButton.click();

      // Panel expands, AND the older-than-cap row is now force-rendered
      // by the cap-bypass branch of `visibleHistoryGroups`.
      await expect(historyToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: 2_000,
      });
      await expect(targetRow).toHaveCount(1, { timeout: 2_000 });
      await expect(
        targetRow,
        "the older-than-cap target row should be highlighted",
      ).toHaveAttribute("data-highlighted", "true", { timeout: 2_000 });
      await expect(targetRow).toBeInViewport({ ratio: 0.1 });

      // After the highlight timer expires the amber styling fades, but
      // the row MUST stay rendered so the reviewer can still read the
      // rationale and click the row's Reinstate button — that's the
      // whole point of the jump.
      await expect(
        targetRow,
        "the highlight should fade after the cleanup timeout",
      ).not.toHaveAttribute("data-highlighted", "true", { timeout: 6_000 });
      await expect(
        targetRow,
        "row must remain rendered after the highlight fades so the audit entry is still inspectable / reinstate-able",
      ).toHaveCount(1);

      // Collapsing the panel clears the cap-bypass pin, so re-expanding
      // returns to the normal HISTORY_ROW_CAP prefix and the older row
      // unmounts again. This proves the bypass is scoped to a live jump
      // session rather than permanently widening the panel.
      await historyToggle.click();
      await expect(historyToggle).toHaveAttribute("aria-expanded", "false");
      await historyToggle.click();
      await expect(historyToggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        targetRow,
        "row should unmount once the panel is collapsed (pin cleared, cap reapplied)",
      ).toHaveCount(0);
    } finally {
      await cleanup(api, [targetPhrase, ...fillerPhrases], {
        reviewer: `${REVIEWER}-cleanup`,
      });
      await api.dispose();
    }
  });
});
