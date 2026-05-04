// Task #984 — Shadow Drift Monitor.
//
// Evaluates shadow vs live divergence on `report_shadow_scores` across a
// configurable lookback window and dispatches a deduplicated webhook alert
// (via the existing AVRI_DRIFT_WEBHOOK_URL channel) when the divergent-rows
// ratio or the legit↔slop tier-flip count crosses a configurable threshold.
//
// The alert evaluates the FULL lookback window (default 7 days), not a
// single day. This means a multi-day outage followed by a scheduler
// recovery will still surface drift that accumulated while the scheduler
// was down.
//
// "Tier flips" for threshold purposes count only legit↔slop transitions
// (shadow moved a report from a legit tier to a slop tier or vice versa),
// matching the task requirement for "legit↔slop tier-flip count". The
// tier buckets mirror `score-stability-monitor.ts`:
//   - legit: Clean, Likely Human
//   - slop:  Likely Slop, Slop
//
// Mirrors the alert pattern established by `score-stability-monitor.ts`:
//   - File-based dedup state keyed by lookback-window end date.
//   - Env-tunable thresholds (SHADOW_DRIFT_DIVERGENCE_THRESHOLD,
//     SHADOW_DRIFT_TIER_FLIP_THRESHOLD, SHADOW_DRIFT_LOOKBACK_DAYS).
//   - Injectable dispatcher for tests.
//   - Links to the reviewer panel (/feedback-analytics) in the payload.

import { readFileSync, existsSync } from "fs";
import { atomicWriteJsonFileSync } from "./atomic-write";
import path from "path";
import { fileURLToPath } from "url";
import { and, gte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { reportShadowScoresTable } from "@workspace/db";
import { logger } from "./logger";
import { buildPublicUrl } from "./public-url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_DIVERGENCE_THRESHOLD = 0.1;
export const DEFAULT_TIER_FLIP_THRESHOLD = 20;

const SCORE_DELTA_THRESHOLD = 10;

const LEGIT_TIERS = new Set(["Clean", "Likely Human"]);
const SLOP_TIERS = new Set(["Likely Slop", "Slop"]);

export type TierBucket = "legit" | "middle" | "slop" | "unknown";

export function bucketForTier(tier: string): TierBucket {
  if (LEGIT_TIERS.has(tier)) return "legit";
  if (SLOP_TIERS.has(tier)) return "slop";
  if (tier === "Questionable") return "middle";
  return "unknown";
}

export function isLegitSlopFlip(liveTier: string, shadowTier: string): boolean {
  const live = bucketForTier(liveTier);
  const shadow = bucketForTier(shadowTier);
  return (
    (live === "legit" && shadow === "slop") ||
    (live === "slop" && shadow === "legit")
  );
}

const ALERT_STATE_CANDIDATES = [
  path.resolve(__dirname, "../../data/shadow-drift-alerts.json"),
  path.resolve(process.cwd(), "data/shadow-drift-alerts.json"),
  path.resolve(
    process.cwd(),
    "artifacts/api-server/data/shadow-drift-alerts.json",
  ),
];

let RESOLVED_ALERT_PATH: string | null = null;

function resolveAlertStatePath(): string {
  if (RESOLVED_ALERT_PATH) return RESOLVED_ALERT_PATH;
  const override = process.env.SHADOW_DRIFT_ALERT_STATE_PATH;
  if (override && override.trim().length > 0) {
    RESOLVED_ALERT_PATH = path.resolve(override);
    return RESOLVED_ALERT_PATH;
  }
  for (const p of ALERT_STATE_CANDIDATES) {
    if (existsSync(p)) {
      RESOLVED_ALERT_PATH = p;
      return p;
    }
  }
  RESOLVED_ALERT_PATH = ALERT_STATE_CANDIDATES[0]!;
  return RESOLVED_ALERT_PATH;
}

interface AlertStateFile {
  alertedWindows: string[];
}

const ALERT_HISTORY_LIMIT = 90;

function readAlertState(): AlertStateFile {
  const filePath = resolveAlertStatePath();
  if (!existsSync(filePath)) return { alertedWindows: [] };
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertStateFile>;
    const list = Array.isArray(parsed.alertedWindows)
      ? parsed.alertedWindows.filter(
          (d): d is string => typeof d === "string",
        )
      : [];
    return { alertedWindows: list };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "[shadow-drift] Failed to read alert state file; starting from empty.",
    );
    return { alertedWindows: [] };
  }
}

function writeAlertState(state: AlertStateFile): void {
  const filePath = resolveAlertStatePath();
  const trimmed = state.alertedWindows.slice(-ALERT_HISTORY_LIMIT);
  atomicWriteJsonFileSync(filePath, {
    _meta:
      "Per-window dedup keys for the shadow-drift divergence alerts. Capped at the last 90 entries; oldest trimmed first.",
    alertedWindows: trimmed,
  });
}

