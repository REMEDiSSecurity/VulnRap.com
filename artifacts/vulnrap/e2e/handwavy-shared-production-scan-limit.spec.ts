import { test, expect, type Page } from "@playwright/test";
import {
  addPhrase,
  cleanup,
  injectCalibrationTokenIntoPage,
  newApiContext,
  uniquePhrase,
} from "./helpers/handwavy";

// Task #230 — the production-scan window persisted in the calibration UI is
// the same value across every tool that runs a production-archive scan, not
// just the add-phrase preview. This spec exercises the cross-tool wiring:
//
//   1. The localStorage key is the calibration-namespaced one
//      (`vulnrap.calibration.productionScanLimit`), and the legacy
//      `vulnrap.handwavy.productionScanLimit` value is migrated on first
//      read so reviewers who tuned the window pre-#230 keep their value.
//   2. The chosen value is sent on the add-phrase dry-run POST body
//      (existing Task #125 behavior, regression-guard here so the rename
//      doesn't quietly drop the field).
//   3. The chosen value is sent on the single-phrase DELETE dry-run body
//      (new Task #230 behavior).
//   4. The chosen value is sent on the batch DELETE dry-run body (new
//      Task #230 behavior).
//
// Each assertion intercepts the outgoing request and inspects the body so
// the test passes/fails on whether the UI actually plumbed the value
// through, independent of any server response shape.

const REVIEWER = "e2e-task230";
const CLEANUP_REVIEWER = "e2e-task230-cleanup";

const LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
const LEGACY_LIMIT_KEY = "vulnrap.handwavy.productionScanLimit";

// Pre-seed the limit key so the calibration page picks it up on first
// render, with the rendered input pulling from localStorage in its
// useState initializer.
async function setStoredLimit(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  await page.addInitScript(
    ([k, v]) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        // ignore storage failures (private mode, quota)
      }
    },
    [key, value] as const,
  );
}

