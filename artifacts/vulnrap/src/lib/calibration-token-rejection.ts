// Task #297 — calibration UI "token rejected" state derived from HTTP 401
// responses on calibration mutation routes.
//
// Background: Task #117/#215 added a polled probe of
// `/api/feedback/calibration/auth-status` that surfaces a banner naming
// `VITE_CALIBRATION_TOKEN` whenever the build's token is missing or
// rejected. That covers the "build was misconfigured at deploy time"
// case, but it does nothing the moment the server's `CALIBRATION_TOKEN`
// is rotated mid-session: the probe still reports the (stale) "valid"
// answer until the next refetch tick (every 60s), so the reviewer's
// first add/remove silently 401s and the only signal is a generic
// "HTTP 401 Unauthorized" toast. Worse, every wrong-token attempt eats
// into the per-IP throttle from Task #116 — typically 5–10 attempts
// before the cooldown banner from Task #212 finally appears, by which
// point the reviewer has to wait the bucket out.
//
// This module subscribes once (at import time) to the shared API
// client's unauthorized observer (`addUnauthorizedObserver` in
// custom-fetch.ts), filters down to calibration MUTATION URLs (the
// auth-status probe is unauthenticated and the read-only handwavy
// list is a GET — see exclusion notes below), and exposes a tiny
// store + React hook the calibration UI uses to render a distinct,
// non-toast warning the moment the FIRST 401 lands. The banner
// names `VITE_CALIBRATION_TOKEN` so the reviewer knows exactly which
// env var to fix before retrying.
//
// The throttle-cooldown banner from Task #212 still wins when the
// per-IP limiter has actually tripped — the consumer hides this
// banner while a cooldown is active so the reviewer sees the
// authoritative "wait N seconds" countdown instead of a stale
// "token rejected" message.

import { useSyncExternalStore } from "react";
import {
  addUnauthorizedObserver,
  type UnauthorizedNotice,
} from "@workspace/api-client-react";

// Path filter — only treat 401s on the calibration namespace as
// reviewer-token rejections. Other routes (e.g. future auth on
// /api/reports/*) have their own credential stories and shouldn't
// trip the calibration banner.
const CALIBRATION_PATH_FRAGMENT = "/feedback/calibration/";

// Method filter — only mutations. We deliberately ignore GETs (e.g. the
// handwavy-phrases list, which also requires a strict auth token and
// would 401 on page load if the token is wrong) for two reasons:
//   - The static auth-status probe (Task #117/#215) already catches
//     the "page just loaded with the wrong token" case and renders
//     its own banner, so a GET-driven rejection would be redundant
//     with that signal on initial load.
//   - This signal is meant to fire on the FIRST mutation attempt that
//     401s — i.e. the action the reviewer just took — so it doesn't
//     compete with the existing static banner the moment the page
//     finishes mounting.
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Snapshot returned by `useCalibrationTokenRejection`.
 *
 * `rejected` flips to true once a 401 has been observed on a calibration
 * mutation and stays true until `resetCalibrationTokenRejection()` is
 * called (e.g. on page reload or a future "I've fixed it, dismiss"
 * affordance). `serverMessage` carries the friendly text the server
 * included in the JSON body so the UI can quote it verbatim.
 *
 * `noticeId` is a monotonically increasing counter that bumps on every
 * fresh notice. It's exposed so consumers (e.g. tests, future telemetry)
 * can deduplicate work across renders.
 */
export interface CalibrationTokenRejectionState {
  rejected: boolean;
  serverMessage: string | null;
  url: string | null;
  method: string | null;
  noticeId: number;
}

const INITIAL_STATE: CalibrationTokenRejectionState = {
  rejected: false,
  serverMessage: null,
  url: null,
  method: null,
  noticeId: 0,
};

let state: CalibrationTokenRejectionState = INITIAL_STATE;
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

function setState(next: CalibrationTokenRejectionState): void {
  state = next;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CalibrationTokenRejectionState {
  return state;
}

function isCalibrationMutationUrl(url: string): boolean {
  // The shared client passes us absolute URLs (when the response has a
  // canonical URL) or path-only URLs from the orval-generated callers.
  // Both forms include the calibration namespace fragment when relevant;
  // we keep the check substring-based so query strings, trailing
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

/**
 * Apply a 401 notice to the in-memory rejection state. Exported for tests
 * and for the rare consumer (e.g. a manual "I just hit 401" code path)
 * that wants to push a notice in directly.
 *
 * Returns the new state snapshot for convenience.
 */
export function applyUnauthorizedNotice(
  notice: UnauthorizedNotice,
): CalibrationTokenRejectionState {
  if (notice.status !== 401) return state;
  if (!isCalibrationMutationUrl(notice.url)) return state;
  if (!MUTATION_METHODS.has(notice.method.toUpperCase())) return state;

  const next: CalibrationTokenRejectionState = {
    rejected: true,
    // Prefer the freshest server message when we have one; fall back to
    // the previously-stored message so a follow-up 401 with an empty
    // body doesn't blank the banner copy.
    serverMessage:
      extractServerMessage(notice.body) ?? state.serverMessage,
    url: notice.url,
    method: notice.method.toUpperCase(),
    noticeId: state.noticeId + 1,
  };
  setState(next);
  return next;
}

/**
 * Reset the rejection to the initial (cleared) state. Exported for tests
 * and for any future "I've fixed it, dismiss the banner" affordance.
 */
export function resetCalibrationTokenRejection(): void {
  setState(INITIAL_STATE);
}

// ---------------------------------------------------------------------------
// Wire the observer ONCE at module load. Importing this module is enough to
// start receiving 401s; the calibration UI just calls
// `useCalibrationTokenRejection`. We do not unsubscribe — the subscriber
// lives for the lifetime of the page, matching the lifetime of the
// feedback-analytics route.
// ---------------------------------------------------------------------------
addUnauthorizedObserver((notice) => {
  applyUnauthorizedNotice(notice);
});

/**
 * React hook that returns the current rejection state. Re-renders only
 * when the rejection store actually changes (a fresh 401 lands or the
 * state is reset), so this hook is cheap to embed alongside the existing
 * cooldown / auth-state hooks in the calibration UI.
 *
 * Consumers typically:
 *   - Render a banner when `state.rejected` is true (and no cooldown
 *     banner is currently showing — the cooldown banner wins per the
 *     module docs above).
 */
export function useCalibrationTokenRejection(): CalibrationTokenRejectionState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
