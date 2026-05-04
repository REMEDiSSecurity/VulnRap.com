// Task #620 — Score Stability Monitor.
//
// Re-scores recent reports against the currently-running code and writes a
// row to `report_rescore_log` whenever today's score differs from the
// stored score. Drives the reviewer-only tier-flip chart on
// `/feedback-analytics` and a >2% flip-rate alert through the existing
// AVRI alerts channel (AVRI_DRIFT_WEBHOOK_URL).
//
// Re-scoring uses `recomputeSlopScoreWithoutLlm` with the persisted
// breakdown + evidence + redacted text. That is deterministic, cheap, and
// (critically) exercises the same axis-fusion code path that flips the
// stored slopTier today — silent regressions in spectral analysis,
// hallucination detection, internal consistency, etc. all bubble up
// through this exact function. We deliberately do not re-run the LLM
// branch: that would make daily re-scores depend on a stochastic external
// signal, which is the opposite of what a stability monitor wants.
//
// All writes go through `db`. The monitor never updates `reports` — it
// only appends to `report_rescore_log`, so a flipped re-score never
// changes what end users see for an existing report.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { and, gte, lt, desc, isNotNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  reportsTable,
  reportRescoreLogTable,
  type EvidenceItem,
  type ScoreBreakdown,
} from "@workspace/db";
import { logger } from "./logger";
import { buildPublicUrl } from "./public-url";
import { recomputeSlopScoreWithoutLlm } from "./score-fusion";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOOKBACK_DAYS = 7;
// Page size for the keyset-paginated scan over `reports`. Tuned to
// keep memory bounded while letting one nightly tick chew through a
// realistic 7-day window (~tens of thousands of rows) without ever
// truncating the result. The pass loops until a page returns fewer
// than `BATCH_SIZE` rows, so the only safety cap is `MAX_PAGES`.
const BATCH_SIZE = 500;
// Hard upper bound on pages per pass. At 500 rows/page this caps the
// pass at 500k reports — well above any realistic 7-day volume — so a
// runaway query (e.g. cutoff misconfigured to "all time") still
// terminates instead of hanging the scheduler.
const MAX_PAGES = 1000;
export const DEFAULT_FLIP_RATE_THRESHOLD = 0.02; // 2 %

const ALERT_STATE_CANDIDATES = [
  path.resolve(__dirname, "../../data/score-stability-alerts.json"),
  path.resolve(process.cwd(), "data/score-stability-alerts.json"),
  path.resolve(
    process.cwd(),
    "artifacts/api-server/data/score-stability-alerts.json",
  ),
];

let RESOLVED_ALERT_PATH: string | null = null;

function resolveAlertStatePath(): string {
  if (RESOLVED_ALERT_PATH) return RESOLVED_ALERT_PATH;
  const override = process.env.SCORE_STABILITY_ALERT_STATE_PATH;
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
  /** Per-day dedup keys for flip-rate alerts already dispatched. */
  alertedDays: string[];
}

const ALERT_HISTORY_LIMIT = 90;

function readAlertState(): AlertStateFile {
  const filePath = resolveAlertStatePath();
  if (!existsSync(filePath)) return { alertedDays: [] };
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AlertStateFile>;
    const list = Array.isArray(parsed.alertedDays)
      ? parsed.alertedDays.filter((d): d is string => typeof d === "string")
      : [];
    return { alertedDays: list };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "[score-stability] Failed to read alert state file; starting from empty.",
    );
    return { alertedDays: [] };
  }
}

