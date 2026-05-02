import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { injectCalibrationTokenIntoPage } from "./helpers/handwavy";

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

    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const original = uniquePhrase("range-from");
    const renamed = uniquePhrase("range-to");

    try {
      // Need a real row in the active list so the per-row Edit affordance
      // is mounted; the dryRun=true DELETE is intercepted below so the
      // synthesized impact (with timestamps) drives the rendered panel.
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

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: original });
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
      await cleanup(apiCtx, [original, renamed]);
      await apiCtx.dispose();
    }
  });

  // Task #496 — Task #345 added inline context snippets next to each
  // sample-match ID on the per-row Trash preview's
  // `HandwavyRemovePreviewMatches` block so reviewers can judge an
  // un-flag in place without leaving the page. The shared
  // `BulkRemovalImpactBlock` renderer's OWN, older sample-match list
  // inside its collapsed `<details>` ("Sample {sourceNoun}s that would
  // lose their flag (N)") only displayed bare IDs. The bulk-retire
  // and per-row Trash flows already pass `hideSampleMatchesDetails`
  // to suppress that legacy block (they render the inline matches
  // block separately), so the only flow that surfaces the legacy
  // `<details>` in real usage today is the per-row edit-then-rename
  // preview. This test stubs the rename dryRun=true DELETE response
  // with a sampleMatches array carrying snippets on the curated side
  // (one with a snippet, one without) and on the synthetic production
  // side, expands the curated `<details>`, and asserts that:
  //   * the snippet renders next to its ID with the surrounding text
  //     (`before`/`after`) plain and the matched phrase wrapped in a
  //     <mark> for highlighting (matching the per-row Trash treatment),
  //   * a sample-match without a snippet does NOT render an empty /
  //     dangling snippet element next to its ID,
  //   * React text-rendering escapes raw HTML in the snippet body so
  //     the literal text appears (no SVG element is injected),
  //   * the production `<details>` rendering follows the same shape.
  test("rename impact preview's collapsed sample-match `<details>` renders the snippet with the matched phrase highlighted (Task #496)", async ({
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

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: original });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // Open Edit, rename, save — the panel mounts because the synthetic
      // dry-run reports valid detections lost on both halves.
      await row.getByTestId("handwavy-edit").click();
      await row.getByTestId("handwavy-edit-phrase").fill(renamed);
      await row.getByTestId("handwavy-edit-save").click();

      const panel = page.getByTestId("handwavy-edit-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Curated half — expand the legacy `<details>` and assert the
      // snippet renders next to its ID with the matched phrase wrapped
      // in a <mark>. The snippetless sibling must NOT render a snippet
      // element.
      const curatedBlock = panel.getByTestId("handwavy-bulk-preview-curated");
      const curatedDetails = curatedBlock.locator("details", {
        hasText: "fixtures that would lose their flag",
      });
      await expect(curatedDetails).toHaveCount(1);
      await curatedDetails.locator("summary").click();

      const curatedSnippet = curatedBlock.getByTestId(
        "handwavy-bulk-preview-curated-sample-snippet-fixture-T1-alpha",
      );
      await expect(curatedSnippet).toBeVisible();
      await expect(curatedSnippet).toContainText("the report says");
      await expect(curatedSnippet).toContainText("has fired here");

      const curatedMark = curatedBlock.getByTestId(
        "handwavy-bulk-preview-curated-sample-snippet-mark-fixture-T1-alpha",
      );
      await expect(curatedMark).toBeVisible();
      await expect(curatedMark).toHaveText("MAGIC PHRASE");
      // The mark element is a real <mark> tag so screen readers and any
      // user CSS targeting the highlight get the correct semantics.
      await expect(curatedMark).toHaveJSProperty("tagName", "MARK");

      // Snippetless sibling — its bare ID is in the list but no snippet
      // element is rendered next to it.
      await expect(curatedDetails).toContainText("fixture-T2-beta");
      await expect(
        curatedBlock.getByTestId(
          "handwavy-bulk-preview-curated-sample-snippet-fixture-T2-beta",
        ),
      ).toHaveCount(0);

      // Production half — expand its legacy `<details>` and assert the
      // same shape, plus the React-escaping guard for the literal `<svg>`
      // substring in the snippet's `before` field (a naive innerHTML
      // render would inject an SVG element into the DOM).
      const productionBlock = panel.getByTestId(
        "handwavy-bulk-preview-production",
      );
      const productionDetails = productionBlock.locator("details", {
        hasText: "reports that would lose their flag",
      });
      await expect(productionDetails).toHaveCount(1);
      await productionDetails.locator("summary").click();

      const productionSnippet = productionBlock.getByTestId(
        "handwavy-bulk-preview-production-sample-snippet-9001",
      );
      await expect(productionSnippet).toBeVisible();
      await expect(productionSnippet).toContainText("about CVE-1234");
      await expect(productionSnippet).toContainText("<svg>");
      await expect(productionSnippet.locator("svg")).toHaveCount(0);

      const productionMark = productionBlock.getByTestId(
        "handwavy-bulk-preview-production-sample-snippet-mark-9001",
      );
      await expect(productionMark).toHaveText("fishy claim");
      await expect(productionMark).toHaveJSProperty("tagName", "MARK");
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
