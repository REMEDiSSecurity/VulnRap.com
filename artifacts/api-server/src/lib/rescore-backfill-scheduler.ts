// Task #388 — Recurring rescore backfill.
//
// Task #271 added `--rescore --only-with-cached-hallucination` to the
// bulk vulnrap backfill so already-scored legacy reports with cached
// fabrication signals can finally drop into the LIKELY_INVALID
// composite band. Until now that was operator-triggered, so the
// inflated composites only got corrected when someone remembered to
// run it. This module fires the same rescore pass on a deterministic
// weekly cadence with two safety caps in place so a runaway scan can't
// saturate the DB:
//
//   1. RESCORE_BACKFILL_LIMIT (default 500) caps the number of rows
//      processed in any single tick. This bounds both DB load and
//      tick wall-clock for a normal weekly cadence.
//   2. RESCORE_BACKFILL_MAX_RUNTIME_MS (default 10 minutes) is a
//      wall-clock budget the inner loop polls after every row, so a
//      single slow row (or a sudden inflow of reports) can never let
//      one tick run unbounded.
//
// The scheduler is opt-in via RESCORE_BACKFILL_SCHEDULER_ENABLED so
// dev / test environments do not accidentally rescore data; production
// flips it on. The status surface mirrors the AVRI drift scheduler
// (`getDriftSchedulerStatus`) so reviewers can confirm the timer is
// firing without scraping logs and the calibration page can render a
// heartbeat panel without a separate convention.

import { logger } from "./logger";
import { backfill } from "../backfill-vulnrap";
import type { BackfillStats, CliOpts } from "../backfill-vulnrap-helpers";
import {
  createPostgresSchedulerLeadership,
  type LeadershipSkipReason,
  type SchedulerLeadership,
} from "./scheduler-leader";

const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LIMIT = 500;
const DEFAULT_MAX_RUNTIME_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_BATCH_SIZE = 50;

