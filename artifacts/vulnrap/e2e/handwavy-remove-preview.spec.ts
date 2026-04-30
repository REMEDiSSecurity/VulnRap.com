import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #173 — End-to-end coverage for the per-row Trash button on the
// curated FLAT hand-wavy phrase list. The Trash button now first issues
// a `DELETE {phrase, dryRun: true}` (Task #155 server path) and:
//
//   * fires the live DELETE in the same click when the preview reports
//     zero valid detections lost (preserves the one-click affordance for
//     safe removals), or
//   * surfaces the same corpus + production removal-impact renderer used
//     by the batch confirm step (`BulkRemovalImpactBlock`) and gates the
//     destructive removal behind an explicit acknowledgment checkbox
//     when valid hand-wavy detections WOULD be un-flagged.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.CALIBRATION_TOKEN || process.env.VITE_CALIBRATION_TOKEN || "";

function uniquePhrase(label = "synthetic"): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  // Including "task173" + a UUID makes it almost impossible for these to
  // accidentally match a fixture or production report — guaranteeing a
  // deterministic "no real detections lost" preview for the happy-path
  // test, which must short-circuit to the live DELETE.
  return `task173 preview ${id} ${label}`;
}

function authHeaders(): Record<string, string> {
  return CALIBRATION_TOKEN ? { "X-Calibration-Token": CALIBRATION_TOKEN } : {};
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: authHeaders(),
    data: { phrase, category: "hedging", reviewer: "e2e-task173" },
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
      data: { phrases, reviewer: "e2e-task173-cleanup" },
    })
    .catch(() => undefined);
}

// Mirror what main.tsx does so authenticated GETs (active phrase list)
// render in tests when the dev server wasn't started with the token.
async function injectCalibrationTokenIntoPage(page: Page): Promise<void> {
  if (!CALIBRATION_TOKEN) return;
  await page.addInitScript((token) => {
    (window as unknown as { __VULNRAP_CALIBRATION_TOKEN__?: string })
      .__VULNRAP_CALIBRATION_TOKEN__ = token;
  }, CALIBRATION_TOKEN);
}

