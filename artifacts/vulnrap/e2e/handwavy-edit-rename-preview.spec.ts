import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #247 — End-to-end coverage for the per-row Edit-then-rename flow
// in the curated FLAT hand-wavy phrase list. The Edit row used to only
// expose category + rationale inputs; this task added a phrase-text
// input that, when changed to a different normalized form, treats the
// save as "remove the original phrase + create the new one". Removing
// the original can un-flag legitimate detections in exactly the same
// way as a direct Trash, so the Edit save now first issues the same
// Task #155 single-phrase `DELETE {phrase, dryRun: true}` preview the
// Trash button uses and:
//
//   * fires the live PATCH (rename) in the same click when the preview
//     reports zero valid detections lost (preserves the one-click
//     affordance for safe renames), or
//   * surfaces the same `BulkRemovalImpactBlock` impact summary the
//     Trash flow shows and gates the live PATCH behind an explicit
//     acknowledgment checkbox when valid hand-wavy detections WOULD be
//     un-flagged.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.CALIBRATION_TOKEN || process.env.VITE_CALIBRATION_TOKEN || "";

function uniquePhrase(label = "synthetic"): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  // "task247" + a UUID makes accidental fixture / production overlap
  // effectively impossible, which guarantees a deterministic
  // "no real detections lost" preview for the happy-path test.
  return `task247 rename ${id} ${label}`;
}

function authHeaders(): Record<string, string> {
  return CALIBRATION_TOKEN ? { "X-Calibration-Token": CALIBRATION_TOKEN } : {};
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: authHeaders(),
    data: { phrase, category: "hedging", reviewer: "e2e-task247" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      headers: authHeaders(),
      data: { phrases, reviewer: "e2e-task247-cleanup" },
    })
    .catch(() => undefined);
}

async function injectCalibrationTokenIntoPage(page: Page): Promise<void> {
  if (!CALIBRATION_TOKEN) return;
  await page.addInitScript((token) => {
    (window as unknown as { __VULNRAP_CALIBRATION_TOKEN__?: string })
      .__VULNRAP_CALIBRATION_TOKEN__ = token;
  }, CALIBRATION_TOKEN);
}

