import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

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
//
// Each seeded phrase carries the `"task247 rename"` prefix (via the
// shared `uniquePhrase` helper) + a UUID so fixture / production
// overlap is effectively impossible, guaranteeing a deterministic
// "no real detections lost" preview for the happy-path test.

const REVIEWER = "e2e-task247";
const CLEANUP_REVIEWER = "e2e-task247-cleanup";

test.describe("Per-row Edit-then-rename impact preview (Task #247)", () => {
  test("rename with zero impact applies in one click without showing the preview panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const original = uniquePhrase("task247 rename", "zero-impact-from");
    const renamed = uniquePhrase("task247 rename", "zero-impact-to");

    try {
      await addPhrase(apiCtx, original, { reviewer: REVIEWER });

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

      // Use the stable `data-handwavy-phrase` attribute (Task #491)
      // rather than `hasText: original` so the locator keeps matching
      // after Edit click — once edit mode swaps the phrase span for a
      // textbox, the phrase only lives in the input value (not in
      // textContent), and a `hasText` filter would lose its match.
      const row = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${original}"]`,
      );
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
      await cleanup(apiCtx, [original, renamed], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("rename whose dryRun reports valid detections lost surfaces the impact panel and gates the live PATCH behind the acknowledgment checkbox", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const original = uniquePhrase("task247 rename", "ack-from");
    const renamed = uniquePhrase("task247 rename", "ack-to");

    try {
      await addPhrase(apiCtx, original, { reviewer: REVIEWER });

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

      // Use the stable `data-handwavy-phrase` attribute (Task #491)
      // rather than `hasText: original` so the locator keeps matching
      // after Edit click — once edit mode swaps the phrase span for a
      // textbox, the phrase only lives in the input value (not in
      // textContent), and a `hasText` filter would lose its match.
      const row = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${original}"]`,
      );
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

      // Task #491 — the inline per-tier sample-match block must be in the
      // DOM (no expand-the-<details> friction) and must surface the
      // curated fixture IDs grouped by tier, mirroring the per-row
      // Trash (Task #245) and batch-confirm (Task #344) previews.
      const matches = panel.getByTestId("handwavy-edit-preview-matches");
      await expect(matches).toBeVisible();
      const curatedMatches = matches.getByTestId(
        "handwavy-remove-preview-matches-curated",
      );
      await expect(curatedMatches).toBeVisible();
      await expect(curatedMatches).toContainText("Curated fixtures");
      await expect(
        curatedMatches.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T1_LEGIT",
        ),
      ).toContainText("fixture-001");
      await expect(
        curatedMatches.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T3_SLOP",
        ),
      ).toContainText("fixture-002");

      // The shared `BulkRemovalImpactBlock` renderer's collapsed
      // <details> sample-match list MUST no longer render alongside
      // the inline block — Task #491 deleted the legacy default-true
      // branch once all three callers wired the inline renderer in.
      await expect(
        panel
          .getByTestId("handwavy-bulk-preview-curated")
          .locator("details", {
            hasText: "fixtures that would lose their flag",
          }),
      ).toHaveCount(0);

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
      await cleanup(apiCtx, [original, renamed], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  // Task #465 — Task #327 locked in the production-scan timestamp range
  // ("Scanned N reports from <oldest> to <newest>") for the add-phrase
  // preview and the per-row Trash (single-remove) preview. The rename
  // preview reuses the same shared `BulkRemovalImpactBlock` and so
  // already produces the line in practice, but no e2e assertion guarded
  // it. This test stubs the rename dryRun=true DELETE response with
  // non-null production `oldestCreatedAt`/`newestCreatedAt`, opens the
  // rename impact preview from the per-row Edit, and asserts the
  // production block's range subtitle renders with the "Scanned N
  // reports from <…> to <…>" shape — and that the curated-side
  // null-timestamps graceful-degradation branch keeps the curated range
  // testid out of the DOM.
  test("rename impact preview production block renders the 'Scanned N reports from … to …' line and gracefully omits the curated range when timestamps are null (Task #465)", async ({
    page,
  }) => {
    // Distinct calendar days so `formatProductionScanRange` returns the
    // "from <…> to <…>" branch rather than collapsing to "on <date>".
    // Both ISO strings are UTC midnight so the rendered date may shift
    // one day in negative-offset locales — the assertions below match
    // the structural shape and the year, both of which are
    // locale-stable. Mirrors the constants used in the Task #327 spec.
    const OLDEST_ISO = "2026-04-01T00:00:00.000Z";
    const NEWEST_ISO = "2026-04-29T00:00:00.000Z";

    const apiCtx = await newApiContext();
    const original = uniquePhrase("task247 rename", "range-from");
    const renamed = uniquePhrase("task247 rename", "range-to");

    try {
      // Need a real row in the active list so the per-row Edit affordance
      // is mounted; the dryRun=true DELETE is intercepted below so the
      // synthesized impact (with timestamps) drives the rendered panel.
      await addPhrase(apiCtx, original, { reviewer: REVIEWER });

      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string }
            | undefined;
          if (!body?.dryRun || body.phrase !== original) {
            await route.fallback();
            return;
          }
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
                // Curated half: validDetectionsLost > 0 so the rename
                // preview panel mounts (zero-impact renames apply in
                // one click and skip the panel entirely), and null
                // timestamps exercise the graceful-degradation branch
                // — the curated-range testid must NOT appear in DOM.
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
                production: {
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
                  corpusSize: 412,
                  oldestCreatedAt: OLDEST_ISO,
                  newestCreatedAt: NEWEST_ISO,
                },
                productionError: null,
                productionLimit: 2000,
              },
              phrases: [],
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Use the stable `data-handwavy-phrase` attribute (Task #491)
      // rather than `hasText: original` so the locator keeps matching
      // after Edit click — once edit mode swaps the phrase span for a
      // textbox, the phrase only lives in the input value (not in
      // textContent), and a `hasText` filter would lose its match.
      const row = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${original}"]`,
      );
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open Edit, rename, save — the panel should appear because the
      // synthetic dry-run reports 1 valid detection lost on the curated
      // half.
      await row.getByTestId("handwavy-edit").click();
      await row.getByTestId("handwavy-edit-phrase").fill(renamed);
      await row.getByTestId("handwavy-edit-save").click();

      const panel = page.getByTestId("handwavy-edit-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // The rename preview uses the shared `BulkRemovalImpactBlock`,
      // which tags its scan-range subtitle with the kind-suffixed
      // testid. The production block must render the same "Scanned N
      // reports from … to …" shape that the bulk-preview and
      // single-remove blocks do.
      const productionRange = panel.getByTestId(
        "handwavy-bulk-preview-production-range",
      );
      await expect(productionRange).toBeVisible();
      await expect(productionRange).toContainText("Scanned 412 reports");
      await expect(productionRange).toContainText(/from .+ to .+/);
      await expect(productionRange).toContainText("2026");

      // Graceful degradation: the curated block returned null
      // timestamps, so its kind-suffixed range testid must not exist
      // anywhere in the panel.
      await expect(
        panel.getByTestId("handwavy-bulk-preview-curated-range"),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [original, renamed], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  // Task #496 (rebased onto Task #491) — Task #345 added inline context
  // snippets next to each sample-match ID on the per-row Trash preview's
  // `HandwavyRemovePreviewMatches` block so reviewers can judge an
  // un-flag in place without leaving the page. Task #496 originally
  // ALSO extended the shared `BulkRemovalImpactBlock` renderer's own
  // collapsed `<details>` sample-match list ("Sample {sourceNoun}s that
  // would lose their flag (N)") to render the snippet inline. Task
  // #491 then deleted that legacy `<details>` block entirely once all
  // three callers (per-row Trash, batch-confirm, edit-rename) wired
  // the inline `HandwavyRemovePreviewMatches` renderer in directly.
  // The judge-in-place affordance therefore now lives exclusively on
  // the inline block — this test pins the same Task #496 contract
  // against that inline renderer on the rename flow:
  //   * the snippet renders next to its ID with the surrounding text
  //     (`before`/`after`) plain and the matched phrase wrapped in a
  //     <mark> for highlighting (matching the per-row Trash treatment),
  //   * a sample-match without a snippet does NOT render an empty /
  //     dangling snippet element next to its ID,
  //   * React text-rendering escapes raw HTML in the snippet body so
  //     the literal text appears (no SVG element is injected),
  //   * the production half follows the same shape,
  //   * the legacy `<details>` block stays out of the DOM (Task #491).
  test("rename impact preview's inline sample-match block renders the snippet with the matched phrase highlighted (Task #496 / Task #491)", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const original = uniquePhrase("snippet-from");
    const renamed = uniquePhrase("snippet-to");

    try {
      await addPhrase(apiCtx, original);

      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | { dryRun?: boolean; phrase?: string }
            | undefined;
          if (!body?.dryRun || body.phrase !== original) {
            await route.fallback();
            return;
          }
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
                    t1Legit: 1,
                    t2Borderline: 1,
                    t3Slop: 1,
                    t4Hallucinated: 1,
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
                    // Snippetless sibling — must NOT render a dangling
                    // snippet element next to its ID.
                    {
                      id: "fixture-T2-beta",
                      tier: "T2_BORDERLINE",
                      snippet: null,
                    },
                  ],
                  warning:
                    "2 legitimate detections would be lost from the curated benchmark",
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
                      // Includes a literal `<svg>` substring to verify
                      // the snippet text is rendered via React (which
                      // escapes angle brackets) rather than as raw HTML.
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
              phrases: [],
            }),
          });
        },
      );

      await injectCalibrationTokenIntoPage(page);
      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      // Use the stable `data-handwavy-phrase` attribute (Task #491)
      // rather than `hasText: original` so the locator keeps matching
      // after Edit click — once edit mode swaps the phrase span for a
      // textbox, the phrase only lives in the input value (not in
      // textContent), and a `hasText` filter would lose its match.
      const row = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${original}"]`,
      );
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open Edit, rename, save — the panel mounts because the synthetic
      // dry-run reports valid detections lost on both halves.
      await row.getByTestId("handwavy-edit").click();
      await row.getByTestId("handwavy-edit-phrase").fill(renamed);
      await row.getByTestId("handwavy-edit-save").click();

      const panel = page.getByTestId("handwavy-edit-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Task #491 — the inline `HandwavyRemovePreviewMatches` block now
      // renders right under the impact summary and is the SOLE surface
      // for sample-match snippets on the rename preview (the legacy
      // `<details>` was deleted from `BulkRemovalImpactBlock`).
      const matches = panel.getByTestId("handwavy-edit-preview-matches");
      await expect(matches).toBeVisible();

      // Curated half — assert the snippet renders next to its ID with
      // the matched phrase wrapped in a <mark>. The snippetless sibling
      // must NOT render a snippet element.
      const curatedMatches = matches.getByTestId(
        "handwavy-remove-preview-matches-curated",
      );
      await expect(curatedMatches).toBeVisible();

      const curatedSnippet = curatedMatches.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-fixture-T1-alpha",
      );
      await expect(curatedSnippet).toBeVisible();
      await expect(curatedSnippet).toContainText("the report says");
      await expect(curatedSnippet).toContainText("has fired here");

      const curatedMark = curatedMatches.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-mark-fixture-T1-alpha",
      );
      await expect(curatedMark).toBeVisible();
      await expect(curatedMark).toHaveText("MAGIC PHRASE");
      // The mark element is a real <mark> tag so screen readers and any
      // user CSS targeting the highlight get the correct semantics.
      await expect(curatedMark).toHaveJSProperty("tagName", "MARK");

      // Snippetless sibling — its bare ID still renders inside the
      // inline list but no snippet element is rendered next to it.
      await expect(curatedMatches).toContainText("fixture-T2-beta");
      await expect(
        curatedMatches.getByTestId(
          "handwavy-remove-preview-matches-curated-snippet-fixture-T2-beta",
        ),
      ).toHaveCount(0);

      // Production half — assert the same shape on the inline production
      // block, plus the React-escaping guard for the literal `<svg>`
      // substring in the snippet's `before` field (a naive innerHTML
      // render would inject an SVG element into the DOM).
      const productionMatches = matches.getByTestId(
        "handwavy-remove-preview-matches-production",
      );
      await expect(productionMatches).toBeVisible();

      const productionSnippet = productionMatches.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-9001",
      );
      await expect(productionSnippet).toBeVisible();
      await expect(productionSnippet).toContainText("about CVE-1234");
      await expect(productionSnippet).toContainText("<svg>");
      await expect(productionSnippet.locator("svg")).toHaveCount(0);

      const productionMark = productionMatches.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-mark-9001",
      );
      await expect(productionMark).toHaveText("fishy claim");
      await expect(productionMark).toHaveJSProperty("tagName", "MARK");

      // Task #491 — the legacy `<details>` block on either side of the
      // shared `BulkRemovalImpactBlock` MUST no longer render — its
      // snippet rendering migrated to the inline block above.
      await expect(
        panel
          .getByTestId("handwavy-bulk-preview-curated")
          .locator("details", {
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
      // The legacy testids the deleted block used to emit must NOT
      // appear anywhere in the panel.
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
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the rename impact preview cancels without firing the live PATCH", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const original = uniquePhrase("task247 rename", "backout-from");
    const renamed = uniquePhrase("task247 rename", "backout-to");

    try {
      await addPhrase(apiCtx, original, { reviewer: REVIEWER });

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

      // Use the stable `data-handwavy-phrase` attribute (Task #491)
      // rather than `hasText: original` so the locator keeps matching
      // after Edit click — once edit mode swaps the phrase span for a
      // textbox, the phrase only lives in the input value (not in
      // textContent), and a `hasText` filter would lose its match.
      const row = page.locator(
        `[data-testid="handwavy-row"][data-handwavy-phrase="${original}"]`,
      );
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
      await cleanup(apiCtx, [original, renamed], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });
});
