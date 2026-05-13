// Synthetic pipeline heartbeat — keeps the public status page truthful
// for a low-traffic site.
//
// Without this, /public/status derives engine health entirely from
// organic submissions: every engine's last_seen is the most recent
// real report. On a quiet day with zero submissions in the last 6h,
// the page reads "Major outage in progress" even though nothing is
// broken. That's a traffic monitor wearing a status-page costume.
//
// This scheduler runs the real analysis pipeline against a tiny canned
// report every few minutes and persists the resulting trace into
// `analysis_traces` with `reportId = null`. The status route already
// treats every trace equally, so engines stay "operational" as long
// as the heartbeat is firing — which is exactly what we want: status
// reflects pipeline health, not user activity.
//
// The synthetic trace is tagged with `synthetic_heartbeat` in
// `trace.notes` so future filters can exclude it from analytics.
//
// Configurable via env (all optional; sane defaults baked in):
//   HEALTH_HEARTBEAT_DISABLED        — set to "1"/"true" to disable.
//   HEALTH_HEARTBEAT_INTERVAL_MS     — success cadence (default 5min).
//   HEALTH_HEARTBEAT_RETRY_INTERVAL_MS — failure retry (default 1min).
//   HEALTH_HEARTBEAT_INITIAL_DELAY_MS  — first-tick delay (default 10s).

import { logger } from "./logger";
import { analyzeWithEnginesTraced } from "./engines";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 10 * 1000;

export const HEARTBEAT_NOTE = "synthetic_heartbeat";

// Small but realistic vulnerability report. The pipeline needs enough
// content to extract signals and run every engine — a 3-line stub
// would skew perplexity / substance scores in ways that make engines
// "trip" their own heuristics. The text here is mundane enough that
// nothing should ever flag it; if a future code change makes the
// heartbeat itself fail scoring, the scheduler will log a warning and
// re-arm at the retry cadence.
const HEARTBEAT_REPORT_TEXT = `# Reflected XSS in /api/v2/search?q= via missing output encoding

## Summary
The \`q\` query parameter on \`GET /api/v2/search\` is reflected into
the search-results page header without HTML-encoding the value, allowing
arbitrary script execution in the victim's browser when a crafted link
is followed.

## Steps to reproduce
1. Sign in to https://example.com/ as any standard user.
2. Navigate to:
   https://example.com/api/v2/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E
3. Observe the alert dialog firing in the rendered page header.

## Expected vs actual
Expected: \`q\` is escaped and rendered as literal text.
Actual: the raw value is interpolated into a \`<h1>\` element via
\`innerHTML\`, so the browser parses and executes the embedded script.

## Impact
Session cookies are not \`HttpOnly\` on this host, so an attacker can
exfiltrate them with \`document.cookie\` and ride the user's session.
CWE-79 (Improper Neutralization of Input During Web Page Generation).

## Suggested fix
Use the project's existing \`escapeHtml()\` helper (or template the
header through Handlebars' default escaping) instead of \`innerHTML\`
assignment in \`renderSearchHeader()\` at \`src/views/search.ts:47\`.
`;

const HEARTBEAT_CLAIMED_CWES = ["CWE-79"] as const;

