// Task #83 — Push AVRI drift flags to reviewers proactively instead of
// waiting for a calibration page visit. The drift dashboard
// (`generateAvriDriftReport`) already computes GAP_BELOW_45 and
// FAMILY_MEAN_SHIFT flags; this module:
//
//   1. Picks out flags that haven't been notified yet (de-duped by a
//      stable per-flag key so the same flag for the same week never
//      pings reviewers twice).
//   2. Dispatches one webhook POST per dispatch run (single payload
//      with all new flags so reviewers get one alert per run, not one
//      per flag) to the URL configured via AVRI_DRIFT_WEBHOOK_URL.
//   3. Persists the per-flag dedup state to
//      `data/avri-drift-notifications.json` so subsequent process
//      restarts still remember what was already announced.
//
// The webhook payload always includes a deep link to the calibration
// page (PUBLIC_URL + /feedback-analytics) and to the runbook so the
// reviewer can act on the alert without hunting for context.
//
// Email is intentionally NOT implemented here — VulnRap doesn't carry
// SMTP credentials in production. Operators that want email alerts can
// point AVRI_DRIFT_WEBHOOK_URL at their existing webhook→email bridge
// (Slack incoming webhook, Discord, PagerDuty Events v2, etc.).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";
import {
  generateAvriDriftReport,
  type AvriDriftReport,
  type DriftFlag,
} from "./avri-drift";

export interface NotifiedFlagRecord {
  /** Stable per-flag key (see `dedupKeyForFlag`). */
  key: string;
  weekStart: string;
  kind: DriftFlag["kind"];
  /** ISO timestamp when the flag was first dispatched. */
  notifiedAt: string;
  /** Original detail string at the time of the first notification. */
  detail: string;
}

interface NotificationsFile {
  _meta?: unknown;
  notified: NotifiedFlagRecord[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_PATHS = [
  // dist-relative (after tsc build): dist/lib/ -> dist/../../data
  path.resolve(__dirname, "../../data/avri-drift-notifications.json"),
  // src-relative (vitest / tsx): src/lib/ -> src/../../data
  path.resolve(__dirname, "../../data/avri-drift-notifications.json"),
  // pkg-root fallback so the file resolves regardless of where the
  // process was launched from.
  path.resolve(process.cwd(), "data/avri-drift-notifications.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/avri-drift-notifications.json"),
];

// Cap the persisted history so the file doesn't grow forever. 500 entries
// is well above what a busy 26-week window with ~10 family shifts/week
// would produce, and small enough to keep the JSON file trivially diffable.
const HISTORY_LIMIT = 500;

let RESOLVED_PATH: string | null = null;

function resolvePath(): string {
  if (RESOLVED_PATH) return RESOLVED_PATH;
  // Tests pin the storage path explicitly via AVRI_DRIFT_NOTIFICATIONS_PATH
  // so they don't touch the shipped JSON file.
  const override = process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
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
  // Fall back to the first candidate so a write can create it on demand.
  RESOLVED_PATH = CANDIDATE_PATHS[0]!;
  return RESOLVED_PATH;
}

/**
 * Stable, dedup-friendly key for a drift flag. The key intentionally
 * does NOT include the floating numbers in `detail` because those move
 * week-to-week — using them would make every refresh look like a "new"
 * flag and re-page reviewers on every dispatch.
 *
 * - `GAP_BELOW_45`: scoped by week (one per week is enough — gap is
 *   bucket-global).
 * - `FAMILY_MEAN_SHIFT`: scoped by week + bucket + family so a single
 *   week with shifts in INJECTION-T1 and MEMORY_CORRUPTION-T3 produces
 *   two distinct alerts but a re-run that re-detects the same shift
 *   does not.
 */
export function dedupKeyForFlag(flag: DriftFlag): string {
  if (flag.kind === "FAMILY_MEAN_SHIFT") {
    // detail format from avri-drift.ts:
    //   "${BUCKET} family ${family} mean shifted by ..."
    const m = /^(T1|T3) family (\S+) /.exec(flag.detail);
    if (m) {
      return `${flag.weekStart}|FAMILY_MEAN_SHIFT|${m[1]}|${m[2]}`;
    }
    // Fallback: at minimum scope by week + kind so we degrade to "one
    // alert per week" rather than "one per re-check" if the detail
    // format ever changes.
    return `${flag.weekStart}|FAMILY_MEAN_SHIFT`;
  }
  return `${flag.weekStart}|${flag.kind}`;
}

interface SelectionResult {
  newFlags: Array<DriftFlag & { key: string }>;
  alreadyNotified: Array<DriftFlag & { key: string }>;
}

/**
 * Partition the flags in a fresh drift report into "never notified" vs
 * "already notified" using the persisted dedup state.
 */
export function selectNewFlags(
  flags: DriftFlag[],
  notified: NotifiedFlagRecord[],
): SelectionResult {
  const seen = new Set(notified.map((n) => n.key));
  const newFlags: Array<DriftFlag & { key: string }> = [];
  const alreadyNotified: Array<DriftFlag & { key: string }> = [];
  // Within a single drift report two flags can produce the same key
  // (extremely unlikely in practice, but cheap to defend against): keep
  // only the first.
  const localSeen = new Set<string>();
  for (const f of flags) {
    const key = dedupKeyForFlag(f);
    const enriched = { ...f, key };
    if (seen.has(key) || localSeen.has(key)) {
      alreadyNotified.push(enriched);
      continue;
    }
    localSeen.add(key);
    newFlags.push(enriched);
  }
  return { newFlags, alreadyNotified };
}

function readState(): NotificationsFile {
  const filePath = resolvePath();
  if (!existsSync(filePath)) {
    return { notified: [] };
  }
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NotificationsFile>;
    const list = Array.isArray(parsed.notified) ? parsed.notified : [];
    const cleaned: NotifiedFlagRecord[] = [];
    for (const entry of list) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as NotifiedFlagRecord).key === "string" &&
        typeof (entry as NotifiedFlagRecord).weekStart === "string" &&
        typeof (entry as NotifiedFlagRecord).kind === "string" &&
        typeof (entry as NotifiedFlagRecord).notifiedAt === "string" &&
        typeof (entry as NotifiedFlagRecord).detail === "string"
      ) {
        cleaned.push(entry as NotifiedFlagRecord);
      }
    }
    return { _meta: parsed._meta, notified: cleaned };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "[avri-drift-notifications] Failed to read state file; starting from empty.",
    );
    return { notified: [] };
  }
}

