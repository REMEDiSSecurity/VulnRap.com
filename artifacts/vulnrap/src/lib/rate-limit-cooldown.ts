// Task #417 — generic per-page cooldown store factory derived from HTTP 429
// responses observed by the shared API client.
//
// Background: Task #212 introduced a calibration-only cooldown store that
// listened to `addRateLimitObserver` from `@workspace/api-client-react`,
// filtered notices to `/feedback/calibration/` URLs, and exposed a hook the
// calibration UI used to render a friendly countdown banner instead of the
// raw "HTTP 429" toast. Other mutation-heavy pages (report-submit today,
// archetype-history admin tomorrow) had the same shared observer available
// but were still bubbling raw 429 toasts because the store was hard-coded
// to the calibration namespace.
//
// This module pulls the store + hook pattern out into a tiny factory:
//
//   const store = createRateLimitCooldown({ urlPrefixes: ["/api/reports"] });
//   const state = store.useCooldown();
//
// Each call to `createRateLimitCooldown` creates an independent store with
// its own `useSyncExternalStore` snapshot, its own subscription to the
// shared rate-limit observer, and its own URL-prefix filter. Per-page
// stores stay isolated — a 429 on `/feedback/calibration/...` will not
// flip the report-submit cooldown, and vice versa.
//
// The store is a plain module-level singleton per-factory-call; the hook
// re-renders every 500ms while a cooldown is active so the countdown ticks
// down in place without each consumer mounting its own timer.

import { useEffect, useSyncExternalStore } from "react";
import {
  addRateLimitObserver,
  type RateLimitNotice,
} from "@workspace/api-client-react";

/**
 * Snapshot returned by `useCooldown`.
 *
 * `active` flips to true once a 429 has been observed on a matching URL
 * and stays true until `resetAt` has elapsed. While active, mutation
 * buttons should be disabled and the banner shown. `secondsRemaining` is
 * the rounded-up integer for display ("try again in 3 seconds"); `resetAt`
 * is the wall-clock deadline.
 *
 * `serverMessage` carries the friendly text the server included in the
 * JSON body so the UI can quote it verbatim — keeping a single canonical
 * message across server, CLI, and UI.
 *
 * `noticeId` is a monotonically increasing counter that bumps on every
 * fresh notice. It's exposed so consumers (e.g. tests, future telemetry)
 * can deduplicate work across renders.
 */
export interface RateLimitCooldownState {
  active: boolean;
  secondsRemaining: number;
  resetAt: number | null;
  serverMessage: string | null;
  limit: number | null;
  noticeId: number;
}

export const INITIAL_RATE_LIMIT_COOLDOWN_STATE: RateLimitCooldownState = {
  active: false,
  secondsRemaining: 0,
  resetAt: null,
  serverMessage: null,
  limit: null,
  noticeId: 0,
};

export interface RateLimitCooldownStore {
  /**
   * React hook that returns the current cooldown state and re-renders
   * once per ~500ms while the cooldown is active so the countdown ticks
   * down in place. Consumers typically render a banner when
   * `state.active` is true and disable mutation buttons via
   * `disabled={state.active || …}`.
   */
  useCooldown(): RateLimitCooldownState;
  /**
   * Apply a 429 notice to this store. Exported for tests and for the rare
   * consumer that wants to push a notice in directly (e.g. a manual
   * "I just hit 429" code path that bypasses the shared observer).
   *
   * Returns the new state snapshot for convenience. Notices whose URL
   * does not match any of this store's prefixes, and notices whose
   * status is not 429, are ignored — the current snapshot is returned
   * unchanged.
   */
  applyRateLimitNotice(notice: RateLimitNotice): RateLimitCooldownState;
  /** Reset the cooldown to the initial (inactive) state. Exported for tests. */
  resetCooldown(): void;
  /**
   * Re-evaluate `secondsRemaining` / `active` against the current clock,
   * and either advance the countdown or clear the cooldown if the
   * bucket has elapsed. Called by the hook's per-second tick. Idempotent.
   */
  tickCooldown(now?: number): void;
}

