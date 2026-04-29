import {
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

// Shared seed/cleanup helpers for the FLAT hand-wavy phrase panel e2e specs.
//
// Each Playwright spec under `artifacts/vulnrap/e2e/` used to re-implement
// its own copy of these (newApiContext / addPhrase / removeSingle /
// reinstate / seedCycles / batchRemove / cleanup), wired against
// `/api/feedback/calibration/handwavy-phrases`. Drift between copies
// (forgetting `X-Calibration-Token`, forgetting to await cleanup, etc.) was
// already showing up by the time Task #152's spec landed as the third copy.
// Centralising them here keeps the seed/cleanup contract honest and lets a
// new `handwavy-*.spec.ts` add real coverage without copying boilerplate.
//
// Helpers in this file:
//   - newApiContext(): a Playwright APIRequestContext pre-loaded with the
//     calibration token header so the strict-auth gate (Task #163) accepts
//     POST/DELETE/reinstate from outside the browser.
//   - addPhrase(api, phrase, opts?): POST /handwavy-phrases.
//   - addPhraseViaUi(page, phrase, opts?): drives the two-step UI add
//     (type → Preview impact → Confirm add) used by the undo specs.
//   - removeSingle(api, phrase, opts?): DELETE one phrase, returns the
//     historyEntry.removedAt timestamp for chaining into reinstate().
//   - reinstate(api, phrase, removedAt, opts?): POST .../reinstate.
//   - seedCycles(api, phrase, cycles, opts?): N complete remove+reinstate
//     round-trips so a phrase ends up in the active list with N reinstated
//     rows in the audit log (used by the high-thrash gate).
//   - batchRemove(api, phrases, opts?): DELETE many, asserts the response
//     looks like a batch removal and returns it (incl. removedAt).
//   - cleanup(api, phrases, opts?): best-effort batch DELETE used in
//     finally blocks; tolerates not-found.
//   - uniquePhrase(prefix, suffix?): randomUUID-backed phrase generator so
//     reruns don't collide with leftover data.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
// Mirror playwright.config.ts default so the strict-auth gate on the
// hand-wavy phrase routes (Task #163, Task #152's CALIBRATION_TOKEN setup)
// accepts our direct API calls in seed/cleanup. CI overrides via
// E2E_CALIBRATION_TOKEN.
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

const DEFAULT_REVIEWER = "e2e-handwavy";

export interface ReviewerOptions {
  /**
   * Reviewer attributed in the audit log entry. Defaults to
   * "e2e-handwavy"; pass a per-spec value (e.g. "e2e-task152") if you
   * want the audit trail to identify which spec wrote the row.
   */
  reviewer?: string;
}

export interface AddPhraseOptions extends ReviewerOptions {
  /**
   * Category for the POST. Defaults to "hedging" — every existing spec
   * was using hedging so this keeps the seeded data uniform.
   */
  category?: string;
}

export interface SingleRemovalResponse {
  removed: boolean;
  phrase: string;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

export interface BatchRemovalResponse {
  batch: true;
  removed: number;
  total: number;
  historyEntry?: { removedAt: string } | null;
}

/**
 * Build an APIRequestContext that already carries the calibration token
 * header. Callers MUST `await ctx.dispose()` (typically in a finally block).
 */
export function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

/**
 * Generate a phrase guaranteed not to collide with leftover data in the
 * dev DB / handwavy-phrases.json. The prefix is meant to identify the
 * spec (e.g. "task152 thrashed"); the optional suffix can disambiguate
 * within a single test (e.g. "older" / "newer").
 */
export function uniquePhrase(prefix: string, suffix?: string): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return suffix ? `${prefix} ${id} ${suffix}` : `${prefix} ${id}`;
}

/**
 * Generate `count` collision-free phrases sharing the same random id.
 * Useful for the batch flows so reviewers can spot a single batch in the
 * audit log by its shared random id.
 */
export function uniquePhrases(count: number, prefix: string): string[] {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return Array.from({ length: count }, (_, i) => `${prefix} ${id} phrase ${i + 1}`);
}

/** POST a single phrase. Asserts the response was 2xx. */
export async function addPhrase(
  api: APIRequestContext,
  phrase: string,
  opts: AddPhraseOptions = {},
): Promise<void> {
  const reviewer = opts.reviewer ?? DEFAULT_REVIEWER;
  const category = opts.category ?? "hedging";
  const res = await api.post("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, category, reviewer },
  });
  expect(
    res.ok(),
    `POST handwavy-phrases failed for "${phrase}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

export interface AddPhraseViaUiOptions {
  /** Category for the dropdown. Defaults to "hedging". */
  category?: string;
  /**
   * Maximum time (ms) to wait for the row to appear after confirm. Defaults
   * to 15s, matching the previous in-spec helper.
   */
  timeout?: number;
}

/**
 * Drive the two-step UI add (type → Preview impact → Confirm add) and wait
 * for the resulting row to land on the active list. Used by the undo specs
 * which need the in-browser flow specifically (a direct API POST would
 * skip the UI's UNDO_WINDOW_MS bookkeeping for the row).
 */
export async function addPhraseViaUi(
  page: Page,
  phrase: string,
  opts: AddPhraseViaUiOptions = {},
): Promise<void> {
  const category = opts.category ?? "hedging";
  const timeout = opts.timeout ?? 15_000;
  const input = page.getByTestId("handwavy-input");
  await input.fill(phrase);
  await page.getByTestId("handwavy-category").selectOption(category);
  await page.getByTestId("handwavy-add").click();
  const confirmBtn = page.getByTestId("handwavy-preview-confirm");
  await expect(confirmBtn).toBeVisible({ timeout });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  // Wait for the row to appear so subsequent typing in the input field
  // doesn't race against the refresh cycle.
  await expect(
    page.locator(`[data-testid="handwavy-row"]`).filter({ hasText: phrase }),
  ).toHaveCount(1, { timeout });
}

/**
 * DELETE a single phrase via the per-phrase removal path. Returns the
 * `historyEntry.removedAt` timestamp so the caller can chain it directly
 * into {@link reinstate}.
 */
export async function removeSingle(
  api: APIRequestContext,
  phrase: string,
  opts: ReviewerOptions = {},
): Promise<string> {
  const reviewer = opts.reviewer ?? DEFAULT_REVIEWER;
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrase, reviewer },
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

/** POST .../reinstate for a previously-removed phrase + its removedAt. */
export async function reinstate(
  api: APIRequestContext,
  phrase: string,
  removedAt: string,
  opts: ReviewerOptions = {},
): Promise<void> {
  const reviewer = opts.reviewer ?? DEFAULT_REVIEWER;
  const res = await api.post(
    "/api/feedback/calibration/handwavy-phrases/reinstate",
    {
      data: { phrase, removedAt, reviewer },
    },
  );
  expect(
    res.ok(),
    `POST reinstate failed for "${phrase}" @ ${removedAt}: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
}

/**
 * Run `cycles` complete remove+reinstate round-trips on `phrase` so it
 * ends up in the active list with `cycles` reinstated rows in the audit
 * history. Each reinstated row counts as one completed cycle for the
 * thrash gate in feedback-analytics.tsx.
 */
export async function seedCycles(
  api: APIRequestContext,
  phrase: string,
  cycles: number,
  opts: ReviewerOptions = {},
): Promise<void> {
  await addPhrase(api, phrase, opts);
  for (let i = 0; i < cycles; i++) {
    const removedAt = await removeSingle(api, phrase, opts);
    await reinstate(api, phrase, removedAt, opts);
  }
}

/**
 * Batch DELETE the supplied phrases. Asserts the response looks like a
 * batch removal (the API key off `phrases` array vs. `phrase` string to
 * decide single vs. batch) and returns it so callers can grab the
 * `historyEntry.removedAt` timestamp the batch group is keyed by.
 */
export async function batchRemove(
  api: APIRequestContext,
  phrases: string[],
  opts: ReviewerOptions = {},
): Promise<BatchRemovalResponse> {
  const reviewer = opts.reviewer ?? DEFAULT_REVIEWER;
  const res = await api.delete("/api/feedback/calibration/handwavy-phrases", {
    data: { phrases, reviewer },
  });
  expect(
    res.ok(),
    `DELETE handwavy-phrases (batch) failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  const body = (await res.json()) as BatchRemovalResponse;
  expect(body.batch).toBe(true);
  expect(body.removed).toBe(phrases.length);
  expect(
    body.historyEntry?.removedAt,
    "batch removal should produce a history entry",
  ).toBeTruthy();
  return body;
}

/**
 * Best-effort cleanup, intended for `finally` blocks. Runs a batch DELETE
 * for the supplied phrases and swallows any error so a re-run doesn't
 * accumulate audit rows even when the test failed mid-flight. Accepts
 * either a single phrase or an array — older specs varied here.
 */
export async function cleanup(
  api: APIRequestContext,
  phrases: string | string[],
  opts: ReviewerOptions = {},
): Promise<void> {
  const list = Array.isArray(phrases) ? phrases : [phrases];
  if (list.length === 0) return;
  const reviewer = opts.reviewer ?? `${DEFAULT_REVIEWER}-cleanup`;
  await api
    .delete("/api/feedback/calibration/handwavy-phrases", {
      data: { phrases: list, reviewer },
    })
    .catch(() => undefined);
}
