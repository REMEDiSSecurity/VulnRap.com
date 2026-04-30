import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
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
});
