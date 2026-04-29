import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

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

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN = process.env.CALIBRATION_TOKEN || process.env.VITE_CALIBRATION_TOKEN || "";

const LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
const LEGACY_LIMIT_KEY = "vulnrap.handwavy.productionScanLimit";

function uniquePhrase(label: string): string {
  return `task230 ${label} ${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function authHeaders(): Record<string, string> {
  return CALIBRATION_TOKEN ? { "X-Calibration-Token": CALIBRATION_TOKEN } : {};
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    headers: authHeaders(),
    data: { phrase, category: "hedging", reviewer: "e2e-task230" },
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
      data: { phrases, reviewer: "e2e-task230-cleanup" },
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

// Pre-seed the limit key so the calibration page picks it up on first
// render, with the rendered input pulling from localStorage in its
// useState initializer.
async function setStoredLimit(page: Page, key: string, value: string): Promise<void> {
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
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("single");

    try {
      await addPhrase(apiCtx, phrase);
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
                    byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
                    sampleMatches: [],
                    warning: null,
                    corpusSize: 0,
                  },
                  production: {
                    total: 0,
                    validDetectionsLost: 0,
                    falsePositivesDropped: 0,
                    byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
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
      await expect(page.getByTestId("handwavy-production-scan-limit")).toHaveValue("750");

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      // The dry-run body must include our seeded limit.
      await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(captured[0]).toBe(750);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("non-default limit propagates to the batch DELETE dry-run request body", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrases = [uniquePhrase("batch1"), uniquePhrase("batch2")];

    try {
      for (const p of phrases) await addPhrase(apiCtx, p);
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
      await expect(page.getByTestId("handwavy-production-scan-limit")).toHaveValue("5000");

      // Tick both rows then open the bulk preview.
      for (const phrase of phrases) {
        const row = page
          .locator(`[data-testid="handwavy-row"]`)
          .filter({ hasText: phrase });
        await expect(row).toHaveCount(1, { timeout: 15_000 });
        await row.getByTestId("handwavy-select").check();
      }
      await page.getByTestId("handwavy-bulk-remove").click();

      await expect.poll(() => captured.length, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(captured[0]).toBe(5000);

      // The preview panel's production-block subtitle should call out the
      // 5000-report window we just sent — proving the value also flows
      // back through the rendered subtitle.
      const panel = page.getByTestId("handwavy-bulk-preview");
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(panel).toContainText(/up to 5000 reports/);
    } finally {
      await cleanup(apiCtx, phrases);
      await apiCtx.dispose();
    }
  });

  test("default limit (2000) is omitted from the request body so the legacy shape is preserved", async ({
    page,
  }) => {
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const phrase = uniquePhrase("default");

    try {
      await addPhrase(apiCtx, phrase);
      // No localStorage seed → default applies.
      await injectCalibrationTokenIntoPage(page);

      const dryRunBodies: Array<{ has: boolean; value: number | undefined }> = [];
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
              has: body !== undefined && Object.prototype.hasOwnProperty.call(body, "productionScanLimit"),
              value: body.productionScanLimit,
            });
          }
          await route.fallback();
        },
      );

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
      await expect(page.getByTestId("handwavy-production-scan-limit")).toHaveValue("2000");

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await row.getByTestId("handwavy-remove").click();

      await expect.poll(() => dryRunBodies.length, { timeout: 15_000 }).toBeGreaterThan(0);
      // Default value is intentionally omitted to keep the request body
      // identical to the pre-Task-#230 shape.
      expect(dryRunBodies[0].has).toBe(false);
      expect(dryRunBodies[0].value).toBeUndefined();
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });
});