function readLookbackDays(fallback: number): number {
  const raw = (process.env.SHADOW_DRIFT_LOOKBACK_DAYS ?? "").trim();
  if (raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) return fallback;
  return parsed;
}

function readDivergenceThreshold(fallback: number): number {
  const raw = (process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD ?? "").trim();
  if (raw.length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function readTierFlipThreshold(fallback: number): number {
  const raw = (process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD ?? "").trim();
  if (raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export interface ShadowDriftSummary {
  lookbackDays: number;
  windowStart: string;
  windowEnd: string;
  total: number;
  divergent: number;
  legitSlopFlips: number;
  divergenceRate: number;
  legitToSlop: number;
  slopToLegit: number;
}

function isoDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeShadowDriftSummary(opts: {
  lookbackDays?: number;
  now?: () => Date;
}): Promise<ShadowDriftSummary> {
  const now = (opts.now ?? (() => new Date()))();
  const lookbackDays = opts.lookbackDays ?? readLookbackDays(DEFAULT_LOOKBACK_DAYS);
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      divergent: sql<number>`count(*) filter (where ${reportShadowScoresTable.tierDiverged} = true OR abs(${reportShadowScoresTable.scoreDiff}) >= ${SCORE_DELTA_THRESHOLD})::int`,
    })
    .from(reportShadowScoresTable)
    .where(gte(reportShadowScoresTable.scoredAt, cutoff));

  const total = totals?.total ?? 0;
  const divergent = totals?.divergent ?? 0;
  const divergenceRate =
    total > 0 ? Math.round((divergent / total) * 10000) / 10000 : 0;

  const tierRows = await db
    .select({
      liveTier: reportShadowScoresTable.liveTier,
      shadowTier: reportShadowScoresTable.shadowTier,
    })
    .from(reportShadowScoresTable)
    .where(
      and(
        gte(reportShadowScoresTable.scoredAt, cutoff),
        sql`${reportShadowScoresTable.tierDiverged} = true`,
      ),
    );

  let legitToSlop = 0;
  let slopToLegit = 0;
  for (const row of tierRows) {
    const liveBucket = bucketForTier(row.liveTier);
    const shadowBucket = bucketForTier(row.shadowTier);
    if (liveBucket === "legit" && shadowBucket === "slop") legitToSlop += 1;
    else if (liveBucket === "slop" && shadowBucket === "legit")
      slopToLegit += 1;
  }

  return {
    lookbackDays,
    windowStart: isoDayUtc(cutoff),
    windowEnd: isoDayUtc(now),
    total,
    divergent,
    legitSlopFlips: legitToSlop + slopToLegit,
    divergenceRate,
    legitToSlop,
    slopToLegit,
  };
}

export interface ShadowDriftAlertPayload {
  event: "shadow_drift_threshold_exceeded";
  generatedAt: string;
  lookbackDays: number;
  windowStart: string;
  windowEnd: string;
  divergenceRate: number;
  divergenceThreshold: number;
  legitSlopFlips: number;
  tierFlipThreshold: number;
  total: number;
  divergent: number;
  legitToSlop: number;
  slopToLegit: number;
  triggeredBy: "divergence_rate" | "tier_flip_count" | "both";
  reviewerPanelUrl: string;
}

export type ShadowDriftDispatcher = (
  url: string,
  payload: ShadowDriftAlertPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const defaultDispatcher: ShadowDriftDispatcher = async (url, payload) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "vulnrap-shadow-drift-monitor/1.0",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok)
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const REVIEWER_PANEL_PATH = "/feedback-analytics";

export interface AlertOptions {
  webhookUrl?: string;
  publicUrl?: string;
  dispatch?: ShadowDriftDispatcher;
  now?: () => Date;
  lookbackDays?: number;
  divergenceThreshold?: number;
  tierFlipThreshold?: number;
  summary?: ShadowDriftSummary;
}

export interface AlertOutcome {
  windowKey: string;
  lookbackDays: number;
  divergenceRate: number;
  divergenceThreshold: number;
  legitSlopFlips: number;
  tierFlipThreshold: number;
  exceeded: boolean;
  triggeredBy: "divergence_rate" | "tier_flip_count" | "both" | "none";
  dispatched: boolean;
  alreadyAlerted: boolean;
  webhookSkipped: boolean;
  dispatchResult?: { ok: boolean; status?: number; error?: string };
}

export async function dispatchShadowDriftAlertIfNeeded(
  opts: AlertOptions = {},
): Promise<AlertOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  const lookbackDays =
    opts.lookbackDays ?? readLookbackDays(DEFAULT_LOOKBACK_DAYS);
  const divergenceThreshold =
    opts.divergenceThreshold ??
    readDivergenceThreshold(DEFAULT_DIVERGENCE_THRESHOLD);
  const tierFlipThreshold =
    opts.tierFlipThreshold ??
    readTierFlipThreshold(DEFAULT_TIER_FLIP_THRESHOLD);

  const summary =
    opts.summary ??
    (await computeShadowDriftSummary({ lookbackDays, now: () => now }));

  const windowKey = `${summary.windowStart}..${summary.windowEnd}`;

  const baseOutcome = {
    windowKey,
    lookbackDays: summary.lookbackDays,
    divergenceRate: summary.divergenceRate,
    divergenceThreshold,
    legitSlopFlips: summary.legitSlopFlips,
    tierFlipThreshold,
  };

  if (summary.total === 0) {
    return {
      ...baseOutcome,
      divergenceRate: 0,
      legitSlopFlips: 0,
      exceeded: false,
      triggeredBy: "none" as const,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
    };
  }

  const rateExceeded = summary.divergenceRate > divergenceThreshold;
  const flipExceeded = summary.legitSlopFlips > tierFlipThreshold;

  if (!rateExceeded && !flipExceeded) {
    return {
      ...baseOutcome,
      exceeded: false,
      triggeredBy: "none" as const,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
    };
  }

  const triggeredBy: "divergence_rate" | "tier_flip_count" | "both" =
    rateExceeded && flipExceeded
      ? "both"
      : rateExceeded
        ? "divergence_rate"
        : "tier_flip_count";

  const state = readAlertState();
  if (state.alertedWindows.includes(windowKey)) {
    return {
      ...baseOutcome,
      exceeded: true,
      triggeredBy,
      dispatched: false,
      alreadyAlerted: true,
      webhookSkipped: false,
    };
  }

  const base = buildPublicUrl({ override: opts.publicUrl });
  const payload: ShadowDriftAlertPayload = {
    event: "shadow_drift_threshold_exceeded",
    generatedAt: now.toISOString(),
    lookbackDays: summary.lookbackDays,
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
    divergenceRate: summary.divergenceRate,
    divergenceThreshold,
    legitSlopFlips: summary.legitSlopFlips,
    tierFlipThreshold,
    total: summary.total,
    divergent: summary.divergent,
    legitToSlop: summary.legitToSlop,
    slopToLegit: summary.slopToLegit,
    triggeredBy,
    reviewerPanelUrl: `${base}${REVIEWER_PANEL_PATH}`,
  };

  const webhookUrl = (
    opts.webhookUrl ??
    process.env.AVRI_DRIFT_WEBHOOK_URL ??
    ""
  ).trim();

  if (webhookUrl.length === 0) {
    writeAlertState({
      alertedWindows: [...state.alertedWindows, windowKey],
    });
    logger.info(
      {
        windowKey,
        divergenceRate: summary.divergenceRate,
        legitSlopFlips: summary.legitSlopFlips,
        triggeredBy,
      },
      "[shadow-drift] Threshold exceeded but AVRI_DRIFT_WEBHOOK_URL is unset; recording as alerted.",
    );
    return {
      ...baseOutcome,
      exceeded: true,
      triggeredBy,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: true,
    };
  }

  const dispatch = opts.dispatch ?? defaultDispatcher;
  const dispatchResult = await dispatch(webhookUrl, payload);
  if (!dispatchResult.ok) {
    logger.warn(
      {
        dispatchResult,
        windowKey,
        divergenceRate: summary.divergenceRate,
        legitSlopFlips: summary.legitSlopFlips,
      },
      "[shadow-drift] Alert dispatch failed; will retry on the next pass.",
    );
    return {
      ...baseOutcome,
      exceeded: true,
      triggeredBy,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
      dispatchResult,
    };
  }

  writeAlertState({
    alertedWindows: [...state.alertedWindows, windowKey],
  });
  logger.info(
    {
      windowKey,
      divergenceRate: summary.divergenceRate,
      legitSlopFlips: summary.legitSlopFlips,
      triggeredBy,
      status: dispatchResult.status,
    },
    "[shadow-drift] Shadow drift alert dispatched.",
  );
  return {
    ...baseOutcome,
    exceeded: true,
    triggeredBy,
    dispatched: true,
    alreadyAlerted: false,
    webhookSkipped: false,
    dispatchResult,
  };
}

export const __testing = {
  resetAlertState: () => {
    RESOLVED_ALERT_PATH = null;
  },
  resolveAlertStatePath,
  readAlertState,
  writeAlertState,
  readDivergenceThreshold,
  readTierFlipThreshold,
  readLookbackDays,
  bucketForTier,
  isLegitSlopFlip,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_DIVERGENCE_THRESHOLD,
  DEFAULT_TIER_FLIP_THRESHOLD,
};