function writeAlertState(state: AlertStateFile): void {
  const filePath = resolveAlertStatePath();
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const trimmed = state.alertedDays.slice(-ALERT_HISTORY_LIMIT);
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        _meta:
          "Per-day dedup keys for the score-stability flip-rate alerts. Capped at the last 90 days; oldest trimmed first.",
        alertedDays: trimmed,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

export interface RescorePassOptions {
  /** Override the lookback window in days (default 7). */
  lookbackDays?: number;
  /**
   * Optional hard cap on the number of rows processed in one pass —
   * used by tests to keep them deterministic. The scheduler path
   * always paginates the full lookback window; do not set this in
   * production.
   */
  limit?: number;
  /** Override `now` for deterministic tests. */
  now?: () => Date;
  /** Override the code-version label written to the log. */
  codeVersion?: string;
}

export interface RescorePassResult {
  scanned: number;
  logged: number;
  flips: number;
  /** Rows skipped because they had no breakdown / evidence / text. */
  skippedNoSignals: number;
  /**
   * Rows whose insert was a no-op because the same
   * (report_id, code_version, UTC day) was already logged — by an
   * earlier retry on this replica or a parallel replica. Counted
   * separately from `failed` so the scheduler can stay green.
   */
  skippedDuplicate: number;
  /** Rows skipped because rescoring threw (counted, not failed). */
  failed: number;
  codeVersion: string;
}

/**
 * Best-effort current-process code version for the audit row. Production
 * passes SCORE_STABILITY_CODE_VERSION (set during deploy); local /
 * tests fall back to "unknown" rather than spelunking through git.
 */
export function currentCodeVersion(): string {
  const explicit = (process.env.SCORE_STABILITY_CODE_VERSION ?? "").trim();
  if (explicit.length > 0) return explicit.slice(0, 64);
  const replitDeploy = (process.env.REPLIT_DEPLOYMENT_ID ?? "").trim();
  if (replitDeploy.length > 0) return replitDeploy.slice(0, 64);
  return "unknown";
}

interface CandidateRow {
  id: number;
  slopScore: number;
  slopTier: string;
  breakdown: ScoreBreakdown | null;
  evidence: EvidenceItem[] | null;
  redactedText: string | null;
  contentText: string | null;
}

/**
 * Re-score every report created in the lookback window that still has
 * the inputs needed for a deterministic re-score, paginating with a
 * keyset cursor on `reports.id` so the full window is processed (no
 * fixed truncation). Inserts use ON CONFLICT DO NOTHING against the
 * `(report_id, code_version, scored_date_utc)` unique index so
 * - retrying after a partial failure does not double-count, and
 * - multiple replicas racing on the same nightly tick converge to one
 *   row per report per day per code version (first writer wins).
 *
 * The pass appends a row for every successfully-rescored report,
 * regardless of whether the tier changed — that lets the chart
 * compute "% of volume that flipped" without also counting un-flipped
 * rows.
 */
export async function runScoreStabilityRescorePass(
  opts: RescorePassOptions = {},
): Promise<RescorePassResult> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const explicitLimit = opts.limit;
  const now = (opts.now ?? (() => new Date()))();
  const codeVersion = (opts.codeVersion ?? currentCodeVersion()).slice(0, 64);
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  let scanned = 0;
  let logged = 0;
  let flips = 0;
  let skippedNoSignals = 0;
  let skippedDuplicate = 0;
  let failed = 0;

  // Keyset cursor on `reports.id` (descending). Pagination on a
  // monotonic id is stable under concurrent inserts: a new report
  // landing mid-pass simply has a larger id than every page boundary
  // and is still in the lookback window for the *next* tick.
  let cursor: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const remaining =
      explicitLimit !== undefined
        ? explicitLimit - scanned
        : Number.POSITIVE_INFINITY;
    if (remaining <= 0) break;
    const pageSize = Math.min(BATCH_SIZE, remaining);

    const conditions = [
      gte(reportsTable.createdAt, cutoff),
      isNotNull(reportsTable.breakdown),
    ];
    if (cursor !== null) conditions.push(lt(reportsTable.id, cursor));

    const rows = (await db
      .select({
        id: reportsTable.id,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
        breakdown: reportsTable.breakdown,
        evidence: reportsTable.evidence,
        redactedText: reportsTable.redactedText,
        contentText: reportsTable.contentText,
      })
      .from(reportsTable)
      .where(and(...conditions))
      .orderBy(desc(reportsTable.id))
      .limit(pageSize)) as CandidateRow[];

    if (rows.length === 0) break;
    scanned += rows.length;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      const text = row.redactedText ?? row.contentText ?? "";
      if (!row.breakdown || text.length === 0) {
        skippedNoSignals += 1;
        continue;
      }
      try {
        const evidence = (row.evidence ?? []) as EvidenceItem[];
        const recomputed = recomputeSlopScoreWithoutLlm(
          row.breakdown,
          evidence,
          text,
        );
        const inserted = await db
          .insert(reportRescoreLogTable)
          .values({
            reportId: row.id,
            oldScore: row.slopScore,
            newScore: recomputed.slopScore,
            oldTier: row.slopTier,
            newTier: recomputed.slopTier,
            scoredAt: now,
            codeVersion,
          })
          .onConflictDoNothing()
          .returning({ id: reportRescoreLogTable.id });
        if (inserted.length > 0) {
          logged += 1;
          if (recomputed.slopTier !== row.slopTier) flips += 1;
        } else {
          // Same (report, code_version, UTC day) was already written —
          // by an earlier retry or another replica. Not an error.
          skippedDuplicate += 1;
        }
      } catch (err) {
        logger.warn(
          { err, reportId: row.id },
          "[score-stability] Re-score failed for report; continuing.",
        );
        failed += 1;
      }
    }

    if (rows.length < pageSize) break;
  }

  return {
    scanned,
    logged,
    flips,
    skippedNoSignals,
    skippedDuplicate,
    failed,
    codeVersion,
  };
}

