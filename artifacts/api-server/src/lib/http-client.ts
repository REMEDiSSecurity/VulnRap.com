/**
 * Task #725 — Shared resilient HTTP client for outbound calls.
 *
 * Wraps the global `fetch` (and exposes a generic `withResilience` helper for
 * SDK calls like the OpenAI client) with:
 *   • A bounded **total** call deadline (per-provider override, default 10s)
 *     — covers the sum of every attempt + every backoff sleep, not just one
 *     attempt. Per-attempt timeout is derived from the remaining budget so a
 *     hung first try cannot starve later retries.
 *   • Retry-on-transient-failure with exponential backoff + full jitter
 *     (network, 5xx, 429 with `Retry-After`), capped at MAX_RETRIES.
 *   • A per-(provider, host) circuit breaker — N failures within a sliding
 *     time window opens the breaker for a cooldown period; first call after
 *     cooldown is a single half-open trial.
 *   • Honours an externally-supplied `AbortSignal` so cancelled requests
 *     stop retrying immediately.
 *
 * Returns a discriminated result type so callers handle "unavailable"
 * (breaker open / upstream down / transient retries exhausted — verification
 * should be skipped) vs. "error" (terminal upstream HTTP error like 404 —
 * score normally) distinctly.
 *
 * Env knobs (see docs/resilience.md):
 *   {PROVIDER}_TIMEOUT_MS        default 10000  (total call deadline)
 *   {PROVIDER}_MAX_RETRIES       default 3
 *   {PROVIDER}_BREAKER_THRESHOLD default 5
 *   {PROVIDER}_BREAKER_RESET_MS  default 30000  (also the failure window)
 *
 * Where {PROVIDER} ∈ {OPENAI, GITHUB, NVD}.
 */
import { logger } from "./logger";
import { getCurrentRequestId } from "./request-context";
import { instrumentExternalCall } from "./metrics";

export type Provider = "openai" | "github" | "nvd";

export type HttpResult<T = Response> =
  | { kind: "ok"; value: T; attempts: number }
  | { kind: "error"; status: number; attempts: number; detail: string }
  | { kind: "unavailable"; reason: "breaker_open" | "timeout" | "network" | "aborted"; attempts: number; detail: string };

interface ProviderConfig {
  timeoutMs: number;
  maxRetries: number;
  breakerThreshold: number;
  breakerResetMs: number;
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // Allow 0 (e.g. MAX_RETRIES=0 to disable retries in tests). Reject only
  // negatives and non-finite values.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getProviderConfig(provider: Provider): ProviderConfig {
  const upper = provider.toUpperCase();
  return {
    timeoutMs: readNumberEnv(`${upper}_TIMEOUT_MS`, 10_000),
    maxRetries: readNumberEnv(`${upper}_MAX_RETRIES`, 3),
    breakerThreshold: readNumberEnv(`${upper}_BREAKER_THRESHOLD`, 5),
    breakerResetMs: readNumberEnv(`${upper}_BREAKER_RESET_MS`, 30_000),
  };
}

// --- Circuit breaker ------------------------------------------------------
//
// Sliding-window failure tracking: an entry's `failureTimestamps` records
// the wall-clock time of every observed failure within the last
// `breakerResetMs` ms. The breaker opens when the in-window count reaches
// `breakerThreshold`. An open breaker stays open until `breakerResetMs`
// after `openedAt` elapses, then admits a single half-open trial. Any
// concurrent call attempt while a half-open trial is already in flight
// short-circuits to `breaker_open` so we never stampede a recovering
// upstream with parallel probes.

type BreakerState = "closed" | "open" | "half_open";

interface BreakerEntry {
  state: BreakerState;
  failureTimestamps: number[];
  openedAt: number;
  halfOpenInFlight: boolean;
}

const breakers = new Map<string, BreakerEntry>();

function breakerKey(provider: Provider, host: string): string {
  return `${provider}:${host}`;
}

