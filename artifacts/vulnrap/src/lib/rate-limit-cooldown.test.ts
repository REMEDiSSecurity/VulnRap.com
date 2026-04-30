// Task #417 — unit tests for the generic rate-limit cooldown factory.
//
// The factory is the new home of the store/hook pattern that used to
// live inline in `calibration-cooldown.ts` (Task #212). The calibration
// store is now a thin wrapper that pins the `/feedback/calibration/`
// prefix; the report-submit page uses its own independent wrapper for
// `/api/reports`. These specs pin down the per-store isolation,
// URL-prefix filter (single string + array forms), and the same
// floor/ceiling/tick semantics the calibration store had — so a future
// refactor of either the factory or its wrappers can't silently regress
// the shared contract across every consumer at once.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRateLimitCooldown,
  type RateLimitCooldownState,
} from "./rate-limit-cooldown";

function makeNotice(overrides: {
  url?: string;
  status?: number;
  retryAfterSeconds?: number;
  body?: unknown;
  limit?: number | null;
} = {}) {
  const retrySec = overrides.retryAfterSeconds ?? 5;
  const headers = new Headers();
  if (overrides.limit != null) {
    headers.set("ratelimit-limit", String(overrides.limit));
  }
  return {
    method: "POST",
    url: overrides.url ?? "/api/widgets/throttled",
    status: overrides.status ?? 429,
    retryAfterMs: retrySec * 1000,
    resetAt: Date.now() + retrySec * 1000,
    limit: overrides.limit ?? null,
    remaining: 0,
    body: overrides.body ?? { error: "Too many requests. Try again later." },
    headers,
  };
}

describe("createRateLimitCooldown — single-prefix store", () => {
  let store: ReturnType<typeof createRateLimitCooldown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store = createRateLimitCooldown({ urlPrefixes: "/api/widgets/" });
  });

  afterEach(() => {
    store.resetCooldown();
    vi.useRealTimers();
  });

  it("activates when a 429 on a matching URL arrives", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 5 }),
    );
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(5);
    expect(next.serverMessage).toMatch(/too many requests/i);
    expect(next.noticeId).toBe(1);
  });

  it("ignores 429s on URLs that don't match the prefix", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/other/path", retryAfterSeconds: 30 }),
    );
    expect(next.active).toBe(false);
    expect(next.secondsRemaining).toBe(0);
  });

  it("ignores non-429 statuses even on matching URLs", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", status: 401 }),
    );
    expect(next.active).toBe(false);
  });

  it("floors the cooldown to 1s when the server reports a sub-second reset", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 0 }),
    );
    expect(next.active).toBe(true);
    expect(next.secondsRemaining).toBe(1);
  });

  it("keeps the longer deadline when a fresher (shorter) notice arrives", () => {
    const first = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 30 }),
    );
    const firstReset = first.resetAt;
    vi.advanceTimersByTime(1);
    const second = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 2 }),
    );
    expect(second.resetAt).toBe(firstReset);
    expect(second.secondsRemaining).toBeGreaterThanOrEqual(29);
    expect(second.noticeId).toBe(2);
  });

  it("captures the limit field when the notice carries it", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", limit: 7 }),
    );
    expect(next.limit).toBe(7);
  });

  it("clears the cooldown after the deadline elapses on tick", () => {
    store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 3 }),
    );
    vi.advanceTimersByTime(10_000);
    store.tickCooldown();
    // Push a no-op notice on a non-matching URL just to read state back.
    const cleared = store.applyRateLimitNotice(
      makeNotice({ url: "/api/other/endpoint" }),
    );
    expect(cleared.active).toBe(false);
    expect(cleared.secondsRemaining).toBe(0);
  });
});

