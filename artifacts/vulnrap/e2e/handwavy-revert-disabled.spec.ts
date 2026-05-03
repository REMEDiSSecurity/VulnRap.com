import { test, expect } from "@playwright/test";
import { cleanup, newApiContext, uniquePhrase } from "./helpers/handwavy";

// Task #148 — End-to-end coverage for the per-edit Revert button's disabled
// state on the per-phrase edit-history panel. Task #132 introduced the
// Revert button itself; Task #133 surfaced the full chronological history.
// Task #148 closes the loop by disabling the button when reverting it would
// be a no-op (the marker's live state already matches the entry's "from"
// values — typically because a later edit put the field back). Reviewers
// then see "At this state" instead of clicking and discovering the no-op
// only after a round-trip toast.
//
// The spec seeds a marker through the API and runs three edits so the
// edit-history panel has multiple rows in known states, then asserts the
// per-row disabled / enabled state via the data-noop attribute that the
// renderer stamps on every Revert button.
//
// Seeding is done with a raw POST + two PATCHes against the route, NOT via
// the shared `addPhrase` / `removeSingle` helpers: this spec specifically
// needs the PATCH path (no other handwavy spec exercises edit history),
// and folding a category-edit helper into helpers/handwavy.ts for a
// single caller would just be dead code in every other spec.

const REVIEWER_PREFIX = "e2e-task148";

test.describe("FLAT hand-wavy phrase panel — per-edit Revert disabled state (Task #148)", () => {
  test("disables Revert on a history row whose 'from' values already match the live marker, and leaves Revert enabled on rows that would actually change something", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task148 revert-disabled");

    try {
      // Seed: add the phrase, then edit it twice through the API so we land
      // back at the original category. We do this through the API instead of
      // the UI to keep the spec focused on the disabled-state assertion (the
      // add + edit UI flows are exercised by other handwavy specs).
      const addResp = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases",
        {
          data: {
            phrase,
            category: "absence",
            reviewer: `${REVIEWER_PREFIX}-seed`,
            rationale: "seed rationale",
          },
        },
      );
      expect(addResp.ok(), `add failed: ${addResp.status()}`).toBe(true);

      // Edit #1: absence -> hedging.
      const edit1Resp = await apiCtx.patch(
        "/api/feedback/calibration/handwavy-phrases",
        {
          data: {
            phrase,
            category: "hedging",
            reviewer: `${REVIEWER_PREFIX}-edit1`,
          },
        },
      );
      expect(edit1Resp.ok(), `edit#1 failed: ${edit1Resp.status()}`).toBe(true);

      // Edit #2: hedging -> absence (puts the marker back to its original
      // category, so reverting Edit #1 would now be a no-op).
      const edit2Resp = await apiCtx.patch(
        "/api/feedback/calibration/handwavy-phrases",
        {
          data: {
            phrase,
            category: "absence",
            reviewer: `${REVIEWER_PREFIX}-edit2`,
          },
        },
      );
      expect(edit2Resp.ok(), `edit#2 failed: ${edit2Resp.status()}`).toBe(true);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(
        row,
        "seeded phrase should appear in the active list",
      ).toHaveCount(1, {
        timeout: 15_000,
      });

      // Two recorded edits => the multi-edit history toggle renders. Open
      // the per-row history panel.
      const historyToggle = row.getByTestId("handwavy-edit-history-toggle");
      await expect(
        historyToggle,
        "edit-history toggle should appear for >1 edits",
      ).toBeVisible({
        timeout: 15_000,
      });
      if ((await historyToggle.getAttribute("aria-expanded")) !== "true") {
        await historyToggle.click();
      }
      const historyList = row.getByTestId("handwavy-edit-history-list");
      await expect(historyList).toBeVisible();

      // Both edits should render as Revert-button rows. Renderer reverses
      // the list so the most recent edit (Edit #2) is row[0] and the older
      // one (Edit #1) is row[1].
      const revertButtons = historyList.getByTestId("handwavy-revert-edit");
      await expect(revertButtons).toHaveCount(2);

      // Most recent edit (hedging -> absence): reverting it would set the
      // category back to hedging — a real change — so the button must be
      // ENABLED with its normal "Revert" label.
      const newestRevert = revertButtons.nth(0);
      await expect(newestRevert).toHaveAttribute("data-noop", "false");
      await expect(newestRevert).toBeEnabled();
      await expect(newestRevert).toContainText("Revert");

      // Older edit (absence -> hedging): the live category is already
      // 'absence', so reverting would be a no-op — the button must be
      // DISABLED with the "At this state" label and aria-label/title that
      // explain why.
      const olderRevert = revertButtons.nth(1);
      await expect(olderRevert).toHaveAttribute("data-noop", "true");
      await expect(olderRevert).toBeDisabled();
      await expect(olderRevert).toContainText("At this state");
      await expect(olderRevert).toHaveAttribute(
        "aria-label",
        new RegExp(
          `Revert unavailable for ${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );

      // Task #241 — the disabled row also renders a visible inline hint
      // explaining why Revert is greyed out, so reviewers on touch devices
      // (and screen-reader users who don't focus the button) don't have to
      // hover to discover the reason. The hint sits inside the SAME
      // edit-history row as the disabled button and is wired to it via
      // aria-describedby.
      const olderRow = historyList
        .getByTestId("handwavy-edit-history-row")
        .filter({
          has: page.locator(
            '[data-testid="handwavy-revert-edit"][data-noop="true"]',
          ),
        });
      await expect(olderRow).toHaveCount(1);
      const noopHint = olderRow.getByTestId("handwavy-revert-noop-hint");
      await expect(
        noopHint,
        "disabled row must show a visible non-hover-only hint",
      ).toBeVisible();
      await expect(noopHint).toContainText(/already matches/i);
      await expect(noopHint).toContainText(/nothing to undo/i);
      const hintId = await noopHint.getAttribute("id");
      expect(
        hintId,
        "hint must have a stable id for aria-describedby wiring",
      ).toBeTruthy();
      // The id MUST be whitespace-free — aria-describedby is an IDREF list
      // split on whitespace, and the seed phrases here contain spaces, so a
      // raw-phrase id would silently break the screen-reader association.
      expect(hintId!).not.toMatch(/\s/);
      expect(hintId!).toMatch(/^[A-Za-z][A-Za-z0-9_:.-]*$/);
      await expect(olderRevert).toHaveAttribute("aria-describedby", hintId!);

      // The other (enabled) row must NOT render a hint — Task #241 only
      // explains the disabled state and leaves working rows untouched.
      const enabledRow = historyList
        .getByTestId("handwavy-edit-history-row")
        .filter({
          has: page.locator(
            '[data-testid="handwavy-revert-edit"][data-noop="false"]',
          ),
        });
      await expect(enabledRow).toHaveCount(1);
      await expect(
        enabledRow.getByTestId("handwavy-revert-noop-hint"),
      ).toHaveCount(0);
      await expect(newestRevert).not.toHaveAttribute("aria-describedby", /.+/);
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: `${REVIEWER_PREFIX}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