function getBreaker(key: string): BreakerEntry {
  let b = breakers.get(key);
  if (!b) {
    b = { state: "closed", failureTimestamps: [], openedAt: 0, halfOpenInFlight: false };
    breakers.set(key, b);
  }
  return b;
}

function pruneWindow(b: BreakerEntry, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  // Drop timestamps older than the rolling window so a years-old failure
  // can't combine with a recent one to open the breaker.
  while (b.failureTimestamps.length > 0 && b.failureTimestamps[0]! < cutoff) {
    b.failureTimestamps.shift();
  }
}

function transitionBreaker(key: string, next: BreakerState, reason: string): void {
  const b = getBreaker(key);
  if (b.state === next) return;
  const prev = b.state;
  b.state = next;
  if (next === "open") {
    b.openedAt = Date.now();
    b.halfOpenInFlight = false;
  }
  if (next === "closed") {
    b.failureTimestamps = [];
    b.halfOpenInFlight = false;
  }
  logger.warn(
    { event: "breaker_state_change", target: key, from: prev, to: next, reason },
    `Circuit breaker ${key} ${prev} → ${next} (${reason})`,
  );
  // Emit a counter-friendly metric line on every transition so dashboards
  // can graph breaker churn alongside `external_api_call_total`. The split
  // outcomes (`breaker_open` / `breaker_close` / `breaker_half_open`)
  // mirror the three target states.
  const [, host = "unknown"] = key.split(":");
  const provider = key.split(":")[0] as Provider;
  const outcome: Outcome = next === "open" ? "breaker_open" : next === "closed" ? "breaker_close" : "breaker_half_open";
  emitMetric(provider, host, outcome);
}

function recordSuccess(key: string): void {
  const b = getBreaker(key);
  if (b.state !== "closed") {
    transitionBreaker(key, "closed", "success");
  } else {
    b.failureTimestamps = [];
  }
  b.halfOpenInFlight = false;
}

function recordFailure(key: string, threshold: number, windowMs: number, reason: string): void {
  const b = getBreaker(key);
  b.failureTimestamps.push(Date.now());
  pruneWindow(b, windowMs);
  if (b.state === "half_open") {
    transitionBreaker(key, "open", `half_open_failed:${reason}`);
    return;
  }
  if (b.state === "closed" && b.failureTimestamps.length >= threshold) {
    transitionBreaker(key, "open", `threshold:${b.failureTimestamps.length}/${threshold}_within_${windowMs}ms`);
  }
}

/**
 * Returns true if the call is allowed. Transitions open → half_open once the
 * cooldown elapses, but only one half-open trial may be in flight at a time.
 */
function checkBreaker(key: string, resetMs: number): boolean {
  const b = getBreaker(key);
  pruneWindow(b, resetMs);
  if (b.state === "open") {
    if (Date.now() - b.openedAt >= resetMs) {
      transitionBreaker(key, "half_open", "cooldown_elapsed");
      b.halfOpenInFlight = true;
      return true;
    }
    return false;
  }
  if (b.state === "half_open") {
    // Already probing — refuse parallel callers so we don't dog-pile.
    if (b.halfOpenInFlight) return false;
    b.halfOpenInFlight = true;
    return true;
  }
  return true;
}

/** Test/diagnostic helper — clears all breaker state. Not exported via index. */
export function _resetBreakersForTests(): void {
  breakers.clear();
}

// --- Metrics --------------------------------------------------------------

type Outcome = "ok" | "error" | "retry" | "unavailable" | "timeout" | "aborted" | "breaker_open" | "breaker_close" | "breaker_half_open";