test.describe("Task #230 shared production-scan window", () => {
  test("legacy `vulnrap.handwavy.productionScanLimit` value is migrated to the calibration-namespaced key on first read", async ({
    page,
  }) => {
    // Seed only the legacy key — the new key is absent. The page should
    // copy it across to the new key and clear the legacy one on first
    // load.
    await setStoredLimit(page, LEGACY_LIMIT_KEY, "1234");
    await injectCalibrationTokenIntoPage(page);
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    // The shared input renders with the migrated value.
    const input = page.getByTestId("handwavy-production-scan-limit");
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(input).toHaveValue("1234");

    // The legacy key has been cleared and the new key now holds the value.
    const after = await page.evaluate(
      ([newKey, legacyKey]) => ({
        next: window.localStorage.getItem(newKey),
        legacy: window.localStorage.getItem(legacyKey),
      }),
      [LIMIT_KEY, LEGACY_LIMIT_KEY] as const,
    );
    expect(after.next).toBe("1234");
    expect(after.legacy).toBeNull();
  });

  test("non-default limit propagates to the single-phrase DELETE dry-run request body", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task230", "single");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });
      // Pre-seed the limit so the input renders with the value already
      // applied; this proves the localStorage value (not just a typed
      // value) flows through to the DELETE preview.
      await setStoredLimit(page, LIMIT_KEY, "750");
      await injectCalibrationTokenIntoPage(page);

      // Capture the productionScanLimit on every dryRun DELETE request
      // and short-circuit the response so we don't accidentally trigger
      // the live UI flow downstream.
      const captured: Array<number | undefined> = [];
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | {
                dryRun?: boolean;
                phrase?: string;
                productionScanLimit?: number;
              }
            | undefined;
          if (body?.dryRun === true && body.phrase === phrase) {
            captured.push(body.productionScanLimit);
            // Synthesize a no-impact preview so the UI fires the live
            // DELETE in the same click; we don't care about the live
            // call here, only the dry-run body.
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
                total: 1,
                projectedTotal: 0,
                results: [{ raw: phrase, phrase, removed: true }],
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
                    corpusSize: 0,
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
                    corpusSize: 0,
                    oldestCreatedAt: null,
                    newestCreatedAt: null,
                  },
                  productionError: null,
                  productionLimit: body.productionScanLimit ?? 2000,
                },
                phrases: [],
              }),
            });
            return;
          }
          await route.fallback();
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      // Sanity: the input picked up the seeded value.
      await expect(
        page.getByTestId("handwavy-production-scan-limit"),
      ).toHaveValue("750");

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      // The dry-run body must include our seeded limit.
      await expect
        .poll(() => captured.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(captured[0]).toBe(750);
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("non-default limit propagates to the batch DELETE dry-run request body", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrases = [
      uniquePhrase("task230", "batch1"),
      uniquePhrase("task230", "batch2"),
    ];

    try {
      for (const p of phrases)
        await addPhrase(apiCtx, p, { reviewer: REVIEWER });
      await setStoredLimit(page, LIMIT_KEY, "5000");
      await injectCalibrationTokenIntoPage(page);

      const captured: Array<number | undefined> = [];
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | {
                dryRun?: boolean;
                phrases?: string[];
                productionScanLimit?: number;
              }
            | undefined;
          const allOurs = Array.isArray(body?.phrases)
            ? body.phrases.every((p) => phrases.includes(p))
            : false;
          if (body?.dryRun === true && allOurs) {
            captured.push(body.productionScanLimit);
          }
          await route.fallback();
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await expect(
        page.getByTestId("handwavy-production-scan-limit"),
      ).toHaveValue("5000");

      // Tick both rows then open the bulk preview.
      for (const phrase of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: phrase });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();

      await expect
        .poll(() => captured.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      expect(captured[0]).toBe(5000);

      // The preview panel's production-block subtitle should call out the
      // 5000-report window we just sent — proving the value also flows
      // back through the rendered subtitle.
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText(/up to 5000 reports/);
    } finally {
      await cleanup(apiCtx, phrases, { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });

  test("default limit (2000) is omitted from the request body so the legacy shape is preserved", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task230", "default");

    try {
      await addPhrase(apiCtx, phrase, { reviewer: REVIEWER });
      // No localStorage seed → default applies.
      await injectCalibrationTokenIntoPage(page);

      const dryRunBodies: Array<{ has: boolean; value: number | undefined }> =
        [];
      await page.route(
        "**/api/feedback/calibration/handwavy-phrases",
        async (route) => {
          const req = route.request();
          if (req.method() !== "DELETE") {
            await route.fallback();
            return;
          }
          const body = req.postDataJSON() as
            | {
                dryRun?: boolean;
                phrase?: string;
                productionScanLimit?: number;
              }
            | undefined;
          if (body?.dryRun === true && body.phrase === phrase) {
            dryRunBodies.push({
              has:
                body !== undefined &&
                Object.prototype.hasOwnProperty.call(
                  body,
                  "productionScanLimit",
                ),
              value: body.productionScanLimit,
            });
          }
          await route.fallback();
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await expect(
        page.getByTestId("handwavy-production-scan-limit"),
      ).toHaveValue("2000");

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      await expect
        .poll(() => dryRunBodies.length, { timeout: 15_000 })
        .toBeGreaterThan(0);
      // Default value is intentionally omitted to keep the request body
      // identical to the pre-Task-#230 shape.
      expect(dryRunBodies[0].has).toBe(false);
      expect(dryRunBodies[0].value).toBeUndefined();
    } finally {
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });
});

// Task #327 — every dry-run preview that runs a production scan already
// surfaces the limit subtitle ("last N of up to LIMIT reports"), but the
// reviewer also needs to see the actual createdAt window of the rows that
// were scanned so they can verify they're scoring against the period they
// think they are. The bulk-remove preview's `BulkRemovalImpactBlock` has
// rendered the "Scanned N reports from <oldest> to <newest>" line since
// Task #218 (locked in for the per-row Trash flow by Task #293), and the
// add-phrase preview's `PreviewMatchBlock` has rendered the same line
// since Task #124. This describe block locks both consumers' visible
// behavior in one place so a future refactor that drops either renderer's
// scan-range subtitle (or breaks the graceful degradation when the
// dry-run returns null timestamps) fails here loudly.
test.describe("Task #327 production-scan timestamp range surfaced on every preview", () => {
  // Distinct calendar days so `formatProductionScanRange` returns the
  // "from <…> to <…>" branch rather than collapsing to "on <date>". Both
  // ISO strings are UTC midnight so the rendered date may shift one day
  // in negative-offset locales — the assertions below match the
  // structural shape and the year, both of which are locale-stable.
  const OLDEST_ISO = "2026-04-01T00:00:00.000Z";
  const NEWEST_ISO = "2026-04-29T00:00:00.000Z";

  test("add-phrase preview production block renders the 'Scanned N reports from … to …' line", async ({
    page,
  }) => {
    const phrase = uniquePhrase("task230", "addrange");

    // Intercept the add-phrase dryRun POST and synthesize a preview whose
    // production block carries an explicit createdAt window. We don't add
    // the phrase to the live list — the preview opens off the dry-run
    // POST alone, so a stubbed response is sufficient and avoids the
    // real-server dependency on archive timestamps.
    await page.route(
      "**/api/feedback/calibration/handwavy-phrases",
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") {
          await route.fallback();
          return;
        }
        const body = req.postDataJSON() as
          | { dryRun?: boolean; phrase?: string; category?: string }
          | undefined;
        if (!body?.dryRun || body.phrase !== phrase) {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dryRun: true,
            added: false,
            phrase,
            category: body.category ?? "absence",
            total: 42,
            phrases: [],
            // Curated block intentionally has null timestamps — the
            // graceful-degradation half of the contract: the range
            // subtitle MUST stay out of the DOM here.
            dryRunMatches: {
              total: 0,
              byTier: {
                t1Legit: 0,
                t2Borderline: 0,
                t3Slop: 0,
                t4Hallucinated: 0,
              },
              falsePositives: 0,
              corpusSize: 50,
              sampleMatches: [],
              warning: null,
              oldestCreatedAt: null,
              newestCreatedAt: null,
            },
            // Production block carries the createdAt window — the range
            // subtitle MUST render with the corpus size, plural noun
            // ("reports"), and the "from <…> to <…>" date pair.
            dryRunMatchesProduction: {
              total: 0,
              byTier: {
                t1Legit: 0,
                t2Borderline: 0,
                t3Slop: 0,
                t4Hallucinated: 0,
              },
              falsePositives: 0,
              corpusSize: 273,
              sampleMatches: [],
              warning: null,
              oldestCreatedAt: OLDEST_ISO,
              newestCreatedAt: NEWEST_ISO,
            },
            dryRunMatchesProductionError: null,
            dryRunMatchesProductionLimit: 2000,
            dryRunOverlaps: { total: 0, matches: [] },
          }),
        });
      },
    );

    await injectCalibrationTokenIntoPage(page);
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    await page.getByTestId("handwavy-input").fill(phrase);
    await page.getByTestId("handwavy-add").click();

    const panel = page.getByTestId("handwavy-preview");
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const productionBlock = panel.getByTestId("handwavy-preview-production");
    await expect(productionBlock).toBeVisible();

    const productionRange = productionBlock.getByTestId(
      "handwavy-preview-production-range",
    );
    await expect(productionRange).toBeVisible();
    // Corpus size + pluralised noun ("reports") + the "from … to …"
    // structural shape produced by `formatProductionScanRange` for
    // distinct calendar days. Year-stable across locales.
    await expect(productionRange).toContainText("Scanned 273 reports");
    await expect(productionRange).toContainText(/from .+ to .+/);
    await expect(productionRange).toContainText("2026");

    // Graceful degradation: the curated block's null timestamps must
    // not produce a range subtitle in the DOM at all. Asserted at the
    // panel scope so a regression that accidentally rendered the line
    // on the curated half would also fail here.
    await expect(
      panel.getByTestId("handwavy-preview-curated-range"),
    ).toHaveCount(0);
  });

  test("single-remove preview production block renders the 'Scanned N reports from … to …' line", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("task230", "rmrange");

    try {
      // Need a real row in the active list so the per-row Trash button
      // is mounted; the dryRun DELETE is intercepted below so the
      // synthesized impact (with timestamps) drives the rendered panel.
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
            | { dryRun?: boolean; phrase?: string }
            | undefined;
          if (!body?.dryRun || body.phrase !== phrase) {
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
              phrase,
              raw: phrase,
              removed: true,
              reason: null,
              total: 99,
              projectedTotal: 98,
              results: [{ raw: phrase, phrase, removed: true }],
              dryRunImpact: {
                // Curated half: validDetectionsLost > 0 forces the
                // preview panel to mount (zero-impact removals skip
                // the panel and fire directly), and null timestamps
                // exercise the graceful-degradation branch.
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
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      const panel = page.getByTestId("handwavy-remove-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });

      // Per-row Trash uses the shared `BulkRemovalImpactBlock`, which
      // tags its scan-range subtitle with the kind-suffixed testid. The
      // production block must render the same "Scanned N reports from
      // … to …" shape that the bulk-preview block does.
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
      await cleanup(apiCtx, [phrase], { reviewer: CLEANUP_REVIEWER });
      await apiCtx.dispose();
    }
  });
});
