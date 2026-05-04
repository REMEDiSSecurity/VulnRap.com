// Task #982 — Scheduled holdout-vs-in-sample accuracy drift check.
//
// The holdout evaluation endpoint (GET /feedback/holdout-eval) computes
// honest precision/recall/F1/accuracy on a 20% partition that calibration
// never touches, alongside the in-sample numbers. Today nobody watches
// the gap automatically — if calibration starts overfitting (in-sample
// metrics improve while holdout metrics decay) the team only notices on
// a manual page visit.
//
// This scheduler runs a daily check that compares holdout F1 to in-sample
// F1 (and accuracy). When the gap exceeds a configurable threshold it
// dispatches an alert through the same AVRI_DRIFT_WEBHOOK_URL webhook
// that drift flags use, so reviewers get a proactive page instead of a
// silent regression.
//
// Dedup: alerts are keyed by calendar date (UTC) and persisted to
// `data/holdout-drift-alerts.json` so the same day's gap doesn't re-fire
// across process restarts or replicas. Once a drift alert for a given day
// is successfully dispatched (or recorded when no webhook is configured),
// subsequent ticks on the same day are suppressed. If the gap recovers
// and re-appears on a different day, a fresh alert fires.
//
// Metric math is shared with GET /feedback/holdout-eval via the
// `holdout-eval` module so both code paths stay in sync.
//
// Configurable via environment variables:
//   HOLDOUT_DRIFT_SCHEDULER_ENABLED  — opt-in ("1" or "true")
//   HOLDOUT_DRIFT_INTERVAL_MS        — success-case cadence (default 24h)
//   HOLDOUT_DRIFT_RETRY_INTERVAL_MS  — failure-case retry   (default 1h)
//   HOLDOUT_DRIFT_INITIAL_DELAY_MS   — delay before first tick (default 3min)
//   HOLDOUT_DRIFT_F1_THRESHOLD       — max allowed F1 gap   (default 0.10)
//   HOLDOUT_DRIFT_ACCURACY_THRESHOLD — max allowed accuracy gap (default 0.10)
//   HOLDOUT_DRIFT_MIN_SAMPLES        — minimum holdout rows before alerting
//                                      (default 20)

import { readFileSync, existsSync } from "fs";
import { atomicWriteJsonFileSync } from "./atomic-write";
import path from "path";
import { fileURLToPath } from "url";
import { computeHoldoutEval, type HoldoutPartition } from "./holdout-eval";
import { logger } from "./logger";
import { buildPublicUrl } from "./public-url";

export type { HoldoutPartition } from "./holdout-eval";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 3 * 60 * 1000;
const DEFAULT_F1_THRESHOLD = 0.1;
const DEFAULT_ACCURACY_THRESHOLD = 0.1;
const DEFAULT_MIN_SAMPLES = 20;
const DEDUP_HISTORY_LIMIT = 90;

// ---------------------------------------------------------------------------
// Persisted dedup state
// ---------------------------------------------------------------------------

export interface HoldoutDriftAlertRecord {
  dedupKey: string;
  alertedAt: string;
  f1Gap: number | null;
  accuracyGap: number | null;
  dispatched: boolean;
  webhookSkipped: boolean;
}

interface AlertsFile {
  _meta?: unknown;
  alerts: HoldoutDriftAlertRecord[];
}

const CANDIDATE_PATHS = [
  path.resolve(__dirname, "../../data/holdout-drift-alerts.json"),
  path.resolve(process.cwd(), "data/holdout-drift-alerts.json"),
  path.resolve(
    process.cwd(),
    "artifacts/api-server/data/holdout-drift-alerts.json",
  ),
];

let RESOLVED_PATH: string | null = null;

function resolvePath(): string {
  if (RESOLVED_PATH) return RESOLVED_PATH;
  const override = process.env.HOLDOUT_DRIFT_ALERTS_PATH;
  if (override && override.trim().length > 0) {
    RESOLVED_PATH = path.resolve(override);
    return RESOLVED_PATH;
  }
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) {
      RESOLVED_PATH = p;
      return p;
    }
  }
  RESOLVED_PATH = CANDIDATE_PATHS[0]!;
  return RESOLVED_PATH;
}