function parseIntegerEnv(
  raw: string | undefined,
  fallback: number,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (allowZero) {
    if (parsed < 0) return fallback;
  } else if (parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntegerEnv(
    process.env.RESCORE_BACKFILL_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
}

function autoRetryIntervalMs(): number {
  return parseIntegerEnv(
    process.env.RESCORE_BACKFILL_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

function autoLimit(): number {
  return parseIntegerEnv(process.env.RESCORE_BACKFILL_LIMIT, DEFAULT_LIMIT);
}

function autoMaxRuntimeMs(): number {
  return parseIntegerEnv(
    process.env.RESCORE_BACKFILL_MAX_RUNTIME_MS,
    DEFAULT_MAX_RUNTIME_MS,
  );
}

function autoBatchSize(): number {
  return parseIntegerEnv(
    process.env.RESCORE_BACKFILL_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
  );
}

function isSchedulerEnabled(): boolean {
  const raw = (process.env.RESCORE_BACKFILL_SCHEDULER_ENABLED ?? "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Build the CliOpts the recurring scheduler hands to `backfill()`. The
 * shape is fixed: rescore mode + cached-hallucination filter + safety
 * caps. Operator-driven invocations still use the CLI directly with
 * whatever flag combination they want.
 */
export function buildRescoreOpts(
  overrides: Partial<
    Pick<CliOpts, "limit" | "maxRuntimeMs" | "batchSize">
  > = {},
): CliOpts {
  return {
    dryRun: false,
    rescore: true,
    onlyWithCachedHallucination: true,
    limit: overrides.limit ?? autoLimit(),
    maxRuntimeMs: overrides.maxRuntimeMs ?? autoMaxRuntimeMs(),
    batchSize: overrides.batchSize ?? autoBatchSize(),
  };
}

export interface RescoreCheckResult {
  ok: boolean;
  /** False when the scheduler is disabled (no DB scan happened). */
  ranCheck: boolean;
  /**
   * Populated when `ranCheck` is false because cross-replica
   * leadership election declined this tick. Lets the heartbeat panel
   * distinguish "skipped because the scheduler is disabled" from
   * "skipped because another replica owns this interval".
   */
  skippedReason?: LeadershipSkipReason;
  stats?: BackfillStats;
}

export interface RunRescoreBackfillCheckOptions {
  /**
   * Inject a leadership helper. Tests pin a fake one so they don't
   * touch the database; in production the default Postgres-backed
   * implementation is used.
   */
  leadership?: SchedulerLeadership;
  /**
   * Suppress a tick when the previous tick *started* less than this
   * many milliseconds ago. Defaults to the scheduler's success
   * interval so a weekly job stays weekly fleet-wide instead of
   * firing once per replica per week.
   */
  minIntervalMs?: number;
}

let cachedLeadership: SchedulerLeadership | null = null;
function defaultLeadership(): SchedulerLeadership {
  if (!cachedLeadership) {
    cachedLeadership = createPostgresSchedulerLeadership();
  }
  return cachedLeadership;
}

/**
 * Run the rescore backfill exactly once. Always resolves; errors are
 * logged and surfaced as `ok: false` so the scheduler can re-arm at
 * the shorter retry interval.
 *
 * Skips the DB scan entirely when:
 *   * the scheduler is disabled (`ranCheck: false`, no
 *     `skippedReason`); or
 *   * another replica already owns this scheduling interval
 *     (`ranCheck: false`, `skippedReason: "lock-held-elsewhere"` or
 *     `"recent-run"`). In a multi-replica deploy this collapses the
 *     fleet-wide tick rate from one-per-replica back to one-per-job.
 */
export async function runRescoreBackfillCheck(
  options: RunRescoreBackfillCheckOptions = {},
): Promise<RescoreCheckResult> {
  if (!isSchedulerEnabled()) {
    return { ok: true, ranCheck: false };
  }
  const minIntervalMs = options.minIntervalMs ?? autoIntervalMs();
  const leadership = options.leadership ?? defaultLeadership();
  const lease = await leadership.tryAcquire({
    jobName: "rescore-backfill",
    minIntervalMs,
  });
  if (!lease.acquired) {
    if (lease.reason === "acquire-error") {
      // Treat leadership-acquisition failures as a degraded run so the
      // scheduler re-arms at the *retry* interval. If we returned
      // `ok: true` here the caller would re-arm at the success
      // interval (a full week for the rescore job) and a transient DB
      // hiccup would suppress rescoring fleet-wide for that window.
      logger.warn(
        { err: lease.error, minIntervalMs },
        "[rescore-backfill] leadership acquire failed; tick will re-arm at the retry interval",
      );
      return { ok: false, ranCheck: false };
    }
    logger.info(
      { reason: lease.reason, minIntervalMs },
      "[rescore-backfill] skipping tick — another replica owns this interval",
    );
    return { ok: true, ranCheck: false, skippedReason: lease.reason };
  }
  let success = false;
  try {
    const opts = buildRescoreOpts();
    logger.info(
      {
        limit: opts.limit,
        maxRuntimeMs: opts.maxRuntimeMs,
        batchSize: opts.batchSize,
      },
      "[rescore-backfill] starting scheduled rescore pass",
    );
    const stats = await backfill(opts);
    logger.info(
      {
        processed: stats.processed,
        rescoredUpdated: stats.rescoredUpdated,
        rescoredReconstructed: stats.rescoredReconstructed,
        skippedConcurrent: stats.skippedConcurrent,
        skippedNoSignals: stats.skippedNoSignals,
        failed: stats.failed,
        deadlineReached: stats.deadlineReached,
        elapsedMs: stats.elapsedMs,
      },
      "[rescore-backfill] scheduled rescore pass complete",
    );
    // We treat any per-row failure as a degraded run so the scheduler
    // re-arms at the shorter retry interval instead of waiting a full
    // week to retry. The overall pass still counts as "ranCheck" so
    // the heartbeat surface shows the latest stats either way.
    const ok = stats.failed === 0;
    // We mark the lease "successful" whenever the pass completed
    // without throwing — even if some rows failed individually — so
    // that `last_completed_at` reflects "the scan ran to the end" and
    // not just "the engine processed every row cleanly". The OK / not-
    // OK split that drives the retry interval is independent.
    success = true;
    return { ok, ranCheck: true, stats };
  } catch (err) {
    logger.warn(
      { err },
      "[rescore-backfill] Scheduled rescore pass failed (non-fatal).",
    );
    return { ok: false, ranCheck: true };
  } finally {
    await lease.release(success);
  }
}

export interface RescoreSchedulerOptions {
  intervalMs?: number;
  retryIntervalMs?: number;
  initialDelayMs?: number;
  /**
   * Inject a custom runner (used by tests to avoid touching the DB).
   */
  run?: () => Promise<RescoreCheckResult>;
}

export interface RescoreScheduler {
  stop(): void;
  ticksCompleted(): number;
}

/**
 * Read-only snapshot of the in-process rescore-backfill scheduler.
 * Backs the calibration page's heartbeat panel for the rescore job —
 * shape mirrors `DriftSchedulerStatus` (booleans / timestamps / small
 * numbers only) so it's safe to expose on an unauthenticated endpoint.
 *
 * Per-process by design: the scheduler timer runs in each replica,
 * but cross-replica leadership election in `runRescoreBackfillCheck`
 * (advisory lock + `scheduler_runs.last_started_at` gate) ensures
 * only one replica per scheduling interval actually performs the
 * scan. Replicas that lose election surface that on the heartbeat
 * via `lastTickSkippedReason` so the calibration page can show "this
 * replica skipped because another replica owns the tick" instead of
 * looking like the scheduler is wedged.
 */
export interface RescoreSchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  limit: number | null;
  maxRuntimeMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickSkippedReason: LeadershipSkipReason | null;
  lastTickProcessed: number | null;
  lastTickRescored: number | null;
  lastTickFailed: number | null;
  lastTickDeadlineReached: boolean | null;
  lastTickElapsedMs: number | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

const INITIAL_STATUS: RescoreSchedulerStatus = {
  schedulerStarted: false,
  schedulerEnabled: false,
  startedAt: null,
  intervalMs: null,
  retryIntervalMs: null,
  limit: null,
  maxRuntimeMs: null,
  lastTickAt: null,
  lastTickOk: null,
  lastTickRanCheck: null,
  lastTickSkippedReason: null,
  lastTickProcessed: null,
  lastTickRescored: null,
  lastTickFailed: null,
  lastTickDeadlineReached: null,
  lastTickElapsedMs: null,
  nextTickAt: null,
  ticksCompleted: 0,
};

let schedulerStatus: RescoreSchedulerStatus = { ...INITIAL_STATUS };

export function getRescoreBackfillSchedulerStatus(): RescoreSchedulerStatus {
  return { ...schedulerStatus, schedulerEnabled: isSchedulerEnabled() };
}

/**
 * Start the recurring rescore backfill scheduler. Call exactly once at
 * server boot. Returns a handle whose `stop()` cancels the next tick.
 *
 * The timer is always armed: even when the scheduler is disabled, the
 * tick still fires but `runRescoreBackfillCheck` short-circuits without
 * touching the DB. This keeps the scheduler ready to pick up work as
 * soon as an operator flips RESCORE_BACKFILL_SCHEDULER_ENABLED on a
 * running replica without requiring a redeploy.
 */
export function startRescoreBackfillScheduler(
  opts: RescoreSchedulerOptions = {},
): RescoreScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const run = opts.run ?? (() => runRescoreBackfillCheck());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let completed = 0;

  const startedAtMs = Date.now();
  schedulerStatus = {
    ...INITIAL_STATUS,
    schedulerStarted: true,
    schedulerEnabled: isSchedulerEnabled(),
    startedAt: new Date(startedAtMs).toISOString(),
    intervalMs,
    retryIntervalMs,
    limit: autoLimit(),
    maxRuntimeMs: autoMaxRuntimeMs(),
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
    let ranCheck: boolean | null = null;
    let skippedReason: LeadershipSkipReason | null = null;
    let stats: BackfillStats | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranCheck = typeof result.ranCheck === "boolean" ? result.ranCheck : null;
      skippedReason = result.skippedReason ?? null;
      stats = result.stats ?? null;
    } catch (err) {
      // `run` is supposed to swallow its own errors, but defend against
      // a misbehaving injected runner so a single throw doesn't kill
      // the scheduler.
      logger.warn(
        { err },
        "[rescore-backfill] Scheduler tick threw unexpectedly (non-fatal).",
      );
      ok = false;
    } finally {
      completed += 1;
      const completedAtMs = Date.now();
      const nextDelayMs = ok ? intervalMs : retryIntervalMs;
      schedulerStatus = {
        ...schedulerStatus,
        schedulerEnabled: isSchedulerEnabled(),
        lastTickAt: new Date(completedAtMs).toISOString(),
        lastTickOk: ok,
        lastTickRanCheck: ranCheck,
        lastTickSkippedReason: skippedReason,
        lastTickProcessed: stats?.processed ?? null,
        lastTickRescored: stats
          ? stats.rescoredUpdated + stats.rescoredReconstructed
          : null,
        lastTickFailed: stats?.failed ?? null,
        lastTickDeadlineReached: stats?.deadlineReached ?? null,
        lastTickElapsedMs: stats?.elapsedMs ?? null,
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
      enabled: isSchedulerEnabled(),
    },
    "[rescore-backfill] Rescore backfill scheduler started.",
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

// Exported for unit tests so they can pin internal state without
// reaching into module internals directly.
export const __testing = {
  resetSchedulerStatus: () => {
    schedulerStatus = { ...INITIAL_STATUS };
  },
  isSchedulerEnabled,
  autoLimit,
  autoMaxRuntimeMs,
  autoIntervalMs,
  autoRetryIntervalMs,
  autoBatchSize,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_BATCH_SIZE,
};
