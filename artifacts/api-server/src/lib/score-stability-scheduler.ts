// Task #620 — Recurring score-stability monitor scheduler.
//
// Mirrors the rescore-backfill scheduler shape (`startRescoreBackfillScheduler`)
// so the calibration page can render a heartbeat panel with the exact
// same conventions reviewers already know. One nightly tick:
//   1. `runScoreStabilityRescorePass` — re-score the lookback window.
//   2. `dispatchScoreStabilityAlertIfNeeded` — page on yesterday's
//      flip-rate if it exceeded the configured threshold (default 2 %).
//
// Opt-in via SCORE_STABILITY_SCHEDULER_ENABLED so dev / test
// environments don't accidentally write rescore log rows.

import { logger } from "./logger";
import {
  runScoreStabilityRescorePass,
  dispatchScoreStabilityAlertIfNeeded,
  pruneOldRescoreLogRows,
  type RescorePassResult,
  type AlertOutcome,
  type PruneResult,
} from "./score-stability-monitor";
import {
  dispatchShadowDriftAlertIfNeeded,
  type AlertOutcome as ShadowDriftAlertOutcome,
} from "./shadow-drift-monitor";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h (nightly)
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000; // 1h on failure
const DEFAULT_INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after boot

function parseIntegerEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntegerEnv(
    process.env.SCORE_STABILITY_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
}

function autoRetryIntervalMs(): number {
  return parseIntegerEnv(
    process.env.SCORE_STABILITY_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

function isSchedulerEnabled(): boolean {
  const raw = (process.env.SCORE_STABILITY_SCHEDULER_ENABLED ?? "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}

export interface StabilityCheckResult {
  ok: boolean;
  /** False when the scheduler is disabled (no DB scan happened). */
  ranCheck: boolean;
  rescore?: RescorePassResult;
  alert?: AlertOutcome;
  shadowDriftAlert?: ShadowDriftAlertOutcome;
  prune?: PruneResult;
}

/**
 * Run one nightly score-stability pass. Always resolves; errors are
 * logged and surfaced as `ok: false` so the scheduler re-arms at the
 * shorter retry interval.
 */
export async function runScoreStabilityCheck(): Promise<StabilityCheckResult> {
  if (!isSchedulerEnabled()) {
    return { ok: true, ranCheck: false };
  }
  try {
    logger.info("[score-stability] Starting scheduled rescore pass.");
    const rescore = await runScoreStabilityRescorePass();
    logger.info(
      {
        scanned: rescore.scanned,
        logged: rescore.logged,
        flips: rescore.flips,
        skippedNoSignals: rescore.skippedNoSignals,
        skippedDuplicate: rescore.skippedDuplicate,
        failed: rescore.failed,
        codeVersion: rescore.codeVersion,
      },
      "[score-stability] Rescore pass complete; evaluating flip-rate alert.",
    );
    const alert = await dispatchScoreStabilityAlertIfNeeded({
      codeVersion: rescore.codeVersion,
    });
    if (alert.exceeded) {
      logger.info(
        {
          date: alert.date,
          flipRate: alert.flipRate,
          alertThreshold: alert.alertThreshold,
          dispatched: alert.dispatched,
          alreadyAlerted: alert.alreadyAlerted,
          webhookSkipped: alert.webhookSkipped,
        },
        "[score-stability] Flip-rate exceeded threshold.",
      );
    }
    let shadowDriftAlert: ShadowDriftAlertOutcome | undefined;
    try {
      shadowDriftAlert = await dispatchShadowDriftAlertIfNeeded();
      if (shadowDriftAlert.exceeded) {
        logger.info(
          {
            windowKey: shadowDriftAlert.windowKey,
            divergenceRate: shadowDriftAlert.divergenceRate,
            legitSlopFlips: shadowDriftAlert.legitSlopFlips,
            triggeredBy: shadowDriftAlert.triggeredBy,
            dispatched: shadowDriftAlert.dispatched,
            alreadyAlerted: shadowDriftAlert.alreadyAlerted,
            webhookSkipped: shadowDriftAlert.webhookSkipped,
          },
          "[shadow-drift] Shadow drift threshold exceeded.",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "[shadow-drift] Shadow drift alert check failed (non-fatal).",
      );
    }
    const prune = await pruneOldRescoreLogRows();
    const ok = rescore.failed === 0;
    return { ok, ranCheck: true, rescore, alert, shadowDriftAlert, prune };
  } catch (err) {
    logger.warn(
      { err },
      "[score-stability] Scheduled rescore pass failed (non-fatal).",
    );
    return { ok: false, ranCheck: true };
  }
}

export interface StabilitySchedulerOptions {
  intervalMs?: number;
  retryIntervalMs?: number;
  initialDelayMs?: number;
  /** Inject a runner for tests so they don't touch the DB. */
  run?: () => Promise<StabilityCheckResult>;
}

export interface StabilityScheduler {
  stop(): void;
  ticksCompleted(): number;
}

/**
 * Per-process snapshot of the score-stability scheduler. Mirrors
 * `RescoreSchedulerStatus` so the UI heartbeat panel reuses the same
 * conventions (booleans / timestamps / small numbers only — safe to
 * expose unauthenticated).
 */
export interface StabilitySchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickScanned: number | null;
  lastTickLogged: number | null;
  lastTickFlips: number | null;
  lastTickFailed: number | null;
  lastAlertDate: string | null;
  lastAlertFlipRate: number | null;
  lastAlertDispatched: boolean | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

const INITIAL_STATUS: StabilitySchedulerStatus = {
  schedulerStarted: false,
  schedulerEnabled: false,
  startedAt: null,
  intervalMs: null,
  retryIntervalMs: null,
  lastTickAt: null,
  lastTickOk: null,
  lastTickRanCheck: null,
  lastTickScanned: null,
  lastTickLogged: null,
  lastTickFlips: null,
  lastTickFailed: null,
  lastAlertDate: null,
  lastAlertFlipRate: null,
  lastAlertDispatched: null,
  nextTickAt: null,
  ticksCompleted: 0,
};

let schedulerStatus: StabilitySchedulerStatus = { ...INITIAL_STATUS };

export function getScoreStabilitySchedulerStatus(): StabilitySchedulerStatus {
  return { ...schedulerStatus, schedulerEnabled: isSchedulerEnabled() };
}

export function startScoreStabilityScheduler(
  opts: StabilitySchedulerOptions = {},
): StabilityScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const run = opts.run ?? (() => runScoreStabilityCheck());

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
    let rescore: RescorePassResult | null = null;
    let alert: AlertOutcome | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranCheck = typeof result.ranCheck === "boolean" ? result.ranCheck : null;
      rescore = result.rescore ?? null;
      alert = result.alert ?? null;
    } catch (err) {
      logger.warn(
        { err },
        "[score-stability] Scheduler tick threw unexpectedly (non-fatal).",
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
        lastTickScanned: rescore?.scanned ?? null,
        lastTickLogged: rescore?.logged ?? null,
        lastTickFlips: rescore?.flips ?? null,
        lastTickFailed: rescore?.failed ?? null,
        lastAlertDate: alert?.date ?? schedulerStatus.lastAlertDate,
        lastAlertFlipRate: alert?.flipRate ?? schedulerStatus.lastAlertFlipRate,
        lastAlertDispatched:
          alert?.dispatched ?? schedulerStatus.lastAlertDispatched,
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
    "[score-stability] Score stability scheduler started.",
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
  isSchedulerEnabled,
  autoIntervalMs,
  autoRetryIntervalMs,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
};