test.describe("Single-phrase removal-impact preview (Task #173)", () => {
  test("phrase with zero impact still removes in one click without showing the preview panel", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("zero-impact");

    try {
      await addPhrase(apiCtx, phrase);

      // Track DELETE traffic so we can assert exactly one dryRun preview
      // was issued AND exactly one live DELETE landed.
      const deleteCalls: { dryRun: boolean }[] = [];
      page.on("request", (req) => {
        if (
          req.method() === "DELETE" &&
          req.url().includes("/api/feedback/calibration/handwavy-phrases")
        ) {
          const body = req.postDataJSON() as
            | { dryRun?: boolean }
            | undefined;
          deleteCalls.push({ dryRun: !!body?.dryRun });
        }
      });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByTestId("handwavy-remove-preview")).toHaveCount(0);

      // Watch for any appearance of the preview panel between the click
      // and the row vanishing — even a brief flash would defeat the
      // "zero-impact removals stay one-click" requirement.
      let previewEverAppeared = false;
      const observer = page
        .getByTestId("handwavy-remove-preview")
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => {
          previewEverAppeared = true;
        })
        .catch(() => undefined);

      await row.getByTestId("handwavy-remove").click();

      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
      await observer;

      expect(
        previewEverAppeared,
        "zero-impact removal must not show the impact-preview panel",
      ).toBe(false);
      await expect(page.getByTestId("handwavy-remove-preview")).toHaveCount(0);

      const dryRunCount = deleteCalls.filter((c) => c.dryRun).length;
      const liveCount = deleteCalls.filter((c) => !c.dryRun).length;
      expect(
        dryRunCount,
        `Expected at least one dryRun=true DELETE preview, saw ${dryRunCount}`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        liveCount,
        `Expected exactly one live DELETE for the zero-impact one-click path, saw ${liveCount}`,
      ).toBe(1);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("phrase whose dryRun reports valid detections lost surfaces the impact panel and gates the live DELETE behind the acknowledgment checkbox", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("ack");

    try {
      await addPhrase(apiCtx, phrase);

      // Intercept the dryRun=true DELETE for the exact phrase under test
      // and inject a synthetic "valid detections lost" response. This
      // exercises the UI gating without needing curated fixture data
      // that overlaps a randomly-generated synthetic phrase.
      let dryRunCalls = 0;
      let liveDeleteCalls = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun && body.phrase === phrase) {
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
                phrase,
                raw: phrase,
                removed: true,
                reason: null,
                total: 99,
                projectedTotal: 98,
                results: [{ raw: phrase, phrase, removed: true }],
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
          // Live DELETE for the same phrase — let it pass through to the
          // server so the row actually disappears, and count it for
          // acknowledgment-gate verification.
          if (
            !body?.dryRun &&
            (body?.phrase === phrase || body?.phrases?.includes(phrase))
          ) {
            liveDeleteCalls += 1;
          }
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      // Preview panel appears with the synthetic warning.
      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText(`Remove "${phrase}"?`);
      await expect(
        panel.getByTestId("handwavy-remove-preview-summary"),
      ).toContainText("2 valid hand-wavy detections");

      // Same renderer as the batch flow — curated impact block must be
      // present and surface the warning verbatim.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated"),
      ).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated-warning"),
      ).toContainText("2 legitimate detections would be lost");

      // Production-scan-unavailable fallback inside the preview panel.
      await expect(
        panel.getByTestId("handwavy-remove-preview-production-error"),
      ).toContainText("Production scan unavailable");

      // Acknowledgment checkbox is present, unchecked, and the destructive
      // confirm is disabled until the reviewer ticks it.
      const ack = panel.getByTestId("handwavy-remove-preview-ack");
      await expect(ack).toBeVisible();
      await expect(ack).not.toBeChecked();
      const confirmBtn = panel.getByTestId("handwavy-remove-preview-confirm");
      await expect(confirmBtn).toBeDisabled();
      expect(
        liveDeleteCalls,
        "no live DELETE should fire while the ack is unchecked",
      ).toBe(0);

      // Tick the ack — the destructive confirm becomes enabled.
      await ack.check();
      await expect(ack).toBeChecked();
      await expect(confirmBtn).toBeEnabled();

      // Confirm fires the live DELETE; the panel closes and the row
      // disappears from the active list.
      await confirmBtn.click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });

      expect(
        dryRunCalls,
        `Expected exactly one dryRun=true DELETE preview, saw ${dryRunCalls}`,
      ).toBe(1);
      expect(
        liveDeleteCalls,
        `Expected exactly one live DELETE after the ack confirm, saw ${liveDeleteCalls}`,
      ).toBe(1);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  // Task #245 — when the dry-run reports a non-zero `validDetectionsLost`
  // the per-row Trash preview panel must render the curated and production
  // `sampleMatches` arrays inline (not buried inside a closed <details>),
  // grouped by tier, with the production report IDs linkified to the
  // /verify/:id viewer route opened in a new tab so the reviewer can
  // confirm what would actually be un-flagged without leaving the page.
  test("inline sample-match list renders curated + production IDs grouped by tier with production links to the report viewer", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("inline-matches");

    try {
      await addPhrase(apiCtx, phrase);

      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun && body.phrase === phrase) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                dryRun: true,
                batch: false,
                wouldRemove: 1,
                notFound: 0,
                duplicateInBatch: 0,
                phrase,
                raw: phrase,
                removed: true,
                reason: null,
                total: 99,
                projectedTotal: 98,
                results: [{ raw: phrase, phrase, removed: true }],
                dryRunImpact: {
                  corpus: {
                    total: 4,
                    validDetectionsLost: 2,
                    falsePositivesDropped: 2,
                    byTier: {
                      t1Legit: 1,
                      t2Borderline: 1,
                      t3Slop: 1,
                      t4Hallucinated: 1,
                    },
                    sampleMatches: [
                      { id: "fixture-T1-alpha", tier: "T1_LEGIT" },
                      { id: "fixture-T2-beta", tier: "T2_BORDERLINE" },
                      { id: "fixture-T3-gamma", tier: "T3_SLOP" },
                      { id: "fixture-T4-delta", tier: "T4_HALLUCINATED" },
                    ],
                    warning:
                      "2 legitimate detections would be lost from the curated benchmark",
                    corpusSize: 47,
                    oldestCreatedAt: null,
                    newestCreatedAt: null,
                  },
                  production: {
                    total: 3,
                    validDetectionsLost: 2,
                    falsePositivesDropped: 1,
                    byTier: {
                      t1Legit: 1,
                      t2Borderline: 0,
                      t3Slop: 1,
                      t4Hallucinated: 1,
                    },
                    sampleMatches: [
                      { id: "9001", tier: "T1_LEGIT" },
                      { id: "9002", tier: "T3_SLOP" },
                      { id: "9003", tier: "T4_HALLUCINATED" },
                    ],
                    warning:
                      "2 legitimate detections would be lost from the production archive",
                    corpusSize: 200,
                    oldestCreatedAt: "2026-04-01T00:00:00.000Z",
                    newestCreatedAt: "2026-04-29T00:00:00.000Z",
                  },
                  productionError: null,
                  productionLimit: 200,
                },
                phrases: [],
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Inline match section is in the DOM and not hidden behind a
      // <details>/<summary> the reviewer would have to expand first.
      const matches = panel.getByTestId("handwavy-remove-preview-matches");
      await expect(matches).toBeVisible();

      // Curated block renders all four tier groups with their fixture IDs
      // visible inline.
      const curatedBlock = matches.getByTestId(
        "handwavy-remove-preview-matches-curated",
      );
      await expect(curatedBlock).toBeVisible();
      await expect(curatedBlock).toContainText("Curated fixtures");
      await expect(
        curatedBlock.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T1_LEGIT",
        ),
      ).toContainText("fixture-T1-alpha");
      await expect(
        curatedBlock.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T2_BORDERLINE",
        ),
      ).toContainText("fixture-T2-beta");
      await expect(
        curatedBlock.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T3_SLOP",
        ),
      ).toContainText("fixture-T3-gamma");
      await expect(
        curatedBlock.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T4_HALLUCINATED",
        ),
      ).toContainText("fixture-T4-delta");

      // Production block renders its own tier groups with each report ID
      // surfaced as a link to /verify/:id that opens in a new tab.
      const productionBlock = matches.getByTestId(
        "handwavy-remove-preview-matches-production",
      );
      await expect(productionBlock).toBeVisible();
      await expect(productionBlock).toContainText("Production reports");

      const t1Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9001",
      );
      const t3Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9002",
      );
      const t4Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9003",
      );
      await expect(t1Link).toBeVisible();
      await expect(t3Link).toBeVisible();
      await expect(t4Link).toBeVisible();
      await expect(t1Link).toHaveText(/report\s*#9001/);
      await expect(t3Link).toHaveText(/report\s*#9002/);
      await expect(t4Link).toHaveText(/report\s*#9003/);
      // Each link must open in a new tab so the reviewer doesn't lose the
      // open Trash preview panel mid-decision.
      await expect(t1Link).toHaveAttribute("target", "_blank");
      await expect(t3Link).toHaveAttribute("target", "_blank");
      await expect(t4Link).toHaveAttribute("target", "_blank");
      // Hrefs point at the report viewer route. The vulnrap artifact is
      // typically served from a sub-path, so the href ends with the
      // /verify/:id suffix rather than starting with it.
      await expect(t1Link).toHaveAttribute("href", /\/verify\/9001$/);
      await expect(t3Link).toHaveAttribute("href", /\/verify\/9002$/);
      await expect(t4Link).toHaveAttribute("href", /\/verify\/9003$/);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  // Task #245 — the inline match block must stay out of the DOM entirely
  // when the dry-run returned no `sampleMatches`, so a zero-impact
  // preview keeps its lean visual footprint and reviewers don't see an
  // empty "would lose their flag" header.
  test("inline sample-match list is not rendered when the dry-run returns no sampleMatches", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("no-matches");

    try {
      await addPhrase(apiCtx, phrase);

      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun && body.phrase === phrase) {
            // Inject a synthetic dry-run that warns about valid detections
            // lost (so the preview panel is forced to render) but leaves
            // both `sampleMatches` arrays empty — the corner case where
            // the inline match block must hide itself.
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                dryRun: true,
                batch: false,
                wouldRemove: 1,
                notFound: 0,
                duplicateInBatch: 0,
                phrase,
                raw: phrase,
                removed: true,
                reason: null,
                total: 99,
                projectedTotal: 98,
                results: [{ raw: phrase, phrase, removed: true }],
                dryRunImpact: {
                  corpus: {
                    total: 1,
                    validDetectionsLost: 1,
                    falsePositivesDropped: 0,
                    byTier: {
                      t1Legit: 0,
                      t2Borderline: 0,
                      t3Slop: 1,
                      t4Hallucinated: 0,
                    },
                    sampleMatches: [],
                    warning:
                      "1 legitimate detection would be lost from the curated benchmark",
                    corpusSize: 47,
                    oldestCreatedAt: null,
                    newestCreatedAt: null,
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
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(
        panel.getByTestId("handwavy-remove-preview-matches"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the impact preview panel cancels without firing the live DELETE", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("backout");

    try {
      await addPhrase(apiCtx, phrase);

      let liveDeleteCalls = 0;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string; phrases?: string[] }
            | undefined;
          if (body?.dryRun && body.phrase === phrase) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                dryRun: true,
                batch: false,
                wouldRemove: 1,
                notFound: 0,
                duplicateInBatch: 0,
                phrase,
                raw: phrase,
                removed: true,
                reason: null,
                total: 99,
                projectedTotal: 98,
                results: [{ raw: phrase, phrase, removed: true }],
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
          if (
            !body?.dryRun &&
            (body?.phrase === phrase || body?.phrases?.includes(phrase))
          ) {
            liveDeleteCalls += 1;
          }
          await route.fallback();
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel.getByTestId("handwavy-remove-preview-cancel").click();

      await expect(panel).toHaveCount(0);
      // Row remains on the active list — no live DELETE fired.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);
      expect(
        liveDeleteCalls,
        "Back out must not fire a live DELETE",
      ).toBe(0);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });
});
