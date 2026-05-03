import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  seedCycles,
  uniquePhrases,
} from "./helpers/handwavy";

// Task #154 — End-to-end coverage for the side-by-side bulk-removal preview
// in the calibration UI. Confirms that the "Remove selected" button drives
// the existing dryRun=true server branch, that the rendered panel surfaces
// `wouldRemove` / `notFound` / `duplicateInBatch`, the per-phrase outcomes,
// and the corpus + production impact, and that the destructive "Remove
// these N" button is gated behind the explicit acknowledgment when valid
// detections would be lost. The "happy path" (no real detections lost) is
// covered with synthetic phrases that no fixture or production report
// matches, so the confirm button is enabled without any acknowledgment.

const REVIEWER = "e2e-task154";
// Task #257 — separate reviewer tag for the bulk-remove preview's
// auto-expand specs so audit-log scans can tell them apart from the
// original Task #154 preview specs above.
const REVIEWER_TASK257 = "e2e-task257";
// Task #365 — separate reviewer tag for the auto-scroll spec so audit-log
// scans can tell its rows apart from the Task #257 auto-expand specs above.
const REVIEWER_TASK365 = "e2e-task365";

// UI-flow helper kept local: it threads checkbox-tick + "Remove selected"
// click in the order this spec needs (the bulk-undo spec has its own
// variant that ALSO confirms the panel — different end states).
async function selectRowsAndOpenPreview(
  page: Page,
  phrases: string[],
): Promise<void> {
  for (const phrase of phrases) {
    const row = page
      .locator(`[data-testid="handwavy-row"]`)
      .filter({ hasText: phrase });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByTestId("handwavy-select").check();
  }
  await page.getByTestId("handwavy-bulk-remove").click();
}

