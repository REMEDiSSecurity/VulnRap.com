import { test, expect } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

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
//
// Including "task173" + a UUID in every seeded phrase (via the shared
// `uniquePhrase` helper, prefix `"task173 preview"`) makes accidental
// fixture / production overlap effectively impossible, which guarantees
// a deterministic "no real detections lost" preview for the happy-path
// test that must short-circuit to the live DELETE.

const REVIEWER = "e2e-task173";
const CLEANUP_REVIEWER = "e2e-task173-cleanup";

test.describe("Single-phrase removal-impact preview (Task #173)", () => {
  test("phrase with zero impact still removes in one click without showing the preview panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "zero-impact");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("phrase whose dryRun reports valid detections lost surfaces the impact panel and gates the live DELETE behind the acknowledgment checkbox", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "ack");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
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
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "inline-matches");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
                      {
                        id: "fixture-T1-alpha",
                        tier: "T1_LEGIT",
                        // Task #345 — server-supplied context snippet so a
                        // reviewer can judge the row in place.
                        snippet: {
                          before: "the report says ",
                          match: "MAGIC PHRASE",
                          after: " has fired here",
                        },
                      },
                      { id: "fixture-T2-beta", tier: "T2_BORDERLINE", snippet: null },
                      { id: "fixture-T3-gamma", tier: "T3_SLOP", snippet: null },
                      { id: "fixture-T4-delta", tier: "T4_HALLUCINATED", snippet: null },
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
                      {
                        id: "9001",
                        tier: "T1_LEGIT",
                        // Task #345 — including a `<` character to verify the
                        // client renders snippet text via React (which escapes
                        // angle brackets) rather than as raw HTML.
                        snippet: {
                          before: "alert(<svg> ",
                          match: "fishy claim",
                          after: " about CVE-1234",
                        },
                      },
                      { id: "9002", tier: "T3_SLOP", snippet: null },
                      { id: "9003", tier: "T4_HALLUCINATED", snippet: null },
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

      // Task #345 — snippets are rendered next to each ID that has one.
      // The matched phrase is wrapped in a <mark> for highlighting; the
      // surrounding text (`before`/`after`) is plain.
      const curatedSnippet = curatedBlock.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-fixture-T1-alpha",
      );
      await expect(curatedSnippet).toBeVisible();
      await expect(curatedSnippet).toContainText("the report says");
      await expect(curatedSnippet).toContainText("has fired here");
      const curatedMark = curatedBlock.getByTestId(
        "handwavy-remove-preview-matches-curated-snippet-mark-fixture-T1-alpha",
      );
      await expect(curatedMark).toBeVisible();
      await expect(curatedMark).toHaveText("MAGIC PHRASE");
      // The mark element is a <mark> tag (so screen readers and any
      // user CSS targeting the highlight get the correct semantics).
      await expect(curatedMark).toHaveJSProperty("tagName", "MARK");

      const productionSnippet = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-9001",
      );
      await expect(productionSnippet).toBeVisible();
      await expect(productionSnippet).toContainText("about CVE-1234");
      const productionMark = productionBlock.getByTestId(
        "handwavy-remove-preview-matches-production-snippet-mark-9001",
      );
      await expect(productionMark).toHaveText("fishy claim");
      // HTML escaping check: the mocked snippet's `before` field contains a
      // literal `<svg>` substring. A naive innerHTML render would inject an
      // SVG element into the DOM; React's text rendering escapes it instead,
      // so the literal text must appear in the rendered snippet.
      await expect(productionSnippet).toContainText("<svg>");
      await expect(productionSnippet.locator("svg")).toHaveCount(0);

      // Sample matches without a snippet must NOT render an empty/dangling
      // snippet element next to their ID.
      await expect(
        curatedBlock.getByTestId(
          "handwavy-remove-preview-matches-curated-snippet-fixture-T2-beta",
        ),
      ).toHaveCount(0);
      await expect(
        productionBlock.getByTestId(
          "handwavy-remove-preview-matches-production-snippet-9002",
        ),
      ).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
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
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "no-matches");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  // Task #346 — server caps `sampleMatches` at 12 entries per tier, so a phrase
  // that hits all four tiers can render up to 48 IDs per corpus inline in the
  // Trash preview, pushing the acknowledgment checkbox and Remove/Back-out
  // buttons below the fold. We default each tier to the first 5 IDs and
  // require the reviewer to opt into the long list per-tier via a "Show all
  // N" toggle so the panel stays compact for large multi-tier dry-runs.
  test("inline sample-match list caps each tier at 5 IDs with a per-tier 'Show all N' toggle", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "show-all-toggle");

    // Fill T3_SLOP with the server's hard cap (12 entries) on both corpora —
    // far above the 5-item default — so the toggle MUST be required for the
    // 6th+ ID to be visible. T1 stays at 1 entry to also assert the toggle
    // is NOT rendered for tiers under the threshold.
    const curatedT3Ids = Array.from(
      { length: 12 },
      (_, i) => `fixture-T3-${String(i + 1).padStart(2, "0")}`,
    );
    const productionT3Ids = Array.from(
      { length: 12 },
      (_, i) => String(7000 + i),
    );

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
                    total: 13,
                    validDetectionsLost: 12,
                    falsePositivesDropped: 1,
                    byTier: {
                      t1Legit: 1,
                      t2Borderline: 0,
                      t3Slop: 12,
                      t4Hallucinated: 0,
                    },
                    sampleMatches: [
                      { id: "fixture-T1-only", tier: "T1_LEGIT" },
                      ...curatedT3Ids.map((id) => ({ id, tier: "T3_SLOP" })),
                    ],
                    warning:
                      "12 legitimate detections would be lost from the curated benchmark",
                    corpusSize: 47,
                    oldestCreatedAt: null,
                    newestCreatedAt: null,
                  },
                  production: {
                    total: 12,
                    validDetectionsLost: 12,
                    falsePositivesDropped: 0,
                    byTier: {
                      t1Legit: 0,
                      t2Borderline: 0,
                      t3Slop: 12,
                      t4Hallucinated: 0,
                    },
                    sampleMatches: productionT3Ids.map((id) => ({
                      id,
                      tier: "T3_SLOP",
                    })),
                    warning:
                      "12 legitimate detections would be lost from the production archive",
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

      // The single T1 entry is under the 5-item threshold — no toggle should
      // be rendered for that tier in either corpus.
      const curatedT1 = panel.getByTestId(
        "handwavy-remove-preview-matches-curated-tier-T1_LEGIT",
      );
      await expect(curatedT1).toBeVisible();
      await expect(curatedT1).toContainText("fixture-T1-only");
      await expect(
        curatedT1.getByTestId(
          "handwavy-remove-preview-matches-curated-tier-T1_LEGIT-toggle",
        ),
      ).toHaveCount(0);

      // The 12-entry T3 tier on the curated side starts collapsed: only the
      // first 5 IDs are visible, the 6th+ are hidden, and a "Show all 12"
      // toggle is offered.
      const curatedT3 = panel.getByTestId(
        "handwavy-remove-preview-matches-curated-tier-T3_SLOP",
      );
      await expect(curatedT3).toBeVisible();
      await expect(curatedT3).toHaveAttribute(
        "data-handwavy-remove-preview-matches-expanded",
        "false",
      );
      for (const id of curatedT3Ids.slice(0, 5)) {
        await expect(
          curatedT3.getByTestId(
            `handwavy-remove-preview-matches-curated-id-${id}`,
          ),
        ).toBeVisible();
      }
      for (const id of curatedT3Ids.slice(5)) {
        await expect(
          curatedT3.getByTestId(
            `handwavy-remove-preview-matches-curated-id-${id}`,
          ),
        ).toHaveCount(0);
      }
      const curatedT3Toggle = curatedT3.getByTestId(
        "handwavy-remove-preview-matches-curated-tier-T3_SLOP-toggle",
      );
      await expect(curatedT3Toggle).toBeVisible();
      await expect(curatedT3Toggle).toHaveText(/Show all 12 \(7 more\)/);
      await expect(curatedT3Toggle).toHaveAttribute("aria-expanded", "false");

      // Production T3 tier: same overflow story, independent of curated.
      const productionT3 = panel.getByTestId(
        "handwavy-remove-preview-matches-production-tier-T3_SLOP",
      );
      await expect(productionT3).toBeVisible();
      await expect(productionT3).toHaveAttribute(
        "data-handwavy-remove-preview-matches-expanded",
        "false",
      );
      for (const id of productionT3Ids.slice(0, 5)) {
        await expect(
          productionT3.getByTestId(
            `handwavy-remove-preview-matches-production-link-${id}`,
          ),
        ).toBeVisible();
      }
      for (const id of productionT3Ids.slice(5)) {
        await expect(
          productionT3.getByTestId(
            `handwavy-remove-preview-matches-production-link-${id}`,
          ),
        ).toHaveCount(0);
      }
      const productionT3Toggle = productionT3.getByTestId(
        "handwavy-remove-preview-matches-production-tier-T3_SLOP-toggle",
      );
      await expect(productionT3Toggle).toBeVisible();

      // Acknowledgment checkbox stays in the DOM and is reachable — the
      // collapsed-by-default behavior is what keeps it above the fold for
      // typical multi-tier dry-runs.
      await expect(
        panel.getByTestId("handwavy-remove-preview-ack-label"),
      ).toBeVisible();

      // Expand only the curated T3 tier — the production T3 toggle's state
      // must not change, proving the per-tier (per-corpus) independence.
      await curatedT3Toggle.click();
      await expect(curatedT3).toHaveAttribute(
        "data-handwavy-remove-preview-matches-expanded",
        "true",
      );
      await expect(curatedT3Toggle).toHaveAttribute("aria-expanded", "true");
      await expect(curatedT3Toggle).toHaveText(/Show fewer/);
      // All 12 curated IDs are now visible.
      for (const id of curatedT3Ids) {
        await expect(
          curatedT3.getByTestId(
            `handwavy-remove-preview-matches-curated-id-${id}`,
          ),
        ).toBeVisible();
      }
      // Production T3 stays collapsed — independent state.
      await expect(productionT3).toHaveAttribute(
        "data-handwavy-remove-preview-matches-expanded",
        "false",
      );
      for (const id of productionT3Ids.slice(5)) {
        await expect(
          productionT3.getByTestId(
            `handwavy-remove-preview-matches-production-link-${id}`,
          ),
        ).toHaveCount(0);
      }

      // Collapsing again returns to the 5-item window.
      await curatedT3Toggle.click();
      await expect(curatedT3).toHaveAttribute(
        "data-handwavy-remove-preview-matches-expanded",
        "false",
      );
      for (const id of curatedT3Ids.slice(5)) {
        await expect(
          curatedT3.getByTestId(
            `handwavy-remove-preview-matches-curated-id-${id}`,
          ),
        ).toHaveCount(0);
      }
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  // Task #293 — Task #218 added a "Scanned N reports from <oldest> to
  // <newest>" line to the bulk hand-wavy phrase removal preview's
  // production block (rendered via `BulkRemovalImpactBlock` with the
  // `handwavy-bulk-preview-production-range` test id). The curated
  // block intentionally never renders this line because curated
  // fixtures carry no wall-clock timestamps. The per-row Trash preview
  // reuses the same renderer, so this spec locks both halves of that
  // asymmetry in: the production block surfaces the scan-range line
  // (with the right corpus size, plural, date range, and testid) when
  // the dry-run carries oldest/newest createdAt; the curated block
  // never grows a `handwavy-bulk-preview-curated-range` testid.
  test("production block renders the scan-range line and the curated block does not (Task #218 / #293)", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "scan-range");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
                  // Curated block carries no wall-clock timestamps, so the
                  // scan-range line MUST stay out of the DOM here.
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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the impact preview panel cancels without firing the live DELETE", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task173 preview", "backout");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });

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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });
});