function writeState(file: NotificationsFile): void {
  const filePath = resolvePath();
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Trim oldest first so the most-recent HISTORY_LIMIT entries are kept.
  const trimmed = file.notified.slice(-HISTORY_LIMIT);
  const payload: NotificationsFile = {
    _meta:
      file._meta ??
      "Persisted dedup state for AVRI drift notifications (Task #83). Each entry records a flag that has already been dispatched to AVRI_DRIFT_WEBHOOK_URL so the same flag for the same week never re-notifies reviewers. Capped at 500 entries.",
    notified: trimmed,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export interface NotifyOptions {
  /** Override the webhook URL (defaults to env AVRI_DRIFT_WEBHOOK_URL). */
  webhookUrl?: string;
  /** Override the public site URL used for the calibration deep link. */
  publicUrl?: string;
  /**
   * Override the runbook URL used in the dispatched payload. Defaults
   * to env AVRI_DRIFT_RUNBOOK_URL, falling back to a path off
   * PUBLIC_URL for in-repo readers.
   */
  runbookUrl?: string;
  /** Inject a custom dispatcher (used by tests to avoid real HTTP). */
  dispatch?: WebhookDispatcher;
  /** Override `now` for deterministic tests. */
  now?: () => Date;
}

export interface WebhookPayload {
  event: "avri_drift_flags";
  generatedAt: string;
  calibrationUrl: string;
  runbookUrl: string;
  thresholds: AvriDriftReport["thresholds"];
  cohort: AvriDriftReport["cohort"];
  flags: Array<{
    key: string;
    weekStart: string;
    kind: DriftFlag["kind"];
    detail: string;
  }>;
}

export type WebhookDispatcher = (
  url: string,
  payload: WebhookPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const RUNBOOK_URL_PATH = "docs/avri-drift-runbook.md";
const CALIBRATION_PATH = "/feedback-analytics";

function buildLinks(
  publicUrl: string | undefined,
  runbookUrlOverride?: string,
): {
  calibrationUrl: string;
  runbookUrl: string;
} {
  // Strip any trailing slash so the join below doesn't double-up.
  const base = (publicUrl ?? process.env.PUBLIC_URL ?? "https://vulnrap.com")
    .replace(/\/+$/, "");
  // The runbook is a Markdown file in the repo and is NOT served as a
  // static asset by the deployed Express app, so the default
  // `${PUBLIC_URL}/${RUNBOOK_URL_PATH}` link will 404 in most
  // production setups. Operators that want a working link should set
  // AVRI_DRIFT_RUNBOOK_URL to wherever they host it (GitHub blob URL,
  // internal wiki, etc.). The default is kept as the path-style link
  // so reviewers at least see the in-repo location they can `git show`.
  const runbookOverride = (
    runbookUrlOverride ??
    process.env.AVRI_DRIFT_RUNBOOK_URL ??
    ""
  ).trim();
  return {
    calibrationUrl: `${base}${CALIBRATION_PATH}`,
    runbookUrl:
      runbookOverride.length > 0 ? runbookOverride : `${base}/${RUNBOOK_URL_PATH}`,
  };
}

const defaultDispatcher: WebhookDispatcher = async (url, payload) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "vulnrap-avri-drift-notifier/1.0",
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

export interface NotificationOutcome {
  /** Flags newly dispatched in this run (zero when nothing was new). */
  notified: Array<DriftFlag & { key: string }>;
  /** Flags found in the report that had already been notified. */
  alreadyNotified: Array<DriftFlag & { key: string }>;
  /** True when a webhook URL was configured and at least one flag was new. */
  dispatched: boolean;
  /** Status from the webhook attempt (only populated when dispatched). */
  dispatchResult?: { ok: boolean; status?: number; error?: string };
  /**
   * True when there were new flags but no webhook URL was configured;
   * we still record the flags as notified so the reviewer doesn't get a
   * stale flood the moment they wire up the webhook (the goal is to
   * stop spamming, not to retro-fire backlogs).
   *
   * Operators that want the backlog can clear
   * `data/avri-drift-notifications.json` after wiring up the webhook.
   */
  webhookSkipped: boolean;
  /** The calibration deep link included in the dispatched payload. */
  calibrationUrl: string;
  /** The runbook link included in the dispatched payload. */
  runbookUrl: string;
}

/**
 * Run a fresh drift check, dispatch a webhook for any newly-firing
 * flags, and persist the dedup state.
 *
 * The dispatch is best-effort: a failed webhook does NOT mark the flags
 * as notified, so the next call will try again. This keeps the system
 * recoverable across temporary webhook outages without spamming the
 * reviewer once it comes back.
 */
export async function notifyDriftFlagsIfNew(
  driftReport: AvriDriftReport,
  opts: NotifyOptions = {},
): Promise<NotificationOutcome> {
  const state = readState();
  const partition = selectNewFlags(driftReport.flags, state.notified);
  const links = buildLinks(opts.publicUrl, opts.runbookUrl);
  const baseOutcome: NotificationOutcome = {
    notified: [],
    alreadyNotified: partition.alreadyNotified,
    dispatched: false,
    webhookSkipped: false,
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
  };
  if (partition.newFlags.length === 0) {
    return baseOutcome;
  }

  const webhookUrl =
    (opts.webhookUrl ?? process.env.AVRI_DRIFT_WEBHOOK_URL ?? "").trim();
  const now = (opts.now ?? (() => new Date()))();

  // Build the dispatch payload up-front so the same shape is shared by
  // the real dispatcher and any logging in the no-webhook path.
  const payload: WebhookPayload = {
    event: "avri_drift_flags",
    generatedAt: driftReport.generatedAt,
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
    thresholds: driftReport.thresholds,
    cohort: driftReport.cohort,
    flags: partition.newFlags.map((f) => ({
      key: f.key,
      weekStart: f.weekStart,
      kind: f.kind,
      detail: f.detail,
    })),
  };

  let dispatched = false;
  let dispatchResult: NotificationOutcome["dispatchResult"];
  let webhookSkipped = false;

  if (webhookUrl.length === 0) {
    webhookSkipped = true;
    logger.info(
      { newFlagCount: partition.newFlags.length },
      "[avri-drift-notifications] AVRI_DRIFT_WEBHOOK_URL not set; recording flags as notified without dispatch.",
    );
  } else {
    const dispatch = opts.dispatch ?? defaultDispatcher;
    dispatchResult = await dispatch(webhookUrl, payload);
    dispatched = dispatchResult.ok;
    if (!dispatchResult.ok) {
      logger.warn(
        { dispatchResult, newFlagCount: partition.newFlags.length },
        "[avri-drift-notifications] Webhook dispatch failed; flags will be retried on the next run.",
      );
      // Do NOT mark as notified — let the next call try again.
      return {
        ...baseOutcome,
        dispatched: false,
        dispatchResult,
      };
    }
    logger.info(
      { newFlagCount: partition.newFlags.length, status: dispatchResult.status },
      "[avri-drift-notifications] AVRI drift webhook dispatched.",
    );
  }

  // Persist the dedup state. Both the dispatched-OK path and the
  // skipped-no-webhook path mark the flags as notified so the reviewer
  // doesn't get retro-blasted when they finally wire up a webhook.
  const newRecords: NotifiedFlagRecord[] = partition.newFlags.map((f) => ({
    key: f.key,
    weekStart: f.weekStart,
    kind: f.kind,
    notifiedAt: now.toISOString(),
    detail: f.detail,
  }));
  writeState({
    _meta: state._meta,
    notified: [...state.notified, ...newRecords],
  });

  return {
    notified: partition.newFlags,
    alreadyNotified: partition.alreadyNotified,
    dispatched,
    dispatchResult,
    webhookSkipped,
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
  };
}

// ---------------------------------------------------------------------------
// In-process throttle for the auto-trigger from the report-create path.
//
// The drift query scans up to N weeks of reports (default 8) for every
// invocation, which is too expensive to run on every report submission.
// We keep a per-process timestamp and skip the check when the last run
// was within AVRI_DRIFT_NOTIFY_INTERVAL_MS (default 6 hours).
//
// On *failure* (drift generation throws, or the webhook returns a
// non-2xx) we use a much shorter retry interval
// (AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS, default 5 minutes) so a
// transient outage at the start of a 6h window doesn't suppress the
// next attempt for the full 6 hours.
//
// The explicit POST endpoint bypasses this throttle so reviewers and
// cron always get a synchronous answer.
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;

let lastAutoRunAt = 0;
let lastAutoRunOk = true;

function parseIntervalEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntervalEnv(process.env.AVRI_DRIFT_NOTIFY_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

function autoRetryIntervalMs(): number {
  return parseIntervalEnv(
    process.env.AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

/**
 * Fire-and-forget auto-trigger meant for the report-create path. Always
 * resolves (errors are logged and swallowed) so the caller never has to
 * await or guard against a notification failure.
 */
export async function maybeNotifyAfterReport(): Promise<void> {
  // Skip entirely when nothing is configured — saves the DB scan cost
  // for operators that don't care about drift webhooks.
  const webhookUrl = (process.env.AVRI_DRIFT_WEBHOOK_URL ?? "").trim();
  if (webhookUrl.length === 0) return;

  const now = Date.now();
  const interval = lastAutoRunOk ? autoIntervalMs() : autoRetryIntervalMs();
  if (now - lastAutoRunAt < interval) return;
  // Mark the start of the attempt so concurrent report submissions
  // don't pile up duplicate runs while this one is in flight.
  lastAutoRunAt = now;

  let ok = false;
  try {
    const driftReport = await generateAvriDriftReport({});
    const outcome = await notifyDriftFlagsIfNew(driftReport);
    // A successful run is one where: the drift report was generated AND
    // either nothing needed dispatching OR the dispatch attempt
    // succeeded / was skipped because no webhook is configured. A
    // dispatch failure (dispatchResult.ok === false) shortens the next
    // retry interval so we recover quickly from transient webhook
    // outages (Slack 5xx, etc.) without re-scanning the DB on every
    // single subsequent report submission.
    ok = !outcome.dispatchResult || outcome.dispatchResult.ok;
  } catch (err) {
    logger.warn(
      { err },
      "[avri-drift-notifications] Auto-notify after report failed (non-fatal).",
    );
    ok = false;
  } finally {
    lastAutoRunOk = ok;
  }
}

// Exported for unit tests so they can force a re-run without waiting
// for the throttle to elapse.
export const __testing = {
  resetThrottle: () => {
    lastAutoRunAt = 0;
    lastAutoRunOk = true;
  },
  resetResolvedPath: () => {
    RESOLVED_PATH = null;
  },
  getThrottleState: () => ({ lastAutoRunAt, lastAutoRunOk }),
  buildLinks,
  readState,
  writeState,
  HISTORY_LIMIT,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
};