test.describe("Per-row Edit-then-rename impact preview (Task #247)", () => {
  test("rename with zero impact applies in one click without showing the preview panel", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const original = uniquePhrase("zero-impact-from");
    const renamed = uniquePhrase("zero-impact-to");

    try {
      await addPhrase(apiCtx, original);

      // Track DELETE dry-run previews and live PATCH calls so we can
      // assert exactly one of each landed for the zero-impact path.
      const deleteDryRuns: { phrase?: string }[] = [];
      const patchCalls: {
        phrase?: string;
        newPhrase?: string;
      }[] = [];
      page.on("request", (req) => {
        if (!req.url().includes("/api/feedback/calibration/handwavy-phrases")) {
          return;
        }
        const body = req.postDataJSON() as
          | { dryRun?: boolean; phrase?: string; newPhrase?: string }
          | undefined;
        if (req.method() === "DELETE" && body?.dryRun) {
          deleteDryRuns.push({ phrase: body.phrase });
        } else if (req.method() === "PATCH") {
          patchCalls.push({
            phrase: body?.phrase,
            newPhrase: body?.newPhrase,
          });
        }
      });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: original });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open Edit, rewrite the phrase, save.
      await row.getByTestId("handwavy-edit").click();
      const phraseInput = row.getByTestId("handwavy-edit-phrase");
      await expect(phraseInput).toBeVisible();
      await expect(phraseInput).toHaveValue(original);
      await phraseInput.fill(renamed);

      // Watch for any preview panel flash between click and rename.
      let previewEverAppeared = false;
      const observer = page
        .getByTestId("handwavy-edit-preview")
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => {
          previewEverAppeared = true;
        })
        .catch(() => undefined);

      await row.getByTestId("handwavy-edit-save").click();

      // Original row vanishes; the renamed row shows up.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: original }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: renamed }),
      ).toHaveCount(1, { timeout: 15_000 });
      await observer;

      expect(
        previewEverAppeared,
        "zero-impact rename must not show the impact-preview panel",
      ).toBe(false);
      await expect(page.getByTestId("handwavy-edit-preview")).toHaveCount(0);

      const ownDryRuns = deleteDryRuns.filter((c) => c.phrase === original);
      const ownPatch = patchCalls.filter(
        (c) => c.phrase === original && c.newPhrase != null,
      );
      expect(
        ownDryRuns.length,
        `Expected at least one dryRun=true DELETE preview for the rename, saw ${ownDryRuns.length}`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        ownPatch.length,
        `Expected exactly one PATCH with newPhrase for the zero-impact one-click path, saw ${ownPatch.length}`,
      ).toBe(1);
    } finally {
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  test("rename whose dryRun reports valid detections lost surfaces the impact panel and gates the live PATCH behind the acknowledgment checkbox", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const original = uniquePhrase("ack-from");
    const renamed = uniquePhrase("ack-to");

    try {
      await addPhrase(apiCtx, original);

      // Intercept the dryRun=true DELETE for the original phrase and
      // inject a synthetic "valid detections lost" response. Mirrors
      // the Task #173 Trash-flow test exactly so reviewers see the
      // identical impact summary + ack gate from the Edit-then-rename
      // entry point.
      let dryRunCalls = 0;
      let patchCalls = 0;
      let patchHadNewPhrase = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() === "DELETE") {
            const body = req.postDataJSON() as
              | { dryRun?: boolean; phrase?: string; phrases?: string[] }
              | undefined;
            if (body?.dryRun && body.phrase === original) {
              dryRunCalls += 1;
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  dryRun: true,
                  batch: false,
                  wouldRemove: 1,
                  notFound: 0,
                  duplicateInBatch: 0,
                  phrase: original,
                  raw: original,
                  removed: true,
                  reason: null,
                  total: 99,
                  projectedTotal: 98,
                  results: [{ raw: original, phrase: original, removed: true }],
                  dryRunImpact: {
                    corpus: {
                      total: 4,
                      validDetectionsLost: 2,
                      falsePositivesDropped: 2,
                      byTier: {
                        t1Legit: 2,
                        t2Borderline: 0,
                        t3Slop: 1,
                        t4Hallucinated: 1,
                      },
                      sampleMatches: [
                        { id: "fixture-001", tier: "t1Legit" },
                        { id: "fixture-002", tier: "t3Slop" },
                      ],
                      warning:
                        "2 legitimate detections would be lost from the curated benchmark",
                      corpusSize: 47,
                    },
                    production: null,
                    productionError:
                      "Production scan unavailable in this synthetic fixture",
                    productionLimit: 200,
                  },
                  phrases: [],
                }),
              });
              return;
            }
          }
          if (req.method() === "PATCH") {
            const body = req.postDataJSON() as
              | { phrase?: string; newPhrase?: string }
              | undefined;
            if (body?.phrase === original) {
              patchCalls += 1;
              if (typeof body?.newPhrase === "string") {
                patchHadNewPhrase = true;
              }
            }
          }
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: original });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open Edit, rename, save — the preview panel should appear
      // because the synthetic dry-run response reports 2 valid
      // detections lost.
      await row.getByTestId("handwavy-edit").click();
      await row.getByTestId("handwavy-edit-phrase").fill(renamed);
      await row.getByTestId("handwavy-edit-save").click();

      const panel = page.getByTestId("handwavy-edit-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText(`Rename "${original}" → "${renamed}"`);
      await expect(
        panel.getByTestId("handwavy-edit-preview-summary"),
      ).toContainText("2 valid hand-wavy detections");

      // Same renderer as the Trash flow — curated impact block must
      // be present and surface the warning verbatim.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated"),
      ).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated-warning"),
      ).toContainText("2 legitimate detections would be lost");

      // Production-scan-unavailable fallback inside the preview panel.
      await expect(
        panel.getByTestId("handwavy-edit-preview-production-error"),
      ).toContainText("Production scan unavailable");

      // Acknowledgment checkbox is present, unchecked, and the
      // destructive confirm is disabled until the reviewer ticks it.
      const ack = panel.getByTestId("handwavy-edit-preview-ack");
      await expect(ack).toBeVisible();
      await expect(ack).not.toBeChecked();
      const confirmBtn = panel.getByTestId("handwavy-edit-preview-confirm");
      await expect(confirmBtn).toBeDisabled();
      expect(
        patchCalls,
        "no live PATCH should fire while the ack is unchecked",
      ).toBe(0);

      // Tick the ack — the destructive confirm becomes enabled.
      await ack.check();
      await expect(ack).toBeChecked();
      await expect(confirmBtn).toBeEnabled();

      // Confirm fires the live PATCH; the panel closes and the row
      // disappears from the active list (replaced by the renamed row
      // once the refresh lands).
      await confirmBtn.click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: original }),
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: renamed }),
      ).toHaveCount(1, { timeout: 15_000 });

      expect(
        dryRunCalls,
        `Expected exactly one dryRun=true DELETE preview, saw ${dryRunCalls}`,
      ).toBe(1);
      expect(
        patchCalls,
        `Expected exactly one PATCH after the ack confirm, saw ${patchCalls}`,
      ).toBe(1);
      expect(
        patchHadNewPhrase,
        "Expected the live PATCH body to carry newPhrase to perform the rename",
      ).toBe(true);
    } finally {
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the rename impact preview cancels without firing the live PATCH", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const original = uniquePhrase("backout-from");
    const renamed = uniquePhrase("backout-to");

    try {
      await addPhrase(apiCtx, original);

      let patchCalls = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() === "DELETE") {
            const body = req.postDataJSON() as
              | { dryRun?: boolean; phrase?: string }
              | undefined;
            if (body?.dryRun && body.phrase === original) {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  dryRun: true,
                  batch: false,
                  wouldRemove: 1,
                  notFound: 0,
                  duplicateInBatch: 0,
                  phrase: original,
                  raw: original,
                  removed: true,
                  reason: null,
                  total: 99,
                  projectedTotal: 98,
                  results: [{ raw: original, phrase: original, removed: true }],
                  dryRunImpact: {
                    corpus: {
                      total: 1,
                      validDetectionsLost: 1,
                      falsePositivesDropped: 0,
                      byTier: {
                        t1Legit: 1,
                        t2Borderline: 0,
                        t3Slop: 0,
                        t4Hallucinated: 0,
                      },
                      sampleMatches: [{ id: "fixture-001", tier: "t1Legit" }],
                      warning:
                        "1 legitimate detection would be lost from the curated benchmark",
                      corpusSize: 47,
                    },
                    production: null,
                    productionError: null,
                    productionLimit: 200,
                  },
                  phrases: [],
                }),
              });
              return;
            }
          }
          if (req.method() === "PATCH") {
            const body = req.postDataJSON() as
              | { phrase?: string }
              | undefined;
            if (body?.phrase === original) {
              patchCalls += 1;
            }
          }
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: original });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-edit").click();
      await row.getByTestId("handwavy-edit-phrase").fill(renamed);
      await row.getByTestId("handwavy-edit-save").click();

      const panel = page.getByTestId("handwavy-edit-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-edit-preview-cancel").click();

      await expect(panel).toHaveCount(0);
      // Original row remains on the active list — no PATCH fired.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: original }),
      ).toHaveCount(1);
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: renamed }),
      ).toHaveCount(0);
      expect(
        patchCalls,
        "Back out must not fire a live PATCH",
      ).toBe(0);
    } finally {
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });
});