export interface CreateRateLimitCooldownOptions {
  /**
   * One or more URL fragments. A 429 notice is applied to this store
   * only when its `url` includes at least one of the listed prefixes.
   * The check is intentionally substring-based so query strings,
   * trailing slashes, and host prefixes don't have to be hand-handled.
   */
  urlPrefixes: string | readonly string[];
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

export function createRateLimitCooldown(
  options: CreateRateLimitCooldownOptions,
): RateLimitCooldownStore {
  const prefixes: readonly string[] = Array.isArray(options.urlPrefixes)
    ? [...options.urlPrefixes]
    : [options.urlPrefixes as string];

  let state: RateLimitCooldownState = INITIAL_RATE_LIMIT_COOLDOWN_STATE;
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

  function setState(next: RateLimitCooldownState): void {
    state = next;
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): RateLimitCooldownState {
    return state;
  }

  function urlMatches(url: string): boolean {
    if (typeof url !== "string" || url.length === 0) return false;
    return prefixes.some((prefix) => url.includes(prefix));
  }

  function recomputeRemaining(now: number): number {
    if (state.resetAt == null) return 0;
    const msLeft = state.resetAt - now;
    if (msLeft <= 0) return 0;
    // Round UP so the countdown never reads "0 seconds" while the
    // bucket is still considered active — the gate flips off only
    // when msLeft <= 0.
    return Math.ceil(msLeft / 1000);
  }

  function applyRateLimitNotice(
    notice: RateLimitNotice,
  ): RateLimitCooldownState {
    if (!urlMatches(notice.url)) return state;
    if (notice.status !== 429) return state;

    // Floor the cooldown at 1 second so the banner is visible even
    // when the server reports a sub-second reset (race between the
    // request landing and the next window tick). Empty headers fall
    // through to this floor too.
    const minResetAt = Date.now() + 1000;
    const candidateResetAt = Math.max(notice.resetAt, minResetAt);
    // If the new notice's `resetAt` is BEFORE the currently-active
    // deadline, keep the longer cooldown — the limiter never shrinks
    // the bucket between requests, so a fresher (shorter) notice
    // would only be a stale-clock artifact.
    const resetAt =
      state.resetAt != null && state.resetAt > candidateResetAt
        ? state.resetAt
        : candidateResetAt;

    const serverMessage =
      extractServerMessage(notice.body) ?? state.serverMessage;
    const limit = notice.limit ?? state.limit;

    const next: RateLimitCooldownState = {
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

  function resetCooldown(): void {
    setState(INITIAL_RATE_LIMIT_COOLDOWN_STATE);
  }

  function tickCooldown(now: number = Date.now()): void {
    if (!state.active || state.resetAt == null) return;
    if (now >= state.resetAt) {
      setState({
        active: false,
        secondsRemaining: 0,
        resetAt: null,
        // Keep the last server message + limit around for one more
        // snapshot so a post-cooldown render can still reference what
        // the server said, but flip `active` so consumers stop
        // disabling buttons.
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

  // Wire the observer ONCE at factory call. Importing the module that
  // calls the factory is enough to start receiving 429s; the consuming
  // UI just calls `useCooldown`. We do not unsubscribe — each store
  // lives for the lifetime of the page bundle.
  addRateLimitObserver((notice) => {
    applyRateLimitNotice(notice);
  });

  function useCooldown(): RateLimitCooldownState {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
      if (!snapshot.active) return;
      const id = window.setInterval(() => {
        tickCooldown();
      }, 500);
      // Tick once synchronously so the first second after activation
      // doesn't have to wait a full interval to update.
      tickCooldown();
      return () => {
        window.clearInterval(id);
      };
    }, [snapshot.active]);

    return snapshot;
  }

  return {
    useCooldown,
    applyRateLimitNotice,
    resetCooldown,
    tickCooldown,
  };
}
