import { test, expect } from "@playwright/test";
import {
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
});
