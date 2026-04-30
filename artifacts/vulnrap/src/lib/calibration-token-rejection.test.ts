// Task #297 — unit tests for the calibration token-rejection store.
//
// We exercise the pure store helpers (`applyUnauthorizedNotice`,
// `resetCalibrationTokenRejection`) and verify the React hook
// (`useCalibrationTokenRejection`) re-renders when a fresh 401 lands.
// The module subscribes to the shared `addUnauthorizedObserver` at
// import time; these tests don't go through `customFetch` (no real HTTP)
// — they push notices into the store directly via the exported helper,
// which is the same path the observer takes.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyUnauthorizedNotice,
  resetCalibrationTokenRejection,
  useCalibrationTokenRejection,
} from "./calibration-token-rejection";

function makeNotice(overrides: {
  url?: string;
  method?: string;
  status?: number;
  body?: unknown;
} = {}) {
  return {
    method: overrides.method ?? "POST",
    url: overrides.url ?? "/api/feedback/calibration/handwavy-phrases",
    status: overrides.status ?? 401,
    body:
      overrides.body ?? {
        error: "Unauthorized: reviewer token rejected.",
      },
    headers: new Headers(),
  };
}

describe("calibration-token-rejection store", () => {
  beforeEach(() => {
    resetCalibrationTokenRejection();
  });

  afterEach(() => {
    resetCalibrationTokenRejection();
  });

  it("flips to rejected when a calibration mutation 401 is observed", () => {
    const next = applyUnauthorizedNotice(makeNotice());
    expect(next.rejected).toBe(true);
    expect(next.serverMessage).toMatch(/reviewer token rejected/i);
    expect(next.method).toBe("POST");
    expect(next.url).toContain("/feedback/calibration/handwavy-phrases");
    expect(next.noticeId).toBe(1);
  });

  it("ignores 401s on non-calibration URLs", () => {
    const next = applyUnauthorizedNotice(
      makeNotice({ url: "/api/reports/submit" }),
    );
    expect(next.rejected).toBe(false);
    expect(next.noticeId).toBe(0);
  });

  it("ignores GET 401s — only mutations should trip the banner", () => {
    // The handwavy-phrases LIST endpoint is a strict-auth GET; if the
    // token is wrong the page-load fetch 401s. The static auth-status
    // probe (Task #117/#215) already covers that case, so we don't want
    // to double up by lighting this banner on initial load.
    const next = applyUnauthorizedNotice(
      makeNotice({
        method: "GET",
        url: "/api/feedback/calibration/handwavy-phrases",
      }),
    );
    expect(next.rejected).toBe(false);
  });

  it("ignores non-401 statuses even on calibration mutation URLs", () => {
    const next = applyUnauthorizedNotice(
      makeNotice({ status: 429 }),
    );
    expect(next.rejected).toBe(false);
  });

  it("treats every mutation verb (POST/PUT/PATCH/DELETE) as a trip", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      resetCalibrationTokenRejection();
      const next = applyUnauthorizedNotice(makeNotice({ method }));
      expect(next.rejected).toBe(true);
      expect(next.method).toBe(method);
    }
  });

  it("normalizes the method to uppercase", () => {
    const next = applyUnauthorizedNotice(makeNotice({ method: "delete" }));
    expect(next.rejected).toBe(true);
    expect(next.method).toBe("DELETE");
  });

  it("retains the previous server message when a follow-up 401 has an empty body", () => {
    applyUnauthorizedNotice(makeNotice());
    const second = applyUnauthorizedNotice(makeNotice({ body: null }));
    expect(second.rejected).toBe(true);
    expect(second.serverMessage).toMatch(/reviewer token rejected/i);
    // Still bumps the noticeId so consumers can detect a fresh 401
    // even when the body didn't move.
    expect(second.noticeId).toBe(2);
  });

  it("extracts a server message from any of error/message/detail/title fields", () => {
    resetCalibrationTokenRejection();
    let snap = applyUnauthorizedNotice(
      makeNotice({ body: { detail: "calibration token mismatch" } }),
    );
    expect(snap.serverMessage).toBe("calibration token mismatch");

    resetCalibrationTokenRejection();
    snap = applyUnauthorizedNotice(
      makeNotice({ body: { title: "Forbidden" } }),
    );
    expect(snap.serverMessage).toBe("Forbidden");
  });

  it("clears state via resetCalibrationTokenRejection()", () => {
    applyUnauthorizedNotice(makeNotice());
    resetCalibrationTokenRejection();
    // A non-matching notice is a no-op that returns the current snapshot.
    const cleared = applyUnauthorizedNotice(
      makeNotice({ url: "/api/other/endpoint" }),
    );
    expect(cleared.rejected).toBe(false);
    expect(cleared.serverMessage).toBeNull();
    expect(cleared.noticeId).toBe(0);
  });
});

describe("useCalibrationTokenRejection hook", () => {
  beforeEach(() => {
    resetCalibrationTokenRejection();
  });

  afterEach(() => {
    resetCalibrationTokenRejection();
  });

  it("returns inactive state by default", () => {
    const { result } = renderHook(() => useCalibrationTokenRejection());
    expect(result.current.rejected).toBe(false);
    expect(result.current.serverMessage).toBeNull();
    expect(result.current.noticeId).toBe(0);
  });

  it("re-renders when a 401 is applied", () => {
    const { result } = renderHook(() => useCalibrationTokenRejection());

    act(() => {
      applyUnauthorizedNotice(makeNotice());
    });

    expect(result.current.rejected).toBe(true);
    expect(result.current.serverMessage).toMatch(/reviewer token rejected/i);
    expect(result.current.noticeId).toBe(1);
  });

  it("re-renders when the rejection is reset", () => {
    const { result } = renderHook(() => useCalibrationTokenRejection());

    act(() => {
      applyUnauthorizedNotice(makeNotice());
    });
    expect(result.current.rejected).toBe(true);

    act(() => {
      resetCalibrationTokenRejection();
    });
    expect(result.current.rejected).toBe(false);
    expect(result.current.noticeId).toBe(0);
  });
});
