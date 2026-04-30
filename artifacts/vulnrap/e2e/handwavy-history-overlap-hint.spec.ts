import { test, expect } from "@playwright/test";
import {
  addAndUndo,
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  reinstate,
  removeSingle,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #295 — Browser coverage for the Task #221 "Previously removed"
// pre-preview hint on the calibration add-phrase form. The CLI side has
// vitest coverage of `detectHandwavyHistoryOverlaps`, but no Playwright
// spec asserts the React surface renders the hint, embeds the audit
// metadata, hides on preview-open, or skips reinstated history rows.

const REVIEWER = "e2e-task295";

test.describe("Pre-preview 'Previously removed' history-overlap hint (Task #221)", () => {
  test("renders for a candidate that matches a retired history entry, surfaces reviewer + date + rationale, and disappears once the dry-run preview opens", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task295 retired");
    const rationale = `task295 reasoning ${phrase.split(" ").pop()}`;
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

      // The history-toggle only mounts after the removal-history payload
      // has loaded — same payload the in-page detection reads from. We
      // do NOT need to expand it: detection runs against the fetched
      // array regardless of collapse state.
      await expect(page.getByTestId("handwavy-history-toggle")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId("handwavy-input").fill(phrase);

      const hint = page.getByTestId("handwavy-history-overlap-hint");
      await expect(hint).toBeVisible({ timeout: 15_000 });

      const top = page.getByTestId("handwavy-history-overlap-hint-top");
      await expect(top).toContainText(phrase);
      await expect(top).toContainText(REVIEWER);
      await expect(top).toContainText(rationale);

      // Mirror the UI's `formatAuditTimestamp` exactly inside the page
      // context so the expected string uses the same Intl locale the
      // browser will render with. Asserting the full formatted date
      // (rather than e.g. just the year) catches a regression that
      // swapped the format options or pointed `removedAt` at the wrong
      // field.
      const expectedDate = await page.evaluate((iso) => {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return null;
        return new Date(t).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }, removedAt);
      expect(expectedDate).not.toBeNull();
      await expect(top).toContainText(expectedDate!);

      await page.getByTestId("handwavy-add").click();
      await expect(page.getByTestId("handwavy-preview")).toBeVisible({
        timeout: 15_000,
      });
      await expect(hint).toHaveCount(0);

      await page.getByTestId("handwavy-preview-cancel").click();
      await expect(page.getByTestId("handwavy-preview")).toHaveCount(0);
    } finally {
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });

  test("does NOT render for a phrase whose removal history entry has been reinstated (negative case)", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task295 reinstated");
    const rationale = `task295 reinstated reasoning ${phrase.split(" ").pop()}`;
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);

      await addPhrase(api, phrase, {
        reviewer: REVIEWER,
        rationale,
        category: "hedging",
      });
      const removedAt = await removeSingle(api, phrase, { reviewer: REVIEWER });
      await reinstate(api, phrase, removedAt, { reviewer: REVIEWER });

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await expect(page.getByTestId("handwavy-history-toggle")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId("handwavy-input").fill(phrase);

      // The phrase is back on the active list, so the existing active-
      // list overlap hint MUST fire — we wait on it as a positive
      // signal that the in-page detection has reacted to our typed
      // input before asserting the history hint is absent (rather than
      // just "not yet rendered").
      await expect(page.getByTestId("handwavy-overlap-hint")).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByTestId("handwavy-history-overlap-hint"),
        "Reinstated history entries must be skipped by the previously-removed hint",
      ).toHaveCount(0);
    } finally {
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });

  // Task #413 — covers the `verb = top.undone ? "undone" : "removed"`
  // wording branch in feedback-analytics.tsx. The Task #295 spec above
  // only exercises the "removed" branch (a deliberate per-row Trash
  // removal), so a regression that swaps the verb (e.g. always renders
  // "removed" or always renders "undone") would slip past CI even with
  // both Task #295 tests green. Seeding via `addAndUndo` produces a
  // history row tagged `undone: true` exactly the way the in-app
  // per-row "Undo" button does, but without coupling this spec to the
  // 5-minute window's live countdown rendering — the per-row Undo path
  // is already covered by handwavy-undo.spec.ts.
  test("renders 'Previously undone' wording (and 'undone by …' in the summary line) when the matching history entry was an undo of a brand-new add", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task413 undone");
    // Keep the rationale free of the literal words "removed"/"undone"
    // so the negative assertions below (which check the rendered hint
    // text doesn't carry the OTHER verb) can't be defeated by the
    // rationale leaking the wrong word into the same `top` block.
    const rationale = `task413 reasoning ${phrase.split(" ").pop()}`;
    const api = await newApiContext();

    try {
      await injectCalibrationTokenIntoPage(page);

      await addAndUndo(api, phrase, {
        reviewer: REVIEWER,
        rationale,
        category: "hedging",
      });

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Same gating signal as the existing tests: the history-toggle only
      // mounts after the removal-history payload has loaded — the same
      // payload the in-page detection reads from. Detection runs against
      // the fetched array regardless of collapse state.
      await expect(page.getByTestId("handwavy-history-toggle")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByTestId("handwavy-input").fill(phrase);

      const hint = page.getByTestId("handwavy-history-overlap-hint");
      await expect(hint).toBeVisible({ timeout: 15_000 });

      // The verb appears TWICE in the rendered hint:
      //   1. The bold leader "Previously {verb} — overlaps with …"
      //   2. The per-entry summary "{verb} by {reviewer} on {date}"
      // Both must read "undone", and neither must read "removed", so a
      // regression that flips only one occurrence (or pins the leader
      // to "removed" while the summary still flips) is caught.
      await expect(hint).toContainText("Previously undone");
      await expect(
        hint,
        "Leader must read 'Previously undone' — never 'Previously removed' — for an undo-tagged history row",
      ).not.toContainText("Previously removed");

      const top = page.getByTestId("handwavy-history-overlap-hint-top");
      await expect(top).toContainText(phrase);
      await expect(top).toContainText(`undone by ${REVIEWER}`);
      await expect(
        top,
        "Per-entry summary must read 'undone by …' — never 'removed by …' — for an undo-tagged history row",
      ).not.toContainText("removed by");
      await expect(top).toContainText(rationale);
    } finally {
      await cleanup(api, phrase, { reviewer: `${REVIEWER}-cleanup` });
      await api.dispose();
    }
  });
});
