import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  removeSingle,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #233 — End-to-end coverage for the panel-level "Undo last N adds"
// affordance on the FLAT Hand-wavy Marker Phrases reviewer panel. The
// reviewer adds several phrases through the API (mimicking a freshly-added
// batch that's still inside its per-marker undo window), then drives the
// panel's bulk-undo button + confirm dialog and asserts every phrase is
// rolled back in one round-trip — and that each one keeps its own
// `undone: true` history row (no batch-merge that hides per-phrase
// provenance).
//
// Task #348 — This spec is verified end-to-end against the production-build
// webServer that bakes `VITE_CALIBRATION_TOKEN` into the page (see the
// non-dev branch of playwright.config.ts). The dev-mode webServer
// (`E2E_DEV_SERVERS=1`) also passes today because playwright.config.ts sets
// `VITE_CALIBRATION_TOKEN` on the Vite dev server's env AND attaches a
// global `X-Calibration-Token` via `extraHTTPHeaders`; the call to
// `injectCalibrationTokenIntoPage` below is a forward-compatible hook for
// any future dev mode that doesn't bake the token into the bundle.
// Mirrors the helper / token-injection pattern from
// handwavy-bulk-undo.spec.ts so both suites stay in lockstep.

const REVIEWER = "e2e-task233";

