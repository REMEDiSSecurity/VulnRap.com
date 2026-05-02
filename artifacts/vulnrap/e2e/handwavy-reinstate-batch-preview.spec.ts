import { test, expect, request, type APIRequestContext, type Page, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #177 — End-to-end coverage for the per-batch "Preview reinstate"
// affordance on the FLAT hand-wavy phrase audit panel. The button calls
// POST /feedback/calibration/handwavy-phrases/reinstate-batch with
// dryRun: true (Task #159) so the reviewer can inspect the per-phrase
// outcome (would reinstate / already reinstated / already active) before
// committing. A "Confirm reinstate" button inside the rendered panel
// then runs the real (non-dry-run) call.
//
// The backend dry-run path already has unit coverage; this spec exercises
// the rendered button + panel, the per-phrase row outcomes, and the
// transition from preview → confirm → "All reinstated".

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext() {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

interface BatchRemovalResponse {
  batch: true;
  removed: number;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

function uniquePhrases(count: number): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from({ length: count }, (_, i) => `task177 preview ${id} phrase ${i + 1}`);
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task177" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function batchRemove(
  api: APIRequestContext,
  phrases: string[],
): Promise<BatchRemovalResponse> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrases, reviewer: "e2e-task177" },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (batch) failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as BatchRemovalResponse;
  expect(body.batch).toBe(true);
  expect(body.removed).toBe(phrases.length);
  expect(body.historyEntry?.removedAt, "batch removal should produce a history entry").toBeTruthy();
  return body;
}

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task177-cleanup" },
    })
    .catch(() => undefined);
}

