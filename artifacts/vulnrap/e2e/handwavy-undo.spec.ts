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

  // Task #222 — navigate-away guard. After adding a phrase the reviewer
  // has a finite (5-minute) chance to roll the mistake back through the
  // audit-friendly Undo path; if they accidentally click an in-app Link
  // before that window elapses, the only way left to drop the phrase is
  // the regular Trash button (which records a manual-removal entry
  // instead of "added then undone"). The guard intercepts that
  // navigation and pops a confirm dialog naming the phrase + remaining
  // time. This test seeds an add, clicks the layout's logo Link
  // (to "/"), confirms the dialog appears with the correct copy,
  // dismisses it, asserts we're still on the panel, then re-clicks the
  // Link and confirms "Leave anyway" actually navigates.
  test("navigating away while an undo window is still ticking pops a confirm dialog with the phrase + remaining time, and dismissing it keeps the reviewer on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task222 navguard", "phrase");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task222");

      await addPhraseViaUi(page, phrase);

      // Sanity: the row must carry an Undo button so we know the guard
      // has something to protect — otherwise this test would silently
      // pass against the pre-Task #222 build (which had no guard but
      // also no Undo to lose).
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // Click an in-app Link in the layout. The header logo is a
      // <Link to="/"> rendered in artifacts/vulnrap/src/components/
      // layout.tsx (it appears multiple times for desktop/mobile
      // breakpoints — .first() picks whichever is visible). Without
      // the guard this would navigate immediately to "/" and the
      // panel — and its undo opportunity — would unmount.
      const logoLink = page.locator('a[href="/"]').first();
      await expect(logoLink).toBeVisible();
      await logoLink.click();

      // The guard's confirm dialog must appear, and it must name the
      // exact phrase the reviewer is about to lose the undo on.
      const dialog = page.getByTestId("handwavy-undo-leave-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByTestId("handwavy-undo-leave-confirm-phrase"),
      ).toContainText(phrase);
      // The remaining-time copy must read in the same "Xm YYs" form as
      // the row-level Undo button (formatUndoRemaining) — the dialog
      // is meant to reinforce that countdown, not invent a new one.
      const remainingText = await dialog
        .getByTestId("handwavy-undo-leave-confirm-remaining")
        .textContent();
      expect(remainingText ?? "").toMatch(/^\d+m \d{2}s$/);

      // "Stay on this page" must dismiss the dialog WITHOUT navigating
      // — we should still be on /feedback-analytics with the phrase
      // row + Undo affordance intact.
      await dialog.getByTestId("handwavy-undo-leave-confirm-cancel").click();
      await expect(dialog).not.toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/feedback-analytics");
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // Clicking the Link a second time must re-arm the dialog — the
      // guard isn't a one-shot, it stays active for as long as a
      // candidate is still inside its window.
      await logoLink.click();
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // "Leave anyway" must actually navigate. We assert via the URL
      // pathname rather than waiting for a specific selector on "/"
      // because the home page is lazy-loaded and could take a moment
      // to render under load.
      await dialog.getByTestId("handwavy-undo-leave-confirm-confirm").click();
      await expect(dialog).not.toBeVisible();
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
        .toBe("/");
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task222-cleanup" });
      await apiCtx.dispose();
    }
  });

  // Task #310 — extends Task #222's link-click coverage to imperative
  // in-app navigation triggered from a button onClick. The Task #222
  // capture-phase document click listener only sees <a>-rendered
  // react-router Links; a button whose onClick calls
  // `navigate("/somewhere")` directly would slip past it and silently
  // unmount the FLAT panel mid-Undo, turning any later removal into a
  // manual-removal audit entry instead of "added then undone". The
  // useGuardedNavigate wrapper added in this task re-routes those
  // imperative calls through the SAME confirm dialog so the reviewer
  // sees the phrase + remaining time and can choose to stay. This
  // spec drives the "Done" button next to the panel header (the only
  // button on the page wired to `guardedNavigate`) — a real <Link>
  // would already be covered by the Task #222 logo-click test above.
  test("clicking an in-page button that programmatically navigates while an undo window is active pops the same confirm dialog and 'Stay' keeps the reviewer on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task310 navguard", "imperative");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task310");

      await addPhraseViaUi(page, phrase);

      // Sanity: the row must carry an Undo button so we know the guard
      // has something to protect — same shape as the Task #222 spec.
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // The "Done" button next to the panel header is the imperative-
      // navigation surface this task is meant to cover. Its onClick
      // calls `guardedNavigate("/")` — without the wrapper that would
      // silently unmount the panel; with it, the same Task #222
      // confirm dialog must appear naming the phrase + remaining time.
      const backHome = page.getByTestId("handwavy-back-home");
      await expect(backHome).toBeVisible();
      await backHome.click();

      const dialog = page.getByTestId("handwavy-undo-leave-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByTestId("handwavy-undo-leave-confirm-phrase"),
      ).toContainText(phrase);
      // Remaining-time copy uses the same "Xm YYs" form as the row-
      // level Undo countdown (formatUndoRemaining); the dialog is
      // meant to reinforce that countdown, not invent a new format.
      const remainingText = await dialog
        .getByTestId("handwavy-undo-leave-confirm-remaining")
        .textContent();
      expect(remainingText ?? "").toMatch(/^\d+m \d{2}s$/);

      // "Stay on this page" must dismiss the dialog WITHOUT navigating.
      // Under the pre-#310 build the imperative navigate would already
      // have fired before the dialog opened, so the URL pathname check
      // below would fail (we'd be on "/" with no /feedback-analytics
      // history entry to recover). With the wrapper the dialog is the
      // only side-effect of the click and the reviewer stays put.
      await dialog.getByTestId("handwavy-undo-leave-confirm-cancel").click();
      await expect(dialog).not.toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/feedback-analytics");
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // Re-clicking the Done button must re-arm the dialog — the guard
      // isn't a one-shot, it stays active for as long as a candidate
      // is inside its window.
      await backHome.click();
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // "Leave anyway" must replay the original `navigate("/")` call.
      // We assert via the URL pathname rather than a selector on "/"
      // because the home page is lazy-loaded.
      await dialog.getByTestId("handwavy-undo-leave-confirm-confirm").click();
      await expect(dialog).not.toBeVisible();
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
        .toBe("/");
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task310-cleanup" });
      await apiCtx.dispose();
    }
  });

  // Task #222 — suppression contract. Clicking the row-level Undo
  // button must NOT pop the navigate-away dialog: the reviewer is the
  // one initiating the rollback, and the panel's instant refresh +
  // list mutation that follows would otherwise spuriously trip the
  // guard against them. The undo path is the audit-friendly route
  // ("added then undone" history entry) so a stray prompt here would
  // actively discourage the behaviour we want.
  test("clicking the row-level Undo button does not pop the navigate-away dialog (the reviewer is the one undoing)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task222 navguard", "self-undo");

    try {
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task222-self");

      await addPhraseViaUi(page, phrase);

      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible();

      await undoBtn.click();

      // The phrase must disappear from the active list (proving the
      // undo round-trip happened) AND the leave-confirm dialog must
      // never have surfaced during it.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByTestId("handwavy-undo-leave-confirm"),
      ).not.toBeVisible();

      // Belt-and-braces: still on /feedback-analytics, no stray
      // navigation triggered.
      expect(new URL(page.url()).pathname).toBe("/feedback-analytics");
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task222-self-cleanup" });
      await apiCtx.dispose();
    }
  });

  // Task #309 — popstate (browser back/forward) variant of the navigate-
  // away guard. Task #222's existing tests above only exercise the in-app
  // <Link> branch; the popstate branch has its own bookkeeping (a sentinel
  // history entry pushed when an undo candidate first appears, plus a
  // history.go(-2) replay in `proceedPendingNavigation` so a single
  // "Leave anyway" click pops both the re-pushed sentinel AND the entry
  // the reviewer's original Back press was aimed at). This test seeds an
  // add, hits the browser Back button, asserts the same leave-confirm
  // dialog surfaces with the phrase + remaining-time copy, then verifies
  // both Stay (URL unchanged + phrase intact) and Leave anyway (lands on
  // the page that was below /feedback-analytics in history) work end-to-
  // end. Locking this in catches regressions if the sentinel/-2 logic is
  // ever touched — e.g. dropping the re-push would break the re-armed
  // dialog after the first Stay; switching `history.go(-2)` to
  // `history.back()` would leave the reviewer stranded on the sentinel
  // entry instead of actually navigating.
  test("hitting the browser Back button while an undo window is still ticking pops the leave-confirm dialog with phrase + remaining time, and dismissing it keeps the reviewer on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task309 popstate", "phrase");

    try {
      // We need a real previous history entry for Back to land on,
      // otherwise the `history.go(-2)` inside proceedPendingNavigation
      // has nowhere meaningful to go and the post-Leave URL assertion
      // would be meaningless. Visit the home page first, then navigate
      // to the panel via a second goto so both entries are in the stack.
      await page.goto("/", { waitUntil: "networkidle" });
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task309");

      await addPhraseViaUi(page, phrase);

      // Sanity: the row carries an Undo button so the guard has
      // something to protect — same belt-and-braces check the in-app
      // Link variant of this test does for the same reason.
      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // Hit the browser Back button. Without the popstate handler this
      // would pop the sentinel and then immediately navigate back to
      // "/" (the entry below /feedback-analytics), unmounting the
      // panel and the row-level Undo affordance with it. The handler
      // intercepts: it re-pushes the sentinel and surfaces the prompt.
      // We use `window.history.back()` via evaluate rather than
      // `page.goBack()` because Playwright's goBack waits for a load
      // lifecycle event that never fires for same-document popstate
      // navigation (the sentinel pop doesn't change the URL).
      await page.evaluate(() => window.history.back());

      // Same dialog as the in-app Link branch — the popstate handler
      // sets the same `pendingNavigation` state shape, so the same
      // testid + copy contract applies.
      const dialog = page.getByTestId("handwavy-undo-leave-confirm");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(
        dialog.getByTestId("handwavy-undo-leave-confirm-phrase"),
      ).toContainText(phrase);
      const remainingText = await dialog
        .getByTestId("handwavy-undo-leave-confirm-remaining")
        .textContent();
      expect(remainingText ?? "").toMatch(/^\d+m \d{2}s$/);

      // "Stay on this page" must dismiss the dialog WITHOUT navigating.
      // The handler re-pushed the sentinel before opening the dialog,
      // so the URL must still be /feedback-analytics and the phrase
      // row + Undo affordance must still be intact.
      await dialog.getByTestId("handwavy-undo-leave-confirm-cancel").click();
      await expect(dialog).not.toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/feedback-analytics");
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);
      await expect(newRow.getByTestId("handwavy-undo")).toBeVisible();

      // Hitting Back a second time must re-arm the dialog — the guard
      // is not a one-shot, the re-pushed sentinel above keeps the
      // popstate listener primed for the next Back press.
      await page.evaluate(() => window.history.back());
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // "Leave anyway" must actually navigate. The popstate branch of
      // proceedPendingNavigation calls `history.go(-2)`, popping both
      // the most-recently-re-pushed sentinel AND the entry the
      // reviewer's original Back press was aimed at, so we should land
      // on "/" — the page we navigated from before opening the panel.
      // We assert via the URL pathname (rather than waiting for a
      // selector on "/") because the home page is lazy-loaded and
      // could take a moment to render under load.
      await dialog.getByTestId("handwavy-undo-leave-confirm-confirm").click();
      await expect(dialog).not.toBeVisible();
      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
        .toBe("/");
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task309-cleanup" });
      await apiCtx.dispose();
    }
  });

  // Task #309 — popstate variant of the suppression contract that
  // already exists for in-app Link clicks above. Once the reviewer
  // clicks the row-level Undo button the candidate retires from
  // `undoCandidates`, `hasActiveUndo` flips to false, and the popstate
  // listener self-uninstalls (the useEffect cleanup runs). Hitting Back
  // after that must therefore NOT pop the leave-confirm dialog: the
  // reviewer already chose the audit-friendly rollback path, and
  // surfacing a "Leave before undoing?" prompt at that point would
  // actively undermine the very behaviour the guard is meant to
  // encourage. The sentinel that was pushed when the candidate first
  // appeared is left in history (the effect cleanup deliberately does
  // not scrub it), so Back simply pops the sentinel and the URL stays
  // on /feedback-analytics — no dialog, no nav.
  test("hitting the browser Back button right after the reviewer's own Undo click does not pop the leave-confirm dialog", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task309 popstate", "self-undo");

    try {
      // Same setup as the Back+dialog spec above — a real previous
      // entry so Back has somewhere to land and the negative assertion
      // doesn't pass for the wrong reason (a no-op Back).
      await page.goto("/", { waitUntil: "networkidle" });
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const reviewer = page.getByTestId("handwavy-reviewer");
      await expect(reviewer).toBeVisible({ timeout: 15_000 });
      await reviewer.fill("e2e-task309-self");

      await addPhraseViaUi(page, phrase);

      const newRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      const undoBtn = newRow.getByTestId("handwavy-undo");
      await expect(undoBtn).toBeVisible();

      await undoBtn.click();

      // Wait for the undo to take effect — the phrase disappears from
      // the active list, which means the refresh has landed and the
      // candidate is gone from `undoCandidates`. At that point
      // hasActiveUndo is false and the popstate listener has been torn
      // down by the effect cleanup.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });

      // Now hit Back. The sentinel pushed when the candidate first
      // appeared is still on the stack, so this pops it and lands us
      // back on /feedback-analytics with the URL unchanged. With the
      // listener removed the dialog must NEVER appear.
      await page.evaluate(() => window.history.back());
      // Give the popstate event a beat to flush through the React
      // render cycle so a regression that re-armed the prompt would
      // have time to surface before we assert non-visibility.
      await page.waitForTimeout(500);
      await expect(
        page.getByTestId("handwavy-undo-leave-confirm"),
      ).not.toBeVisible();

      // Belt-and-braces: still on /feedback-analytics, no stray
      // navigation triggered by the back press.
      expect(new URL(page.url()).pathname).toBe("/feedback-analytics");
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task309-self-cleanup" });
      await apiCtx.dispose();
    }
  });
});