function emitMetric(provider: Provider, host: string, outcome: Outcome, status?: number): void {
  // The shared observability layer (task #22 family) is the eventual home for
  // these counters. Until then we emit a structured `external_api_call_total`
  // log line so a log-shipper / dashboard can aggregate them.
  logger.info(
    {
      metric: "external_api_call_total",
      provider,
      host,
      outcome,
      ...(status !== undefined ? { status } : {}),
    },
    `external_api_call_total provider=${provider} host=${host} outcome=${outcome}${status !== undefined ? ` status=${status}` : ""}`,
  );
}

// --- Retry helpers --------------------------------------------------------

function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 30_000);
  // Exponential base 200ms, capped at 5s, with full jitter.
  const cap = 5_000;
  const base = Math.min(cap, 200 * Math.pow(2, attempt));
  return Math.floor(Math.random() * base);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

// --- Public API -----------------------------------------------------------

export interface HttpJsonOptions {
  provider: Provider;
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
}

/**
 * Resilient JSON-or-Response fetch. Returns the raw `Response` on success
 * (callers can `await resp.json()` / inspect status), or a discriminated
 * `unavailable` / `error` result on failure.
 */
export async function httpFetch(opts: HttpJsonOptions): Promise<HttpResult<Response>> {
  const { provider, url, init, signal: externalSignal } = opts;
  const cfg = getProviderConfig(provider);
  const host = hostFromUrl(url);
  const key = breakerKey(provider, host);

  if (!checkBreaker(key, cfg.breakerResetMs)) {
    emitMetric(provider, host, "breaker_open");
    return { kind: "unavailable", reason: "breaker_open", attempts: 0, detail: `circuit breaker open for ${key}` };
  }

  // Total call deadline — covers every attempt + every backoff sleep.
  const startedAt = Date.now();
  const deadline = startedAt + cfg.timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  let lastError = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      emitMetric(provider, host, "aborted");
      return { kind: "unavailable", reason: "aborted", attempts: attempt, detail: "external signal aborted" };
    }
    if (remaining() === 0) {
      emitMetric(provider, host, "timeout");
      return { kind: "unavailable", reason: "timeout", attempts: attempt, detail: `total deadline ${cfg.timeoutMs}ms exceeded before attempt ${attempt + 1}` };
    }

    const timeoutController = new AbortController();
    // Per-attempt timeout = whatever budget remains. The wrapper still owns
    // a single bounded deadline; we just cap each attempt at the remainder.
    const timeoutId = setTimeout(() => timeoutController.abort(), remaining());
    const onExternalAbort = () => timeoutController.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      // Task #724 — Forward the inbound request id so upstream APIs (and our
      // own response-side logs) can correlate one user-visible reference id
      // with every outbound call it triggered. Threading this inside
      // http-client keeps every migrated call site observability-equivalent
      // to the pre-#725 manual fetch + AbortController pattern.
      const reqId = getCurrentRequestId();
      const mergedHeaders: Record<string, string> = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      };
      if (reqId && !mergedHeaders["X-Request-Id"]) mergedHeaders["X-Request-Id"] = reqId;
      const resp = await instrumentExternalCall(
        provider,
        () => fetch(url, { ...init, headers: mergedHeaders, signal: timeoutController.signal }),
        (r) => (r.ok || r.status === 404 ? "success" : "error"),
      );
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);

      if (resp.ok) {
        recordSuccess(key);
        emitMetric(provider, host, "ok", resp.status);
        return { kind: "ok", value: resp, attempts: attempt + 1 };
      }

      lastStatus = resp.status;
      if (isTransientStatus(resp.status) && attempt < cfg.maxRetries) {
        const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
        const wait = backoffDelay(attempt, retryAfter);
        emitMetric(provider, host, "retry", resp.status);
        recordFailure(key, cfg.breakerThreshold, cfg.breakerResetMs, `status_${resp.status}`);
        // Don't sleep past the call-level deadline.
        if (wait >= remaining()) {
          emitMetric(provider, host, "timeout");
          return { kind: "unavailable", reason: "timeout", attempts: attempt + 1, detail: `deadline would be exceeded by backoff after HTTP ${resp.status}` };
        }
        try {
          await delay(wait, externalSignal);
        } catch {
          emitMetric(provider, host, "aborted");
          return { kind: "unavailable", reason: "aborted", attempts: attempt + 1, detail: "aborted during backoff" };
        }
        // Re-check breaker before next attempt — a parallel failure may have opened it.
        if (!checkBreaker(key, cfg.breakerResetMs)) {
          emitMetric(provider, host, "breaker_open");
          return { kind: "unavailable", reason: "breaker_open", attempts: attempt + 1, detail: `breaker opened mid-retry for ${key}` };
        }
        continue;
      }

      if (isTransientStatus(resp.status)) {
        // Transient status with retry budget exhausted → upstream is degraded
        // from the caller's POV. Surface as `unavailable` (not `error`) so
        // downstream code (active-verification) sets upstreamUnavailable and
        // emits VERIFICATION_UNAVAILABLE instead of treating this as a real
        // 429/5xx that should influence scoring.
        recordFailure(key, cfg.breakerThreshold, cfg.breakerResetMs, `status_${resp.status}`);
        emitMetric(provider, host, "unavailable", resp.status);
        return { kind: "unavailable", reason: "network", attempts: attempt + 1, detail: `HTTP ${resp.status} after ${attempt + 1} attempts (transient retries exhausted)` };
      }
      // Non-transient 4xx → upstream is healthy and gave us a definitive
      // answer (e.g. 404 = not found). Counts as success for breaker.
      recordSuccess(key);
      emitMetric(provider, host, "error", resp.status);
      return { kind: "error", status: resp.status, attempts: attempt + 1, detail: `HTTP ${resp.status}` };
    } catch (err) {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;

      if (externalSignal?.aborted) {
        emitMetric(provider, host, "aborted");
        return { kind: "unavailable", reason: "aborted", attempts: attempt + 1, detail: msg };
      }

      const isTimeout = timeoutController.signal.aborted;
      const reason = isTimeout ? "timeout" : "network";
      recordFailure(key, cfg.breakerThreshold, cfg.breakerResetMs, reason);

      if (attempt < cfg.maxRetries && remaining() > 0) {
        const wait = backoffDelay(attempt, null);
        if (wait >= remaining()) {
          emitMetric(provider, host, "timeout");
          return { kind: "unavailable", reason: "timeout", attempts: attempt + 1, detail: `deadline would be exceeded by backoff after ${reason}` };
        }
        emitMetric(provider, host, "retry");
        try {
          await delay(wait, externalSignal);
        } catch {
          emitMetric(provider, host, "aborted");
          return { kind: "unavailable", reason: "aborted", attempts: attempt + 1, detail: "aborted during backoff" };
        }
        if (!checkBreaker(key, cfg.breakerResetMs)) {
          emitMetric(provider, host, "breaker_open");
          return { kind: "unavailable", reason: "breaker_open", attempts: attempt + 1, detail: `breaker opened mid-retry for ${key}` };
        }
        continue;
      }

      emitMetric(provider, host, isTimeout ? "timeout" : "unavailable");
      return { kind: "unavailable", reason, attempts: attempt + 1, detail: msg };
    }
  }

  emitMetric(provider, host, "unavailable", lastStatus || undefined);
  return { kind: "unavailable", reason: "network", attempts: cfg.maxRetries + 1, detail: lastError || `HTTP ${lastStatus}` };
}

