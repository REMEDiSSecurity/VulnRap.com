// Task #417 — unit tests for the report-submit cooldown wrapper.
//
// The wrapper is a thin specialisation of the generic
// `createRateLimitCooldown` factory that pins the `/api/reports` URL
// prefix. The factory is exhaustively tested in
// `rate-limit-cooldown.test.ts`; these specs only pin the
// wrapper-specific contract: it routes 429s on `/api/reports` and
// `/api/reports/check` (the two routes the API server's submit /
// analysis limiters protect) and ignores 429s on the calibration
// namespace so the two cooldowns stay isolated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyReportSubmitRateLimitNotice,
  resetReportSubmitCooldown,
} from "./report-submit-cooldown";

function makeNotice(overrides: { url?: string; status?: number; retryAfterSeconds?: number } = {}) {
  const retrySec = overrides.retryAfterSeconds ?? 5;
  return {
    method: "POST",
    url: overrides.url ?? "/api/reports",
    status: overrides.status ?? 429,
    retryAfterMs: retrySec * 1000,
    resetAt: Date.now() + retrySec * 1000,
    limit: null,
    remaining: 0,
    body: { error: "Too many requests. Please try again later." },
    headers: new Headers(),
  };
}

describe("report-submit cooldown wrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetReportSubmitCooldown();
  });

  afterEach(() => {
    resetReportSubmitCooldown();
    vi.useRealTimers();
  });

  it("activates on 429s for the submit endpoint", () => {
    const next = applyReportSubmitRateLimitNotice(
      makeNotice({ url: "/api/reports", retryAfterSeconds: 8 }),
    );
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(8);
  });

  it("activates on 429s for the analysis-check endpoint (shared bucket)", () => {
    const next = applyReportSubmitRateLimitNotice(
      makeNotice({ url: "/api/reports/check", retryAfterSeconds: 4 }),
    );
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(4);
  });

  it("ignores 429s on the calibration namespace", () => {
    const next = applyReportSubmitRateLimitNotice(
      makeNotice({
        url: "/api/feedback/calibration/apply",
        retryAfterSeconds: 30,
      }),
    );
    expect(next.active).toBe(false);
  });

  it("ignores non-429 statuses on the submit endpoint", () => {
    const next = applyReportSubmitRateLimitNotice(
      makeNotice({ url: "/api/reports", status: 500 }),
    );
    expect(next.active).toBe(false);
  });
});
