// Task #212 — calibration UI cooldown state derived from HTTP 429 responses.
//
// Background: Task #116 added a per-IP throttle on the wrong-token failure
// path of `/api/feedback/calibration/*` mutation routes (window/limits are
// configurable via env). When a reviewer fat-fingers their token a few times
// the server returns:
//   HTTP 429
//   RateLimit-Limit:     <max wrong-token attempts in the window>
//   RateLimit-Remaining: 0
//   RateLimit-Reset:     <seconds until the bucket resets>
//   { "error": "Too many failed calibration auth attempts. ..." }
//
// Before this module the calibration UI just bubbled the raw ApiError up to a
// toast that read "HTTP 429 Too Many Requests…", which gave reviewers no
// indication that the failure was self-imposed and would resolve on its own.
//
// Task #417 generalised the underlying store + hook into
// `createRateLimitCooldown` (in `./rate-limit-cooldown.ts`) so other
// mutation-heavy pages (report-submit, future archetype-history admin)
// can opt in with one mount + one hook subscription. This module is now a
// thin wrapper that pins the calibration URL prefix and re-exports the
// existing names so calibration screens + their tests keep their UX
// without any call-site changes.

import {
  createRateLimitCooldown,
  type RateLimitCooldownState,
} from "./rate-limit-cooldown";

// Path filter — only treat 429s on the calibration mutation namespace as
// calibration cooldowns. Other routes (e.g. /api/reports submit) have their
// own throttles surfaced by their own per-page stores.
const CALIBRATION_PATH_FRAGMENT = "/feedback/calibration/";

const calibrationStore = createRateLimitCooldown({
  urlPrefixes: CALIBRATION_PATH_FRAGMENT,
});

/**
 * Snapshot returned by `useCalibrationCooldown`. Re-exported as a type
 * alias of the generic state shape so call sites that imported
 * `CalibrationCooldownState` keep working unchanged.
 */
export type CalibrationCooldownState = RateLimitCooldownState;

/**
 * Apply a 429 notice to the in-memory calibration cooldown state. Exported
 * for tests and for the rare consumer (e.g. a manual "I just hit 429" code
 * path) that wants to push a notice in directly. Returns the new state
 * snapshot for convenience. Notices on non-calibration URLs are ignored.
 */
export const applyRateLimitNotice = calibrationStore.applyRateLimitNotice;

/** Reset the cooldown to the initial (inactive) state. Exported for tests. */
export const resetCalibrationCooldown = calibrationStore.resetCooldown;

/**
 * Re-evaluate `secondsRemaining` / `active` against the current clock, and
 * either advance the countdown or clear the cooldown if the bucket has
 * elapsed. Idempotent.
 */
export const tickCalibrationCooldown = calibrationStore.tickCooldown;

/**
 * React hook that returns the current calibration cooldown state and
 * re-renders once per ~500ms while the cooldown is active so the
 * countdown ticks down in place.
 *
 * Consumers typically:
 *   - Render `<CalibrationCooldownBanner state={cooldown} />` when
 *     `state.active` is true (the banner returns `null` while inactive).
 *   - Disable mutation buttons via `disabled={state.active || …}`.
 */
export const useCalibrationCooldown = calibrationStore.useCooldown;