describe("createRateLimitCooldown — multi-prefix store", () => {
  let store: ReturnType<typeof createRateLimitCooldown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store = createRateLimitCooldown({
      urlPrefixes: ["/api/widgets/", "/api/gizmos/"],
    });
  });

  afterEach(() => {
    store.resetCooldown();
    vi.useRealTimers();
  });

  it("activates on either matching prefix", () => {
    const a = store.applyRateLimitNotice(
      makeNotice({ url: "/api/widgets/list", retryAfterSeconds: 4 }),
    );
    expect(a.active).toBe(true);
    store.resetCooldown();
    const b = store.applyRateLimitNotice(
      makeNotice({ url: "/api/gizmos/spin", retryAfterSeconds: 4 }),
    );
    expect(b.active).toBe(true);
  });

  it("still ignores URLs that don't include any of the prefixes", () => {
    const next = store.applyRateLimitNotice(
      makeNotice({ url: "/api/something-else", retryAfterSeconds: 4 }),
    );
    expect(next.active).toBe(false);
  });
});

describe("createRateLimitCooldown — store isolation", () => {
  let widgetStore: ReturnType<typeof createRateLimitCooldown>;
  let gizmoStore: ReturnType<typeof createRateLimitCooldown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    widgetStore = createRateLimitCooldown({ urlPrefixes: "/api/widgets/" });
    gizmoStore = createRateLimitCooldown({ urlPrefixes: "/api/gizmos/" });
  });

  afterEach(() => {
    widgetStore.resetCooldown();
    gizmoStore.resetCooldown();
    vi.useRealTimers();
  });

  it("a 429 on one store's URL does not flip the other store", () => {
    // Push the notice through both stores' applyRateLimitNotice
    // (mimicking what the shared observer fan-out does at runtime —
    // every store's subscriber sees the notice and decides whether
    // it matches its own prefix list).
    const notice = makeNotice({
      url: "/api/widgets/foo",
      retryAfterSeconds: 5,
    });
    widgetStore.applyRateLimitNotice(notice);
    gizmoStore.applyRateLimitNotice(notice);

    const widgetSnap = widgetStore.applyRateLimitNotice(
      makeNotice({ url: "/api/other/noop" }),
    );
    const gizmoSnap = gizmoStore.applyRateLimitNotice(
      makeNotice({ url: "/api/other/noop" }),
    );
    expect(widgetSnap.active).toBe(true);
    expect(gizmoSnap.active).toBe(false);
  });
});

describe("createRateLimitCooldown — useCooldown hook", () => {
  let store: ReturnType<typeof createRateLimitCooldown>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store = createRateLimitCooldown({ urlPrefixes: "/api/widgets/" });
  });

  afterEach(() => {
    store.resetCooldown();
    vi.useRealTimers();
  });

  it("returns inactive state by default", () => {
    const { result } = renderHook(() => store.useCooldown());
    expect(result.current.active).toBe(false);
    expect(result.current.secondsRemaining).toBe(0);
  });

  it("re-renders with the countdown after a 429 is applied", () => {
    const { result } = renderHook(() => store.useCooldown());

    act(() => {
      store.applyRateLimitNotice(
        makeNotice({ url: "/api/widgets/foo", retryAfterSeconds: 3 }),
      );
    });

    expect(result.current.active).toBe(true);
    expect(result.current.secondsRemaining).toBe(3);

    // Advance 1.5s — the hook's 500ms interval ticks the countdown.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.active).toBe(true);
    expect(result.current.secondsRemaining).toBeLessThanOrEqual(2);
    expect(result.current.secondsRemaining).toBeGreaterThanOrEqual(1);

    // Past the deadline — cooldown clears.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.active).toBe(false);
    expect(result.current.secondsRemaining).toBe(0);
  });
});

describe("createRateLimitCooldown — initial state shape", () => {
  it("starts in the canonical inactive snapshot", () => {
    const store = createRateLimitCooldown({ urlPrefixes: "/api/widgets/" });
    // Push a no-op notice through to read back the snapshot without
    // mutating it (no matching prefix → returns current state).
    const snap: RateLimitCooldownState = store.applyRateLimitNotice(
      makeNotice({ url: "/api/other/noop" }),
    );
    expect(snap).toEqual({
      active: false,
      secondsRemaining: 0,
      resetAt: null,
      serverMessage: null,
      limit: null,
      noticeId: 0,
    });
  });
});