/**
 * Generic resilience wrapper for SDK calls (e.g. OpenAI client). Wraps an
 * arbitrary async invocation in the same timeout / retry / breaker harness.
 *
 * The provided `invoke(signal)` callback receives a composed AbortSignal
 * combining the per-attempt timeout and the caller's external signal — pass
 * it to the SDK call so cancellation propagates.
 *
 * `classifyError` lets the caller mark which thrown errors are transient
 * (retry + record breaker failure) vs terminal (return immediately).
 */
export interface WithResilienceOptions<T> {
  provider: Provider;
  host: string;
  invoke: (signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  classifyError?: (err: unknown) => "transient" | "terminal";
}

export async function withResilience<T>(opts: WithResilienceOptions<T>): Promise<HttpResult<T>> {
  const { provider, host, invoke, signal: externalSignal, classifyError } = opts;
  const cfg = getProviderConfig(provider);
  const key = breakerKey(provider, host);

  if (!checkBreaker(key, cfg.breakerResetMs)) {
    emitMetric(provider, host, "breaker_open");
    return { kind: "unavailable", reason: "breaker_open", attempts: 0, detail: `circuit breaker open for ${key}` };
  }

  // Total call deadline (see httpFetch). The SDK call gets a signal capped
  // at the remaining budget so a hung first attempt cannot starve retries.
  const deadline = Date.now() + cfg.timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  let lastError = "";
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      emitMetric(provider, host, "aborted");
      return { kind: "unavailable", reason: "aborted", attempts: attempt, detail: "external signal aborted" };
    }
    if (remaining() === 0) {
      emitMetric(provider, host, "timeout");
      return { kind: "unavailable", reason: "timeout", attempts: attempt, detail: `total deadline ${cfg.timeoutMs}ms exceeded before attempt ${attempt + 1}` };
    }

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), remaining());
    const onExternalAbort = () => timeoutController.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      // Task #724 — Mirror httpFetch by funnelling SDK invocations through
      // the same Prometheus instrumentation. Callers (e.g. llm-slop's OpenAI
      // call) are responsible for forwarding X-Request-Id via SDK headers
      // since each SDK exposes a different per-call header escape hatch.
      const value = await instrumentExternalCall(
        provider,
        () => invoke(timeoutController.signal),
      );
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      recordSuccess(key);
      emitMetric(provider, host, "ok");
      return { kind: "ok", value, attempts: attempt + 1 };
    } catch (err) {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;

      if (externalSignal?.aborted) {
        emitMetric(provider, host, "aborted");
        return { kind: "unavailable", reason: "aborted", attempts: attempt + 1, detail: msg };
      }

      const isTimeout = timeoutController.signal.aborted;
      const classification = classifyError ? classifyError(err) : "transient";

      if (classification === "terminal") {
        recordSuccess(key);
        emitMetric(provider, host, "error");
        return { kind: "error", status: 0, attempts: attempt + 1, detail: msg };
      }

      recordFailure(key, cfg.breakerThreshold, cfg.breakerResetMs, isTimeout ? "timeout" : "network");

      if (attempt < cfg.maxRetries && remaining() > 0) {
        const wait = backoffDelay(attempt, null);
        if (wait >= remaining()) {
          emitMetric(provider, host, "timeout");
          return { kind: "unavailable", reason: "timeout", attempts: attempt + 1, detail: `deadline would be exceeded by backoff after ${isTimeout ? "timeout" : "network"}` };
        }
        emitMetric(provider, host, "retry");
        try {
          await delay(wait, externalSignal);
        } catch {
          emitMetric(provider, host, "aborted");
          return { kind: "unavailable", reason: "aborted", attempts: attempt + 1, detail: "aborted during backoff" };
        }
        if (!checkBreaker(key, cfg.breakerResetMs)) {
          emitMetric(provider, host, "breaker_open");
          return { kind: "unavailable", reason: "breaker_open", attempts: attempt + 1, detail: `breaker opened mid-retry for ${key}` };
        }
        continue;
      }

      emitMetric(provider, host, isTimeout ? "timeout" : "unavailable");
      return { kind: "unavailable", reason: isTimeout ? "timeout" : "network", attempts: attempt + 1, detail: msg };
    }
  }

  emitMetric(provider, host, "unavailable");
  return { kind: "unavailable", reason: "network", attempts: cfg.maxRetries + 1, detail: lastError };
}