async function openHistoryAndFindBatch(
  page: Page,
  batchRemovedAt: string,
): Promise<Locator> {
  await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

  const toggle = page.getByTestId("handwavy-history-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("handwavy-history-list")).toBeVisible();

  const group = page.locator(
    `[data-testid="handwavy-history-batch-group"][data-batch-removed-at="${batchRemovedAt}"]`,
  );
  await expect(
    group,
    `expected to find a batch group with data-batch-removed-at="${batchRemovedAt}"`,
  ).toHaveCount(1, { timeout: 15_000 });
  return group;
}

test.describe("FLAT hand-wavy phrase panel — 'Preview reinstate' batch button", () => {
  test("clicking 'Preview reinstate' opens an inline panel of per-phrase outcomes without mutating anything, and 'Confirm reinstate' commits the batch", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      const header = group.getByTestId("handwavy-history-batch-header");
      await expect(header).toBeVisible();

      // Both the existing "Reinstate all" and the new "Preview reinstate"
      // buttons should be available in the header before any interaction.
      const previewBtn = group.getByTestId("handwavy-reinstate-batch-preview");
      const batchBtn = group.getByTestId("handwavy-reinstate-batch");
      await expect(previewBtn).toBeVisible();
      await expect(previewBtn).toHaveText(/Preview reinstate/);
      await expect(batchBtn).toBeVisible();
      await expect(batchBtn).toHaveText(new RegExp(`Reinstate all ${phrases.length}\\b`));

      // None of the phrases are on the active list before the click.
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // Open the dry-run preview panel.
      await previewBtn.click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toHaveAttribute("data-batch-removed-at", removedAt);

      // The panel renders one outcome row per inner phrase, and every row
      // is marked "would-reinstate" since none of these phrases are
      // already active or already reinstated.
      const rows = panel.getByTestId("handwavy-reinstate-batch-preview-row");
      await expect(rows).toHaveCount(phrases.length);
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      for (const p of phrases) {
        await expect(rows.filter({ hasText: p })).toHaveCount(1);
      }

      // Critically: nothing has been mutated by the dry-run. The batch
      // header must NOT have flipped to "All reinstated" and the active
      // list must still be empty for these phrases.
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);
      await expect(batchBtn).toBeVisible();
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }

      // Press the panel's "Confirm reinstate" button to fire the real call.
      const confirmBtn = panel.getByTestId("handwavy-reinstate-batch-preview-confirm");
      await expect(confirmBtn).toBeEnabled();
      await expect(confirmBtn).toContainText(`Confirm reinstate (${phrases.length})`);
      await confirmBtn.click();

      // After the round-trip the header swaps to "All reinstated", the
      // preview panel goes away (cleared by the success path), and every
      // phrase reappears on the active list.
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toBeVisible({
        timeout: 15_000,
      });
      await expect(group.getByTestId("handwavy-reinstate-batch-preview-panel")).toHaveCount(0);
      await expect(group.getByTestId("handwavy-reinstate-batch")).toHaveCount(0);
      await expect(group.getByTestId("handwavy-reinstate-batch-preview")).toHaveCount(0);

      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("'Cancel' on the preview panel closes it without committing the reinstate", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();

      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      await panel.getByTestId("handwavy-reinstate-batch-preview-cancel").click();
      await expect(group.getByTestId("handwavy-reinstate-batch-preview-panel")).toHaveCount(0);

      // Nothing should have been mutated — the batch button is still there
      // and none of the phrases are on the active list.
      await expect(group.getByTestId("handwavy-reinstate-batch")).toBeVisible();
      await expect(group.getByTestId("handwavy-history-batch-reinstated")).toHaveCount(0);
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0);
      }
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("the preview panel surfaces 'already reinstated' rows when one inner phrase has already been per-phrase reinstated", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Reinstate the first phrase via the per-phrase API so the dry-run
      // preview classifies it as "already-reinstated".
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate",
        {
          data: { phrase: phrases[0], removedAt, reviewer: "e2e-task177-pre" },
        },
      );
      expect(
        reinstateRes.ok(),
        `per-phrase reinstate failed: ${reinstateRes.status()} ${await reinstateRes.text()}`,
      ).toBeTruthy();

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // 1 row marked "already-reinstated", 2 rows marked "would-reinstate".
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      const alreadyReinstatedRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="already-reinstated"]',
      );
      await expect(wouldRows).toHaveCount(2);
      await expect(alreadyReinstatedRows).toHaveCount(1);
      await expect(alreadyReinstatedRows.first()).toContainText(phrases[0]);

      // Confirm count reflects only the would-reinstate rows.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toContainText("Confirm reinstate (2)");
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  // Task #248 — when a teammate per-phrase reinstates one of the inner
  // phrases between the dry-run preview and the reviewer's confirm click,
  // the panel keeps showing the original "would-reinstate" outcome for
  // that row. The new drift indicator should detect the mismatch (the
  // current state would now classify the row as "already-reinstated")
  // and surface a "Re-preview to refresh" notice, mirroring the
  // bulk-remove preview's "Selection has changed since this preview was
  // generated" warning. Confirm stays enabled — the server's reinstate
  // call already ignores already-reinstated / already-active rows
  // safely (Task #159).
  test("a per-phrase reinstate landing between preview and confirm surfaces a 'stale preview' notice on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Every row starts as "would-reinstate" and the stale notice is
      // not rendered yet — the snapshot still matches reality.
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-stale"),
      ).toHaveCount(0);

      // Out of band: a teammate per-phrase reinstates the first inner
      // phrase. The preview panel's snapshot now disagrees with reality
      // (it still shows that row as "would-reinstate" but the real
      // state is "already-reinstated").
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate",
        {
          data: {
            phrase: phrases[0],
            removedAt,
            reviewer: "e2e-task248-drift",
          },
        },
      );
      expect(
        reinstateRes.ok(),
        `per-phrase reinstate failed: ${reinstateRes.status()} ${await reinstateRes.text()}`,
      ).toBeTruthy();

      // While the preview panel is open Task #248 polls
      // /handwavy-phrases every 5s so the page picks up out-of-band
      // mutations like this per-phrase reinstate without the reviewer
      // having to alt-tab. After the next poll the inner row's
      // `reinstated` flag is true and the panel's captured
      // "would-reinstate" snapshot for that row no longer matches
      // reality, so the stale notice renders.
      const stale = panel.getByTestId("handwavy-reinstate-batch-preview-stale");
      await expect(stale).toBeVisible({ timeout: 20_000 });
      await expect(stale).toContainText(/Re-preview to refresh/);

      // The confirm button stays enabled — the server-side mutating
      // call already de-dupes already-reinstated rows safely, so the
      // notice is a heads-up rather than a hard block. The original
      // per-phrase outcomes are still rendered exactly as captured.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toBeEnabled();
      await expect(wouldRows).toHaveCount(phrases.length);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  // Task #355 — companion to the per-phrase-reinstate drift case above.
  // `expectedOutcomeFor` (in feedback-analytics.tsx) has three branches:
  // already-reinstated (history row's reinstated flag flipped),
  // already-active (the phrase is on the active list independent of any
  // history row), and would-reinstate. The test above covers the first
  // branch via POST .../reinstate; this test covers the second branch by
  // independently re-adding one of the inner phrases to the active list
  // via POST /handwavy-phrases between preview and confirm. The dry-run
  // captured "would-reinstate" for that row, but `expectedOutcomeFor`
  // now resolves it to "already-active" because it shows up in the
  // `phrases` list, so the panel's stale notice should fire after the
  // 5s in-panel poll picks up the new active-list state.
  test("a re-add to the active list landing between preview and confirm surfaces the 'stale preview' notice on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Every row starts as "would-reinstate" and the stale notice is
      // not rendered yet — the snapshot still matches reality.
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-stale"),
      ).toHaveCount(0);

      // Out of band: a teammate independently re-adds the first inner
      // phrase to the active list via POST /handwavy-phrases (i.e. NOT
      // the per-batch or per-phrase reinstate endpoint, so the inner
      // history row's `reinstated` flag stays false). The dry-run
      // snapshot still says "would-reinstate" for that row but the
      // current state has it on the active list, so
      // `expectedOutcomeFor` now classifies it as "already-active".
      await addPhrase(apiCtx, phrases[0]);

      // The preview panel polls /handwavy-phrases every 5s while open
      // (Task #248). Once the next poll lands the active-list contains
      // the re-added phrase, the panel-side `previewDrifted` check
      // notices the mismatch ("would-reinstate" snapshot vs current
      // "already-active") and renders the stale notice.
      const stale = panel.getByTestId("handwavy-reinstate-batch-preview-stale");
      await expect(stale).toBeVisible({ timeout: 20_000 });
      await expect(stale).toContainText(/Re-preview to refresh/);

      // Confirm stays enabled — the server's reinstate call already
      // de-dupes already-active rows safely. The original per-phrase
      // outcomes are still rendered exactly as captured at click time.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toBeEnabled();
      await expect(wouldRows).toHaveCount(phrases.length);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  // Task #498 — third-branch coverage for `expectedOutcomeFor` /
  // `previewDrifted` in the per-batch reinstate preview panel. The
  // comment around expectedOutcomeFor in feedback-analytics.tsx names
  // three drift triggers: a per-phrase reinstate landing in between
  // (Task #248, snapshot="would-reinstate" → current="already-reinstated"),
  // an independent re-add of one of the phrases to the active list
  // (Task #355, snapshot="would-reinstate" → current="already-active"),
  // and "re-removes a previously reinstated row" — the case this test
  // is meant to close.
  //
  // expectedOutcomeFor's three returns are: A "already-reinstated" (when
  // the inner history row's `reinstated` flag is true), B "already-active"
  // (when the phrase is on the active list), and C "would-reinstate"
  // (the fallback). Tasks #248 and #355 cover transitions INTO A and B;
  // the only transition that exercises branch C as the *new* outcome is
  // a snapshot of A or B that resolves to C after re-removal.
  //
  // The literal "per-phrase reinstate then re-remove" path (which would
  // be snapshot=A → current=C) cannot fire today: removeHandwavyPhrase
  // and removeHandwavyPhrasesBatch in
  // artifacts/api-server/src/lib/engines/avri/handwavy-phrases.ts only
  // APPEND a fresh history entry — neither clears the previous entry's
  // inner.reinstated flag. Empirically (verified end-to-end against the
  // running api-server during task work): per-phrase reinstate → DELETE
  // → GET /handwavy-phrases shows the original history row with
  // reinstated=true intact. So expectedOutcomeFor's branch A always
  // wins for that row and `previewDrifted` stays false.
  //
  // The transition that IS reachable today and exercises the same C
  // (would-reinstate) fallback in expectedOutcomeFor is snapshot=B
  // ("already-active") → current=C: independently re-add a phrase via
  // POST /handwavy-phrases (so the dry-run captures it as
  // "already-active" and inner.reinstated stays false), open the
  // preview, then DELETE the phrase so the active list no longer
  // contains it. expectedOutcomeFor falls through both A
  // (innerRow.reinstated=false) and B (not on active list) and returns
  // "would-reinstate"; previewDrifted flips and the stale notice
  // renders after the in-panel poll picks up the new state.
  //
  // The asserts below also lock in the actual engine behavior — the
  // inner row's `reinstated` flag stays false across the whole flow —
  // so a future engine change that DOES make the literal "per-phrase
  // reinstate then re-remove" path drift (e.g. by clearing the flag on
  // re-remove) will surface as a clear backend signal alongside this
  // test, rather than silently regressing the panel's drift detection.
  test("a re-remove of a previously re-added phrase landing between preview and confirm surfaces the 'stale preview' notice on the panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      // Setup the snapshot=B ("already-active") state: independently
      // re-add the first inner phrase via POST /handwavy-phrases. This
      // does NOT touch the original batch's inner.reinstated flag —
      // unlike the per-phrase reinstate endpoint, which would flip the
      // flag and lock branch A in. The dry-run preview opened next
      // will see this row as already-active.
      await addPhrase(apiCtx, phrases[0]);

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Snapshot baseline: 1 row "already-active" (the re-added phrase),
      // 2 rows "would-reinstate" (the rest), no stale notice yet.
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      const alreadyActiveRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="already-active"]',
      );
      await expect(alreadyActiveRows).toHaveCount(1);
      await expect(alreadyActiveRows.first()).toContainText(phrases[0]);
      await expect(wouldRows).toHaveCount(phrases.length - 1);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-stale"),
      ).toHaveCount(0);

      // Out of band: a teammate re-removes the re-added phrase via
      // DELETE /handwavy-phrases. The active list no longer contains
      // it, but the inner history row's `reinstated` flag stays false
      // (the engine only appends a fresh removal entry). After the
      // 5s in-panel poll picks up the new active list,
      // expectedOutcomeFor falls through branches A + B and returns
      // "would-reinstate" for that row, while the snapshot still says
      // "already-active" — previewDrifted flips to true.
      const reRemoveRes = await apiCtx.delete(
        "/api/feedback/calibration/handwavy-phrases",
        {
          data: { phrase: phrases[0], reviewer: "e2e-task498-drift" },
        },
      );
      expect(
        reRemoveRes.ok(),
        `re-remove DELETE failed: ${reRemoveRes.status()} ${await reRemoveRes.text()}`,
      ).toBeTruthy();

      const stale = panel.getByTestId("handwavy-reinstate-batch-preview-stale");
      await expect(stale).toBeVisible({ timeout: 20_000 });
      await expect(stale).toContainText(/Re-preview to refresh/);

      // Lock in the engine's actual flag-handling: the inner row in
      // the original batch must still have reinstated=false after the
      // re-remove (the engine only appends; it never touches the
      // existing entry). If a future change starts flipping the flag
      // back to false on re-removal that's still consistent with this
      // assertion (false stays false), and the much stronger test
      // would be the still-uncovered snapshot=A → current=C path.
      // What this assertion guards against is the OPPOSITE regression
      // — the engine accidentally flipping the flag to TRUE on
      // re-removal — which would also break this drift detection.
      const historyRes = await apiCtx.get(
        "/api/feedback/calibration/handwavy-phrases",
      );
      expect(historyRes.ok()).toBeTruthy();
      const historyBody = (await historyRes.json()) as {
        history: Array<{
          removedAt: string;
          phrases: Array<{ phrase: string; reinstated?: boolean }>;
        }>;
      };
      const originalEntry = historyBody.history.find(
        (e) => e.removedAt === removedAt,
      );
      expect(
        originalEntry,
        `expected to find original batch history entry for removedAt=${removedAt}`,
      ).toBeTruthy();
      const innerRow = originalEntry!.phrases.find(
        (p) => p.phrase === phrases[0],
      );
      expect(
        innerRow,
        `expected inner phrase row for "${phrases[0]}" inside batch ${removedAt}`,
      ).toBeTruthy();
      expect(
        innerRow!.reinstated ?? false,
        "engine must not flip the inner row's `reinstated` flag on a fresh re-removal",
      ).toBe(false);

      // Confirm stays enabled — the server's reinstate call already
      // de-dupes already-active and would-reinstate rows safely. The
      // original per-phrase outcomes are still rendered exactly as
      // captured at click time.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toBeEnabled();
      await expect(alreadyActiveRows).toHaveCount(1);
      await expect(wouldRows).toHaveCount(phrases.length - 1);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  // Task #354 — when the stale notice surfaces (Task #248), the reviewer
  // can refresh the dry-run snapshot in place by pressing the
  // "Re-preview" button rendered next to the notice copy. That re-runs
  // handlePreviewReinstateBatch(removedAtIso) so the captured results +
  // counts catch up to current state without forcing the reviewer to
  // close the panel and click "Preview reinstate" again (two clicks
  // for what is effectively a refresh, and which would lose their place
  // in the history list). Once the new snapshot matches reality the
  // stale notice disappears.
  test("the stale notice's 'Re-preview' button refreshes the snapshot in place and clears the notice", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3);

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
      const batch = await batchRemove(apiCtx, phrases);
      const removedAt = batch.historyEntry!.removedAt;

      const group = await openHistoryAndFindBatch(page, removedAt);
      await group.getByTestId("handwavy-reinstate-batch-preview").click();
      const panel = group.getByTestId("handwavy-reinstate-batch-preview-panel");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Initial snapshot: every row would-reinstate, no stale notice.
      const wouldRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="would-reinstate"]',
      );
      await expect(wouldRows).toHaveCount(phrases.length);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-stale"),
      ).toHaveCount(0);

      // Out of band: a teammate per-phrase reinstates the first inner
      // phrase. The poll picks it up and the stale notice renders
      // (the same trigger as the Task #248 spec above).
      const reinstateRes = await apiCtx.post(
        "/api/feedback/calibration/handwavy-phrases/reinstate",
        {
          data: {
            phrase: phrases[0],
            removedAt,
            reviewer: "e2e-task354-drift",
          },
        },
      );
      expect(
        reinstateRes.ok(),
        `per-phrase reinstate failed: ${reinstateRes.status()} ${await reinstateRes.text()}`,
      ).toBeTruthy();

      const stale = panel.getByTestId("handwavy-reinstate-batch-preview-stale");
      await expect(stale).toBeVisible({ timeout: 20_000 });

      // The stale notice now exposes a one-click "Re-preview" button
      // alongside the "Re-preview to refresh" copy.
      const repreviewBtn = stale.getByTestId(
        "handwavy-reinstate-batch-preview-stale-repreview",
      );
      await expect(repreviewBtn).toBeVisible();
      await expect(repreviewBtn).toHaveText(/Re-preview/);
      await expect(repreviewBtn).toBeEnabled();

      // Pressing it re-runs the dry-run preview against current state.
      // The previously-reinstated phrase should now be classified as
      // "already-reinstated" (so 2 would-reinstate rows + 1
      // already-reinstated row), and the stale notice should clear
      // because the new snapshot matches reality. Critically, the
      // panel itself stays open — the reviewer's place in the history
      // list isn't lost.
      await repreviewBtn.click();

      const alreadyReinstatedRows = panel.locator(
        '[data-testid="handwavy-reinstate-batch-preview-row"][data-outcome="already-reinstated"]',
      );
      await expect(alreadyReinstatedRows).toHaveCount(1, { timeout: 15_000 });
      await expect(alreadyReinstatedRows.first()).toContainText(phrases[0]);
      await expect(wouldRows).toHaveCount(phrases.length - 1);
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-stale"),
      ).toHaveCount(0);
      await expect(panel).toBeVisible();

      // Confirm count reflects the refreshed snapshot — only the
      // remaining would-reinstate rows.
      await expect(
        panel.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toContainText(`Confirm reinstate (${phrases.length - 1})`);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });
});