test.describe("Panel-level Undo last N adds (Task #233)", () => {
  test("rolls back every still-in-window phrase in one round-trip and emits one undone:true history row per phrase", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task233 undo-all happy");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Sanity: the three rows are on the active list so the page is
      // showing the fresh adds we just made.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }

      // The panel-level "Undo last N adds" button renders because at
      // least two reviewer-added phrases are inside their per-marker
      // undo window.
      const undoAll = page.getByTestId("handwavy-undo-all");
      await expect(undoAll).toBeVisible({ timeout: 15_000 });
      // The label includes the candidate count so the reviewer can
      // see the blast radius before clicking.
      await expect(undoAll).toContainText(/Undo last \d+ adds/);

      await undoAll.click();

      const dialog = page.getByTestId("handwavy-undo-all-confirm");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      // The dialog headline echoes the count of still-in-window adds
      // captured at click time.
      await expect(dialog).toContainText(/Undo the last \d+ adds\?/);
      // The summary list shows every phrase that's about to be rolled
      // back so a misclick is visible before any audit-log mutation.
      const summary = dialog.getByTestId("handwavy-undo-all-confirm-summary");
      for (const p of phrases) {
        await expect(summary).toContainText(p);
      }

      // Capture the pre-undo history length so we can assert exactly N
      // new undone:true rows were appended (one per phrase, no
      // batch-merge collapse).
      const preHistoryRes = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(preHistoryRes.ok()).toBeTruthy();
      const preHistory = (await preHistoryRes.json()) as {
        history: Array<{ phrase: string; undone?: boolean; removedAt: string }>;
      };
      const preUndoneForPhrases = preHistory.history.filter(
        (h) => h.undone === true && phrases.includes(h.phrase),
      );

      await dialog.getByTestId("handwavy-undo-all-confirm-confirm").click();

      // The dialog closes and the rows disappear from the active list.
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      // Task #347 — confirmation summary toast carries the undone +
      // skipped breakdown. `.first()` because the toast viewport
      // renders the text twice (visual + aria-live mirror).
      await expect(
        page
          .getByText(`Undid ${phrases.length} adds. Skipped 0`, { exact: false })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }
      // The button itself is gone now that no candidates remain.
      await expect(page.getByTestId("handwavy-undo-all")).toHaveCount(0);

      // The API confirms the audit-trail contract: exactly N new
      // undone:true rows appeared, one per phrase. No row got merged
      // into a single batch entry.
      const postRes = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(postRes.ok()).toBeTruthy();
      const post = (await postRes.json()) as {
        phrases: Array<{ phrase: string }>;
        history: Array<{ phrase: string; undone?: boolean; removedAt: string }>;
      };
      // Active list no longer contains any of the test phrases.
      const activePhrases = post.phrases.map((m) => m.phrase);
      for (const p of phrases) expect(activePhrases).not.toContain(p);
      // Per-phrase undone:true rows: one new row per phrase.
      const postUndoneForPhrases = post.history.filter(
        (h) => h.undone === true && phrases.includes(h.phrase),
      );
      expect(postUndoneForPhrases.length - preUndoneForPhrases.length).toBe(
        phrases.length,
      );
      // Each phrase has its OWN dedicated row; the batch wasn't
      // collapsed into a single audit entry.
      const undonePhrases = new Set(postUndoneForPhrases.map((r) => r.phrase));
      for (const p of phrases) expect(undonePhrases.has(p)).toBe(true);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("the bulk-undo button is hidden when fewer than two reviewer-added phrases are inside their undo window", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(1, "task233 undo-all single");

    try {
      await addPhrase(apiCtx, phrases[0], { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // The single phrase row is visible in the active list.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrases[0] }),
      ).toHaveCount(1, { timeout: 15_000 });

      // The per-row Undo affordance is enough for a single eligible
      // phrase, so the panel-level "Undo last N adds" button does not
      // render at all (the show/hide gate is `undoCandidates.size >= 2`).
      await expect(page.getByTestId("handwavy-undo-all")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #488 — mixed-failure path of the bulk-undo confirmation toast.
  // Task #347 split the per-entry failures the server reports into two
  // buckets: window-expired skips (the expected "the dialog sat open
  // long enough that one entry's 5-minute window elapsed before the
  // POST landed") vs. other reasons (drift like `not-found` /
  // `addedAt-mismatch` from a refresh racing the click). The happy-path
  // test above only exercises the all-success branch; this test drives
  // the partial breakdown branch by deleting one of the candidates
  // server-side AFTER the dialog snapshot is captured but BEFORE
  // confirm — so the POST sends three entries and the server replies
  // with two `undone:true` and one `undone:false, reason:"not-found"`.
  // The toast then has to use the mixed-format breakdown
  // (`Skipped N (X no longer in window, Y other)`) and the audit-log
  // hint sentence, which is the wording reviewers see whenever drift
  // shows up at confirm time.
  test("partial-failure toast lists the per-failure breakdown and audit-log hint", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task488 undo-all mixed");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }

      const undoAll = page.getByTestId("handwavy-undo-all");
      await expect(undoAll).toBeVisible({ timeout: 15_000 });
      await undoAll.click();

      const dialog = page.getByTestId("handwavy-undo-all-confirm");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      // Snapshot of all three phrases is captured in the dialog state at
      // open time, so the upcoming server-side mutation can't shrink it.
      const summary = dialog.getByTestId("handwavy-undo-all-confirm-summary");
      for (const p of phrases) {
        await expect(summary).toContainText(p);
      }

      // Drift one candidate out from under the dialog: a direct DELETE
      // through the calibration API removes it from the active list, so
      // the per-marker undo path the bulk endpoint walks will return
      // `not-found` for that one entry while the other two succeed. This
      // is the same shape as a refresh-race where the reviewer's other
      // tab removed a row between the dialog open and the confirm click,
      // and produces a non-window-expired failure (i.e. an "other"
      // failure that triggers the partial breakdown wording).
      await removeSingle(apiCtx, phrases[0], { reviewer: REVIEWER });

      await dialog.getByTestId("handwavy-undo-all-confirm-confirm").click();

      // Dialog closes after confirm, even on the partial-failure path.
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });

      // The success toast renders with the partial breakdown wording —
      // 2 succeeded ("Undid 2 adds"), 1 failed for a non-window reason
      // ("Skipped 1 (0 no longer in window, 1 other)"), plus the
      // audit-log hint pointing to the per-phrase removal history. The
      // toast viewport renders the text twice (visual + aria-live
      // mirror) so we anchor on `.first()`.
      await expect(
        page
          .getByText("Undid 2 adds. Skipped 1 (0 no longer in window, 1 other)", {
            exact: false,
          })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .getByText(
            "Check the removal history below for the per-phrase audit row.",
            { exact: false },
          )
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      // The two not-drifted phrases are gone from the active list (the
      // bulk-undo rolled them back). The drifted one is also gone, but
      // because it was removed via the manual DELETE path, not undone.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }

      // Audit-trail contract: exactly two `undone:true` rows appeared
      // (one per successfully-undone phrase), and the drifted phrase
      // has its own non-undone removal row from the manual DELETE
      // instead of an undone row.
      const postRes = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(postRes.ok()).toBeTruthy();
      const post = (await postRes.json()) as {
        history: Array<{ phrase: string; undone?: boolean }>;
      };
      const undoneForPhrases = post.history.filter(
        (h) => h.undone === true && phrases.includes(h.phrase),
      );
      expect(undoneForPhrases.map((h) => h.phrase).sort()).toEqual(
        [phrases[1], phrases[2]].sort(),
      );
      const driftedUndoneRows = post.history.filter(
        (h) => h.undone === true && h.phrase === phrases[0],
      );
      expect(driftedUndoneRows).toHaveLength(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #488 — all-failed branch: every entry in the captured snapshot
  // has drifted by the time the confirm click lands, so the server
  // returns `undoneCount: 0` and the toast switches to the destructive
  // "Nothing to undo" title (instead of "Undid N adds") while still
  // showing the per-failure breakdown and the audit-log hint. This is
  // the worst-case wording the reviewer sees when a long-paused dialog
  // is finally confirmed against a fully-stale candidate set.
  test("all-failed branch surfaces the 'Nothing to undo' destructive toast with the audit-log hint", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task488 undo-all none");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }

      const undoAll = page.getByTestId("handwavy-undo-all");
      await expect(undoAll).toBeVisible({ timeout: 15_000 });
      await undoAll.click();

      const dialog = page.getByTestId("handwavy-undo-all-confirm");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      const summary = dialog.getByTestId("handwavy-undo-all-confirm-summary");
      for (const p of phrases) {
        await expect(summary).toContainText(p);
      }

      // Drift EVERY candidate so the bulk-undo POST sees a fully-stale
      // snapshot: each entry returns `undone:false, reason:"not-found"`.
      for (const p of phrases) {
        await removeSingle(apiCtx, p, { reviewer: REVIEWER });
      }

      await dialog.getByTestId("handwavy-undo-all-confirm-confirm").click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });

      // Title flips to "Nothing to undo" because `undoneCount === 0`,
      // and the toast variant becomes destructive (we don't assert on
      // the variant attribute directly, since the toast's
      // role="status" + the explicit title text is the contract that
      // the reviewer reads). The description still carries the
      // breakdown and the audit-log hint so the reviewer knows where
      // to inspect what went wrong.
      await expect(
        page.getByText("Nothing to undo", { exact: false }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .getByText("Undid 0 adds. Skipped 2 (0 no longer in window, 2 other)", {
            exact: false,
          })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .getByText(
            "Check the removal history below for the per-phrase audit row.",
            { exact: false },
          )
          .first(),
      ).toBeVisible({ timeout: 15_000 });

      // No `undone:true` row appeared for either phrase — the bulk-undo
      // POST didn't roll anything back, the existing manual-removal
      // history rows from the drift DELETEs are what stayed in the log.
      const postRes = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(postRes.ok()).toBeTruthy();
      const post = (await postRes.json()) as {
        history: Array<{ phrase: string; undone?: boolean }>;
      };
      const undoneForPhrases = post.history.filter(
        (h) => h.undone === true && phrases.includes(h.phrase),
      );
      expect(undoneForPhrases).toHaveLength(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("dialog Cancel leaves every phrase active and emits no audit rows", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task233 undo-all cancel");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const undoAll = page.getByTestId("handwavy-undo-all");
      await expect(undoAll).toBeVisible({ timeout: 15_000 });
      await undoAll.click();
      const dialog = page.getByTestId("handwavy-undo-all-confirm");
      await expect(dialog).toBeVisible({ timeout: 15_000 });

      // Cancel: dialog closes, the rows stay on the active list, and
      // no `undone:true` row is appended for either phrase.
      await dialog.getByTestId("handwavy-undo-all-confirm-cancel").click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });

      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1);
      }

      const res = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as {
        history: Array<{ phrase: string; undone?: boolean }>;
      };
      const undoneRows = body.history.filter(
        (h) => h.undone === true && phrases.includes(h.phrase),
      );
      expect(undoneRows).toHaveLength(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #487 — when a non-window-expired failure shows up in the
  // bulk-undo summary toast (i.e. drift between the captured candidate
  // list and the active list), the toast carries a "View skipped"
  // action button that scrolls the removal-history panel into view and
  // pulse-highlights the matching audit row(s). This spec drives the
  // drift case end-to-end: seed two phrases, open the confirm dialog,
  // remove one phrase out-of-band via the API (so the captured
  // candidate is now stale), confirm the dialog, and assert the toast's
  // action button jumps + highlights the dropped phrase's history row.
  test("toast `View skipped` action scrolls + pulse-highlights drift-skipped phrase rows in removal history", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task487 undo-all drift");

    try {
      for (const p of phrases) await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Both rows live on the active list before we open the dialog.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }

      const undoAll = page.getByTestId("handwavy-undo-all");
      await expect(undoAll).toBeVisible({ timeout: 15_000 });
      await undoAll.click();

      const dialog = page.getByTestId("handwavy-undo-all-confirm");
      await expect(dialog).toBeVisible({ timeout: 15_000 });

      // Drift seed: out-of-band remove ONE of the captured-candidate
      // phrases via the API while the dialog is open. The dialog
      // already snapshotted both phrases as in-window candidates, so
      // the impending bulk-undo will return a non-window-expired
      // failure ("not-found") for the drifted phrase and a successful
      // undo for the other.
      const driftedPhrase = phrases[0];
      const survivingPhrase = phrases[1];
      await removeSingle(apiCtx, driftedPhrase, {
        reviewer: `${REVIEWER}-drift`,
      });

      // Confirm the bulk-undo round-trip while the captured-candidate
      // list is now stale.
      await dialog.getByTestId("handwavy-undo-all-confirm-confirm").click();
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });

      // The summary toast splits the count and surfaces the skipped
      // breakdown including the drift ("other") count.
      await expect(
        page
          .getByText("Undid 1 add. Skipped 1", { exact: false })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("0 no longer in window, 1 other", { exact: false }).first(),
      ).toBeVisible({ timeout: 15_000 });

      // The drift case carries the toast action affordance.
      const jumpButton = page.getByTestId("handwavy-undo-all-toast-jump-skipped");
      await expect(jumpButton).toBeVisible({ timeout: 15_000 });
      await expect(jumpButton).toHaveText(/View skipped/);

      await jumpButton.click();

      // The removal-history panel is now open (the action force-opens
      // the collapsed panel) and the drifted phrase's audit row is
      // pulse-highlighted via the shared amber `data-highlighted`
      // attribute that the per-row jump UX (Task #412) also uses.
      await expect(page.getByTestId("handwavy-history-list")).toBeVisible({
        timeout: 15_000,
      });
      const driftedHistoryRow = page.locator(
        `[data-handwavy-history-phrase="${driftedPhrase}"]`,
      );
      await expect(driftedHistoryRow).toHaveCount(1, { timeout: 15_000 });
      await expect(driftedHistoryRow).toHaveAttribute(
        "data-highlighted",
        "true",
        { timeout: 15_000 },
      );

      // The successfully-undone phrase's row exists too (its audit
      // entry is the per-phrase `undone:true` row from the bulk undo)
      // but it is NOT lit up — only drift-skipped phrases get the
      // pulse so the reviewer's eye lands on the rows that actually
      // need investigation.
      const survivingHistoryRow = page.locator(
        `[data-handwavy-history-phrase="${survivingPhrase}"]`,
      );
      await expect(survivingHistoryRow).toHaveCount(1, { timeout: 15_000 });
      await expect(survivingHistoryRow).not.toHaveAttribute(
        "data-highlighted",
        "true",
      );
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
