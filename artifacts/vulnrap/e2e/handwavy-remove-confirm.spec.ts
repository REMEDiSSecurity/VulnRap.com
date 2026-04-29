import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Request,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

// Task #152 — End-to-end coverage for the high-thrash single-remove
// confirmation panel introduced in Task #139. The trash button on a phrase
// row routes through `requestRemove(phrase, cycles)` in
// feedback-analytics.tsx; when the phrase has >=2 completed remove+reinstate
// cycles in the audit history, the DELETE is paused behind a confirm panel
// (`handwavy-remove-confirm`) so the reviewer sees the prior cycles before
// triggering what's likely cycle #N+1. Lower-thrash phrases keep firing the
// DELETE immediately, exactly as before.
//
// This spec drives the real UI through three branches:
//   1. >=2 cycles → confirm panel appears with a cycle list, clicking
//      "Remove anyway" deletes the phrase and dismisses the panel.
//   2. >=2 cycles → "Back out" closes the panel without firing a DELETE
//      and the phrase stays on the active list.
//   3. 0 cycles → trash fires the DELETE immediately with no confirm panel.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
// Same default as playwright.config.ts — the strict-auth GET on the
// hand-wavy phrase panel and (when CALIBRATION_TOKEN is set on the API
// server) every mutation requires this header. Direct test API calls
// always send it so seed/cleanup work regardless of which dev mode is up.
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

function newApiContext() {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

interface SingleRemovalResponse {
  removed: boolean;
  phrase: string;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

function uniquePhrase(label: string): string {
  // randomUUID keeps each test run independent of phrases left behind in the
  // dev DB / handwavy-phrases.json. The "task152" prefix makes the seeded
  // entries easy to spot during debugging.
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return `task152 ${label} ${id} phrase`;
}

async function addPhrase(api: APIRequestContext, phrase: string): Promise<void> {
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category: "hedging", reviewer: "e2e-task152" },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

async function removeSingle(api: APIRequestContext, phrase: string): Promise<string> {
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, reviewer: "e2e-task152" },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (single) failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as SingleRemovalResponse;
  const removedAt = body.historyEntry?.removedAt;
  expect(
    typeof removedAt,
    "single removal should produce a history entry with a removedAt timestamp",
  ).toBe("string");
  return removedAt as string;
}

async function reinstate(
  api: APIRequestContext,
  phrase: string,
  removedAt: string,
): Promise<void> {
  const res = await api.post(
    "/api/feedback/calibration/handwavy-phrases/reinstate",
    {
      data: { phrase, removedAt, reviewer: "e2e-task152" },
    },
  );
  expect(
    res.ok(),
    `POST reinstate failed for "${phrase}" @ ${removedAt}: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

// Run `cycles` complete remove+reinstate round-trips on `phrase` so it ends
// up in the active list with `cycles` reinstated rows in the history log.
// Each reinstated row counts as one completed cycle for the purposes of the
// thrash gate in feedback-analytics.tsx.
async function seedCycles(
  api: APIRequestContext,
  phrase: string,
  cycles: number,
): Promise<void> {
  await addPhrase(api, phrase);
  for (let i = 0; i < cycles; i++) {
    const removedAt = await removeSingle(api, phrase);
    await reinstate(api, phrase, removedAt);
  }
}

// Cleans up anything we left behind so a re-run doesn't accumulate audit
// rows. We try to remove every phrase the test added; not-found is fine.
async function cleanup(api: APIRequestContext, phrases: string[]): Promise<void> {
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases, reviewer: "e2e-task152-cleanup" },
    })
    .catch(() => undefined);
}

test.describe("FLAT hand-wavy phrase panel — high-thrash remove confirmation (Task #139)", () => {
  test("phrase with >=2 completed cycles shows the confirm panel and 'Remove anyway' deletes it", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("thrashed");

    try {
      await seedCycles(apiCtx, phrase, 2);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      // The confirm panel is gated behind the click — it must not be open
      // before we press the trash button.
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);

      await row.getByTestId("handwavy-remove").click();

      const confirm = page.getByTestId("handwavy-remove-confirm");
      await expect(confirm).toBeVisible({ timeout: 10_000 });
      // The panel header echoes the phrase so the reviewer can't confuse it
      // with another row.
      await expect(confirm).toContainText(phrase);

      // The cycle list must render one <li> per completed remove+reinstate
      // cycle that we seeded (we did 2).
      const cycleItems = confirm
        .getByTestId("handwavy-remove-confirm-cycles")
        .locator("li");
      await expect(cycleItems).toHaveCount(2);

      // The DELETE has not fired yet — the phrase is still on the active
      // list while the confirm panel is open.
      await expect(row).toHaveCount(1);

      await confirm.getByTestId("handwavy-remove-confirm-go").click();

      // After the round-trip the panel goes away and the phrase is gone
      // from the active list.
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("'Back out' on the high-thrash confirm panel closes it without firing a DELETE", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("backout");

    try {
      await seedCycles(apiCtx, phrase, 2);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });

      await row.getByTestId("handwavy-remove").click();
      const confirm = page.getByTestId("handwavy-remove-confirm");
      await expect(confirm).toBeVisible({ timeout: 10_000 });

      // Watch network traffic from this point on so we can assert no DELETE
      // is issued when the reviewer backs out.
      const deleteCalls: string[] = [];
      const onRequest = (req: Request) => {
        if (
          req.method() === "DELETE" &&
          req.url().includes("/api/feedback/calibration/handwavy-phrases")
        ) {
          deleteCalls.push(req.url());
        }
      };
      page.on("request", onRequest);

      await confirm.getByTestId("handwavy-remove-confirm-cancel").click();
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0, {
        timeout: 10_000,
      });

      // Phrase must still be present.
      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(1);

      // Wait for the network to idle so any DELETE that the cancel handler
      // might have fired asynchronously would already be visible to the
      // request listener. This is more deterministic than a fixed sleep.
      await page.waitForLoadState("networkidle");
      page.off("request", onRequest);
      expect(
        deleteCalls,
        `Back out must not fire a DELETE; saw: ${deleteCalls.join(", ")}`,
      ).toEqual([]);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });

  test("phrase with 0 cycles is removed immediately with no confirm panel", async ({
    page,
  }) => {
    const apiCtx = await newApiContext();
    const phrase = uniquePhrase("control");

    try {
      // Control case: a freshly-added phrase has 0 completed cycles, so the
      // trash button must fire the DELETE immediately without showing the
      // confirm panel at all.
      await addPhrase(apiCtx, phrase);

      await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

      const row = page
        .locator(`[data-testid="handwavy-row"]`)
        .filter({ hasText: phrase });
      await expect(row).toHaveCount(1, { timeout: 15_000 });
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);

      // Watch for any appearance of the confirm panel between the click
      // and the row vanishing — even a brief flash would be a regression.
      let confirmEverAppeared = false;
      const observer = page
        .getByTestId("handwavy-remove-confirm")
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => {
          confirmEverAppeared = true;
        })
        .catch(() => undefined);

      await row.getByTestId("handwavy-remove").click();

      await expect(
        page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
      ).toHaveCount(0, { timeout: 15_000 });
      await observer;
      expect(
        confirmEverAppeared,
        "0-cycle phrase removal must not show the high-thrash confirm panel",
      ).toBe(false);
      await expect(page.getByTestId("handwavy-remove-confirm")).toHaveCount(0);
    } finally {
      await cleanup(apiCtx, [phrase]);
      await apiCtx.dispose();
    }
  });
});
