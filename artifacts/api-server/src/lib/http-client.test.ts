import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { httpFetch, withResilience, _resetBreakersForTests } from "./http-client.js";

// Task #725 — coverage matrix for the shared resilient HTTP client.
// Each test stubs global `fetch` and tunes the per-provider env knobs so
// retries/backoff don't blow up wall-clock time. Breakers are reset between
// tests so state doesn't leak across cases.

function makeResponse(status: number, headers: Record<string, string> = {}, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

describe("httpFetch", () => {
  beforeEach(() => {
    _resetBreakersForTests();
    process.env.GITHUB_TIMEOUT_MS = "200";
    process.env.GITHUB_MAX_RETRIES = "2";
    process.env.GITHUB_BREAKER_THRESHOLD = "3";
    process.env.GITHUB_BREAKER_RESET_MS = "10000";
    process.env.NVD_TIMEOUT_MS = "200";
    process.env.NVD_MAX_RETRIES = "2";
    process.env.NVD_BREAKER_THRESHOLD = "3";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns ok on first-try success", async () => {
    const fetchMock = vi.fn(async () => makeResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/repos/x/y" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on transient 503 then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      return calls < 2 ? makeResponse(503) : makeResponse(200);
    }));
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    expect(r.kind).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns terminal error on non-transient 4xx without retrying", async () => {
    const fetchMock = vi.fn(async () => makeResponse(404));
    vi.stubGlobal("fetch", fetchMock);
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable after exhausting retries on persistent 5xx", async () => {
    // Keep the breaker + deadline out of the way so we can assert the
    // retry-exhaustion path specifically.
    process.env.GITHUB_BREAKER_THRESHOLD = "100";
    process.env.GITHUB_TIMEOUT_MS = "10000";
    const fetchMock = vi.fn(async () => makeResponse(500));
    vi.stubGlobal("fetch", fetchMock);
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    // Task #725: persistent transient failures surface as `unavailable` (not
    // `error`) so active-verification can flip upstreamUnavailable + emit
    // VERIFICATION_UNAVAILABLE rather than treating the 5xx as scoring signal.
    expect(r.kind).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("breaker uses a sliding window — failures older than reset_ms are dropped", async () => {
    process.env.GITHUB_MAX_RETRIES = "0";
    process.env.GITHUB_BREAKER_THRESHOLD = "3";
    process.env.GITHUB_BREAKER_RESET_MS = "50";
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(500)));
    // Two failures, then wait past the window, then two more — total of 4
    // failures across all time, but only 2 within any 50ms window. Breaker
    // must stay closed; a stale-counter implementation would open at #3.
    await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    await new Promise((r) => setTimeout(r, 80));
    await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).not.toBe("breaker_open");
  });

  it("enforces the call-level deadline budget across attempts + backoff", async () => {
    process.env.GITHUB_TIMEOUT_MS = "150";
    process.env.GITHUB_MAX_RETRIES = "5";
    process.env.GITHUB_BREAKER_THRESHOLD = "100";
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(503)));
    const start = Date.now();
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    const elapsed = Date.now() - start;
    expect(r.kind).toBe("unavailable");
    // Total wall-clock must respect the 150ms budget (allow generous slack
    // for setTimeout coalescing and one in-flight fetch resolving).
    expect(elapsed).toBeLessThan(400);
  });

  it("opens the breaker after threshold consecutive failures and fails fast", async () => {
    process.env.GITHUB_MAX_RETRIES = "0";
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(500)));
    // 3 failed calls → breaker threshold reached.
    for (let i = 0; i < 3; i++) {
      await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    }
    const fetchMock = vi.fn(async () => makeResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("breaker_open");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts immediately when the external signal is already aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse(200)));
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x", signal: ctrl.signal });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("aborted");
  });

  it("honours Retry-After header on 429", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse(429, { "retry-after": "0" });
      return makeResponse(200);
    }));
    const r = await httpFetch({ provider: "nvd", url: "https://services.nvd.nist.gov/x" });
    expect(r.kind).toBe("ok");
    expect(calls).toBe(2);
  });

  it("returns unavailable on per-attempt timeout", async () => {
    process.env.GITHUB_TIMEOUT_MS = "20";
    process.env.GITHUB_MAX_RETRIES = "1";
    process.env.GITHUB_BREAKER_THRESHOLD = "100";
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }));
    const r = await httpFetch({ provider: "github", url: "https://api.github.com/x" });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason === "timeout" || r.reason === "network").toBe(true);
  });
});

describe("withResilience", () => {
  beforeEach(() => {
    _resetBreakersForTests();
    process.env.OPENAI_TIMEOUT_MS = "200";
    process.env.OPENAI_MAX_RETRIES = "1";
    process.env.OPENAI_BREAKER_THRESHOLD = "2";
    process.env.OPENAI_BREAKER_RESET_MS = "10000";
  });

  it("returns terminal error when classifyError says terminal (no retry)", async () => {
    const invoke = vi.fn(async () => { throw Object.assign(new Error("bad request"), { status: 400 }); });
    const r = await withResilience({
      provider: "openai",
      host: "api.openai.com",
      invoke,
      classifyError: () => "terminal",
    });
    expect(r.kind).toBe("error");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retries on transient classification then succeeds", async () => {
    let calls = 0;
    const r = await withResilience({
      provider: "openai",
      host: "api.openai.com",
      invoke: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("flaky"), { status: 503 });
        return { ok: true };
      },
      classifyError: () => "transient",
    });
    expect(r.kind).toBe("ok");
    expect(calls).toBe(2);
  });

  it("opens the breaker after persistent transient failures", async () => {
    process.env.OPENAI_MAX_RETRIES = "0";
    const invoke = async () => { throw new Error("network"); };
    await withResilience({ provider: "openai", host: "api.openai.com", invoke });
    await withResilience({ provider: "openai", host: "api.openai.com", invoke });
    const r = await withResilience({
      provider: "openai",
      host: "api.openai.com",
      invoke: async () => ({ ok: true }),
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toBe("breaker_open");
  });
});