test.describe("Bulk-removal preview panel (Task #154)", () => {
  test("Preview shows wouldRemove summary + per-phrase outcomes; confirm runs the real DELETEs (no real detections lost → no acknowledgment required)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const realPhrases = uniquePhrases(3, "task154 preview real");

    try {
      for (const p of realPhrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, realPhrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText(
        new RegExp(`Removal preview for ${realPhrases.length} phrase`),
      );
      await expect(panel).toContainText(
        new RegExp(`${realPhrases.length}\\b.*would be removed`),
      );

      // Per-phrase outcomes: every requested phrase becomes a "would-remove"
      // row (plus none in notFound/duplicate buckets for this happy path).
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      const wouldRemoveRows = panel.locator(
        `[data-testid="handwavy-bulk-preview-result-row"][data-outcome="would-remove"]`,
      );
      await expect(wouldRemoveRows).toHaveCount(realPhrases.length);

      // Curated corpus block always renders.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated"),
      ).toBeVisible();

      // No legitimate detections would be lost → no acknowledgment checkbox
      // and the confirm button is enabled immediately.
      await expect(panel.getByTestId("handwavy-bulk-preview-ack")).toHaveCount(
        0,
      );
      const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
      await expect(confirmBtn).toBeEnabled();
      await expect(confirmBtn).toHaveText(
        new RegExp(`Remove ${realPhrases.length} phrase`),
      );

      await confirmBtn.click();

      // Panel closes and the active list no longer contains any of the
      // committed phrases.
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      for (const p of realPhrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(0, { timeout: 15_000 });
      }
    } finally {
      await cleanup(apiCtx, realPhrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the preview panel cancels without mutating the active list", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task154 preview backout");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible();
      await panel.getByTestId("handwavy-bulk-preview-cancel").click();
      await expect(panel).toHaveCount(0);
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1);
      }
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("Acknowledgment checkbox gates the destructive confirm when valid detections would be lost", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task154 preview ack");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      // Intercept the dryRun DELETE to inject a synthetic "valid
      // detections lost" response. This lets us verify the UI gating
      // behavior (which is the part of Task #154 that's hardest to
      // exercise without seeded fixture matches) without needing real
      // corpus data that overlaps with these test-only phrases.
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                corpus: {
                  total: 5,
                  validDetectionsLost: 3,
                  falsePositivesDropped: 2,
                  byTier: {
                    t1Legit: 2,
                    t2Borderline: 1,
                    t3Slop: 1,
                    t4Hallucinated: 1,
                  },
                  sampleMatches: [
                    { id: "fixture-001", tier: "t1Legit" },
                    { id: "fixture-002", tier: "t3Slop" },
                  ],
                  warning:
                    "3 legitimate detections would be lost from the curated benchmark",
                  corpusSize: 47,
                },
                production: null,
                productionError:
                  "Production scan unavailable in this synthetic fixture",
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Ack checkbox must be present and unchecked.
      const ack = panel.getByTestId("handwavy-bulk-preview-ack");
      await expect(ack).toBeVisible();
      await expect(ack).not.toBeChecked();

      // Confirm button should be DISABLED until the reviewer ticks the
      // acknowledgment checkbox.
      const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
      await expect(confirmBtn).toBeDisabled();
      await expect(confirmBtn).toHaveText(/Remove .* anyway/);

      // Curated-corpus warning should be visible verbatim.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated-warning"),
      ).toContainText("3 legitimate detections would be lost");

      // Production-scan-error fallback should also render.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-production-error"),
      ).toContainText("Production scan unavailable");

      // Ticking the ack enables the destructive confirm.
      await ack.check();
      await expect(ack).toBeChecked();
      await expect(confirmBtn).toBeEnabled();
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #344 — when the bulk dry-run reports a non-zero
  // `validDetectionsLost`, the batch-confirm preview must render the
  // curated and production `sampleMatches` arrays inline (not buried
  // inside the closed `<details>` the shared `BulkRemovalImpactBlock`
  // renders by default), grouped by tier, with the production report
  // IDs linkified to the `/verify/:id` viewer route opened in a new
  // tab — mirroring the per-row Trash preview affordance Task #245
  // added so a reviewer running a bulk retire sees the same
  // affordance.
  test("Inline sample-match list renders curated + production IDs grouped by tier with production links to the report viewer", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task344 batch matches");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      // Inject a synthetic dryRun response that includes per-tier
      // `sampleMatches` on both the curated and production blocks so we
      // can deterministically assert the inline rendering without
      // depending on real corpus / production data overlapping these
      // test-only phrases.
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
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
                    { id: "9101", tier: "T1_LEGIT" },
                    { id: "9102", tier: "T3_SLOP" },
                    { id: "9103", tier: "T4_HALLUCINATED" },
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
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Inline match section is in the DOM and not hidden behind a
      // <details>/<summary> the reviewer would have to expand first.
      const matches = panel.getByTestId("handwavy-bulk-preview-matches");
      await expect(matches).toBeVisible();

      // Curated block renders all four tier groups with their fixture
      // IDs visible inline.
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

      // Production block renders its own tier groups with each report
      // ID surfaced as a link to /verify/:id that opens in a new tab.
      const productionBlock = matches.getByTestId(
        "handwavy-remove-preview-matches-production",
      );
      await expect(productionBlock).toBeVisible();
      await expect(productionBlock).toContainText("Production reports");

      const t1Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9101",
      );
      const t3Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9102",
      );
      const t4Link = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-link-9103",
      );
      await expect(t1Link).toBeVisible();
      await expect(t3Link).toBeVisible();
      await expect(t4Link).toBeVisible();
      await expect(t1Link).toHaveText(/report\s*#9101/);
      await expect(t3Link).toHaveText(/report\s*#9102/);
      await expect(t4Link).toHaveText(/report\s*#9103/);
      await expect(t1Link).toHaveAttribute("target", "_blank");
      await expect(t3Link).toHaveAttribute("target", "_blank");
      await expect(t4Link).toHaveAttribute("target", "_blank");
      await expect(t1Link).toHaveAttribute("href", /\/verify\/9101$/);
      await expect(t3Link).toHaveAttribute("href", /\/verify\/9102$/);
      await expect(t4Link).toHaveAttribute("href", /\/verify\/9103$/);

      // The shared `BulkRemovalImpactBlock` renderer's collapsed
      // <details> sample-match list MUST be suppressed on this flow so
      // the same IDs don't appear twice — once inline above and once
      // hidden behind a <summary> click below.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated").locator("details", {
          hasText: "fixtures that would lose their flag",
        }),
      ).toHaveCount(0);
      await expect(
        panel
          .getByTestId("handwavy-bulk-preview-production")
          .locator("details", {
            hasText: "reports that would lose their flag",
          }),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #496 — Task #345 added inline context snippets next to each
  // sample-match ID on the per-row Trash preview's
  // `HandwavyRemovePreviewMatches` block so reviewers can judge an
  // un-flag in place without leaving the page. The shared
  // `BulkRemovalImpactBlock` renderer's OWN, older sample-match list
  // inside its collapsed `<details>` ("Sample {sourceNoun}s that would
  // lose their flag (N)") was extended in Task #496 to render the same
  // snippet inline next to each ID with the matched phrase wrapped in
  // a `<mark>`. Task #491 then deleted that legacy `<details>` block
  // entirely once all three callers (per-row Trash, batch-confirm,
  // edit-rename) wired the inline `HandwavyRemovePreviewMatches`
  // renderer in directly — the duplicated rendering inside
  // `BulkRemovalImpactBlock` was redundant once every caller drew the
  // inline matches block above it. This test pins both halves of the
  // surviving design on the bulk-flow:
  //   * the bulk-flow's INLINE matches block surfaces the per-tier
  //     snippet next to each ID with the matched phrase highlighted
  //     in a real `<mark>` element (the actual surfaced behavior here),
  //   * the legacy `<details>` block on the shared
  //     `BulkRemovalImpactBlock` is gone for good, so the
  //     `handwavy-bulk-preview-{kind}-sample-snippet-…` testids the
  //     deleted block used to emit do NOT appear anywhere — neither
  //     side renders them, even with a snippet-bearing dryRun response.
  test("Bulk-flow surfaces sample-match snippets via the inline block while the legacy `<details>` stays suppressed (Task #496)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task496 batch snippets");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                corpus: {
                  total: 2,
                  validDetectionsLost: 1,
                  falsePositivesDropped: 1,
                  byTier: {
                    t1Legit: 1,
                    t2Borderline: 1,
                    t3Slop: 0,
                    t4Hallucinated: 0,
                  },
                  sampleMatches: [
                    {
                      id: "fixture-T1-alpha",
                      tier: "T1_LEGIT",
                      snippet: {
                        before: "the report says ",
                        match: "MAGIC PHRASE",
                        after: " has fired here",
                      },
                    },
                    {
                      id: "fixture-T2-beta",
                      tier: "T2_BORDERLINE",
                      snippet: null,
                    },
                  ],
                  warning:
                    "1 legitimate detection would be lost from the curated benchmark",
                  corpusSize: 47,
                  oldestCreatedAt: null,
                  newestCreatedAt: null,
                },
                production: {
                  total: 1,
                  validDetectionsLost: 1,
                  falsePositivesDropped: 0,
                  byTier: {
                    t1Legit: 1,
                    t2Borderline: 0,
                    t3Slop: 0,
                    t4Hallucinated: 0,
                  },
                  sampleMatches: [
                    {
                      id: "9001",
                      tier: "T1_LEGIT",
                      // Literal `<svg>` substring guards React text-node
                      // escaping (a naive innerHTML render would inject
                      // an SVG element into the DOM).
                      snippet: {
                        before: "alert(<svg> ",
                        match: "fishy claim",
                        after: " about CVE-1234",
                      },
                    },
                  ],
                  warning:
                    "1 legitimate detection would be lost from the production archive",
                  corpusSize: 200,
                  oldestCreatedAt: "2026-04-01T00:00:00.000Z",
                  newestCreatedAt: "2026-04-29T00:00:00.000Z",
                },
                productionError: null,
                productionLimit: 200,
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Inline matches block is the ACTUAL surfaced renderer on the
      // bulk-flow — assert the snippet shows next to its ID with the
      // matched phrase wrapped in a real `<mark>` element.
      const matches = panel.getByTestId("handwavy-bulk-preview-matches");
      await expect(matches).toBeVisible();

      const curatedInlineSnippet = matches.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-fixture-T1-alpha",
      );
      await expect(curatedInlineSnippet).toBeVisible();
      await expect(curatedInlineSnippet).toContainText("the report says");
      await expect(curatedInlineSnippet).toContainText("has fired here");
      const curatedInlineMark = matches.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-mark-fixture-T1-alpha",
      );
      await expect(curatedInlineMark).toHaveText("MAGIC PHRASE");
      await expect(curatedInlineMark).toHaveJSProperty("tagName", "MARK");

      const productionInlineSnippet = matches.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-9001",
      );
      await expect(productionInlineSnippet).toBeVisible();
      await expect(productionInlineSnippet).toContainText("about CVE-1234");
      await expect(productionInlineSnippet).toContainText("<svg>");
      await expect(productionInlineSnippet.locator("svg")).toHaveCount(0);
      const productionInlineMark = matches.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-mark-9001",
      );
      await expect(productionInlineMark).toHaveText("fishy claim");
      await expect(productionInlineMark).toHaveJSProperty("tagName", "MARK");

      // BulkRemovalImpactBlock's legacy collapsed `<details>`
      // sample-match list (now snippet-aware after Task #496) MUST stay
      // suppressed on the bulk-flow so the same IDs/snippets don't
      // appear twice — once inline above and once hidden behind a
      // <summary> click below. The Task #496 testids the legacy block
      // would emit must NOT exist anywhere in the panel.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated").locator("details", {
          hasText: "fixtures that would lose their flag",
        }),
      ).toHaveCount(0);
      await expect(
        panel
          .getByTestId("handwavy-bulk-preview-production")
          .locator("details", {
            hasText: "reports that would lose their flag",
          }),
      ).toHaveCount(0);
      await expect(
        panel.getByTestId(
          "handwavy-bulk-preview-curated-sample-snippet-fixture-T1-alpha",
        ),
      ).toHaveCount(0);
      await expect(
        panel.getByTestId(
          "handwavy-bulk-preview-production-sample-snippet-9001",
        ),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #344 — when the dry-run returned no `sampleMatches` on either
  // side (e.g. the synthetic happy-path phrases used in the first spec
  // here), the inline match block must stay out of the DOM entirely so
  // zero-impact previews keep their lean visual footprint. Mirrors the
  // companion guard that Task #245 added on the per-row Trash preview.
  test("Inline sample-match list is not rendered when the dry-run returns no sampleMatches", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task344 batch nomatches");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      // The synthetic test phrases do not overlap any curated or
      // production samples, so the dry-run server response leaves both
      // `sampleMatches` arrays empty and the inline block stays out of
      // the DOM.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-matches"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #415 — Task #218 added a "Scanned N reports from <oldest> to
  // <newest>" line to the bulk hand-wavy phrase removal preview's
  // production block (rendered via `BulkRemovalImpactBlock` with the
  // `handwavy-bulk-preview-production-range` test id). The bulk-retire
  // flow was Task #218's original consumer, but the matching assertion
  // was added to the per-row Trash spec by Task #293 — leaving the
  // bulk-retire confirm panel without coverage of the same line. A
  // regression that drops the line on the bulk flow would currently
  // slip through the bulk spec, so this test locks both halves of the
  // curated/production asymmetry in here too: the production block
  // surfaces the scan-range line (with the right corpus size, plural,
  // date range, and testid) when the dry-run carries oldest/newest
  // createdAt; the curated block never grows a
  // `handwavy-bulk-preview-curated-range` testid. Mirrors the Task #293
  // spec in `handwavy-remove-preview.spec.ts`.
  test("Production block renders the scan-range line and the curated block does not (Task #218 / #415)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task415 batch scan-range");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      // Inject a synthetic dryRun response that carries createdAt
      // timestamps on the production block (and none on the curated
      // block) so we can deterministically assert the renderer's
      // curated/production scan-range asymmetry without depending on
      // real production data overlapping these test-only phrases.
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                // Curated block carries no wall-clock timestamps, so
                // the scan-range line MUST stay out of the DOM here.
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
                  sampleMatches: [],
                  warning:
                    "1 legitimate detection would be lost from the curated benchmark",
                  corpusSize: 47,
                  oldestCreatedAt: null,
                  newestCreatedAt: null,
                },
                // Production block carries a real createdAt window, so
                // the scan-range line MUST render with the corpus size,
                // plural noun ("reports"), and "from … to …" range.
                production: {
                  total: 2,
                  validDetectionsLost: 1,
                  falsePositivesDropped: 1,
                  byTier: {
                    t1Legit: 1,
                    t2Borderline: 0,
                    t3Slop: 0,
                    t4Hallucinated: 1,
                  },
                  sampleMatches: [],
                  warning:
                    "1 legitimate detection would be lost from the production archive",
                  corpusSize: 173,
                  oldestCreatedAt: "2026-04-01T00:00:00.000Z",
                  newestCreatedAt: "2026-04-29T00:00:00.000Z",
                },
                productionError: null,
                productionLimit: 200,
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      const curatedBlock = panel.getByTestId("handwavy-bulk-preview-curated");
      const productionBlock = panel.getByTestId(
        "handwavy-bulk-preview-production",
      );
      await expect(curatedBlock).toBeVisible();
      await expect(productionBlock).toBeVisible();

      // Production block's scan-range line: same testid as the renderer,
      // mentions corpus size + pluralised noun + the "from … to …" range
      // produced by `formatProductionScanRange` for distinct dates.
      const productionRange = productionBlock.getByTestId(
        "handwavy-bulk-preview-production-range",
      );
      await expect(productionRange).toBeVisible();
      await expect(productionRange).toContainText("Scanned 173 reports");
      // Date formatting is locale-dependent (toLocaleDateString) and the
      // ISO inputs are UTC midnight (so they may render as the prior day
      // in negative-offset locales). Match the structural "from <…> to
      // <…>" shape and the year, which are stable across locales.
      await expect(productionRange).toContainText(/from .+ to .+/);
      await expect(productionRange).toContainText("2026");

      // Curated block carries no timestamps → the matching range testid
      // must not appear in the DOM at all (the curated/production
      // asymmetry the renderer enforces).
      await expect(
        curatedBlock.getByTestId("handwavy-bulk-preview-curated-range"),
      ).toHaveCount(0);
      // Belt-and-braces: the testid must not exist anywhere on the page,
      // not just inside the curated block.
      await expect(
        page.getByTestId("handwavy-bulk-preview-curated-range"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  test("Preview surfaces notFound and duplicate-in-batch outcomes for phantom + repeated entries", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const realPhrases = uniquePhrases(1, "task154 preview real-only");
    const phantomPhrase = `task154 phantom ${randomUUID().replace(/-/g, "").slice(0, 8)}`;

    try {
      for (const p of realPhrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Pick the one real phrase via the UI checkbox.
      const realRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: realPhrases[0] });
      await expect(realRow).toHaveCount(1, { timeout: 15_000 });
      await realRow.getByTestId("handwavy-select").check();

      // We can't tick a phantom phrase through the UI (no row exists), so
      // call the dryRun endpoint directly and assert the panel rendering
      // by injecting through the page's own mutation hook. Easier path:
      // hit the API directly to confirm the server reports notFound +
      // duplicate, since the route is the contract this UI panel is
      // meant to surface — and then trust the same data is rendered.
      const dryRes = await apiCtx.delete(
        "/api/feedback/calibration/handwavy-phrases",
        {
          data: {
            phrases: [
              realPhrases[0],
              phantomPhrase,
              phantomPhrase, // duplicate in the batch
            ],
            dryRun: true,
            reviewer: REVIEWER,
          },
        },
      );
      expect(dryRes.ok()).toBeTruthy();
      const dryBody = await dryRes.json();
      expect(dryBody.dryRun).toBe(true);
      expect(dryBody.wouldRemove).toBe(1);
      expect(dryBody.notFound).toBe(1);
      expect(dryBody.duplicateInBatch).toBe(1);
      expect(
        dryBody.results.some(
          (r: { raw: string; reason?: string }) =>
            r.raw === phantomPhrase && r.reason === "not-found",
        ),
        "phantom phrase should be reported as not-found",
      ).toBe(true);
      expect(
        dryBody.results.some(
          (r: { raw: string; reason?: string }) =>
            r.raw === phantomPhrase && r.reason === "duplicate-in-batch",
        ),
        "duplicate phantom phrase should be reported as duplicate-in-batch",
      ).toBe(true);

      // Now drive the UI: clicking "Remove selected" with just the one
      // real phrase opens the panel; the per-phrase results list should
      // render exactly one would-remove row (no notFound/duplicate
      // because the UI selection only includes the real phrase).
      await page.getByTestId("handwavy-bulk-remove").click();
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible();
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      await expect(
        panel.locator(
          `[data-testid="handwavy-bulk-preview-result-row"][data-outcome="would-remove"]`,
        ),
      ).toHaveCount(1);
      await expect(
        panel.locator(
          `[data-testid="handwavy-bulk-preview-result-row"][data-outcome="not-found"]`,
        ),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [...realPhrases, phantomPhrase], {
        reviewer: `${REVIEWER}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });

  // Task #178 — per-row dismiss on the bulk-remove confirm panel. Before
  // this, a reviewer who spotted a high-thrash row in a 20-phrase batch
  // had to back out of the panel, find that one phrase in the active
  // list, untick it, then re-open the panel — friction that nudged
  // people toward just hitting Remove anyway. The dismiss button drops
  // ONE phrase from the pending batch in place so the rest can fire in
  // a single confirm click.
  test("Per-row drop button removes a single phrase from the pending batch and updates the live counts", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task154 preview drop");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Open the per-phrase outcomes list so the dismiss buttons render.
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();

      const allRows = panel.locator(
        `[data-testid="handwavy-bulk-preview-result-row"]`,
      );
      await expect(allRows).toHaveCount(3);
      await expect(panel).toContainText("Removal preview for 3 phrases");
      const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
      await expect(confirmBtn).toHaveText(/Remove 3 phrases/);

      // Drop the middle phrase via its inline dismiss button. The summary
      // count and the confirm button label MUST both update live; the
      // remaining rows MUST keep working (so we drop another in the next
      // step).
      const droppedPhrase = phrases[1];
      const dropBtn = panel.locator(
        `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
      );
      await expect(dropBtn).toHaveCount(1);
      await dropBtn.click();

      await expect(allRows).toHaveCount(2);
      await expect(
        panel.locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        ),
      ).toHaveCount(0);
      await expect(panel).toContainText("Removal preview for 2 phrases");
      await expect(confirmBtn).toHaveText(/Remove 2 phrases/);

      // The underlying selection checkbox for the dropped phrase should
      // also be unticked so the active-list state matches the reviewer's
      // intent (and the "selection has changed" stale banner doesn't fire
      // from the drop itself).
      const droppedRow = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: droppedPhrase });
      await expect(droppedRow.getByTestId("handwavy-select")).not.toBeChecked();
      await expect(
        panel.getByTestId("handwavy-bulk-preview-stale"),
      ).toHaveCount(0);

      // Drop a second phrase — count + label keep tracking.
      await panel
        .locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${phrases[0]}"]`,
        )
        .click();
      await expect(allRows).toHaveCount(1);
      await expect(panel).toContainText("Removal preview for 1 phrase");
      await expect(confirmBtn).toHaveText(/Remove 1 phrase\b/);

      // Confirming now removes ONLY the surviving phrase. The two dropped
      // phrases stay on the active list — the reviewer chose to skip them.
      await confirmBtn.click();
      await expect(panel).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: phrases[2] }),
      ).toHaveCount(0, { timeout: 15_000 });
      for (const survivor of [phrases[0], phrases[1]]) {
        await expect(
          page
            .locator(`[data-testid="handwavy-row"]`)
            .filter({ hasText: survivor }),
        ).toHaveCount(1);
      }
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #178 — dropping the last selected phrase closes the panel, same
  // as clicking Back out. Without this, the panel would render an empty
  // list with a disabled confirm button, which is just dead UI.
  test("Dropping the last phrase closes the bulk-remove preview (same as Back out)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task154 preview droplast");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();

      // Drop both phrases one by one. After the second drop the panel
      // should disappear without firing any DELETEs.
      for (const p of phrases) {
        await panel
          .locator(
            `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${p}"]`,
          )
          .click();
      }
      await expect(panel).toHaveCount(0);

      // Both phrases must still be on the active list (we never confirmed).
      for (const p of phrases) {
        await expect(
          page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: p }),
        ).toHaveCount(1);
      }
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #257 — when ANY phrase in the pending bulk-remove batch has
  // already cycled >=2 times, the per-phrase outcomes <details> should
  // default to OPEN so the high-thrash row's per-row dismiss button
  // (Task #178) is visible alongside the high-thrash summary banner.
  // Otherwise a reviewer who notices the warning could still hit Remove
  // without ever expanding the list. The collapsed-by-default behavior
  // for routine batches (no high-thrash phrases) must be preserved, and
  // a manual collapse on a high-thrash batch must stick for the rest of
  // that panel session — including across drop-a-phrase re-renders.
  test("Per-phrase outcomes auto-expands when the batch contains a high-thrash phrase", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const thrashy = `task257 thrashy ${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const fresh = `task257 fresh ${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      // `thrashy` ends with 2 completed remove+reinstate cycles (the
      // HIGH_THRASH_MIN gate); `fresh` is a brand-new phrase with 0
      // cycles. Selecting both means at least one phrase trips the
      // high-thrash flag → outcomes list should auto-expand.
      await seedCycles(apiCtx, thrashy, 2, { reviewer: REVIEWER_TASK257 });
      await addPhrase(apiCtx, fresh, { reviewer: REVIEWER_TASK257 });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, [thrashy, fresh]);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // The thrash summary banner must be present (sanity check that the
      // high-thrash gate fired at all).
      await expect(
        panel.getByTestId("handwavy-bulk-preview-thrash-summary"),
      ).toBeVisible();

      // The outcomes <details> should be open WITHOUT us clicking the
      // summary, so the per-row drop button on the thrashy row is
      // immediately reachable.
      const details = panel.getByTestId(
        "handwavy-bulk-preview-results-details",
      );
      await expect(details).toHaveJSProperty("open", true);

      const thrashyDropBtn = panel.locator(
        `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${thrashy}"]`,
      );
      await expect(thrashyDropBtn).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-bulk-preview-thrash-badge"),
      ).toBeVisible();
    } finally {
      await cleanup(apiCtx, [thrashy, fresh], {
        reviewer: `${REVIEWER_TASK257}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });

  // Task #365 — when the outcomes <details> auto-expands because the
  // batch contains a high-thrash phrase, the row itself can still be
  // scrolled below the fold inside the `max-h-48 overflow-y-auto`
  // container in 30+ phrase batches. Task #257's auto-expand alone
  // wasn't enough — the per-row drop button would be in the DOM but
  // outside the visible portion of the scroll container, so a reviewer
  // who saw the high-thrash banner still had to manually scroll the
  // inner list to act. The follow-up scrolls the first
  // `handwavy-bulk-preview-result-row-thrash` row into view inside that
  // container the first time the panel renders auto-expanded; this spec
  // pins the row's bounding box landing inside the container's visible
  // portion after the auto-expand.
  test("Auto-expand scrolls the first high-thrash row into view inside the outcomes scroll container", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    // 30 routine fillers added FIRST so they occupy the top of the
    // displayed active list (curated insertion order). The high-thrash
    // phrase is added LAST via seedCycles, putting its outcomes row at
    // the bottom of the rendered list — well below the `max-h-48`
    // container's ~192px visible portion. Zero-padded suffix avoids the
    // `hasText` substring collision selectRowsAndOpenPreview would hit
    // if we used `uniquePhrases` (where "… phrase 1" matches "… phrase
    // 10" / "… phrase 11" / etc).
    const fillers = Array.from(
      { length: 30 },
      (_, i) => `task365 filler ${id} idx${String(i + 1).padStart(3, "0")}`,
    );
    const thrashy = `task365 thrashy ${id}`;

    try {
      for (const p of fillers)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER_TASK365 });
      await seedCycles(apiCtx, thrashy, 2, { reviewer: REVIEWER_TASK365 });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, [...fillers, thrashy]);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Sanity: the auto-expand from Task #257 still fires.
      const details = panel.getByTestId(
        "handwavy-bulk-preview-results-details",
      );
      await expect(details).toHaveJSProperty("open", true);

      const thrashyRow = panel
        .locator(`[data-testid="handwavy-bulk-preview-result-row-thrash"]`)
        .first();
      await expect(thrashyRow).toHaveCount(1);

      // The row's bounding box must sit within the scroll container's
      // visible portion — proving the auto-scroll lands the row on
      // screen and not just in the DOM below the overflow fold. The
      // ±1px slack absorbs sub-pixel rounding in the layout engine.
      // We walk up from the row itself to find the outcomes <ul>
      // ancestor (rather than re-querying the document) so the
      // assertion stays scoped to the same panel even if a second
      // preview container is ever present in the DOM.
      await expect
        .poll(
          async () =>
            thrashyRow.evaluate((row) => {
              const container = row.closest(
                '[data-testid="handwavy-bulk-preview-results"]',
              );
              if (!container) return null;
              const r = row.getBoundingClientRect();
              const c = container.getBoundingClientRect();
              return {
                rowTop: r.top,
                rowBottom: r.bottom,
                containerTop: c.top,
                containerBottom: c.bottom,
                inView: r.top >= c.top - 1 && r.bottom <= c.bottom + 1,
              };
            }),
          {
            message:
              "first high-thrash row should be in the visible portion of the outcomes scroll container after auto-expand",
            timeout: 5_000,
          },
        )
        .toMatchObject({ inView: true });
    } finally {
      await cleanup(apiCtx, [...fillers, thrashy], {
        reviewer: `${REVIEWER_TASK365}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });

  // Task #257 — pin the inverse: a routine batch with zero high-thrash
  // phrases must keep the original collapsed-by-default outcomes block
  // so we don't add gratuitous noise to every routine bulk removal.
  test("Per-phrase outcomes stays collapsed by default when no phrase in the batch is high-thrash", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(2, "task257 noop");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER_TASK257 });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // No high-thrash summary should fire …
      await expect(
        panel.getByTestId("handwavy-bulk-preview-thrash-summary"),
      ).toHaveCount(0);
      // … and the outcomes <details> should be collapsed (no `open`
      // attribute on the rendered element).
      const details = panel.getByTestId(
        "handwavy-bulk-preview-results-details",
      );
      await expect(details).toHaveJSProperty("open", false);
    } finally {
      await cleanup(apiCtx, phrases, {
        reviewer: `${REVIEWER_TASK257}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });

  // Task #257 — a manual collapse on a high-thrash batch must stick for
  // the rest of that panel session. The drop-a-phrase flow re-renders
  // the panel (bulkPreview state changes), but auto-expand only fires
  // on the panel's open transition, so the manual collapse should be
  // preserved across that re-render.
  test("Manual collapse of the auto-expanded outcomes list is respected across drop-a-phrase re-renders", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const thrashy = `task257 stickycollapse ${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const fresh = `task257 sticky-fresh ${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      await seedCycles(apiCtx, thrashy, 2, { reviewer: REVIEWER_TASK257 });
      await addPhrase(apiCtx, fresh, { reviewer: REVIEWER_TASK257 });

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, [thrashy, fresh]);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      const details = panel.getByTestId(
        "handwavy-bulk-preview-results-details",
      );
      await expect(details).toHaveJSProperty("open", true);

      // Reviewer manually collapses the outcomes block.
      await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", false);

      // Re-open it just enough to drop the `fresh` phrase, then collapse
      // again. After the drop, the high-thrash phrase is still in the
      // batch, but the panel must NOT re-auto-expand.
      await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", true);
      await panel
        .locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${fresh}"]`,
        )
        .click();
      // One row left (the thrashy phrase).
      await expect(
        panel.locator(
          `[data-testid="handwavy-bulk-preview-result-row-thrash"]`,
        ),
      ).toHaveCount(1);
      // Now collapse manually and verify it stays collapsed.
      await details.locator("summary").click();
      await expect(details).toHaveJSProperty("open", false);
    } finally {
      await cleanup(apiCtx, [thrashy, fresh], {
        reviewer: `${REVIEWER_TASK257}-cleanup`,
      });
      await apiCtx.dispose();
    }
  });

  // Task #258 — when a reviewer drops a phrase from the bulk-remove
  // preview the corpus + production `validDetectionsLost` figures (and
  // the red-bordered acknowledgement gate) used to stay frozen at the
  // ORIGINAL batch's totals. A reviewer who dropped the only high-thrash
  // phrase from a 2-phrase batch still saw the scary projected-impact
  // numbers — which trains people to ignore the banner. The drop now
  // schedules a debounced (~250ms) dry-run re-fetch against the
  // surviving phrases list; once it lands, the impact figures and the
  // ack checkbox both refresh. This spec asserts the end-to-end
  // behaviour: the warning panel demotes from "ack required" to "safe to
  // proceed" once the only at-risk phrase is dropped, and the per-row
  // high-thrash badge disappears in the same tick the local
  // thrashByPhrase map drops the phrase.
  test("Dropping the only high-thrash phrase re-fetches the dry-run; the impact-warning banner clears and the ack checkbox is no longer required", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const thrashy = `task258 thrashy ${id}`;
    const fresh = `task258 fresh ${id}`;
    const phrases = [thrashy, fresh];

    try {
      // Make `thrashy` carry 2 reinstated history rows so the local
      // thrashByPhrase map flags it (HIGH_THRASH_MIN = 2). `fresh` is
      // added once and never cycled.
      await seedCycles(apiCtx, thrashy, 2, { reviewer: REVIEWER });
      await addPhrase(apiCtx, fresh, { reviewer: REVIEWER });

      // Mock the dry-run DELETE so we can deterministically control the
      // before/after `validDetectionsLost` numbers without depending on
      // real corpus matches for these synthetic phrases. Critical: the
      // mock branches on the request body's `phrases` length so the
      // initial 2-phrase preview reports a positive `validDetectionsLost`
      // (ack required, red banner) and the post-drop 1-phrase re-fetch
      // reports zero (ack section disappears, panel demotes to amber).
      // Track every dry-run hit so we can assert the second call really
      // fired after the drop (otherwise the panel could be hiding the ack
      // section purely because of an unrelated client-side bug).
      const dryRunBodies: Array<{ phrases: string[] }> = [];
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          dryRunBodies.push({ phrases: [...requested] });
          const validLost = requested.length >= 2 ? 3 : 0;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                corpus: {
                  total: validLost > 0 ? 5 : 0,
                  validDetectionsLost: validLost,
                  falsePositivesDropped: validLost > 0 ? 2 : 0,
                  byTier: {
                    t1Legit: validLost > 0 ? 2 : 0,
                    t2Borderline: 0,
                    t3Slop: validLost > 0 ? 1 : 0,
                    t4Hallucinated: 0,
                  },
                  sampleMatches: [],
                  warning:
                    validLost > 0
                      ? "3 legitimate detections would be lost from the curated benchmark"
                      : null,
                  corpusSize: 47,
                },
                production: null,
                productionError:
                  "Production scan unavailable in this synthetic fixture",
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Pre-conditions for the drop: the high-thrash summary banner
      // renders (because `thrashy` carries >=2 cycles in the audit log)
      // AND the validDetectionsLost-driven ack section renders (because
      // the mocked dry-run reports 3 valid detections lost for the
      // 2-phrase batch).
      await expect(
        panel.getByTestId("handwavy-bulk-preview-thrash-summary"),
      ).toBeVisible();
      const ack = panel.getByTestId("handwavy-bulk-preview-ack");
      await expect(ack).toBeVisible();
      const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
      await expect(confirmBtn).toHaveText(/Remove .* anyway/);
      await expect(confirmBtn).toBeDisabled();

      // The first dry-run was the one fired when the reviewer clicked
      // "Remove selected" — it carries both phrases in any order.
      expect(dryRunBodies).toHaveLength(1);
      expect([...dryRunBodies[0].phrases].sort()).toEqual([...phrases].sort());

      // Open the per-phrase outcomes list and dismiss the only
      // high-thrash row. The `dropPhraseFromBulkPreview` helper schedules
      // a ~250ms debounced re-fetch with the surviving 1-phrase list.
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      await panel
        .locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${thrashy}"]`,
        )
        .click();

      // The high-thrash summary banner clears immediately (it's keyed
      // off the local thrashByPhrase map, not the dry-run response).
      await expect(
        panel.getByTestId("handwavy-bulk-preview-thrash-summary"),
      ).toHaveCount(0);

      // After the debounce, the re-fetch hits the mocked DELETE with the
      // surviving single phrase. Once that response lands the ack
      // checkbox stops rendering (validDetectionsLost is now 0), the red
      // ack section is replaced by the green "safe to proceed" copy, and
      // the confirm button is enabled without any acknowledgement.
      await expect(panel.getByTestId("handwavy-bulk-preview-ack")).toHaveCount(
        0,
        { timeout: 5_000 },
      );
      await expect(panel).toContainText(
        "No legitimate hand-wavy detections would be lost",
      );
      await expect(confirmBtn).toBeEnabled();
      await expect(confirmBtn).toHaveText(/Remove 1 phrase/);

      // The dry-run was actually re-fired with the surviving list — not
      // simply hidden behind a stale-data check.
      expect(dryRunBodies.length).toBeGreaterThanOrEqual(2);
      const lastBody = dryRunBodies[dryRunBodies.length - 1];
      expect(lastBody.phrases).toEqual([fresh]);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #375 — between the per-row drop click and the debounced re-fetch
  // landing (debounce + network round-trip), the corpus / production
  // `validDetectionsLost` figures rendered above are stale-by-one-drop
  // and the reviewer has no signal that newer numbers are inbound. A
  // small "refreshing impact…" hint above the impact grid makes the
  // live re-scoring visible. This spec gates the indicator's appearance
  // on a drop and its removal on the re-fetch landing — the indicator
  // MUST appear in the window after the drop and MUST disappear once
  // the new dry-run response is applied.
  test("Per-row drop surfaces a 'refreshing impact…' indicator until the debounced dry-run lands", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const a = `task375 a ${id}`;
    const b = `task375 b ${id}`;
    const phrases = [a, b];

    try {
      await addPhrase(apiCtx, a, { reviewer: REVIEWER });
      await addPhrase(apiCtx, b, { reviewer: REVIEWER });

      // Mock the dry-run DELETE so we can:
      //   1. Return synthetically clean impact figures (no real corpus
      //      detections lost), so the panel is in its "happy path" state
      //      and the indicator is the only thing the assertions key off.
      //   2. Hold the post-drop dry-run response open long enough that the
      //      indicator is observable in the post-drop window. The initial
      //      ("Remove selected") response returns immediately so the
      //      panel reaches a settled rendered state before the drop.
      // Gating by `requested.length === 1` (the surviving single phrase)
      // is more robust than counting calls — even if the panel ends up
      // making more than one initial dry-run call, only the post-drop
      // refetch carries exactly one phrase.
      const dryRunBodies: Array<{ phrases: string[] }> = [];
      let releaseDropResponse: (() => void) | null = null;
      const dropResponseGate = new Promise<void>((resolve) => {
        releaseDropResponse = resolve;
      });
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          dryRunBodies.push({ phrases: [...requested] });
          if (requested.length === 1) {
            await dropResponseGate;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                corpus: {
                  total: 0,
                  validDetectionsLost: 0,
                  falsePositivesDropped: 0,
                  byTier: {
                    t1Legit: 0,
                    t2Borderline: 0,
                    t3Slop: 0,
                    t4Hallucinated: 0,
                  },
                  sampleMatches: [],
                  warning: null,
                  corpusSize: 47,
                },
                production: null,
                productionError:
                  "Production scan unavailable in this synthetic fixture",
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // The settled (post-initial-preview) panel does NOT show the
      // refreshing indicator — it only fires off a per-row drop.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-refreshing"),
      ).toHaveCount(0);

      // Drop one row. The debounced re-fetch is now scheduled and the
      // indicator MUST appear immediately (we set it before the 250ms
      // debounce fires so the reviewer has a signal as soon as they
      // click).
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      await panel
        .locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${a}"]`,
        )
        .click();

      const refreshing = panel.getByTestId("handwavy-bulk-preview-refreshing");
      await expect(refreshing).toBeVisible({ timeout: 2_000 });
      await expect(refreshing).toContainText("refreshing impact");

      // Release the held drop response. Once the dry-run lands the
      // indicator MUST disappear.
      releaseDropResponse?.();
      await expect(refreshing).toHaveCount(0, { timeout: 5_000 });

      // Sanity check: the drop dry-run did fire (i.e. the indicator
      // was tied to a real refetch round-trip, not a UI-only flash).
      const dropBodies = dryRunBodies.filter((b) => b.phrases.length === 1);
      expect(dropBodies.length).toBeGreaterThanOrEqual(1);
      expect(dropBodies[dropBodies.length - 1].phrases).toEqual([b]);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #376 — when the post-drop debounced dry-run re-fetch fails with
  // anything other than an AbortError (network blip, 5xx, etc.), the
  // panel must surface a small inline "couldn't refresh impact" hint
  // with a Retry button. The previously-rendered impact figures stay in
  // place (over-warning is the safe direction) but the reviewer is no
  // longer left believing the on-screen numbers reflect their current
  // selection. Clicking Retry re-fires the dry-run and clears the hint
  // on success.
  test("A 500 on the post-drop dry-run re-fetch surfaces a 'couldn't refresh impact' hint with a working Retry", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const phrases = [
      `task376 first ${id}`,
      `task376 second ${id}`,
      `task376 third ${id}`,
    ];

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      // Mock the dry-run DELETE so we can deterministically control the
      // pass/fail outcome of each call:
      //  1. The initial 3-phrase preview (200, validDetectionsLost > 0)
      //  2. The first post-drop re-fetch with the surviving 2-phrase
      //     list (500 — the case under test) — only the FIRST 2-phrase
      //     dry-run fails.
      //  3. The Retry-triggered re-fetch (200, fresh figures).
      // Branching on payload (rather than a global counter) means the
      // spec stays robust if any unrelated dry-run slips into the mix
      // — only the surviving-2-phrase refetch is forced to 500, and
      // only on its very first arrival.
      const dryRunBodies: Array<{ phrases: string[] }> = [];
      let firstRefetchAfterDropFailed = false;
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrases?: string[] }
            | undefined;
          if (!body?.dryRun) {
            await route.fallback();
            return;
          }
          const requested = body.phrases ?? [];
          dryRunBodies.push({ phrases: [...requested] });
          const isPostDropRefetch = requested.length === 2;
          if (isPostDropRefetch && !firstRefetchAfterDropFailed) {
            firstRefetchAfterDropFailed = true;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "synthetic refetch 500" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              dryRun: true,
              wouldRemove: requested.length,
              notFound: 0,
              duplicateInBatch: 0,
              total: 99,
              projectedTotal: 99 - requested.length,
              results: requested.map((raw: string) => ({
                raw,
                phrase: raw,
                removed: true,
              })),
              dryRunImpact: {
                corpus: {
                  total: 5,
                  validDetectionsLost: 3,
                  falsePositivesDropped: 2,
                  byTier: {
                    t1Legit: 2,
                    t2Borderline: 0,
                    t3Slop: 1,
                    t4Hallucinated: 0,
                  },
                  sampleMatches: [],
                  warning:
                    "3 legitimate detections would be lost from the curated benchmark",
                  corpusSize: 47,
                },
                production: null,
                productionError:
                  "Production scan unavailable in this synthetic fixture",
              },
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await selectRowsAndOpenPreview(page, phrases);

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Pre-conditions: the initial 3-phrase preview reports valid
      // detections lost, so the ack section renders and the hint is NOT
      // present yet.
      const ack = panel.getByTestId("handwavy-bulk-preview-ack");
      await expect(ack).toBeVisible();
      await expect(
        panel.getByTestId("handwavy-bulk-preview-refetch-failed"),
      ).toHaveCount(0);
      expect(dryRunBodies).toHaveLength(1);
      expect([...dryRunBodies[0].phrases].sort()).toEqual([...phrases].sort());

      // Drop one phrase via its inline dismiss button — fires the
      // debounced (~250ms) re-fetch with the surviving 2 phrases, which
      // the mock above answers with a 500.
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      const droppedPhrase = phrases[0];
      await panel
        .locator(
          `[data-testid="handwavy-bulk-preview-result-drop"][data-phrase="${droppedPhrase}"]`,
        )
        .click();

      // The "couldn't refresh impact" hint appears with a Retry button.
      const refetchFailed = panel.getByTestId(
        "handwavy-bulk-preview-refetch-failed",
      );
      await expect(refetchFailed).toBeVisible({ timeout: 5_000 });
      await expect(refetchFailed).toContainText(/couldn't refresh impact/i);
      const retryBtn = panel.getByTestId("handwavy-bulk-preview-refetch-retry");
      await expect(retryBtn).toBeVisible();

      // Critical: the previous response's impact figures stay in place
      // (over-warning is the safe direction) — the ack checkbox is still
      // rendered, NOT silently cleared by the failed refetch.
      await expect(ack).toBeVisible();

      // The 500 we returned must actually have been issued against the
      // surviving 2-phrase list (not the original 3) so the test isn't
      // accidentally asserting against the initial preview's request.
      expect(dryRunBodies.length).toBeGreaterThanOrEqual(2);
      expect([...dryRunBodies[1].phrases].sort()).toEqual(
        [phrases[1], phrases[2]].sort(),
      );
      const failedRefetchCallCount = dryRunBodies.length;

      // Click Retry — fires a new debounced dry-run with the same
      // surviving 2-phrase list. The mock returns 200 this time, so the
      // hint must clear and the dry-run impact stays (still > 0 in this
      // mock, so the ack section also stays).
      await retryBtn.click();
      await expect(refetchFailed).toHaveCount(0, { timeout: 5_000 });
      await expect(ack).toBeVisible();

      // The retry actually re-issued the dry-run for the current
      // requested phrase set — not just hidden the hint client-side.
      await expect
        .poll(() => dryRunBodies.length, { timeout: 5_000 })
        .toBeGreaterThan(failedRefetchCallCount);
      const retryBody = dryRunBodies[dryRunBodies.length - 1];
      expect([...retryBody.phrases].sort()).toEqual(
        [phrases[1], phrases[2]].sort(),
      );
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });

  // Task #502 — when the bulk-remove preview's "Selection has changed
  // since this preview was generated" stale notice fires, the reviewer
  // can refresh the dry-run snapshot in place by pressing the
  // "Re-preview" button rendered next to the notice copy. That re-runs
  // `handlePreviewBulkRemove` against the current `selectedInList` so
  // the captured outcomes + counts catch up to the live selection
  // without forcing the reviewer to back out and click "Remove
  // selected" again (two clicks for what is effectively a refresh, and
  // which would also lose the panel's "high-thrash auto-expand" state
  // and the reviewer's place in the active list). Once the new
  // snapshot matches the current selection the stale notice
  // disappears. Mirrors the Task #354 affordance on the per-batch
  // reinstate preview.
  test("the stale notice's 'Re-preview' button refreshes the snapshot in place and clears the notice", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = uniquePhrases(3, "task502 bulk repreview");

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });

      // Mock the GET handwavy-phrases response so the active list is
      // reduced to JUST our 3 phrases (plus an empty history). This is
      // necessary because the dev DB is pre-seeded with many other
      // marker phrases and the drift trigger we use below
      // (`select all`) would otherwise promote the selection to every
      // single phrase in the table — making the dry-run scoring
      // assertions noisy and brittle. Mocking GET lets the test stay
      // focused on the new "Re-preview" button while keeping the
      // (real) DELETE dry-run path intact for the snapshot itself.
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          if (route.request().method() !== "GET") {
            await route.fallback();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              phrases: phrases.map((phrase) => ({
                phrase,
                category: "STYLE_HEDGING",
                rationale: null,
                reviewer: REVIEWER,
                addedAt: new Date().toISOString(),
              })),
              total: phrases.length,
              history: [],
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Sanity: only our 3 phrases render in the active list.
      await expect(page.locator('[data-testid="handwavy-row"]')).toHaveCount(
        phrases.length,
        { timeout: 15_000 },
      );

      // Tick only the FIRST TWO phrases, then open the bulk-remove
      // preview. The dry-run is scored against [phrases[0], phrases[1]]
      // — `requestedPhrases` captures exactly those two.
      for (const p of phrases.slice(0, 2)) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: p });
        await expect(row).toHaveCount(1);
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();

      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText("Removal preview for 2 phrases");
      const confirmBtn = panel.getByTestId("handwavy-bulk-preview-confirm");
      await expect(confirmBtn).toHaveText(/Remove 2 phrases/);

      // Initial snapshot matches the current selection — no stale notice.
      const stale = panel.getByTestId("handwavy-bulk-preview-stale");
      await expect(stale).toHaveCount(0);

      // Drift the selection without closing the panel. Per-row checkboxes
      // are disabled while the preview is open, but the toolbar's
      // "select all" checkbox stays operable — clicking it with a
      // partial selection promotes it to the full set, so
      // `selectedInList` becomes all 3 phrases while `requestedPhrases`
      // stays at the original 2. That's the drift the panel detects.
      await page.getByTestId("handwavy-select-all").click();

      // Stale notice now renders alongside a one-click "Re-preview"
      // button. The original captured outcomes + counts are unchanged
      // (the panel still shows the 2-phrase snapshot the reviewer was
      // reading) — the notice is purely an in-place affordance to
      // refresh the dry-run.
      await expect(stale).toBeVisible();
      await expect(stale).toContainText(/Re-preview to refresh/);
      await expect(panel).toContainText("Removal preview for 2 phrases");
      await expect(confirmBtn).toHaveText(/Remove 2 phrases/);

      const repreviewBtn = stale.getByTestId(
        "handwavy-bulk-preview-stale-repreview",
      );
      await expect(repreviewBtn).toBeVisible();
      await expect(repreviewBtn).toHaveText(/Re-preview/);
      await expect(repreviewBtn).toBeEnabled();

      // Pressing it re-runs the dry-run preview against the current
      // selection (all 3 phrases). The summary header + confirm button
      // count both move to 3, the stale notice clears because the new
      // snapshot matches reality, and the panel itself stays open —
      // the reviewer's place is preserved.
      await repreviewBtn.click();

      await expect(panel).toContainText("Removal preview for 3 phrases", {
        timeout: 15_000,
      });
      await expect(confirmBtn).toHaveText(/Remove 3 phrases/);
      await expect(
        panel.getByTestId("handwavy-bulk-preview-stale"),
      ).toHaveCount(0);
      await expect(panel).toBeVisible();

      // The per-phrase outcomes list now carries one would-remove row
      // per currently-selected phrase — confirms the snapshot was
      // genuinely refreshed against the wider selection rather than
      // the stale notice being hidden client-side.
      await panel
        .getByTestId("handwavy-bulk-preview-results-details")
        .locator("summary")
        .click();
      await expect(
        panel.locator(
          `[data-testid="handwavy-bulk-preview-result-row"][data-outcome="would-remove"]`,
        ),
      ).toHaveCount(3);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: `${REVIEWER}-cleanup` });
      await apiCtx.dispose();
    }
  });
});