function isDisabled(): boolean {
  const raw = (process.env.HEALTH_HEARTBEAT_DISABLED ?? "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseIntegerEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntegerEnv(
    process.env.HEALTH_HEARTBEAT_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
}

function autoRetryIntervalMs(): number {
  return parseIntegerEnv(
    process.env.HEALTH_HEARTBEAT_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

function autoInitialDelayMs(): number {
  return parseIntegerEnv(
    process.env.HEALTH_HEARTBEAT_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
  );
}

export interface HeartbeatTickResult {
  ok: boolean;
  /** False when the scheduler is disabled (no DB write happened). */
  ranTick: boolean;
  /** Total pipeline duration in ms when ranTick is true. */
  durationMs?: number;
  /** Correlation id of the persisted trace, when ranTick succeeded. */
  correlationId?: string;
}

/**
 * Run one heartbeat tick. Resolves to `{ ok: true }` when the
 * synthetic trace is persisted, `{ ok: true, ranTick: false }` when
 * the scheduler is disabled, and `{ ok: false }` on any failure
 * (logged, not thrown — the caller re-arms at the retry cadence).
 */
export async function runHeartbeatTick(): Promise<HeartbeatTickResult> {
  if (isDisabled()) {
    return { ok: true, ranTick: false };
  }
  try {
    // Lazy-import @workspace/db so unit tests that mock it can do so
    // before this module's first call resolves it. Mirrors the
    // scheduler-leader lazy-pool pattern.
    const { db, analysisTracesTable } = await import("@workspace/db");

    const result = analyzeWithEnginesTraced(HEARTBEAT_REPORT_TEXT, {
      claimedCwes: [...HEARTBEAT_CLAIMED_CWES],
    });
    const taggedTrace = {
      ...result.trace,
      reportId: null,
      notes: [...result.trace.notes, HEARTBEAT_NOTE],
    };
    await db.insert(analysisTracesTable).values({
      correlationId: taggedTrace.correlationId,
      reportId: null,
      totalDurationMs: taggedTrace.totalDurationMs,
      trace: taggedTrace,
    });
    return {
      ok: true,
      ranTick: true,
      durationMs: taggedTrace.totalDurationMs,
      correlationId: taggedTrace.correlationId,
    };
  } catch (err) {
    logger.warn(
      { err },
      "[health-heartbeat] tick failed (non-fatal); will retry",
    );
    return { ok: false, ranTick: true };
  }
}

export interface HeartbeatSchedulerOptions {
  intervalMs?: number;
  retryIntervalMs?: number;
  initialDelayMs?: number;
  /** Inject a runner for tests so they don't touch the DB. */
  run?: () => Promise<HeartbeatTickResult>;
}

export interface HeartbeatScheduler {
  stop(): void;
  ticksCompleted(): number;
}

export interface HeartbeatSchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanTick: boolean | null;
  lastTickDurationMs: number | null;
  lastCorrelationId: string | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

const INITIAL_STATUS: HeartbeatSchedulerStatus = {
  schedulerStarted: false,
  schedulerEnabled: false,
  startedAt: null,
  intervalMs: null,
  retryIntervalMs: null,
  lastTickAt: null,
  lastTickOk: null,
  lastTickRanTick: null,
  lastTickDurationMs: null,
  lastCorrelationId: null,
  nextTickAt: null,
  ticksCompleted: 0,
};

let schedulerStatus: HeartbeatSchedulerStatus = { ...INITIAL_STATUS };

export function getHealthHeartbeatSchedulerStatus(): HeartbeatSchedulerStatus {
  return { ...schedulerStatus, schedulerEnabled: !isDisabled() };
}

export function startHealthHeartbeatScheduler(
  opts: HeartbeatSchedulerOptions = {},
): HeartbeatScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? autoInitialDelayMs();
  const run = opts.run ?? (() => runHeartbeatTick());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let completed = 0;

  const startedAtMs = Date.now();
  schedulerStatus = {
    ...INITIAL_STATUS,
    schedulerStarted: true,
    schedulerEnabled: !isDisabled(),
    startedAt: new Date(startedAtMs).toISOString(),
    intervalMs,
    retryIntervalMs,
    nextTickAt: new Date(startedAtMs + initialDelayMs).toISOString(),
  };

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    let ok = true;
    let ranTick: boolean | null = null;
    let durationMs: number | null = null;
    let correlationId: string | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranTick = typeof result.ranTick === "boolean" ? result.ranTick : null;
      durationMs = typeof result.durationMs === "number" ? result.durationMs : null;
      correlationId = result.correlationId ?? null;
    } catch (err) {
      logger.warn(
        { err },
        "[health-heartbeat] scheduler tick threw unexpectedly (non-fatal).",
      );
      ok = false;
    } finally {
      completed += 1;
      const completedAtMs = Date.now();
      const nextDelayMs = ok ? intervalMs : retryIntervalMs;
      schedulerStatus = {
        ...schedulerStatus,
        schedulerEnabled: !isDisabled(),
        lastTickAt: new Date(completedAtMs).toISOString(),
        lastTickOk: ok,
        lastTickRanTick: ranTick,
        lastTickDurationMs: durationMs,
        lastCorrelationId: correlationId ?? schedulerStatus.lastCorrelationId,
        nextTickAt: stopped
          ? null
          : new Date(completedAtMs + nextDelayMs).toISOString(),
        ticksCompleted: completed,
      };
    }
    schedule(ok ? intervalMs : retryIntervalMs);
  }

  schedule(initialDelayMs);

  logger.info(
    {
      intervalMs,
      retryIntervalMs,
      initialDelayMs,
      enabled: !isDisabled(),
    },
    "[health-heartbeat] Health heartbeat scheduler started.",
  );

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedulerStatus = { ...schedulerStatus, nextTickAt: null };
    },
    ticksCompleted: () => completed,
  };
}

export const __testing = {
  resetSchedulerStatus: () => {
    schedulerStatus = { ...INITIAL_STATUS };
  },
  isDisabled,
  autoIntervalMs,
  autoRetryIntervalMs,
  autoInitialDelayMs,
  HEARTBEAT_REPORT_TEXT,
  HEARTBEAT_CLAIMED_CWES,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
};
