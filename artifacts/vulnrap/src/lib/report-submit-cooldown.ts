// Task #417 — report-submit page cooldown state derived from HTTP 429
// responses observed by the shared API client.
//
// Background: the API server protects `/api/reports` (file/raw/URL submit)
// and `/api/reports/check` with two stacked rate limiters
// (artifacts/api-server/src/app.ts):
//   - `submitLimiter` — coarse 5000/15min window mounted via
//     `app.use("/api/reports", …)`, applies to every nested route.
//   - `analysisLimiter` — tight 30/15min window on the POST endpoints
//     that actually run the scoring pipeline.
//
// When either bucket trips the home-page submit flow used to bubble the
// raw `ApiError` into a destructive toast that read "HTTP 429 Too Many
// Requests…" — the same poor UX the calibration screens used to suffer
// from before Task #212. This store wires the home-page submit flow into
// the same friendly countdown banner the calibration screens use, by
// filtering the shared rate-limit observer to URLs that include
// `/api/reports`.
//
// `/api/reports` is broad enough to also catch the `/api/reports/check`
// path (which shares the analysis limiter), which is exactly what we
// want — a reviewer who exhausts the analysis bucket on `check` should
// see the same "wait N seconds" guidance they'd see on `submit`, since
// the underlying bucket is shared.

import {
  createRateLimitCooldown,
  type RateLimitCooldownState,
} from "./rate-limit-cooldown";

const REPORT_SUBMIT_PATH_FRAGMENT = "/api/reports";

const reportSubmitStore = createRateLimitCooldown({
  urlPrefixes: REPORT_SUBMIT_PATH_FRAGMENT,
});

/**
 * Snapshot returned by `useReportSubmitCooldown`. Aliased to the generic
 * shape so call sites that import the type don't have to know about the
 * underlying factory.
 */
export type ReportSubmitCooldownState = RateLimitCooldownState;

/**
 * Apply a 429 notice to the report-submit cooldown state. Exported for
 * tests; the production path goes through the shared rate-limit observer
 * subscription wired up inside `createRateLimitCooldown`.
 */
export const applyReportSubmitRateLimitNotice =
  reportSubmitStore.applyRateLimitNotice;

/** Reset the cooldown to the initial (inactive) state. Exported for tests. */
export const resetReportSubmitCooldown = reportSubmitStore.resetCooldown;

/** Re-evaluate the countdown against the current clock. Exported for tests. */
export const tickReportSubmitCooldown = reportSubmitStore.tickCooldown;

/**
 * React hook that returns the current report-submit cooldown state and
 * re-renders once per ~500ms while the cooldown is active so the
 * countdown ticks down in place.
 *
 * Consumers typically:
 *   - Render `<ReportSubmitCooldownBanner state={cooldown} />` when
 *     `state.active` is true (the banner returns `null` while inactive).
 *   - Disable the submit button via `disabled={state.active || …}`.
 */
export const useReportSubmitCooldown = reportSubmitStore.useCooldown;
