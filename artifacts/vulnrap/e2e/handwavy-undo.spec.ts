import { test, expect } from "@playwright/test";
import {
  addPhrase,
  addPhraseViaUi,
  cleanup,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #158 — End-to-end coverage for the FLAT hand-wavy phrase panel's
// add + undo path. The "Undo" affordance appears on every phrase added
// within a 5-minute window (UNDO_WINDOW_MS in feedback-analytics.tsx —
// originally just the single most-recent add, broadened by Task #141 to
// every still-in-window add). It is critical for keeping the audit trail
// honest: an add followed by an undo should pair into a single "added then
// undone" history row (rendered with the "Undone" badge), NOT a manual
// removal. This spec drives the real UI through the full preview ->
// confirm add -> undo flow and asserts both halves of that contract.

const REVIEWER = "e2e-task158";

test.describe("FLAT hand-wavy phrase panel — add + undo flow", () => {
  test("adding a phrase shows the Undo button on its row, and clicking it logs an 'Undone' history entry instead of a manual removal", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task158 undo", "phrase");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // The reviewer field is required for the audit trail to attribute
      // the add to a non-anonymous user; the panel works without it but
      // setting it keeps this spec consistent with the other handwavy
      // specs and the manual review flow.
      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill(REVIEWER);

      // Add flow is two-step: type the phrase, click "Preview impact",
      // wait for the preview banner, then click "Confirm add".
      await addPhraseViaUi(page, phrase);

      // The "Undo" button should be visible on the new row because it
      // was just added and is well within the 5-minute UNDO_WINDOW_MS.
      // Curated defaults and older reviewer-added phrases that have
      // aged out must NOT carry an undo button.
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible();
      await expect(undoBtn).toBeEnabled();

      // Task #140 — the button surfaces a live countdown in the form
      // "Undo (Xm YYs)" so reviewers know how much of the 5-minute
      // window remains. A fresh add starts well above 60s so the
      // minutes/seconds form must be present (the bare "Undo" of the
      // pre-#140 UI would no longer match this regex).
      await expect(undoBtn).toHaveText(/^Undo \(\d+m \d{2}s\)$/);
      // While the window is still wide open the button must NOT be
      // flagged as urgent (urgent kicks in inside the last ~30s).
      await expect(undoBtn).toHaveAttribute("data-undo-urgent", "false");
      // The remaining-ms data attribute is exposed for tests/automation
      // and must be a positive integer well above the urgent threshold
      // immediately after a fresh add.
      const remainingAttr = await undoBtn.getAttribute(
        "data-undo-remaining-ms",
      );
      expect(remainingAttr).not.toBeNull();
      const remainingMs = Number(remainingAttr);
      expect(Number.isFinite(remainingMs)).toBe(true);
      expect(remainingMs).toBeGreaterThan(60_000);

      await undoBtn.click();

      // After the undo round-trip the active list should no longer
      // contain our phrase…
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
        "phrase should disappear from the active list after undo",
      ).toHaveCount(0, { timeout: 15_000 });

      // …and the history panel should render an entry for the phrase
      // marked as "Undone" (data-history-kind="undone" + the
      // handwavy-history-undone badge), NOT as a manual removal. We
      // expand the history toggle if needed, then locate the row by the
      // unique phrase text.
      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: phrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });
      await expect(historyRow).toHaveAttribute("data-history-kind", "undone");
      await expect(historyRow.getByTestId("handwavy-history-undone")).toBeVisible();
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #141 — the Undo affordance used to live only on the single
  // most-recently-added marker, which forced reviewers to drop older
  // mistakes into the regular Trash flow (recording them as manual
  // removals in the audit trail). After Task #141 every still-in-window
  // add carries its own Undo button. This test seeds two adds back-to-
  // back, confirms BOTH rows expose Undo, then undoes the OLDER one and
  // verifies it lands in history as "undone" rather than as a manual
  // removal — the exact contract the task is meant to deliver.
  test("two consecutive adds both expose Undo, and undoing the older one is still tagged as 'undone' in the audit trail", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const olderPhrase = uniquePhrase("task158 undo", "older");
    const newerPhrase = uniquePhrase("task158 undo", "newer");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task141");

      await addPhraseViaUi(page, olderPhrase);
      await addPhraseViaUi(page, newerPhrase);

      const olderRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: olderPhrase });
      const newerRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: newerPhrase });

      // BOTH adds should now carry their own Undo affordance. This is
      // the core Task #141 behaviour — under the old single-best memo
      // the older row's Undo would have disappeared the moment the
      // newer add landed and the reviewer would have had to use Trash.
      await expect(olderRow.getByTestId("handwavy-undo")).toBeVisible();
      await expect(olderRow.getByTestId("handwavy-undo")).toBeEnabled();
      await expect(newerRow.getByTestId("handwavy-undo")).toBeVisible();
      await expect(newerRow.getByTestId("handwavy-undo")).toBeEnabled();

      // Undo the OLDER add specifically — under the old behaviour the
      // older row would not have had this button at all.
      await olderRow.getByTestId("handwavy-undo").click();

      // The older phrase disappears from the active list; the newer
      // one stays put (and keeps its own Undo button — its window
      // hasn't elapsed either).
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: olderPhrase }),
        "older phrase should disappear from the active list after undo",
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: newerPhrase }),
        "newer phrase should still be present after undoing the older one",
      ).toHaveCount(1);
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: newerPhrase })
          .getByTestId("handwavy-undo"),
      ).toBeVisible();

      // The history row for the older phrase MUST be tagged "undone"
      // (data-history-kind="undone" + the handwavy-history-undone
      // badge), proving the older add went through the audit-friendly
      // undo path rather than being recorded as a manual removal.
      const toggle = page.getByTestId("handwavy-history-toggle");
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

      const historyRow = page
        .locator(`[data-testid="handwavy-history-row"]`)
        .filter({ hasText: olderPhrase });
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });
      await expect(historyRow).toHaveAttribute("data-history-kind", "undone");
      await expect(historyRow.getByTestId("handwavy-history-undone")).toBeVisible();
    } finally {
      await cleanup(apiCtx, [olderPhrase, newerPhrase], {
        reviewer: "e2e-task141-cleanup",
      });
      await apiCtx.dispose();
    }
  });

  // Task #223 — Task #140's existing spec only exercises the "wide-open
  // window" branch of the per-row Undo button (urgent=false, amber
  // styling). The urgent branch — text-red-400 + animate-pulse +
  // data-undo-urgent="true" + the live "Undo (Xs)" countdown — only
  // kicks in inside the last 30s of the 5-minute window, which is far
  // too long to wait in real wall-clock time inside a Playwright spec.
  // We seed the marker via the API with a backdated `addedAt` so only
  // ~25s remain in the window (the api-server only honors that field
  // when HANDWAVY_ALLOW_TEST_BACKDATE=1, set by playwright.config.ts),
  // then drive the page through the full add-detected-by-page flow and
  // assert the urgent visual state. Finally we wait for the button to
  // vanish at the true 0-mark and assert no "0s" text ever flashes on
  // the way out (formatUndoRemaining uses Math.ceil + the
  // undoCandidates Map drops entries the moment remainingMs <= 0, so
  // rendering "0s" would be a regression of either guard).
  test("the per-row Undo button switches to the urgent (red + pulse) state inside the last ~30s of the window and vanishes cleanly without any '0s' flash", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task223 urgent", "phrase");

    try {
      // 5-minute UNDO_WINDOW_MS - 25s leaves the row inside the urgent
      // band (UNDO_URGENT_MS = 30s) but not so close to 0 that the
      // window elapses before the page even renders. Using 25s gives
      // ~5s of headroom for page navigation + the initial render.
      const UNDO_WINDOW_MS = 5 * 60 * 1000;
      const TARGET_REMAINING_MS = 25_000;
      const addedAtIso = new Date(
        Date.now() - (UNDO_WINDOW_MS - TARGET_REMAINING_MS),
      ).toISOString();

      await addPhrase(apiCtx, phrase, {
        reviewer: "e2e-task223",
        addedAt: addedAtIso,
      });

      // Visit the panel AFTER the seed POST so the initial fetch picks
      // up the backdated marker. There's no auto-poll on the handwavy
      // phrase query so we don't need to race a refresh.
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible({ timeout: 15_000 });

      // The urgent branch must be active because remainingMs starts
      // well below UNDO_URGENT_MS (30s). All three signals (the data
      // attribute the existing spec asserts, plus the two utility
      // classes the existing spec does NOT cover) must flip together.
      await expect(undoBtn).toHaveAttribute("data-undo-urgent", "true");
      await expect(undoBtn).toHaveClass(/text-red-400/);
      await expect(undoBtn).toHaveClass(/animate-pulse/);

      // The remaining-ms data attribute must reflect the urgent band
      // (≤ 30s) and must be strictly positive — anything else means
      // we either missed the window or rendered after the entry was
      // dropped from undoCandidates.
      const remainingAttr = await undoBtn.getAttribute(
        "data-undo-remaining-ms",
      );
      expect(remainingAttr).not.toBeNull();
      const remainingMs = Number(remainingAttr);
      expect(Number.isFinite(remainingMs)).toBe(true);
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(30_000);

      // Countdown text in the urgent band is the "Xs" form (no minutes),
      // not the "Xm YYs" form covered by the wide-open spec above.
      await expect(undoBtn).toHaveText(/^Undo \(\d+s\)$/);

      // Wait for the button to vanish at the true 0-mark and assert
      // that "0s" never appears in its text along the way. Math.ceil
      // in formatUndoRemaining + the `if (remainingMs <= 0) continue;`
      // guard in undoCandidates together guarantee the button hides
      // BEFORE its text would render "(0s)"; if either regresses this
      // poll throws inside the page (and surfaces as a Playwright
      // failure) instead of silently passing on a UI flicker.
      await page.waitForFunction(
        ({ phraseToFind }) => {
          const rows = Array.from(
            document.querySelectorAll('[data-testid="handwavy-row"]'),
          );
          let btn: Element | null = null;
          for (const row of rows) {
            if (row.textContent?.includes(phraseToFind)) {
              btn = row.querySelector('[data-testid="handwavy-undo"]');
              break;
            }
          }
          if (!btn) return true; // gone — success
          const text = btn.textContent ?? "";
          if (/\(0s\)/.test(text)) {
            throw new Error(
              `Saw '0s' flash on Undo button before it vanished: ${text}`,
            );
          }
          return false;
        },
        { phraseToFind: phrase },
        // 30s urgent band + a generous safety margin. The button must
        // disappear well within this window even on a slow runner —
        // the seed put the marker ~25s from elapsing.
        { timeout: 35_000, polling: 100 },
      );

      // Sanity check: the row itself stays put (the marker was never
      // removed — the undo affordance just retired). Without this we'd
      // also pass if the whole row vanished for an unrelated reason.
      await expect(newRow).toHaveCount(1);
      await expect(newRow.getByTestId("handwavy-undo")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task223-cleanup" });
      await apiCtx.dispose();
    }
  });
});
