import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  newApiContext,
  removeSingle,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #214 — End-to-end coverage for the "calibration mutations blocked"
// gate. When the un-gated `/feedback/calibration/auth-status` probe reports
// that the server requires a reviewer token AND the UI is sending the
// wrong one (or no token at all), `useCalibrationAuthState()` flips
// `mutationsAllowed` to false. Every mutating control on both the
// Scoring Calibration card and the FLAT hand-wavy phrase admin panel
// should then render disabled, with the shared MUTATIONS_BLOCKED_TITLE
// tooltip pointing reviewers back at the warning banner above the card.
//
// We intercept the auth-status probe via `page.route` and return a
// `tokenPresented: true, tokenValid: false` payload so the page sees the
// "invalid" branch even though the Playwright bundle's real token would
// be accepted by the api-server. This keeps the spec hermetic — no need
// to flip the api-server's CALIBRATION_TOKEN at runtime — and it
// exercises the same render path a real misconfigured deploy would hit.

test.describe("FLAT hand-wavy phrase panel + calibration card — mutations blocked when token invalid (Task #214)", () => {
  test("disables all mutating controls and exposes the shared blocked-title tooltip when auth-status reports invalid token", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task214 blocked");

    try {
      // Seed one active phrase via the API (with the real token) so the
      // panel has at least one row whose per-row Edit/Remove/Revert
      // buttons we can assert against. Without a row the per-row
      // controls don't render.
      await addPhrase(apiCtx, phrase, { reviewer: "e2e-task214-seed" });

      // Force the auth-status probe to report "invalid token" for every
      // call (initial load + the 60s refetch). This must be installed
      // before navigation so the React Query first-fetch sees the mock.
      await page.route(
        "**/api/feedback/calibration/auth-status",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              serverRequiresToken: true,
              tokenPresented: true,
              tokenValid: false,
            }),
          });
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row, "seeded phrase should appear in the active list").toHaveCount(
        1,
        { timeout: 15_000 },
      );

      // Per-row controls (Edit / Remove) on the seeded phrase should be
      // disabled with the shared blocked-title tooltip + the
      // data-mutations-blocked="true" stamp the renderer adds.
      const editBtn = row.getByTestId("handwavy-edit");
      const removeBtn = row.getByTestId("handwavy-remove");
      await expect(editBtn).toBeDisabled();
      await expect(editBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(editBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );
      await expect(removeBtn).toBeDisabled();
      await expect(removeBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(removeBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );

      // The "add a new phrase" button at the top of the panel must also
      // disable — even with a typed-in input value the click would 401.
      // We don't need to type anything; the button reads the
      // mutationsAllowed flag directly.
      const addBtn = page.getByTestId("handwavy-add");
      await expect(addBtn).toBeDisabled();
      await expect(addBtn).toHaveAttribute("data-mutations-blocked", "true");
      await expect(addBtn).toHaveAttribute(
        "title",
        /reviewer token is missing or invalid/i,
      );

      // The Scoring Calibration card may render zero or more
      // SuggestionCard rows depending on the seeded data. If any are
      // present, every Apply button must be disabled with the same
      // tooltip. If none render we don't fail — the panel-level
      // assertions above already prove the wiring is in place.
      const applyButtons = page.getByTestId("calibration-suggestion-apply");
      const applyCount = await applyButtons.count();
      for (let i = 0; i < applyCount; i++) {
        const btn = applyButtons.nth(i);
        await expect(btn).toBeDisabled();
        await expect(btn).toHaveAttribute("data-mutations-blocked", "true");
        await expect(btn).toHaveAttribute(
          "title",
          /reviewer token is missing or invalid/i,
        );
      }

      // Cancel/dismiss-style controls must stay enabled — the gate is
      // only on mutating actions. The panel always renders the
      // category dropdown + free-text input even when add is blocked,
      // so reviewers can still draft a phrase to apply later once the
      // token is fixed.
      const input = page.getByTestId("handwavy-input");
      await expect(input).toBeEnabled();
      const categorySelect = page.getByTestId("handwavy-category");
      await expect(categorySelect).toBeEnabled();
    } finally {
      await cleanup(apiCtx, phrase, { reviewer: "e2e-task214-cleanup" });
      await apiCtx.dispose();
    }
  });

  // Task #337 — extends the Task #241 "visible Revert hint" pattern to
  // every other disabled mutation control in the panel. Hover-only
  // titles aren't reachable on touch devices and assistive-tech users
  // who land on a disabled button only hear the title if their stack
  // happens to read it. The follow-on requirement is that each disabled
  // control renders a visible inline caption describing why it's
  // disabled, and that the button's `aria-describedby` points at that
  // caption so screen readers reach the same wording.
  //
  // We re-use the same auth-status mock from the Task #214 case above
  // (the cleanest way to flip every mutating control into the
  // !mutationsAllowed branch in one go) and seed enough state to make
  // every relevant disabled button render: an active phrase (per-row
  // Edit / Trash + bulk Remove selected), a removed phrase with a
  // captured removedAt (per-row Reinstate in the history panel + the
  // batch reinstate cluster), and the bulk-remove preview's "Remove
  // selected" toolbar button (which only renders the
  // "select at least one phrase first" extraReason branch when nothing
  // is ticked).
  test("renders visible disabled-reason captions and aria-describedby links for every disabled mutating control (Task #337)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const activePhrase = uniquePhrase("task337 active");
    const removedPhrase = uniquePhrase("task337 removed");

    try {
      // Active phrase — drives per-row Edit/Trash hints in the body of
      // the panel.
      await addPhrase(apiCtx, activePhrase, {
        reviewer: "e2e-task337-active",
      });
      // Add + remove a second phrase so the history panel has at least
      // one row whose per-row Reinstate button is on screen and
      // disabled. The batch-removal panel keys off the same audit row
      // so its own disabled Reinstate buttons render too.
      await addPhrase(apiCtx, removedPhrase, {
        reviewer: "e2e-task337-removed",
      });
      const removedAt = await removeSingle(apiCtx, removedPhrase, {
        reviewer: "e2e-task337-removed",
      });
      expect(
        removedAt,
        "seed removal should report a removedAt for the history row",
      ).toBeTruthy();

      await page.route(
        "**/api/feedback/calibration/auth-status",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              serverRequiresToken: true,
              tokenPresented: true,
              tokenValid: false,
            }),
          });
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // 1) Per-row Edit/Trash hint — single shared caption beneath the
      // active phrase's button row, with both buttons aria-describedby
      // pointing at it.
      const activeRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: activePhrase });
      await expect(activeRow).toHaveCount(1, { timeout: 15_000 });
      const rowHint = activeRow.getByTestId("handwavy-row-disabled-hint");
      await expect(rowHint).toBeVisible();
      await expect(rowHint).toContainText(/reviewer token is missing or invalid/i);
      const rowHintId = await rowHint.getAttribute("id");
      expect(rowHintId, "row hint must carry an id for aria-describedby").toBeTruthy();
      await expect(activeRow.getByTestId("handwavy-edit")).toHaveAttribute(
        "aria-describedby",
        rowHintId!,
      );
      await expect(activeRow.getByTestId("handwavy-remove")).toHaveAttribute(
        "aria-describedby",
        rowHintId!,
      );

      // 2a) Top-of-panel "Preview impact" add button — always rendered.
      // The blocked token reason should win over the "type at least 3
      // chars" extraReason branch.
      const addHint = page.getByTestId("handwavy-add-disabled-hint");
      await expect(addHint).toBeVisible();
      await expect(addHint).toContainText(
        /reviewer token is missing or invalid/i,
      );
      const addHintId = await addHint.getAttribute("id");
      expect(addHintId).toBeTruthy();
      await expect(page.getByTestId("handwavy-add")).toHaveAttribute(
        "aria-describedby",
        addHintId!,
      );

      // 2) Bulk toolbar — "Remove selected" is always rendered, the
      // hint sibling row beneath it should describe the reviewer-token
      // gate (which beats the "select at least one phrase" extra
      // reason in describeHandwavyDisabledReason's order).
      const bulkRemoveHint = page.getByTestId(
        "handwavy-bulk-remove-disabled-hint",
      );
      await expect(bulkRemoveHint).toBeVisible();
      await expect(bulkRemoveHint).toContainText(
        /reviewer token is missing or invalid/i,
      );
      const bulkRemoveHintId = await bulkRemoveHint.getAttribute("id");
      expect(bulkRemoveHintId).toBeTruthy();
      await expect(page.getByTestId("handwavy-bulk-remove")).toHaveAttribute(
        "aria-describedby",
        bulkRemoveHintId!,
      );

      // 3) Per-row Reinstate in the history panel — only renders for
      // the seeded removed phrase. We scroll the history into view via
      // the existing data-testid hook on the row.
      const historyRow = page
        .locator('[data-testid="handwavy-history-row"]')
        .filter({ hasText: removedPhrase })
        .first();
      await expect(historyRow).toHaveCount(1, { timeout: 15_000 });
      await historyRow.scrollIntoViewIfNeeded();
      const reinstateHint = historyRow.getByTestId(
        "handwavy-reinstate-disabled-hint",
      );
      await expect(reinstateHint).toBeVisible();
      await expect(reinstateHint).toContainText(
        /reviewer token is missing or invalid/i,
      );
      const reinstateHintId = await reinstateHint.getAttribute("id");
      expect(reinstateHintId).toBeTruthy();
      await expect(historyRow.getByTestId("handwavy-reinstate")).toHaveAttribute(
        "aria-describedby",
        reinstateHintId!,
      );

      // 4) Batch reinstate cluster (Preview reinstate / Reinstate all)
      // — the seed-removed phrase becomes its own single-row batch
      // group in the history panel. Both buttons share one hintId.
      const batchHint = page
        .getByTestId("handwavy-batch-reinstate-disabled-hint")
        .first();
      await expect(batchHint).toBeVisible();
      await expect(batchHint).toContainText(
        /reviewer token is missing or invalid/i,
      );
      const batchHintId = await batchHint.getAttribute("id");
      expect(batchHintId).toBeTruthy();
      const batchPreview = page
        .getByTestId("handwavy-reinstate-batch-preview")
        .first();
      await expect(batchPreview).toHaveAttribute(
        "aria-describedby",
        batchHintId!,
      );
      const batchReinstateAll = page
        .getByTestId("handwavy-reinstate-batch")
        .first();
      await expect(batchReinstateAll).toHaveAttribute(
        "aria-describedby",
        batchHintId!,
      );

      // 5) Removal-batches picker — its "Reinstate this batch" entry
      // also carries the visible caption + aria-describedby pair.
      const pickerReinstate = page
        .getByTestId("handwavy-removal-batches-reinstate")
        .first();
      const pickerCount = await pickerReinstate.count();
      if (pickerCount > 0) {
        await pickerReinstate.scrollIntoViewIfNeeded();
        const pickerHint = page
          .getByTestId("handwavy-picker-reinstate-disabled-hint")
          .first();
        await expect(pickerHint).toBeVisible();
        await expect(pickerHint).toContainText(
          /reviewer token is missing or invalid/i,
        );
        const pickerHintId = await pickerHint.getAttribute("id");
        expect(pickerHintId).toBeTruthy();
        await expect(pickerReinstate).toHaveAttribute(
          "aria-describedby",
          pickerHintId!,
        );
      }
    } finally {
      await cleanup(apiCtx, [activePhrase, removedPhrase], {
        reviewer: "e2e-task337-cleanup",
      });
      await apiCtx.dispose();
    }
  });
});