function readAlertState(): AlertsFile {
  const filePath = resolvePath();
  if (!existsSync(filePath)) {
    return { alerts: [] };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertsFile>;
    const list = Array.isArray(parsed.alerts) ? parsed.alerts : [];
    const cleaned: HoldoutDriftAlertRecord[] = [];
    for (const entry of list) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as HoldoutDriftAlertRecord).dedupKey === "string" &&
        typeof (entry as HoldoutDriftAlertRecord).alertedAt === "string"
      ) {
        const e = entry as HoldoutDriftAlertRecord;
        cleaned.push({
          dedupKey: e.dedupKey,
          alertedAt: e.alertedAt,
          f1Gap: typeof e.f1Gap === "number" ? e.f1Gap : null,
          accuracyGap: typeof e.accuracyGap === "number" ? e.accuracyGap : null,
          dispatched: typeof e.dispatched === "boolean" ? e.dispatched : false,
          webhookSkipped: typeof e.webhookSkipped === "boolean" ? e.webhookSkipped : false,
        });
      }
    }
    return { _meta: parsed._meta, alerts: cleaned };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "[holdout-drift] Failed to read alert state file; starting from empty.",
    );
    return { alerts: [] };
  }
}

function writeAlertState(file: AlertsFile): void {
  const filePath = resolvePath();
  const trimmed = file.alerts.slice(-DEDUP_HISTORY_LIMIT);
  const payload: AlertsFile = {
    _meta:
      file._meta ??
      "Persisted dedup state for holdout accuracy drift alerts. Each entry represents a day on which a holdout-vs-in-sample gap exceeded the configured threshold (capped at 90).",
    alerts: trimmed,
  };
  atomicWriteJsonFileSync(filePath, payload);
}

function isAlreadyAlerted(dedupKey: string): boolean {
  const state = readAlertState();
  return state.alerts.some((a) => a.dedupKey === dedupKey);
}