// ---------------------------------------------------------------------------
// Tier classification + alert dispatch.
// ---------------------------------------------------------------------------

/**
 * Coarse 3-bucket classification used to decide flip *direction*. The
 * five raw `getSlopTier` labels collapse to:
 *   - legit: Clean, Likely Human
 *   - middle: Questionable
 *   - slop:  Likely Slop, Slop
 * "legit→slop" / "slop→legit" in the chart use these buckets so the
 * counts stay intuitive even as the underlying tier names evolve.
 */
export type FlipBucket = "legit" | "middle" | "slop" | "unknown";

export function bucketForTier(tier: string): FlipBucket {
  switch (tier) {
    case "Clean":
    case "Likely Human":
      return "legit";
    case "Questionable":
      return "middle";
    case "Likely Slop":
    case "Slop":
      return "slop";
    default:
      return "unknown";
  }
}

export type FlipDirection =
  | "legit_to_slop"
  | "slop_to_legit"
  | "tightened"
  | "loosened"
  | "lateral"
  | "none";

/** Direction label for a single re-score row. */
export function flipDirection(oldTier: string, newTier: string): FlipDirection {
  if (oldTier === newTier) return "none";
  const o = bucketForTier(oldTier);
  const n = bucketForTier(newTier);
  if (o === "legit" && n === "slop") return "legit_to_slop";
  if (o === "slop" && n === "legit") return "slop_to_legit";
  if (o === "legit" && n === "middle") return "tightened";
  if (o === "middle" && n === "slop") return "tightened";
  if (o === "slop" && n === "middle") return "loosened";
  if (o === "middle" && n === "legit") return "loosened";
  return "lateral";
}

export interface DailyFlipBucket {
  /** ISO date `YYYY-MM-DD` (UTC). */
  date: string;
  total: number;
  flips: number;
  legitToSlop: number;
  slopToLegit: number;
  tightened: number;
  loosened: number;
  lateral: number;
  /** flips / total, 4 decimal places. */
  flipRate: number;
}

export interface ScoreStabilitySummary {
  generatedAt: string;
  lookbackDays: number;
  alertThreshold: number;
  /** Most-recent first. */
  daily: DailyFlipBucket[];
  totals: {
    total: number;
    flips: number;
    legitToSlop: number;
    slopToLegit: number;
    tightened: number;
    loosened: number;
    lateral: number;
    flipRate: number;
  };
}

