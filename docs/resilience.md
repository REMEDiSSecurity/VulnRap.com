# External-API resilience (Task #725)

Outbound calls to third-party providers (OpenAI for the LLM gate, GitHub for
source-code verification, NVD for CVE lookups) all flow through the shared
client at `artifacts/api-server/src/lib/http-client.ts`. The client wraps
every call with a bounded timeout, exponential backoff with full jitter,
and a per-`(provider, host)` circuit breaker.

## Why

Without this layer, a slow GitHub API or a temporary OpenAI 503 would
either:

- Hang the request thread for a long time (no per-call timeout).
- Surface as a "verification failed" signal that the scoring pipeline
  treated as evidence of fabrication, even though the upstream provider
  was simply down.
- Stampede a degraded upstream with retries, making the outage worse.

The shared client centralises all three concerns in one place so each
call site no longer has to reinvent timeouts and ad-hoc retry loops.

## Public API

```ts
import { httpFetch, withResilience } from "./http-client";

// HTTP path (GitHub, NVD).
const r = await httpFetch({ provider: "github", url, init: { headers } });
if (r.kind === "ok")          { /* r.value is a Response */ }
else if (r.kind === "error")  { /* terminal HTTP error, e.g. 404 */ }
else                          { /* unavailable: breaker_open|timeout|network|aborted */ }

// SDK path (OpenAI client).
const r = await withResilience({
  provider: "openai",
  host: "api.openai.com",
  invoke: (signal) => client.chat.completions.create(req, { signal }),
  classifyError: (err) => /* "transient" | "terminal" */,
});
```

The discriminated `HttpResult` lets callers distinguish:

| Kind          | Meaning                                                              | Scoring impact                                  |
| ------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `ok`          | Success.                                                             | Normal.                                         |
| `error`       | Terminal upstream HTTP error (e.g. 404 — the resource really is gone). | Normal — counts as evidence.                    |
| `unavailable` | Breaker open, timeout, network failure, or caller aborted.           | Surface `VERIFICATION_UNAVAILABLE`, do not score. |

## Retry & backoff

- Transient HTTP statuses (`429`, any `5xx`) and network/timeout errors
  are retried up to `MAX_RETRIES` times.
- Backoff is `min(5_000, 200 * 2^attempt)` ms with full jitter
  (`Math.random() * base`).
- A `Retry-After` header (seconds or HTTP date) is honoured and capped
  at 30s.
- Caller-supplied `AbortSignal` is propagated; cancellation stops both
  the in-flight request and any pending backoff sleep.

## Circuit breaker

State is kept per `(provider, host)` tuple in-process:

- **closed** → normal operation. Each consecutive failure increments
  a counter; reaching `BREAKER_THRESHOLD` opens the breaker.
- **open** → calls fail fast with `unavailable: breaker_open`. After
  `BREAKER_RESET_MS` the next call transitions to half-open.
- **half_open** → one trial call. Success → closed. Failure → open.

State changes are emitted as structured `breaker_state_change` log lines.

## VERIFICATION_UNAVAILABLE flag

When `httpFetch` returns `unavailable` for GitHub or NVD inside
`performActiveVerification`, the verification result records:

- `verification.upstreamUnavailable.{github,nvd} = true`.
- A non-scoring evidence row: `{ type: "upstream_unavailable", result: "skipped", weight: 0 }`.
- A leading triage note prefixed `VERIFICATION_UNAVAILABLE: …`.

The route layer (`routes/reports.ts`) propagates the flag onto the
Engine 2 `signalBreakdown.activeVerification.verificationUnavailable`
diagnostics field. Scoring is **not** penalised — the flag tells the
diagnostics UI to render an "inconclusive — provider unreachable"
banner instead of treating missing checks as fabrication signal.

## Metrics

Every call emits one structured log line per outcome:

```
external_api_call_total provider=<p> host=<h> outcome=<o> [status=<n>]
```

Where `outcome ∈ {ok, error, retry, unavailable, timeout, aborted, breaker_open}`.

Log shippers can aggregate by `(provider, host, outcome)` to track
upstream health without a separate metrics SDK.

## Environment knobs

For each provider `P ∈ {OPENAI, GITHUB, NVD}`:

| Variable                   | Default | Purpose                                            |
| -------------------------- | ------- | -------------------------------------------------- |
| `P_TIMEOUT_MS`             | 10000   | Per-attempt deadline.                              |
| `P_MAX_RETRIES`            | 3       | Retry budget on transient failures.                |
| `P_BREAKER_THRESHOLD`      | 5       | Consecutive failures that open the breaker.        |
| `P_BREAKER_RESET_MS`       | 30000   | Cooldown before the breaker enters half-open.      |

Set `P_MAX_RETRIES=0` in tests to keep retry-induced wall-clock cost
out of the suite.

## Adding a new provider

1. Extend the `Provider` union in `http-client.ts`.
2. Add the four `P_…` env knobs to `.env.example` with sensible defaults.
3. At each call site, replace direct `fetch` / SDK calls with
   `httpFetch` / `withResilience` and switch on the discriminated
   `HttpResult` instead of relying on thrown errors.
4. If the provider feeds verification, propagate "unavailable" to a
   new `upstreamUnavailable.<provider>` flag and surface
   `VERIFICATION_UNAVAILABLE` in the diagnostics block exactly as
   GitHub and NVD do today.