function recordAlert(record: HoldoutDriftAlertRecord): void {
  const state = readAlertState();
  if (!state.alerts.some((a) => a.dedupKey === record.dedupKey)) {
    state.alerts.push(record);
  }
  writeAlertState(state);
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntEnv(process.env.HOLDOUT_DRIFT_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

function autoRetryIntervalMs(): number {
  return parseIntEnv(
    process.env.HOLDOUT_DRIFT_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

function isSchedulerEnabled(): boolean {
  const raw = (process.env.HOLDOUT_DRIFT_SCHEDULER_ENABLED ?? "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}

function autoF1Threshold(): number {
  return parseFloatEnv(
    process.env.HOLDOUT_DRIFT_F1_THRESHOLD,
    DEFAULT_F1_THRESHOLD,
  );
}

function autoAccuracyThreshold(): number {
  return parseFloatEnv(
    process.env.HOLDOUT_DRIFT_ACCURACY_THRESHOLD,
    DEFAULT_ACCURACY_THRESHOLD,
  );
}

function autoMinSamples(): number {
  return parseIntEnv(
    process.env.HOLDOUT_DRIFT_MIN_SAMPLES,
    DEFAULT_MIN_SAMPLES,
  );
}

function todayUtcKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Core drift computation
// ---------------------------------------------------------------------------

export interface HoldoutDriftResult {
  holdout: HoldoutPartition;
  inSample: HoldoutPartition;
  f1Gap: number | null;
  accuracyGap: number | null;
  f1Exceeded: boolean;
  accuracyExceeded: boolean;
  scoreThreshold: number;
  ratingThreshold: number;
  f1ThresholdUsed: number;
  accuracyThresholdUsed: number;
  minSamplesUsed: number;
  insufficientData: boolean;
}

export async function computeHoldoutDrift(opts?: {
  f1Threshold?: number;
  accuracyThreshold?: number;
  minSamples?: number;
}): Promise<HoldoutDriftResult> {
  const f1Threshold = opts?.f1Threshold ?? autoF1Threshold();
  const accuracyThreshold = opts?.accuracyThreshold ?? autoAccuracyThreshold();
  const minSamples = opts?.minSamples ?? autoMinSamples();

  const eval_ = await computeHoldoutEval();

  const insufficientData = eval_.holdout.totalFeedback < minSamples;

  const f1Gap =
    eval_.inSample.f1 != null && eval_.holdout.f1 != null
      ? Math.round((eval_.inSample.f1 - eval_.holdout.f1) * 1000) / 1000
      : null;
  const accuracyGap =
    eval_.inSample.accuracy != null && eval_.holdout.accuracy != null
      ? Math.round(
          (eval_.inSample.accuracy - eval_.holdout.accuracy) * 1000,
        ) / 1000
      : null;

  const f1Exceeded =
    !insufficientData && f1Gap != null && f1Gap > f1Threshold;
  const accuracyExceeded =
    !insufficientData && accuracyGap != null && accuracyGap > accuracyThreshold;

  return {
    holdout: eval_.holdout,
    inSample: eval_.inSample,
    f1Gap,
    accuracyGap,
    f1Exceeded,
    accuracyExceeded,
    scoreThreshold: eval_.scoreThreshold,
    ratingThreshold: eval_.ratingThreshold,
    f1ThresholdUsed: f1Threshold,
    accuracyThresholdUsed: accuracyThreshold,
    minSamplesUsed: minSamples,
    insufficientData,
  };
}

// ---------------------------------------------------------------------------
// Webhook dispatch
// ---------------------------------------------------------------------------

export interface HoldoutDriftWebhookPayload {
  event: "holdout_accuracy_drift";
  detectedAt: string;
  dedupKey: string;
  f1Gap: number | null;
  accuracyGap: number | null;
  f1Threshold: number;
  accuracyThreshold: number;
  holdout: HoldoutPartition;
  inSample: HoldoutPartition;
  scoreThreshold: number;
  ratingThreshold: number;
  holdoutSamples: number;
  calibrationUrl: string;
}

export type HoldoutDriftDispatcher = (
  url: string,
  payload: HoldoutDriftWebhookPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const defaultDispatcher: HoldoutDriftDispatcher = async (url, payload) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "vulnrap-holdout-drift-notifier/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// ---------------------------------------------------------------------------
// Single-run check with dedup + dispatch
// ---------------------------------------------------------------------------

export interface HoldoutDriftAlertOutcome {
  ok: boolean;
  ranCheck: boolean;
  driftResult?: HoldoutDriftResult;
  exceeded: boolean;
  alreadyAlerted: boolean;
  dispatched: boolean;
  dispatchResult?: { ok: boolean; status?: number; error?: string };
  webhookSkipped: boolean;
  dedupKey?: string;
}

export async function runHoldoutDriftCheck(opts?: {
  webhookUrl?: string;
  publicUrl?: string;
  dispatch?: HoldoutDriftDispatcher;
  now?: () => Date;
  f1Threshold?: number;
  accuracyThreshold?: number;
  minSamples?: number;
}): Promise<HoldoutDriftAlertOutcome> {
  if (!isSchedulerEnabled()) {
    return { ok: true, ranCheck: false, exceeded: false, alreadyAlerted: false, dispatched: false, webhookSkipped: false };
  }

  try {
    const driftResult = await computeHoldoutDrift({
      f1Threshold: opts?.f1Threshold,
      accuracyThreshold: opts?.accuracyThreshold,
      minSamples: opts?.minSamples,
    });

    if (driftResult.insufficientData) {
      logger.info(
        {
          holdoutSamples: driftResult.holdout.totalFeedback,
          minSamples: driftResult.minSamplesUsed,
        },
        "[holdout-drift] Insufficient holdout samples; skipping alert check.",
      );
      return {
        ok: true,
        ranCheck: true,
        driftResult,
        exceeded: false,
        alreadyAlerted: false,
        dispatched: false,
        webhookSkipped: false,
      };
    }

    const exceeded = driftResult.f1Exceeded || driftResult.accuracyExceeded;

    if (!exceeded) {
      logger.info(
        {
          f1Gap: driftResult.f1Gap,
          accuracyGap: driftResult.accuracyGap,
          f1Threshold: driftResult.f1ThresholdUsed,
          accuracyThreshold: driftResult.accuracyThresholdUsed,
        },
        "[holdout-drift] No drift detected; holdout metrics within thresholds.",
      );
      return {
        ok: true,
        ranCheck: true,
        driftResult,
        exceeded: false,
        alreadyAlerted: false,
        dispatched: false,
        webhookSkipped: false,
      };
    }

    const now = (opts?.now ?? (() => new Date()))();
    const dayKey = todayUtcKey(now);
    const dedupKey = `HOLDOUT_DRIFT|${dayKey}`;

    if (isAlreadyAlerted(dedupKey)) {
      logger.info(
        { dedupKey, f1Gap: driftResult.f1Gap, accuracyGap: driftResult.accuracyGap },
        "[holdout-drift] Drift exceeded but already alerted today; skipping duplicate dispatch.",
      );
      return {
        ok: true,
        ranCheck: true,
        driftResult,
        exceeded: true,
        alreadyAlerted: true,
        dispatched: false,
        webhookSkipped: false,
        dedupKey,
      };
    }

    const webhookUrl = (
      opts?.webhookUrl ?? process.env.AVRI_DRIFT_WEBHOOK_URL ?? ""
    ).trim();

    if (webhookUrl.length === 0) {
      logger.warn(
        {
          dedupKey,
          f1Gap: driftResult.f1Gap,
          accuracyGap: driftResult.accuracyGap,
        },
        "[holdout-drift] Drift DETECTED but AVRI_DRIFT_WEBHOOK_URL not set; recording as alerted without dispatch.",
      );
      recordAlert({
        dedupKey,
        alertedAt: now.toISOString(),
        f1Gap: driftResult.f1Gap,
        accuracyGap: driftResult.accuracyGap,
        dispatched: false,
        webhookSkipped: true,
      });
      return {
        ok: true,
        ranCheck: true,
        driftResult,
        exceeded: true,
        alreadyAlerted: false,
        dispatched: false,
        webhookSkipped: true,
        dedupKey,
      };
    }

    const base = buildPublicUrl({ override: opts?.publicUrl });

    const payload: HoldoutDriftWebhookPayload = {
      event: "holdout_accuracy_drift",
      detectedAt: now.toISOString(),
      dedupKey,
      f1Gap: driftResult.f1Gap,
      accuracyGap: driftResult.accuracyGap,
      f1Threshold: driftResult.f1ThresholdUsed,
      accuracyThreshold: driftResult.accuracyThresholdUsed,
      holdout: driftResult.holdout,
      inSample: driftResult.inSample,
      scoreThreshold: driftResult.scoreThreshold,
      ratingThreshold: driftResult.ratingThreshold,
      holdoutSamples: driftResult.holdout.totalFeedback,
      calibrationUrl: `${base}/feedback-analytics`,
    };

    const dispatch = opts?.dispatch ?? defaultDispatcher;
    const dispatchResult = await dispatch(webhookUrl, payload);

    if (!dispatchResult.ok) {
      logger.warn(
        { dispatchResult, dedupKey, f1Gap: driftResult.f1Gap, accuracyGap: driftResult.accuracyGap },
        "[holdout-drift] Webhook dispatch failed; will retry on next tick.",
      );
      return {
        ok: false,
        ranCheck: true,
        driftResult,
        exceeded: true,
        alreadyAlerted: false,
        dispatched: false,
        dispatchResult,
        webhookSkipped: false,
        dedupKey,
      };
    }

    logger.warn(
      {
        dedupKey,
        f1Gap: driftResult.f1Gap,
        accuracyGap: driftResult.accuracyGap,
        status: dispatchResult.status,
      },
      "[holdout-drift] Holdout accuracy drift ALERT dispatched.",
    );

    recordAlert({
      dedupKey,
      alertedAt: now.toISOString(),
      f1Gap: driftResult.f1Gap,
      accuracyGap: driftResult.accuracyGap,
      dispatched: true,
      webhookSkipped: false,
    });

    return {
      ok: true,
      ranCheck: true,
      driftResult,
      exceeded: true,
      alreadyAlerted: false,
      dispatched: true,
      dispatchResult,
      webhookSkipped: false,
      dedupKey,
    };
  } catch (err) {
    logger.warn(
      { err },
      "[holdout-drift] Scheduled holdout drift check failed (non-fatal).",
    );
    return { ok: false, ranCheck: true, exceeded: false, alreadyAlerted: false, dispatched: false, webhookSkipped: false };
  }
}

// ---------------------------------------------------------------------------
// Alert history (for status / debugging)
// ---------------------------------------------------------------------------

export function listHoldoutDriftAlerts(): HoldoutDriftAlertRecord[] {
  return readAlertState().alerts.map((a) => ({ ...a }));
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface HoldoutDriftSchedulerOptions {
  intervalMs?: number;
  retryIntervalMs?: number;
  initialDelayMs?: number;
  run?: () => Promise<HoldoutDriftAlertOutcome>;
}

export interface HoldoutDriftScheduler {
  stop(): void;
  ticksCompleted(): number;
}

export interface HoldoutDriftSchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  f1Threshold: number;
  accuracyThreshold: number;
  minSamples: number;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickExceeded: boolean | null;
  lastTickAlreadyAlerted: boolean | null;
  lastTickDispatched: boolean | null;
  lastTickF1Gap: number | null;
  lastTickAccuracyGap: number | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

const INITIAL_STATUS: HoldoutDriftSchedulerStatus = {
  schedulerStarted: false,
  schedulerEnabled: false,
  startedAt: null,
  intervalMs: null,
  retryIntervalMs: null,
  f1Threshold: DEFAULT_F1_THRESHOLD,
  accuracyThreshold: DEFAULT_ACCURACY_THRESHOLD,
  minSamples: DEFAULT_MIN_SAMPLES,
  lastTickAt: null,
  lastTickOk: null,
  lastTickRanCheck: null,
  lastTickExceeded: null,
  lastTickAlreadyAlerted: null,
  lastTickDispatched: null,
  lastTickF1Gap: null,
  lastTickAccuracyGap: null,
  nextTickAt: null,
  ticksCompleted: 0,
};

let schedulerStatus: HoldoutDriftSchedulerStatus = { ...INITIAL_STATUS };

export function getHoldoutDriftSchedulerStatus(): HoldoutDriftSchedulerStatus {
  return {
    ...schedulerStatus,
    schedulerEnabled: isSchedulerEnabled(),
    f1Threshold: autoF1Threshold(),
    accuracyThreshold: autoAccuracyThreshold(),
    minSamples: autoMinSamples(),
  };
}

export function startHoldoutDriftScheduler(
  opts: HoldoutDriftSchedulerOptions = {},
): HoldoutDriftScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const run = opts.run ?? (() => runHoldoutDriftCheck());

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
    f1Threshold: autoF1Threshold(),
    accuracyThreshold: autoAccuracyThreshold(),
    minSamples: autoMinSamples(),
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
    let exceeded: boolean | null = null;
    let alreadyAlerted: boolean | null = null;
    let dispatched: boolean | null = null;
    let f1Gap: number | null = null;
    let accuracyGap: number | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranCheck = typeof result.ranCheck === "boolean" ? result.ranCheck : null;
      exceeded = result.exceeded;
      alreadyAlerted = result.alreadyAlerted;
      dispatched = result.dispatched;
      if (result.driftResult) {
        f1Gap = result.driftResult.f1Gap;
        accuracyGap = result.driftResult.accuracyGap;
      }
    } catch (err) {
      logger.warn(
        { err },
        "[holdout-drift] Scheduler tick threw unexpectedly (non-fatal).",
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
        lastTickExceeded: exceeded,
        lastTickAlreadyAlerted: alreadyAlerted,
        lastTickDispatched: dispatched,
        lastTickF1Gap: f1Gap,
        lastTickAccuracyGap: accuracyGap,
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
      f1Threshold: autoF1Threshold(),
      accuracyThreshold: autoAccuracyThreshold(),
      minSamples: autoMinSamples(),
    },
    "[holdout-drift] Holdout drift scheduler started.",
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
  resetResolvedPath: () => {
    RESOLVED_PATH = null;
  },
  readAlertState,
  writeAlertState,
  todayUtcKey,
  isSchedulerEnabled,
  autoIntervalMs,
  autoRetryIntervalMs,
  autoF1Threshold,
  autoAccuracyThreshold,
  autoMinSamples,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_F1_THRESHOLD,
  DEFAULT_ACCURACY_THRESHOLD,
  DEFAULT_MIN_SAMPLES,
  DEDUP_HISTORY_LIMIT,
};
