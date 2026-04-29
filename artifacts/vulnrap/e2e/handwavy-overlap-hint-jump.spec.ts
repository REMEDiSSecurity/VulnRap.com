import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #220 — End-to-end coverage for the "jump to colliding row" affordance
// inside the inline overlap hint that Task #129 added under the add-phrase
// form. The hint already names the colliding curated entry; Task #220 makes
// that name a clickable button that scrolls the matching row in the active
// list into view and gives it a brief amber highlight pulse.
//
// The spec seeds two curated phrases via the API:
//   * a `decoy` that we add FIRST so the active-list ordering pushes it off
//     the initial viewport. The hand-wavy phrase panel sits well below the
//     fold on a 720px viewport, and even within the panel the active list
//     is rendered in insertion order — adding 30+ ad-hoc dummies just to
//     guarantee scrolling would slow the spec down without making the
//     assertion stronger, so we instead resize the viewport to a short
//     window and rely on the existing curated defaults to push the target
//     row out of view.
//   * a `target` curated phrase whose row the spec then expects to scroll
//     into view + highlight after the reviewer clicks the hint.
//
// Then the spec drives the UI: types the same phrase as the candidate (an
// exact-duplicate overlap), clicks the jump button rendered inside the
// `handwavy-overlap-hint-top` span, and asserts the seeded target row got
// `data-highlighted="true"` AND is now within the visible viewport. After
// the highlight timeout expires (~2.5s) the attribute should clear back to
// its default unset state, proving the cleanup path runs too.

test.describe("FLAT hand-wavy phrase panel — overlap-hint jump-to-row (Task #220)", () => {
  test("clicking the named phrase inside the redundancy hint scrolls and highlights the matching active-list row", async ({
    page,
  }) => {
    // Use a short viewport so the active list reliably extends below the
    // fold even on a fresh dev DB (the curated defaults alone fill more
    // than ~360px of vertical space inside the panel). This keeps the
    // "scrolls into view" assertion meaningful without depending on a
    // specific row count being seeded ahead of time.
    await page.setViewportSize({ width: 1280, height: 360 });

    const apiCtx = await newApiContext();
    const target = uniquePhrase("task220 overlap target");

    try {
      // Seed the target phrase. We deliberately use a phrase that contains
      // a uuid-ish suffix so the overlap hint will match exactly one
      // curated entry (avoids ambiguity from any leftover dev-DB rows).
      await addPhrase(apiCtx, target, { reviewer: "e2e-task220-seed" });

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const targetRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: target });
      await expect(
        targetRow,
        "seeded target phrase should appear in the active list",
      ).toHaveCount(1, { timeout: 15_000 });

      // Type the SAME phrase as the add-form candidate so
      // detectHandwavyCuratedOverlaps reports an exact-duplicate overlap and
      // the inline hint surfaces.
      const input = page.getByTestId("handwavy-input");
      await input.scrollIntoViewIfNeeded();
      await input.fill(target);

      const hint = page.getByTestId("handwavy-overlap-hint");
      await expect(
        hint,
        "the inline overlap hint should surface for an exact-duplicate candidate",
      ).toBeVisible({ timeout: 5_000 });

      const jumpButton = page.getByTestId("handwavy-overlap-hint-jump");
      await expect(jumpButton).toBeVisible();
      await expect(
        jumpButton,
        "the jump button should name the colliding phrase",
      ).toContainText(target);

      // Before clicking, the target row should NOT carry the highlight
      // attribute. The renderer omits the attribute entirely when the row
      // isn't highlighted, so we check it's not the "true" sentinel value.
      await expect(targetRow).not.toHaveAttribute("data-highlighted", "true");

      await jumpButton.click();

      // After the click: the matching row picks up data-highlighted="true"
      // synchronously (state flip in the click handler), and the helper
      // schedules a smooth scroll on the next animation frame. We wait for
      // both signals so a slow scroll animation doesn't flake the test.
      await expect(
        targetRow,
        "clicking the jump button should mark the target row as highlighted",
      ).toHaveAttribute("data-highlighted", "true", { timeout: 2_000 });

      // The row should now be within the viewport. Playwright's
      // `toBeInViewport` checks that >0% of the element overlaps the
      // visible area; that's exactly what scrollIntoView({block:'center'})
      // guarantees.
      await expect(
        targetRow,
        "the target row should be scrolled into the viewport",
      ).toBeInViewport({ ratio: 0.1 });

      // After the 2.5s highlight timer expires the attribute should clear
      // back to unset (renderer omits it when highlightedPhrase is null).
      await expect(
        targetRow,
        "the highlight should fade after the cleanup timeout",
      ).not.toHaveAttribute("data-highlighted", "true", { timeout: 6_000 });
    } finally {
      await cleanup(apiCtx, target, { reviewer: "e2e-task220-cleanup" });
      await apiCtx.dispose();
    }
  });
});