interface DailyAccumulator {
  total: number;
  flips: number;
  legitToSlop: number;
  slopToLegit: number;
  tightened: number;
  loosened: number;
  lateral: number;
}

function emptyAcc(): DailyAccumulator {
  return {
    total: 0,
    flips: 0,
    legitToSlop: 0,
    slopToLegit: 0,
    tightened: 0,
    loosened: 0,
    lateral: 0,
  };
}

function isoDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` as a UTC midnight. */
function utcDayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export interface SummaryOptions {
  lookbackDays?: number;
  alertThreshold?: number;
  now?: () => Date;
}

/**
 * Aggregate `report_rescore_log` rows from the lookback window into
 * per-day flip counts. Backs both the chart endpoint and the alert
 * decision.
 */
export async function computeScoreStabilitySummary(
  opts: SummaryOptions = {},
): Promise<ScoreStabilitySummary> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const alertThreshold =
    opts.alertThreshold ?? readFlipRateThreshold(DEFAULT_FLIP_RATE_THRESHOLD);
  const now = (opts.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      oldTier: reportRescoreLogTable.oldTier,
      newTier: reportRescoreLogTable.newTier,
      scoredAt: reportRescoreLogTable.scoredAt,
    })
    .from(reportRescoreLogTable)
    .where(gte(reportRescoreLogTable.scoredAt, cutoff))
    .orderBy(desc(reportRescoreLogTable.scoredAt));

  const byDay = new Map<string, DailyAccumulator>();
  // Seed every day in the window so the chart renders zeros instead of
  // gaps for days the scheduler ran but found nothing to log.
  for (let i = 0; i < lookbackDays; i++) {
    const dayMs = now.getTime() - i * 24 * 60 * 60 * 1000;
    byDay.set(isoDayUtc(new Date(dayMs)), emptyAcc());
  }

  for (const row of rows) {
    const day = isoDayUtc(row.scoredAt as Date);
    const acc = byDay.get(day) ?? emptyAcc();
    acc.total += 1;
    const dir = flipDirection(row.oldTier, row.newTier);
    if (dir !== "none") {
      acc.flips += 1;
      if (dir === "legit_to_slop") acc.legitToSlop += 1;
      else if (dir === "slop_to_legit") acc.slopToLegit += 1;
      else if (dir === "tightened") acc.tightened += 1;
      else if (dir === "loosened") acc.loosened += 1;
      else acc.lateral += 1;
    }
    byDay.set(day, acc);
  }

  const daily: DailyFlipBucket[] = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, acc]) => ({
      date,
      total: acc.total,
      flips: acc.flips,
      legitToSlop: acc.legitToSlop,
      slopToLegit: acc.slopToLegit,
      tightened: acc.tightened,
      loosened: acc.loosened,
      lateral: acc.lateral,
      flipRate:
        acc.total > 0 ? Math.round((acc.flips / acc.total) * 10000) / 10000 : 0,
    }));

  const totals = daily.reduce(
    (a, d) => {
      a.total += d.total;
      a.flips += d.flips;
      a.legitToSlop += d.legitToSlop;
      a.slopToLegit += d.slopToLegit;
      a.tightened += d.tightened;
      a.loosened += d.loosened;
      a.lateral += d.lateral;
      return a;
    },
    {
      total: 0,
      flips: 0,
      legitToSlop: 0,
      slopToLegit: 0,
      tightened: 0,
      loosened: 0,
      lateral: 0,
      flipRate: 0,
    },
  );
  totals.flipRate =
    totals.total > 0
      ? Math.round((totals.flips / totals.total) * 10000) / 10000
      : 0;

  return {
    generatedAt: now.toISOString(),
    lookbackDays,
    alertThreshold,
    daily,
    totals,
  };
}

export interface FlipDetail {
  reportId: number;
  oldTier: string;
  newTier: string;
  oldScore: number;
  newScore: number;
  direction: FlipDirection;
}

export interface DayFlipsResult {
  date: string;
  flips: FlipDetail[];
}

export async function listFlipsForDay(
  date: string,
): Promise<DayFlipsResult> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      reportId: reportRescoreLogTable.reportId,
      oldTier: reportRescoreLogTable.oldTier,
      newTier: reportRescoreLogTable.newTier,
      oldScore: reportRescoreLogTable.oldScore,
      newScore: reportRescoreLogTable.newScore,
    })
    .from(reportRescoreLogTable)
    .where(
      and(
        gte(reportRescoreLogTable.scoredAt, dayStart),
        lt(reportRescoreLogTable.scoredAt, dayEnd),
      ),
    )
    .orderBy(desc(reportRescoreLogTable.id));

  const flips: FlipDetail[] = [];
  for (const row of rows) {
    const dir = flipDirection(row.oldTier, row.newTier);
    if (dir === "none") continue;
    flips.push({
      reportId: row.reportId,
      oldTier: row.oldTier,
      newTier: row.newTier,
      oldScore: row.oldScore,
      newScore: row.newScore,
      direction: dir,
    });
  }

  return { date, flips };
}

function readFlipRateThreshold(fallback: number): number {
  const raw = (process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD ?? "").trim();
  if (raw.length === 0) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Alert dispatch.
// ---------------------------------------------------------------------------

export interface ScoreStabilityAlertPayload {
  event: "score_stability_flip_rate_exceeded";
  generatedAt: string;
  date: string;
  flipRate: number;
  alertThreshold: number;
  total: number;
  flips: number;
  legitToSlop: number;
  slopToLegit: number;
  codeVersion: string;
  calibrationUrl: string;
  runbookUrl: string;
}

export type ScoreStabilityDispatcher = (
  url: string,
  payload: ScoreStabilityAlertPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const defaultDispatcher: ScoreStabilityDispatcher = async (url, payload) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "vulnrap-score-stability-monitor/1.0",
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

const RUNBOOK_PATH = "docs/score-stability-runbook.md";
const CALIBRATION_PATH = "/feedback-analytics";

function buildLinks(publicUrlOverride?: string, runbookOverride?: string) {
  const base = buildPublicUrl({ override: publicUrlOverride });
  const runbook = (
    runbookOverride ??
    process.env.SCORE_STABILITY_RUNBOOK_URL ??
    ""
  ).trim();
  return {
    calibrationUrl: `${base}${CALIBRATION_PATH}`,
    runbookUrl: runbook.length > 0 ? runbook : `${base}/${RUNBOOK_PATH}`,
  };
}

export interface AlertOptions {
  /** Webhook URL — defaults to AVRI_DRIFT_WEBHOOK_URL ("existing AVRI alerts channel"). */
  webhookUrl?: string;
  publicUrl?: string;
  runbookUrl?: string;
  dispatch?: ScoreStabilityDispatcher;
  now?: () => Date;
  /** Day to evaluate (default: yesterday UTC). */
  evaluateDate?: string;
  alertThreshold?: number;
  codeVersion?: string;
  summary?: ScoreStabilitySummary;
}

export interface AlertOutcome {
  /** Day evaluated (`YYYY-MM-DD`). */
  date: string;
  flipRate: number;
  alertThreshold: number;
  /** True when the day's flip-rate exceeded the threshold. */
  exceeded: boolean;
  /** True when a webhook URL was set AND the dispatch succeeded. */
  dispatched: boolean;
  /** True when the day was over threshold but already alerted. */
  alreadyAlerted: boolean;
  /** True when the day was over threshold but no webhook was configured. */
  webhookSkipped: boolean;
  dispatchResult?: { ok: boolean; status?: number; error?: string };
}

/**
 * Evaluate the previous day's flip-rate and dispatch a single alert if
 * it exceeded the threshold. Dedup: the day's date is recorded in
 * `data/score-stability-alerts.json` after a successful dispatch (or
 * when the dispatch is skipped because no webhook is configured), so
 * the next scheduler run never re-pages reviewers for the same day.
 */
export async function dispatchScoreStabilityAlertIfNeeded(
  opts: AlertOptions = {},
): Promise<AlertOutcome> {
  const now = (opts.now ?? (() => new Date()))();
  // Default to yesterday UTC: nightly job runs after midnight and
  // evaluates the day that just closed.
  const date =
    opts.evaluateDate ??
    isoDayUtc(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const alertThreshold =
    opts.alertThreshold ?? readFlipRateThreshold(DEFAULT_FLIP_RATE_THRESHOLD);

  const summary =
    opts.summary ??
    (await computeScoreStabilitySummary({
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      alertThreshold,
      now: () => now,
    }));
  const day = summary.daily.find((d) => d.date === date);
  if (!day || day.total === 0) {
    return {
      date,
      flipRate: 0,
      alertThreshold,
      exceeded: false,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
    };
  }
  if (day.flipRate <= alertThreshold) {
    return {
      date,
      flipRate: day.flipRate,
      alertThreshold,
      exceeded: false,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
    };
  }

  const state = readAlertState();
  if (state.alertedDays.includes(date)) {
    return {
      date,
      flipRate: day.flipRate,
      alertThreshold,
      exceeded: true,
      dispatched: false,
      alreadyAlerted: true,
      webhookSkipped: false,
    };
  }

  const links = buildLinks(opts.publicUrl, opts.runbookUrl);
  const payload: ScoreStabilityAlertPayload = {
    event: "score_stability_flip_rate_exceeded",
    generatedAt: now.toISOString(),
    date,
    flipRate: day.flipRate,
    alertThreshold,
    total: day.total,
    flips: day.flips,
    legitToSlop: day.legitToSlop,
    slopToLegit: day.slopToLegit,
    codeVersion: (opts.codeVersion ?? currentCodeVersion()).slice(0, 64),
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
  };

  const webhookUrl = (
    opts.webhookUrl ??
    process.env.AVRI_DRIFT_WEBHOOK_URL ??
    ""
  ).trim();

  if (webhookUrl.length === 0) {
    // No webhook configured — record the day as alerted so wiring up a
    // webhook later doesn't replay yesterday's alarm. Mirrors the
    // drift-notifications "webhookSkipped" pattern.
    writeAlertState({ alertedDays: [...state.alertedDays, date] });
    logger.info(
      { date, flipRate: day.flipRate, alertThreshold },
      "[score-stability] Flip-rate exceeded threshold but AVRI_DRIFT_WEBHOOK_URL is unset; recording as alerted.",
    );
    return {
      date,
      flipRate: day.flipRate,
      alertThreshold,
      exceeded: true,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: true,
    };
  }

  const dispatch = opts.dispatch ?? defaultDispatcher;
  const dispatchResult = await dispatch(webhookUrl, payload);
  if (!dispatchResult.ok) {
    logger.warn(
      { dispatchResult, date, flipRate: day.flipRate },
      "[score-stability] Alert dispatch failed; will retry on the next pass.",
    );
    return {
      date,
      flipRate: day.flipRate,
      alertThreshold,
      exceeded: true,
      dispatched: false,
      alreadyAlerted: false,
      webhookSkipped: false,
      dispatchResult,
    };
  }

  writeAlertState({ alertedDays: [...state.alertedDays, date] });
  logger.info(
    {
      date,
      flipRate: day.flipRate,
      alertThreshold,
      status: dispatchResult.status,
    },
    "[score-stability] Flip-rate alert dispatched.",
  );
  return {
    date,
    flipRate: day.flipRate,
    alertThreshold,
    exceeded: true,
    dispatched: true,
    alreadyAlerted: false,
    webhookSkipped: false,
    dispatchResult,
  };
}

// Test hooks.
export const __testing = {
  resetAlertState: () => {
    RESOLVED_ALERT_PATH = null;
  },
  resolveAlertStatePath,
  readAlertState,
  writeAlertState,
  readFlipRateThreshold,
  DEFAULT_FLIP_RATE_THRESHOLD,
  DEFAULT_LOOKBACK_DAYS,
  BATCH_SIZE,
  MAX_PAGES,
};
