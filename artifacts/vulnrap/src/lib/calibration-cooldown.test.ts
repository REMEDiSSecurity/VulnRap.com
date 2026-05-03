// Task #212 — unit tests for the calibration cooldown store.
//
// We exercise the pure store helpers (`applyRateLimitNotice`,
// `tickCalibrationCooldown`, `resetCalibrationCooldown`) and verify the
// React hook (`useCalibrationCooldown`) re-renders as the countdown ticks.
// The module subscribes to the shared `addRateLimitObserver` at import time;
// these tests don't go through `customFetch` (no real HTTP) — they push
// notices into the store directly via the exported helper, which is the
// same path the observer takes.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyRateLimitNotice,
  resetCalibrationCooldown,
  tickCalibrationCooldown,
  useCalibrationCooldown,
} from "./calibration-cooldown";

function makeNotice(
  overrides: {
    url?: string;
    status?: number;
    retryAfterSeconds?: number;
    body?: unknown;
    limit?: number | null;
  } = {},
) {
  const retrySec = overrides.retryAfterSeconds ?? 5;
  const headers = new Headers();
  if (overrides.limit != null) {
    headers.set("ratelimit-limit", String(overrides.limit));
  }
  return {
    method: "POST",
    url: overrides.url ?? "/api/feedback/calibration/apply",
    status: overrides.status ?? 429,
    retryAfterMs: retrySec * 1000,
    resetAt: Date.now() + retrySec * 1000,
    limit: overrides.limit ?? null,
    remaining: 0,
    body: overrides.body ?? {
      error: "Too many failed calibration auth attempts. Try again later.",
    },
    headers,
  };
}

describe("calibration-cooldown store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetCalibrationCooldown();
  });

  afterEach(() => {
    resetCalibrationCooldown();
    vi.useRealTimers();
  });

  it("activates the cooldown when a calibration 429 is observed", () => {
    const next = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 5 }));
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(5);
    expect(next.serverMessage).toMatch(/too many failed/i);
    expect(next.noticeId).toBe(1);
  });

  it("ignores 429s on non-calibration URLs", () => {
    const next = applyRateLimitNotice(
      makeNotice({ url: "/api/reports/submit", retryAfterSeconds: 30 }),
    );
    expect(next.active).toBe(false);
    expect(next.secondsRemaining).toBe(0);
  });

  it("ignores non-429 statuses even on calibration URLs", () => {
    const next = applyRateLimitNotice(
      makeNotice({ status: 401, retryAfterSeconds: 0 }),
    );
    expect(next.active).toBe(false);
  });

  it("floors the cooldown to 1s when the server reports a sub-second reset", () => {
    const next = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 0 }));
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(1);
  });

  it("keeps the longer deadline when a fresher (shorter) notice arrives", () => {
    const first = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 30 }));
    const firstReset = first.resetAt;
    // A second 429 arrives 1ms later with a much shorter advertised reset.
    vi.advanceTimersByTime(1);
    const second = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 2 }));
    expect(second.resetAt).toBe(firstReset);
    expect(second.secondsRemaining).toBeGreaterThanOrEqual(29);
    expect(second.noticeId).toBe(2);
  });

  it("counts down via tickCalibrationCooldown and clears after the deadline", () => {
    applyRateLimitNotice(makeNotice({ retryAfterSeconds: 3 }));

    vi.advanceTimersByTime(1000);
    tickCalibrationCooldown();
    // Still active with ~2s remaining.
    let snap = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 3 })); // refresh
    // After the refresh above, cooldown reset to 3s again — exercise just
    // the tick path on a fresh notice.
    resetCalibrationCooldown();
    applyRateLimitNotice(makeNotice({ retryAfterSeconds: 3 }));

    vi.advanceTimersByTime(1500);
    tickCalibrationCooldown();
    // 1.5s elapsed of a 3s window → 2s remaining (ceil).
    snap = applyRateLimitNotice(makeNotice({ retryAfterSeconds: 0 })); // observe state
    // The 0-second notice would only floor at 1s, but the existing 3s
    // deadline wins, so secondsRemaining stays at the active value.
    expect(snap.active).toBe(true);
    expect(snap.secondsRemaining).toBeLessThanOrEqual(2);

    // Jump past the deadline and tick: cooldown clears.
    vi.advanceTimersByTime(10_000);
    tickCalibrationCooldown();
    // Re-read state via a new notice on a non-calibration URL (which is a
    // no-op but returns the current snapshot).
    const cleared = applyRateLimitNotice(
      makeNotice({ url: "/api/other/endpoint" }),
    );
    expect(cleared.active).toBe(false);
    expect(cleared.secondsRemaining).toBe(0);
  });

  it("captures the limit header when present", () => {
    const next = applyRateLimitNotice(
      makeNotice({ retryAfterSeconds: 5, limit: 10 }),
    );
    expect(next.limit).toBe(10);
  });
});

describe("useCalibrationCooldown hook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetCalibrationCooldown();
  });

  afterEach(() => {
    resetCalibrationCooldown();
    vi.useRealTimers();
  });

  it("returns inactive state by default", () => {
    const { result } = renderHook(() => useCalibrationCooldown());
    expect(result.current.active).toBe(false);
    expect(result.current.secondsRemaining).toBe(0);
  });

  it("re-renders with countdown after a 429 is applied", () => {
    const { result } = renderHook(() => useCalibrationCooldown());

    act(() => {
      applyRateLimitNotice(makeNotice({ retryAfterSeconds: 3 }));
    });

    expect(result.current.active).toBe(true);
    expect(result.current.secondsRemaining).toBe(3);

    // Advance 1.5s — the hook's 500ms interval should trigger a tick.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.active).toBe(true);
    expect(result.current.secondsRemaining).toBeLessThanOrEqual(2);
    expect(result.current.secondsRemaining).toBeGreaterThanOrEqual(1);

    // Advance past the deadline — cooldown clears.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.active).toBe(false);
    expect(result.current.secondsRemaining).toBe(0);
  });
});
