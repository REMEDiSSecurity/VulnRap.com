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
// This module subscribes once (at import time) to the shared API client's
// rate-limit observer (`addRateLimitObserver` in custom-fetch.ts), filters
// down to calibration mutation URLs, and exposes a tiny store + React hook
// the calibration UI uses to:
//   1. Render a friendly banner explaining the cooldown ("too many failed
//      attempts — try again in N seconds").
//   2. Disable mutation buttons until the bucket resets.
//
// The store is a plain module-level singleton with a `useSyncExternalStore`
// hook so the banner re-renders every second to count down without mounting
// a separate timer per consumer.

import { useEffect, useSyncExternalStore } from "react";
import {
  addRateLimitObserver,
  type RateLimitNotice,
} from "@workspace/api-client-react";

// Path filter — only treat 429s on the calibration mutation namespace as
// calibration cooldowns. Other routes (e.g. /api/reports submit) have their
// own throttles that surface elsewhere.
const CALIBRATION_PATH_FRAGMENT = "/feedback/calibration/";

/**
 * Snapshot returned by `useCalibrationCooldown`.
 *
 * `active` flips to true once a 429 has been observed and stays true until
 * `resetAt` has elapsed. While active, mutation buttons should be disabled
 * and the banner shown. `secondsRemaining` is the rounded-up integer for
 * display ("try again in 3 seconds"); `resetAt` is the wall-clock deadline.
 *
 * `serverMessage` carries the friendly text the server included in the JSON
 * body so the UI can quote it verbatim — keeping a single canonical message
 * across server, CLI, and UI.
 *
 * `noticeId` is a monotonically increasing counter that bumps on every
 * fresh notice. It's exposed so consumers (e.g. tests, future telemetry)
 * can deduplicate work across renders.
 */
export interface CalibrationCooldownState {
  active: boolean;
  secondsRemaining: number;
  resetAt: number | null;
  serverMessage: string | null;
  limit: number | null;
  noticeId: number;
}

const INITIAL_STATE: CalibrationCooldownState = {
  active: false,
  secondsRemaining: 0,
  resetAt: null,
  serverMessage: null,
  limit: null,
  noticeId: 0,
};

let state: CalibrationCooldownState = INITIAL_STATE;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // Defensive: a misbehaving subscriber must not stall the others.
    }
  }
}

function setState(next: CalibrationCooldownState): void {
  state = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CalibrationCooldownState {
  return state;
}

function isCalibrationMutationUrl(url: string): boolean {
  // The shared client passes us absolute URLs (when the response has a
  // canonical URL) or path-only URLs from the orval-generated callers. Both
  // forms include the calibration namespace fragment when relevant; we
  // intentionally keep the check substring-based so query strings, trailing
  // slashes, and host prefixes don't have to be hand-handled.
  return url.includes(CALIBRATION_PATH_FRAGMENT);
}

function extractServerMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "title"] as const) {
    const value = candidate[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function recomputeRemaining(now: number): number {
  if (state.resetAt == null) return 0;
  const msLeft = state.resetAt - now;
  if (msLeft <= 0) return 0;
  // Round UP so the countdown never reads "0 seconds" while the bucket is
  // still considered active — the gate flips off only when msLeft <= 0.
  return Math.ceil(msLeft / 1000);
}

/**
 * Apply a 429 notice to the in-memory cooldown state. Exported for tests and
 * for the rare consumer (e.g. a manual "I just hit 429" code path) that
 * wants to push a notice in directly.
 *
 * Returns the new state snapshot for convenience.
 *
 * If the new notice's `resetAt` is BEFORE the currently-active deadline, we
 * keep the longer cooldown — the limiter never shrinks the bucket between
 * requests, so a fresher (shorter) notice would only be a stale-clock
 * artifact.
 */
export function applyRateLimitNotice(
  notice: RateLimitNotice,
): CalibrationCooldownState {
  if (!isCalibrationMutationUrl(notice.url)) return state;
  if (notice.status !== 429) return state;

  // Floor the cooldown at 1 second so the banner is visible even when the
  // server reports a sub-second reset (race between the request landing
  // and the next window tick). Empty headers fall through to this floor too.
  const minResetAt = Date.now() + 1000;
  const candidateResetAt = Math.max(notice.resetAt, minResetAt);
  const resetAt =
    state.resetAt != null && state.resetAt > candidateResetAt
      ? state.resetAt
      : candidateResetAt;

  const serverMessage = extractServerMessage(notice.body) ?? state.serverMessage;
  const limit = notice.limit ?? state.limit;

  const next: CalibrationCooldownState = {
    active: true,
    resetAt,
    secondsRemaining: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    serverMessage,
    limit,
    noticeId: state.noticeId + 1,
  };
  setState(next);
  return next;
}

/**
 * Reset the cooldown to the initial (inactive) state. Exported for tests.
 */
export function resetCalibrationCooldown(): void {
  setState(INITIAL_STATE);
}

/**
 * Re-evaluate `secondsRemaining` / `active` against the current clock, and
 * either advance the countdown or clear the cooldown if the bucket has
 * elapsed. Called by the hook's per-second tick. Idempotent.
 */
export function tickCalibrationCooldown(now: number = Date.now()): void {
  if (!state.active || state.resetAt == null) return;
  if (now >= state.resetAt) {
    setState({
      active: false,
      secondsRemaining: 0,
      resetAt: null,
      // Keep the last server message around for one more snapshot so a
      // post-cooldown render can still reference what the server said,
      // but flip `active` so consumers stop disabling buttons.
      serverMessage: state.serverMessage,
      limit: state.limit,
      noticeId: state.noticeId,
    });
    return;
  }
  const remaining = recomputeRemaining(now);
  if (remaining === state.secondsRemaining) return;
  setState({ ...state, secondsRemaining: remaining });
}

// ---------------------------------------------------------------------------
// Wire the observer ONCE at module load. Importing this module is enough to
// start receiving 429s; the calibration UI just calls `useCalibrationCooldown`.
// We do not unsubscribe — the subscriber lives for the lifetime of the page,
// matching the lifetime of the feedback-analytics route.
// ---------------------------------------------------------------------------
addRateLimitObserver((notice) => {
  applyRateLimitNotice(notice);
});

/**
 * React hook that returns the current cooldown state and re-renders once per
 * second while the cooldown is active so the countdown ticks down in place.
 *
 * Consumers typically:
 *   - Render a banner when `state.active` is true.
 *   - Disable mutation buttons via `disabled={state.active || …}`.
 */
export function useCalibrationCooldown(): CalibrationCooldownState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!snapshot.active) return;
    const id = window.setInterval(() => {
      tickCalibrationCooldown();
    }, 500);
    // Tick once synchronously so the first second after activation doesn't
    // have to wait a full interval to update.
    tickCalibrationCooldown();
    return () => {
      window.clearInterval(id);
    };
  }, [snapshot.active]);

  return snapshot;
}
