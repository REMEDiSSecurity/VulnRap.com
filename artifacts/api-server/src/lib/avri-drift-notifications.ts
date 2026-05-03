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
import { hostname as osHostname } from "os";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger";
import { buildPublicUrl } from "./public-url";
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

/**
 * Audit entry recorded every time `removeNotifiedFlags` re-arms a
 * previously-notified flag. Preserves the original notification
 * metadata plus the wall-clock + reviewer context for the re-arm.
 */
export interface RearmAuditEntry {
  /** Stable per-flag dedup key that was re-armed. */
  key: string;
  /** Week the flag was scoped to (preserved from the dedup record). */
  weekStart: string;
  /** Flag kind (preserved from the dedup record). */
  kind: DriftFlag["kind"];
  /** ISO timestamp when the original notification first dispatched. */
  originalNotifiedAt: string;
  /** Original detail string at the time of the first notification. */
  originalDetail: string;
  /** ISO timestamp when the entry was re-armed. */
  rearmedAt: string;
  /** Optional reviewer name supplied by the calibration UI. */
  rearmedBy?: string;
  /** Optional free-form rationale supplied by the reviewer. */
  rationale?: string;
}

/**
 * Audit entry recorded every time the stalled-scheduler watchdog
 * dispatches a "scheduler appears wedged" alert. Persisted to the same
 * state file as drift flags so a process restart still remembers which
 * stall windows were already announced and never double-pages reviewers
 * for the same missed tick.
 */
export interface SchedulerStallRecord {
  /**
   * Stable per-stall key. Derived from the missed `nextTickAt` so a
   * different stall window (i.e. the scheduler resumed and later got
   * stuck on a *different* expected tick) produces a distinct key and
   * a fresh alert.
   */
  key: string;
  /** ISO timestamp when the stall was detected and dispatched. */
  detectedAt: string;
  /** ISO timestamp of the missed scheduled tick. */
  expectedNextTickAt: string;
  /** ms that had elapsed past `expectedNextTickAt` when detected. */
  overdueByMs: number;
  /** Configured success-case interval at the time of detection. */
  intervalMs: number;
}

interface NotificationsFile {
  _meta?: unknown;
  notified: NotifiedFlagRecord[];
  /**
   * Bounded audit log of re-arm events. Optional on disk so older
   * state files keep loading; `readState` normalizes it to an array.
   */
  rearmHistory?: RearmAuditEntry[];
  /**
   * Bounded audit log of stalled-scheduler alerts dispatched by the
   * watchdog. Optional on disk so older state files keep loading;
   * `readState` normalizes it to an array.
   */
  schedulerStalls?: SchedulerStallRecord[];
  /**
   * Task #397 — per-replica scheduler heartbeats so the calibration
   * UI can render one row per server replica and detect a wedged
   * replica that's hiding behind a healthy one. Keyed by `replicaId`
   * so concurrent writes from different replicas naturally upsert.
   * Optional on disk; pre-#397 state files load with no heartbeats
   * and the surface degrades to "this replica only".
   */
  schedulerHeartbeats?: Record<string, PersistedSchedulerHeartbeat>;
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
  path.resolve(
    process.cwd(),
    "artifacts/api-server/data/avri-drift-notifications.json",
  ),
];

// Cap the persisted history so the file doesn't grow forever. 500 entries
// is well above what a busy 26-week window with ~10 family shifts/week
// would produce, and small enough to keep the JSON file trivially diffable.
const HISTORY_LIMIT = 500;
// Bound for the re-arm audit log. 200 events covers a busy quarter
// (~3 re-arms/day). Trimmed oldest-first.
const REARM_HISTORY_LIMIT = 200;
// Bound for the stalled-scheduler audit log. A wedged scheduler should
// be a rare event (one entry per missed-tick window per replica), so
// 100 entries covers years of normal operation while staying tiny on
// disk. Trimmed oldest-first.
const STALL_HISTORY_LIMIT = 100;
// Task #397 — Cap the per-replica heartbeat map. 50 covers very large
// horizontal scale-outs and rolling-deploy churn (every redeploy
// generates a fresh boot id), and is small enough to keep the JSON
// file diffable. Oldest by `heartbeatAt` is trimmed first so the most
// recently-active replicas always win.
const SCHEDULER_HEARTBEAT_LIMIT = 50;

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
    return {
      notified: [],
      rearmHistory: [],
      schedulerStalls: [],
      schedulerHeartbeats: {},
    };
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
    // Pre-existing state files won't have a `rearmHistory` block; treat
    // that as an empty audit log so the read keeps working without
    // forcing a one-shot migration.
    const rawHistory = Array.isArray(parsed.rearmHistory)
      ? parsed.rearmHistory
      : [];
    const cleanedHistory: RearmAuditEntry[] = [];
    for (const entry of rawHistory) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as RearmAuditEntry).key === "string" &&
        typeof (entry as RearmAuditEntry).weekStart === "string" &&
        typeof (entry as RearmAuditEntry).kind === "string" &&
        typeof (entry as RearmAuditEntry).originalNotifiedAt === "string" &&
        typeof (entry as RearmAuditEntry).originalDetail === "string" &&
        typeof (entry as RearmAuditEntry).rearmedAt === "string"
      ) {
        const e = entry as RearmAuditEntry;
        const out: RearmAuditEntry = {
          key: e.key,
          weekStart: e.weekStart,
          kind: e.kind,
          originalNotifiedAt: e.originalNotifiedAt,
          originalDetail: e.originalDetail,
          rearmedAt: e.rearmedAt,
        };
        if (typeof e.rearmedBy === "string" && e.rearmedBy.length > 0) {
          out.rearmedBy = e.rearmedBy;
        }
        if (typeof e.rationale === "string" && e.rationale.length > 0) {
          out.rationale = e.rationale;
        }
        cleanedHistory.push(out);
      }
    }
    // Pre-existing state files won't have a `schedulerStalls` block;
    // treat that as an empty audit log so the read keeps working
    // without forcing a one-shot migration.
    const rawStalls = Array.isArray(parsed.schedulerStalls)
      ? parsed.schedulerStalls
      : [];
    const cleanedStalls: SchedulerStallRecord[] = [];
    for (const entry of rawStalls) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as SchedulerStallRecord).key === "string" &&
        typeof (entry as SchedulerStallRecord).detectedAt === "string" &&
        typeof (entry as SchedulerStallRecord).expectedNextTickAt ===
          "string" &&
        typeof (entry as SchedulerStallRecord).overdueByMs === "number" &&
        typeof (entry as SchedulerStallRecord).intervalMs === "number"
      ) {
        const e = entry as SchedulerStallRecord;
        cleanedStalls.push({
          key: e.key,
          detectedAt: e.detectedAt,
          expectedNextTickAt: e.expectedNextTickAt,
          overdueByMs: e.overdueByMs,
          intervalMs: e.intervalMs,
        });
      }
    }
    // Task #397 — load any persisted per-replica heartbeats. Pre-#397
    // state files won't have a `schedulerHeartbeats` block; treat it as
    // empty so the read keeps working without forcing a one-shot
    // migration.
    const rawHeartbeats =
      parsed.schedulerHeartbeats &&
      typeof parsed.schedulerHeartbeats === "object"
        ? (parsed.schedulerHeartbeats as Record<string, unknown>)
        : {};
    const cleanedHeartbeats: Record<string, PersistedSchedulerHeartbeat> = {};
    for (const [replicaId, value] of Object.entries(rawHeartbeats)) {
      const candidate = value as Partial<PersistedSchedulerHeartbeat> | null;
      if (
        candidate &&
        typeof candidate === "object" &&
        typeof candidate.replicaId === "string" &&
        typeof candidate.hostname === "string" &&
        typeof candidate.heartbeatAt === "string" &&
        typeof candidate.schedulerStarted === "boolean" &&
        typeof candidate.webhookConfigured === "boolean" &&
        typeof candidate.ticksCompleted === "number"
      ) {
        cleanedHeartbeats[replicaId] = {
          replicaId: candidate.replicaId,
          hostname: candidate.hostname,
          heartbeatAt: candidate.heartbeatAt,
          schedulerStarted: candidate.schedulerStarted,
          startedAt:
            typeof candidate.startedAt === "string"
              ? candidate.startedAt
              : null,
          intervalMs:
            typeof candidate.intervalMs === "number"
              ? candidate.intervalMs
              : null,
          retryIntervalMs:
            typeof candidate.retryIntervalMs === "number"
              ? candidate.retryIntervalMs
              : null,
          webhookConfigured: candidate.webhookConfigured,
          lastTickAt:
            typeof candidate.lastTickAt === "string"
              ? candidate.lastTickAt
              : null,
          lastTickOk:
            typeof candidate.lastTickOk === "boolean"
              ? candidate.lastTickOk
              : null,
          lastTickRanCheck:
            typeof candidate.lastTickRanCheck === "boolean"
              ? candidate.lastTickRanCheck
              : null,
          lastTickDispatched:
            typeof candidate.lastTickDispatched === "boolean"
              ? candidate.lastTickDispatched
              : null,
          lastTickNewFlagCount:
            typeof candidate.lastTickNewFlagCount === "number"
              ? candidate.lastTickNewFlagCount
              : null,
          nextTickAt:
            typeof candidate.nextTickAt === "string"
              ? candidate.nextTickAt
              : null,
          ticksCompleted: candidate.ticksCompleted,
        };
      }
    }
    return {
      _meta: parsed._meta,
      notified: cleaned,
      rearmHistory: cleanedHistory,
      schedulerStalls: cleanedStalls,
      schedulerHeartbeats: cleanedHeartbeats,
    };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "[avri-drift-notifications] Failed to read state file; starting from empty.",
    );
    return {
      notified: [],
      rearmHistory: [],
      schedulerStalls: [],
      schedulerHeartbeats: {},
    };
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
  const trimmedHistory = (file.rearmHistory ?? []).slice(-REARM_HISTORY_LIMIT);
  const trimmedStalls = (file.schedulerStalls ?? []).slice(
    -STALL_HISTORY_LIMIT,
  );
  // Task #397 — cap heartbeat map at SCHEDULER_HEARTBEAT_LIMIT, evicting
  // by oldest `heartbeatAt` so the most recently active replicas always
  // win. Rolling deploys churn replica IDs (each boot generates a fresh
  // suffix) so without a cap the file would grow per-deploy forever.
  const heartbeatsIn = file.schedulerHeartbeats ?? {};
  const heartbeatEntries = Object.entries(heartbeatsIn);
  let trimmedHeartbeats: Record<string, PersistedSchedulerHeartbeat>;
  if (heartbeatEntries.length <= SCHEDULER_HEARTBEAT_LIMIT) {
    trimmedHeartbeats = heartbeatsIn;
  } else {
    heartbeatEntries.sort((a, b) =>
      a[1].heartbeatAt.localeCompare(b[1].heartbeatAt),
    );
    trimmedHeartbeats = Object.fromEntries(
      heartbeatEntries.slice(-SCHEDULER_HEARTBEAT_LIMIT),
    );
  }
  const payload: NotificationsFile = {
    _meta:
      file._meta ??
      "Persisted dedup state for AVRI drift notifications. `notified` records flags already dispatched to AVRI_DRIFT_WEBHOOK_URL (capped at 500). `rearmHistory` is a bounded audit log of reviewer-driven re-arm events (capped at 200). `schedulerStalls` is a bounded audit log of stalled-scheduler alerts dispatched by the watchdog (capped at 100). `schedulerHeartbeats` is a per-replica scheduler health snapshot keyed by replica id (capped at 50).",
    notified: trimmed,
    rearmHistory: trimmedHistory,
    schedulerStalls: trimmedStalls,
    schedulerHeartbeats: trimmedHeartbeats,
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
  // Trailing-slash stripping + the PUBLIC_URL→default fallback ladder are
  // owned by the shared buildPublicUrl helper so this module stays in lockstep
  // with server-side links emitted from routes.ts. The `publicUrl` arg here
  // is a per-call test/operator override and takes precedence over env.
  const base = buildPublicUrl({ override: publicUrl });
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
      runbookOverride.length > 0
        ? runbookOverride
        : `${base}/${RUNBOOK_URL_PATH}`,
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

  const webhookUrl = (
    opts.webhookUrl ??
    process.env.AVRI_DRIFT_WEBHOOK_URL ??
    ""
  ).trim();
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
      {
        newFlagCount: partition.newFlags.length,
        status: dispatchResult.status,
      },
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
  // Re-read fresh state right before writing so that any concurrent
  // removeNotifiedFlags() call that landed during the awaited dispatch
  // (its `rearmHistory` append, plus its `notified` removals) is
  // preserved instead of being clobbered by the stale snapshot we read
  // at the top of this function.
  const fresh = readState();
  const freshNotifiedKeys = new Set(fresh.notified.map((n) => n.key));
  const mergedNotified = [
    ...fresh.notified,
    // Only append records that aren't already present (e.g. another
    // dispatcher run or a fast re-arm+re-fire could have raced in).
    ...newRecords.filter((r) => !freshNotifiedKeys.has(r.key)),
  ];
  writeState({
    _meta: fresh._meta,
    notified: mergedNotified,
    rearmHistory: fresh.rearmHistory ?? [],
    schedulerStalls: fresh.schedulerStalls ?? [],
    // Preserve persisted per-replica heartbeats — this writer only
    // touches the dedup state, not heartbeats.
    schedulerHeartbeats: fresh.schedulerHeartbeats ?? {},
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
// Background scheduler.
//
// Task #197: the drift check used to piggyback on POST /api/reports as a
// fire-and-forget side effect throttled to one run per ~6h per process.
// That coupled the cadence to traffic (quiet days = no checks) and made
// the throttle process-local, so multi-instance deploys would multiply
// the rate. This module now exposes a deterministic interval-timer
// scheduler started from src/index.ts at server boot, plus a single-run
// helper used by both the scheduler and the auth-gated manual endpoint.
//
// On *failure* (drift generation throws, or the webhook returns a
// non-2xx) the scheduler re-arms with a much shorter retry interval
// (AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS, default 5 minutes) so a
// transient outage at the start of a 6h window doesn't suppress the
// next attempt for the full 6 hours.
//
// The explicit POST endpoint bypasses the timer so reviewers and cron
// callers always get a synchronous answer.
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 5 * 60 * 1000;
// First tick fires shortly after boot rather than immediately so the
// scheduler doesn't compete with HTTP startup work (DB warmup, etc.).
const DEFAULT_INITIAL_DELAY_MS = 60 * 1000;

function parseIntervalEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function autoIntervalMs(): number {
  return parseIntervalEnv(
    process.env.AVRI_DRIFT_NOTIFY_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
}

function autoRetryIntervalMs(): number {
  return parseIntervalEnv(
    process.env.AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}

function isWebhookConfigured(): boolean {
  return (process.env.AVRI_DRIFT_WEBHOOK_URL ?? "").trim().length > 0;
}

/**
 * Run the drift check exactly once. Always resolves; errors are logged
 * and surfaced as `ok: false` so callers (the scheduler, tests) can
 * decide whether to retry sooner.
 *
 * Skips the DB scan entirely when AVRI_DRIFT_WEBHOOK_URL is unset, so
 * operators that don't care about drift webhooks pay zero cost per
 * tick.
 */
export async function runDriftNotificationCheck(): Promise<{
  ok: boolean;
  ranCheck: boolean;
  outcome?: NotificationOutcome;
}> {
  if (!isWebhookConfigured()) {
    return { ok: true, ranCheck: false };
  }
  try {
    const driftReport = await generateAvriDriftReport({});
    const outcome = await notifyDriftFlagsIfNew(driftReport);
    // A successful run is one where: the drift report was generated AND
    // either nothing needed dispatching OR the dispatch attempt
    // succeeded / was skipped because no webhook is configured. A
    // dispatch failure (dispatchResult.ok === false) shortens the next
    // retry interval so we recover quickly from transient webhook
    // outages (Slack 5xx, etc.).
    const ok = !outcome.dispatchResult || outcome.dispatchResult.ok;
    return { ok, ranCheck: true, outcome };
  } catch (err) {
    logger.warn(
      { err },
      "[avri-drift-notifications] Scheduled drift check failed (non-fatal).",
    );
    return { ok: false, ranCheck: true };
  }
}

export interface DriftSchedulerOptions {
  /** Override the success-case interval (defaults to env / 6h). */
  intervalMs?: number;
  /** Override the failure-case retry interval (defaults to env / 5min). */
  retryIntervalMs?: number;
  /** Delay before the first tick (defaults to 60s; tests typically pass 0). */
  initialDelayMs?: number;
  /**
   * Inject a custom runner (used by tests to avoid touching the DB).
   * Optional `ranCheck` / `outcome` fields flow through to the
   * scheduler status surface so the calibration UI can show whether
   * the last tick actually scanned the database. Tests that don't
   * care about status can keep returning just `{ ok }`.
   */
  run?: () => Promise<{
    ok: boolean;
    ranCheck?: boolean;
    outcome?: NotificationOutcome;
  }>;
}

export interface DriftScheduler {
  /** Cancel all future ticks. Safe to call multiple times. */
  stop(): void;
  /**
   * Resolves with the count of ticks that have completed. Useful for
   * tests that want to await the next scheduled tick deterministically.
   */
  ticksCompleted(): number;
}

/**
 * Read-only snapshot of the drift-notification scheduler for a single
 * replica. Backs the calibration page's heartbeat panel so reviewers
 * can confirm the timer is firing without scraping logs. The shape is
 * intentionally boolean/timestamp-only — it never carries error text
 * or webhook URLs because the backing endpoint is unauthenticated.
 *
 * Task #397: every entry is keyed by `replicaId` (a stable
 * per-process identity — see `currentReplicaId()`) so a multi-replica
 * deploy returns one row per server, and a wedged replica can't hide
 * behind a healthy one. `heartbeatAt` is the wall-clock at which this
 * snapshot was last written to the shared state file (null for the
 * live in-memory snapshot of the responding replica before its first
 * persisted heartbeat).
 */
export interface DriftSchedulerStatus {
  /** Stable per-process identity for this replica (e.g. "pod-7-a1b2c3d4"). */
  replicaId: string;
  /** Hostname (`os.hostname()`) of the replica, surfaced for the UI table. */
  hostname: string;
  /**
   * ISO timestamp at which the snapshot was last persisted to the
   * shared state file. Null for the live in-memory snapshot when
   * nothing has been persisted yet (e.g. scheduler never started in
   * this process and there is no on-disk row).
   */
  heartbeatAt: string | null;
  schedulerStarted: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  webhookConfigured: boolean;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanCheck: boolean | null;
  lastTickDispatched: boolean | null;
  lastTickNewFlagCount: number | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

/**
 * Persisted shape of a replica heartbeat in the shared state file.
 * Identical to {@link DriftSchedulerStatus} but with `heartbeatAt`
 * non-nullable (we only persist after stamping a timestamp).
 */
export interface PersistedSchedulerHeartbeat extends Omit<
  DriftSchedulerStatus,
  "heartbeatAt"
> {
  heartbeatAt: string;
}

const INITIAL_SCHEDULER_LOCAL_STATE = {
  schedulerStarted: false,
  startedAt: null as string | null,
  intervalMs: null as number | null,
  retryIntervalMs: null as number | null,
  webhookConfigured: false,
  lastTickAt: null as string | null,
  lastTickOk: null as boolean | null,
  lastTickRanCheck: null as boolean | null,
  lastTickDispatched: null as boolean | null,
  lastTickNewFlagCount: null as number | null,
  nextTickAt: null as string | null,
  ticksCompleted: 0,
};

type SchedulerLocalState = typeof INITIAL_SCHEDULER_LOCAL_STATE;

let schedulerLocal: SchedulerLocalState = { ...INITIAL_SCHEDULER_LOCAL_STATE };

// Stable per-process replica identity. Computed lazily so tests can
// override AVRI_REPLICA_ID in beforeEach without colliding with a
// frozen module-level value. The hex suffix protects against two pods
// that happen to share `os.hostname()` (e.g. a misconfigured
// dev/staging pair).
let CACHED_REPLICA_ID: string | null = null;
let CACHED_HOSTNAME: string | null = null;

function currentHostname(): string {
  if (CACHED_HOSTNAME) return CACHED_HOSTNAME;
  try {
    CACHED_HOSTNAME = osHostname() || "unknown-host";
  } catch {
    CACHED_HOSTNAME = "unknown-host";
  }
  return CACHED_HOSTNAME;
}

function currentReplicaId(): string {
  if (CACHED_REPLICA_ID) return CACHED_REPLICA_ID;
  const override = (process.env.AVRI_REPLICA_ID ?? "").trim();
  if (override.length > 0) {
    CACHED_REPLICA_ID = override;
    return CACHED_REPLICA_ID;
  }
  const suffix = randomBytes(4).toString("hex");
  CACHED_REPLICA_ID = `${currentHostname()}-${suffix}`;
  return CACHED_REPLICA_ID;
}

/**
 * Build the live `DriftSchedulerStatus` for the current replica from
 * the in-memory bookkeeping struct. `heartbeatAt` is set by the caller
 * when persisting; the live read returns null until the persisted row
 * is loaded back.
 */
function buildLocalStatus(heartbeatAt: string | null): DriftSchedulerStatus {
  return {
    replicaId: currentReplicaId(),
    hostname: currentHostname(),
    heartbeatAt,
    schedulerStarted: schedulerLocal.schedulerStarted,
    startedAt: schedulerLocal.startedAt,
    intervalMs: schedulerLocal.intervalMs,
    retryIntervalMs: schedulerLocal.retryIntervalMs,
    webhookConfigured: isWebhookConfigured(),
    lastTickAt: schedulerLocal.lastTickAt,
    lastTickOk: schedulerLocal.lastTickOk,
    lastTickRanCheck: schedulerLocal.lastTickRanCheck,
    lastTickDispatched: schedulerLocal.lastTickDispatched,
    lastTickNewFlagCount: schedulerLocal.lastTickNewFlagCount,
    nextTickAt: schedulerLocal.nextTickAt,
    ticksCompleted: schedulerLocal.ticksCompleted,
  };
}

/**
 * Persist the current replica's heartbeat to the shared state file so
 * peer replicas reading the file see this replica's last tick. Best-
 * effort: a write failure is logged but doesn't block the scheduler
 * (the status surface degrades to in-memory-only for this replica).
 */
function persistLocalHeartbeat(now: Date): void {
  try {
    const state = readState();
    const heartbeats = { ...(state.schedulerHeartbeats ?? {}) };
    const replicaId = currentReplicaId();
    const live = buildLocalStatus(now.toISOString());
    heartbeats[replicaId] = {
      replicaId: live.replicaId,
      hostname: live.hostname,
      heartbeatAt: now.toISOString(),
      schedulerStarted: live.schedulerStarted,
      startedAt: live.startedAt,
      intervalMs: live.intervalMs,
      retryIntervalMs: live.retryIntervalMs,
      webhookConfigured: live.webhookConfigured,
      lastTickAt: live.lastTickAt,
      lastTickOk: live.lastTickOk,
      lastTickRanCheck: live.lastTickRanCheck,
      lastTickDispatched: live.lastTickDispatched,
      lastTickNewFlagCount: live.lastTickNewFlagCount,
      nextTickAt: live.nextTickAt,
      ticksCompleted: live.ticksCompleted,
    };
    writeState({
      _meta: state._meta,
      notified: state.notified,
      rearmHistory: state.rearmHistory ?? [],
      schedulerHeartbeats: heartbeats,
    });
  } catch (err) {
    logger.warn(
      { err },
      "[avri-drift-notifications] Failed to persist scheduler heartbeat (non-fatal).",
    );
  }
}

/**
 * Return one snapshot per replica that has ever published a
 * heartbeat to the shared state file, plus the live in-memory
 * snapshot of the responding replica. The live entry takes precedence
 * over any persisted row for the same `replicaId` (the in-memory
 * struct is by definition fresher than what we last wrote).
 *
 * Sorted by `replicaId` so the calibration UI renders a stable order
 * across refreshes.
 */
export function getDriftSchedulerStatus(): DriftSchedulerStatus[] {
  let persisted: Record<string, PersistedSchedulerHeartbeat> = {};
  try {
    persisted = readState().schedulerHeartbeats ?? {};
  } catch (err) {
    // Read failures already log inside `readState`; degrade to
    // live-only so the UI keeps working.
    logger.warn(
      { err },
      "[avri-drift-notifications] Failed to read persisted heartbeats; returning live-only status.",
    );
    persisted = {};
  }
  const replicaId = currentReplicaId();
  const livePersisted = persisted[replicaId];
  const live = buildLocalStatus(
    livePersisted ? livePersisted.heartbeatAt : null,
  );
  const out: DriftSchedulerStatus[] = [live];
  for (const [id, snap] of Object.entries(persisted)) {
    if (id === replicaId) continue;
    out.push({
      replicaId: snap.replicaId,
      hostname: snap.hostname,
      heartbeatAt: snap.heartbeatAt,
      schedulerStarted: snap.schedulerStarted,
      startedAt: snap.startedAt,
      intervalMs: snap.intervalMs,
      retryIntervalMs: snap.retryIntervalMs,
      webhookConfigured: snap.webhookConfigured,
      lastTickAt: snap.lastTickAt,
      lastTickOk: snap.lastTickOk,
      lastTickRanCheck: snap.lastTickRanCheck,
      lastTickDispatched: snap.lastTickDispatched,
      lastTickNewFlagCount: snap.lastTickNewFlagCount,
      nextTickAt: snap.nextTickAt,
      ticksCompleted: snap.ticksCompleted,
    });
  }
  out.sort((a, b) => a.replicaId.localeCompare(b.replicaId));
  return out;
}

/**
 * Start the recurring drift-notification scheduler. Call exactly once
 * at server boot from `src/index.ts`. Returns a handle whose `stop()`
 * cancels the next tick.
 */
export function startDriftNotificationScheduler(
  opts: DriftSchedulerOptions = {},
): DriftScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const run = opts.run ?? (() => runDriftNotificationCheck());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let completed = 0;

  // Seed the status surface so the heartbeat panel can render
  // "scheduler started, first tick scheduled at <initialDelay>" even
  // before the first tick fires.
  const startedAtMs = Date.now();
  schedulerLocal = {
    ...INITIAL_SCHEDULER_LOCAL_STATE,
    schedulerStarted: true,
    startedAt: new Date(startedAtMs).toISOString(),
    intervalMs,
    retryIntervalMs,
    webhookConfigured: isWebhookConfigured(),
    nextTickAt: new Date(startedAtMs + initialDelayMs).toISOString(),
  };
  // Task #397 — publish the "armed, awaiting first tick" snapshot to
  // the shared store immediately so peer replicas see this replica
  // came up before its first tick fires (otherwise a slow first tick
  // would make the replica look like it never started).
  persistLocalHeartbeat(new Date(startedAtMs));

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    // Don't keep the event loop alive for the timer alone — the HTTP
    // server is the process's reason to exist.
    if (typeof timer.unref === "function") timer.unref();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    let ok = true;
    let ranCheck: boolean | null = null;
    let dispatched: boolean | null = null;
    let newFlagCount: number | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranCheck = typeof result.ranCheck === "boolean" ? result.ranCheck : null;
      if (result.outcome) {
        dispatched = result.outcome.dispatched;
        newFlagCount = result.outcome.notified.length;
      }
    } catch (err) {
      // `run` is supposed to swallow its own errors, but defend against
      // a misbehaving injected runner so a single throw doesn't kill
      // the scheduler.
      logger.warn(
        { err },
        "[avri-drift-notifications] Scheduler tick threw unexpectedly (non-fatal).",
      );
      ok = false;
    } finally {
      completed += 1;
      const completedAtMs = Date.now();
      const nextDelayMs = ok ? intervalMs : retryIntervalMs;
      schedulerLocal = {
        ...schedulerLocal,
        webhookConfigured: isWebhookConfigured(),
        lastTickAt: new Date(completedAtMs).toISOString(),
        lastTickOk: ok,
        lastTickRanCheck: ranCheck,
        lastTickDispatched: dispatched,
        lastTickNewFlagCount: newFlagCount,
        nextTickAt: stopped
          ? null
          : new Date(completedAtMs + nextDelayMs).toISOString(),
        ticksCompleted: completed,
      };
      // Task #397 — flush the freshly-completed tick to the shared
      // state file so peer replicas see this replica's heartbeat
      // advance even when their own GET /scheduler-status is the next
      // request that lands.
      persistLocalHeartbeat(new Date(completedAtMs));
    }
    schedule(ok ? intervalMs : retryIntervalMs);
  }

  schedule(initialDelayMs);

  logger.info(
    { intervalMs, retryIntervalMs, initialDelayMs },
    "[avri-drift-notifications] Drift notification scheduler started.",
  );

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Reflect the stop in the status surface so the heartbeat panel
      // doesn't keep showing a "next tick at <past time>" after a
      // SIGTERM during deploy.
      schedulerLocal = { ...schedulerLocal, nextTickAt: null };
      // Task #397 — flush the "stopped" snapshot so peer replicas
      // observe this replica going down gracefully instead of seeing
      // the last tick's `nextTickAt` linger and look overdue.
      persistLocalHeartbeat(new Date());
    },
    ticksCompleted: () => completed,
  };
}

// ---------------------------------------------------------------------------
// Task #396 — Stalled-scheduler watchdog.
//
// Task #277 surfaced the scheduler heartbeat on the calibration page so a
// reviewer can *see* whether the timer is still firing — but only if they
// happen to look. The watchdog gives reviewers a passive signal even when
// nobody is on the page: it periodically reads the in-memory scheduler
// status, decides whether the next scheduled tick is significantly
// overdue (Date.now() > nextTickAt + 2 * intervalMs), and dispatches a
// one-off "scheduler appears wedged" payload through the same webhook
// that drift flags use.
//
// Dedup matches the drift-flag pattern: each detected stall produces a
// `SchedulerStallRecord` keyed by the missed `expectedNextTickAt`, and
// the records are persisted to the same state file (`schedulerStalls`
// array) so a process restart never re-pages reviewers for a stall
// window that was already announced. A different stall window (i.e. the
// scheduler resumed and later got stuck on a different expected tick)
// produces a distinct key and a fresh alert.
//
// Like the drift dispatcher: a failed webhook does NOT mark the stall
// as alerted, so transient outages auto-recover on the next watchdog
// tick. When AVRI_DRIFT_WEBHOOK_URL is unset we still record the stall
// locally so wiring up a webhook later does not produce a retroactive
// flood of alerts for stalls that long since recovered.
// ---------------------------------------------------------------------------

/**
 * Payload dispatched by the stalled-scheduler watchdog. Intentionally a
 * separate shape (and event name) from `WebhookPayload` so consumers
 * can branch on `event` to render an appropriate alert without parsing
 * the rest of the body.
 */
export interface SchedulerStallPayload {
  event: "avri_drift_scheduler_stalled";
  detectedAt: string;
  expectedNextTickAt: string;
  overdueByMs: number;
  intervalMs: number;
  retryIntervalMs: number | null;
  schedulerStartedAt: string | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  ticksCompleted: number;
  calibrationUrl: string;
  runbookUrl: string;
}

export type SchedulerStallDispatcher = (
  url: string,
  payload: SchedulerStallPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const defaultStallDispatcher: SchedulerStallDispatcher = async (
  url,
  payload,
) => {
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

/**
 * Compute whether a scheduler status snapshot represents a stalled
 * scheduler. A stall is defined as: scheduler started, has a known
 * `nextTickAt` and `intervalMs`, and the wall clock is more than
 * `2 * intervalMs` past the missed tick. The 2x buffer absorbs normal
 * jitter (event-loop pauses, GC, etc.) so a tick that runs a few seconds
 * late doesn't fire a false positive.
 *
 * Exported for the calibration UI / tests to share the exact same
 * threshold the watchdog uses.
 */
export function isSchedulerStalled(
  status: DriftSchedulerStatus,
  nowMs: number,
): boolean {
  if (!status.schedulerStarted) return false;
  if (status.nextTickAt == null) return false;
  if (status.intervalMs == null) return false;
  const nextTickMs = Date.parse(status.nextTickAt);
  if (!Number.isFinite(nextTickMs)) return false;
  return nowMs > nextTickMs + 2 * status.intervalMs;
}

export interface DetectStalledSchedulerOptions {
  webhookUrl?: string;
  publicUrl?: string;
  runbookUrl?: string;
  dispatch?: SchedulerStallDispatcher;
  now?: () => Date;
  /** Override the status read (used by tests to skip the in-memory state). */
  status?: DriftSchedulerStatus;
}

export interface DetectStalledSchedulerResult {
  /** True when the scheduler is overdue per `isSchedulerStalled`. */
  stalled: boolean;
  /**
   * True when the stall was detected but a record for the same missed
   * tick already exists in the persisted state file (so no webhook was
   * dispatched and no record was appended).
   */
  alreadyAlerted: boolean;
  /** True when a webhook URL was configured AND the dispatch succeeded. */
  dispatched: boolean;
  /** Status from the webhook attempt (only populated when dispatched). */
  dispatchResult?: { ok: boolean; status?: number; error?: string };
  /**
   * True when the stall was new but no webhook URL was configured; we
   * still record the stall locally so the reviewer doesn't get a retro
   * flood the moment they wire up the webhook.
   */
  webhookSkipped: boolean;
  /**
   * The stall record that was persisted (or that would have been
   * persisted on dispatch failure). Undefined when nothing was stalled
   * or when the stall was already alerted.
   */
  record?: SchedulerStallRecord;
  /** Calibration deep link included in the dispatched payload. */
  calibrationUrl: string;
  /** Runbook link included in the dispatched payload. */
  runbookUrl: string;
}

/**
 * Read the scheduler status, decide whether it's stalled, dispatch a
 * one-off webhook if a fresh stall is detected, and persist the dedup
 * record. Resolves on every call — never throws — so the watchdog (or
 * any other caller) can swallow errors uniformly.
 *
 * Idempotent within a stall window: calling this repeatedly for the
 * same missed tick produces exactly one webhook (the first call) and
 * returns `alreadyAlerted: true` on subsequent calls.
 */
export async function detectAndNotifyStalledScheduler(
  opts: DetectStalledSchedulerOptions = {},
): Promise<DetectStalledSchedulerResult> {
  // Task #397 — `getDriftSchedulerStatus()` now returns a per-replica
  // array. The watchdog runs in-process so we only ever care about
  // *this* replica's scheduler health: a peer replica's stall is
  // detected by its own watchdog. Pick this replica's entry; tests
  // can still override via `opts.status` to drive specific scenarios.
  const replicaId = currentReplicaId();
  const statuses = opts.status ? [opts.status] : getDriftSchedulerStatus();
  const status =
    statuses.find((s) => s.replicaId === replicaId) ?? statuses[0]!;
  const links = buildLinks(opts.publicUrl, opts.runbookUrl);
  const baseResult: DetectStalledSchedulerResult = {
    stalled: false,
    alreadyAlerted: false,
    dispatched: false,
    webhookSkipped: false,
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
  };
  const now = (opts.now ?? (() => new Date()))();
  if (!isSchedulerStalled(status, now.getTime())) {
    return baseResult;
  }
  // Both fields are guaranteed non-null by isSchedulerStalled, but
  // narrow them explicitly for the type checker.
  const expectedNextTickAt = status.nextTickAt!;
  const intervalMs = status.intervalMs!;
  const overdueByMs = now.getTime() - Date.parse(expectedNextTickAt);

  const dedupKey = `STALL|${expectedNextTickAt}`;
  const state = readState();
  const seenStalls = state.schedulerStalls ?? [];
  if (seenStalls.some((s) => s.key === dedupKey)) {
    return { ...baseResult, stalled: true, alreadyAlerted: true };
  }

  const record: SchedulerStallRecord = {
    key: dedupKey,
    detectedAt: now.toISOString(),
    expectedNextTickAt,
    overdueByMs,
    intervalMs,
  };

  const webhookUrl = (
    opts.webhookUrl ??
    process.env.AVRI_DRIFT_WEBHOOK_URL ??
    ""
  ).trim();
  let dispatched = false;
  let dispatchResult: DetectStalledSchedulerResult["dispatchResult"];
  let webhookSkipped = false;

  if (webhookUrl.length === 0) {
    webhookSkipped = true;
    logger.info(
      { expectedNextTickAt, overdueByMs },
      "[avri-drift-notifications] AVRI_DRIFT_WEBHOOK_URL not set; recording stalled-scheduler alert without dispatch.",
    );
  } else {
    const payload: SchedulerStallPayload = {
      event: "avri_drift_scheduler_stalled",
      detectedAt: record.detectedAt,
      expectedNextTickAt,
      overdueByMs,
      intervalMs,
      retryIntervalMs: status.retryIntervalMs,
      schedulerStartedAt: status.startedAt,
      lastTickAt: status.lastTickAt,
      lastTickOk: status.lastTickOk,
      ticksCompleted: status.ticksCompleted,
      calibrationUrl: links.calibrationUrl,
      runbookUrl: links.runbookUrl,
    };
    const dispatch = opts.dispatch ?? defaultStallDispatcher;
    dispatchResult = await dispatch(webhookUrl, payload);
    dispatched = dispatchResult.ok;
    if (!dispatchResult.ok) {
      logger.warn(
        { dispatchResult, expectedNextTickAt, overdueByMs },
        "[avri-drift-notifications] Stalled-scheduler webhook dispatch failed; will retry on the next watchdog tick.",
      );
      // Do NOT persist — let the next watchdog call try again.
      return {
        ...baseResult,
        stalled: true,
        dispatched: false,
        dispatchResult,
        record,
      };
    }
    logger.warn(
      { expectedNextTickAt, overdueByMs, status: dispatchResult.status },
      "[avri-drift-notifications] Stalled-scheduler webhook dispatched.",
    );
  }

  // Re-read state right before writing so any concurrent writer (the
  // drift dispatcher's `notified` append, a re-arm event, etc.) that
  // landed during the awaited dispatch is preserved instead of being
  // clobbered by the stale snapshot we read at the top of this function.
  const fresh = readState();
  const freshStalls = fresh.schedulerStalls ?? [];
  // Guard against a race where another watchdog tick wrote the same key
  // between our seenStalls check and the write.
  const stallAlreadyPersisted = freshStalls.some((s) => s.key === dedupKey);
  const mergedStalls = stallAlreadyPersisted
    ? freshStalls
    : [...freshStalls, record];
  writeState({
    _meta: fresh._meta,
    notified: fresh.notified,
    rearmHistory: fresh.rearmHistory ?? [],
    schedulerStalls: mergedStalls,
  });

  return {
    stalled: true,
    alreadyAlerted: false,
    dispatched,
    dispatchResult,
    webhookSkipped,
    record,
    calibrationUrl: links.calibrationUrl,
    runbookUrl: links.runbookUrl,
  };
}

/**
 * Snapshot of the persisted stalled-scheduler audit log. Returns a
 * fresh array on every call so callers can safely mutate the result.
 */
export function listSchedulerStalls(): SchedulerStallRecord[] {
  return (readState().schedulerStalls ?? []).map((s) => ({ ...s }));
}

const DEFAULT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

function autoWatchdogIntervalMs(): number {
  return parseIntervalEnv(
    process.env.AVRI_DRIFT_STALL_WATCHDOG_INTERVAL_MS,
    DEFAULT_WATCHDOG_INTERVAL_MS,
  );
}

export interface SchedulerWatchdogOptions extends DetectStalledSchedulerOptions {
  /**
   * Cadence of the watchdog poll. Defaults to env
   * AVRI_DRIFT_STALL_WATCHDOG_INTERVAL_MS, falling back to 5 minutes
   * — short enough to detect a stall promptly even with a tight
   * `intervalMs` override, and long enough to add negligible cost.
   */
  watchdogIntervalMs?: number;
  /**
   * Delay before the first watchdog poll. Defaults to the watchdog
   * interval so we don't immediately page on a freshly-booted process
   * that hasn't had a chance to run its first tick yet.
   */
  initialDelayMs?: number;
}

export interface SchedulerWatchdog {
  stop(): void;
  /** Poll count, useful for tests that want to await the next tick. */
  ticksCompleted(): number;
}

/**
 * Start a recurring watchdog that periodically checks the scheduler
 * heartbeat and dispatches a one-off "scheduler appears wedged"
 * webhook the first time a stall is detected. Independent of the main
 * scheduler timer so a wedged scheduler can't suppress its own alarm.
 *
 * Returns a handle whose `stop()` cancels future polls.
 */
export function startStalledSchedulerWatchdog(
  opts: SchedulerWatchdogOptions = {},
): SchedulerWatchdog {
  const intervalMs = opts.watchdogIntervalMs ?? autoWatchdogIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? intervalMs;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let completed = 0;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await detectAndNotifyStalledScheduler({
        webhookUrl: opts.webhookUrl,
        publicUrl: opts.publicUrl,
        runbookUrl: opts.runbookUrl,
        dispatch: opts.dispatch,
        now: opts.now,
        status: opts.status,
      });
    } catch (err) {
      // detectAndNotifyStalledScheduler is supposed to swallow its own
      // errors, but defend against a misbehaving injected dispatcher
      // so a single throw doesn't kill the watchdog.
      logger.warn(
        { err },
        "[avri-drift-notifications] Stalled-scheduler watchdog tick threw unexpectedly (non-fatal).",
      );
    } finally {
      completed += 1;
    }
    schedule(intervalMs);
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  schedule(initialDelayMs);

  logger.info(
    { intervalMs, initialDelayMs },
    "[avri-drift-notifications] Stalled-scheduler watchdog started.",
  );

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    ticksCompleted: () => completed,
  };
}

// ---------------------------------------------------------------------------
// Task #196 — Reviewer-driven re-arm of previously-notified flags.
//
// `notifyDriftFlagsIfNew` records every dispatched flag in the dedup state
// so the same flag for the same week never re-pages reviewers. That is the
// right default, but it leaves no recovery path for the
// "acknowledged-but-not-fixed by the fix-by date" workflow: the flag sits
// silently in the dedup file and reviewers have to hand-edit the JSON to
// re-page themselves once the fix-by lapses.
//
// `listNotifiedFlags()` and `removeNotifiedFlags()` give the calibration UI
// (and any future cron) a programmatic way to inspect and prune the dedup
// state. Removing an entry by key is exactly equivalent to "I never saw
// this flag" — the next dispatch run will treat it as new and re-fire the
// webhook, then re-record the entry with a fresh `notifiedAt`.
// ---------------------------------------------------------------------------

/**
 * Snapshot of the persisted dedup state — the flags that have already
 * been dispatched and would NOT re-page reviewers on the next run unless
 * they're re-armed via `removeNotifiedFlags`.
 *
 * Returns a fresh array on every call (no shared references with the
 * on-disk file) so callers can safely mutate the result.
 */
export function listNotifiedFlags(): NotifiedFlagRecord[] {
  return readState().notified.map((n) => ({ ...n }));
}

export interface RemoveNotifiedFlagsResult {
  /** Records that were found and removed (one per matched key). */
  removed: NotifiedFlagRecord[];
  /** Keys that were requested but did not match any persisted entry. */
  notFound: string[];
  /** Total entries remaining in the dedup state after the removal. */
  remaining: number;
  /**
   * Audit entries appended to the persisted re-arm history for this
   * call (one per matched key). Empty when nothing matched.
   */
  auditEntries: RearmAuditEntry[];
  /**
   * Snapshot of the persisted re-arm history AFTER this call so callers
   * can render the updated audit log without an extra read.
   */
  rearmHistory: RearmAuditEntry[];
}

/**
 * Optional reviewer context for `removeNotifiedFlags`. `reviewer` is a
 * free-form display name (auth is enforced separately) and `rationale`
 * is a short note. `now` is overridable for deterministic tests.
 */
export interface RemoveNotifiedFlagsOptions {
  reviewer?: string;
  rationale?: string;
  now?: () => Date;
}

/**
 * Remove one or more entries from the persisted dedup state by key. The
 * next dispatch run will treat any matching flag as never-notified and
 * re-fire the webhook for it.
 *
 * Duplicate keys in the input are de-duped before lookup, so passing the
 * same key twice still only counts as one removal.
 *
 * Each successful removal also appends an entry to the persisted
 * `rearmHistory` audit log (capped at REARM_HISTORY_LIMIT) preserving
 * the original notification metadata plus the supplied reviewer /
 * rationale context.
 */
export function removeNotifiedFlags(
  keys: string[],
  options: RemoveNotifiedFlagsOptions = {},
): RemoveNotifiedFlagsResult {
  const requested = new Set<string>();
  for (const k of keys) {
    if (typeof k === "string" && k.trim().length > 0) {
      requested.add(k);
    }
  }
  const state = readState();
  const removed: NotifiedFlagRecord[] = [];
  const kept: NotifiedFlagRecord[] = [];
  for (const entry of state.notified) {
    if (requested.has(entry.key)) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  const matchedKeys = new Set(removed.map((r) => r.key));
  const notFound: string[] = [];
  for (const k of requested) {
    if (!matchedKeys.has(k)) notFound.push(k);
  }
  // Build audit entries up-front so the same wall-clock timestamp is
  // shared across a batch (a single reviewer click that re-arms 5 keys
  // produces 5 entries with the same `rearmedAt`, which is what the
  // calibration UI groups on).
  const reviewer =
    typeof options.reviewer === "string" ? options.reviewer.trim() : "";
  const rationale =
    typeof options.rationale === "string" ? options.rationale.trim() : "";
  const now = (options.now ?? (() => new Date()))();
  const rearmedAt = now.toISOString();
  const auditEntries: RearmAuditEntry[] = removed.map((r) => {
    const entry: RearmAuditEntry = {
      key: r.key,
      weekStart: r.weekStart,
      kind: r.kind,
      originalNotifiedAt: r.notifiedAt,
      originalDetail: r.detail,
      rearmedAt,
    };
    if (reviewer.length > 0) entry.rearmedBy = reviewer;
    if (rationale.length > 0) entry.rationale = rationale;
    return entry;
  });
  const nextHistory: RearmAuditEntry[] =
    removed.length > 0
      ? [...(state.rearmHistory ?? []), ...auditEntries]
      : (state.rearmHistory ?? []);
  if (removed.length > 0) {
    writeState({
      _meta: state._meta,
      notified: kept,
      rearmHistory: nextHistory,
      schedulerStalls: state.schedulerStalls ?? [],
      // Preserve persisted per-replica heartbeats — re-arming dedup
      // state must not clobber scheduler heartbeats from other replicas.
      schedulerHeartbeats: state.schedulerHeartbeats ?? {},
    });
  }
  // Echo back the newest-trimmed snapshot so callers see the same view
  // a subsequent `listRearmHistory()` would return (i.e. with the
  // REARM_HISTORY_LIMIT trim applied).
  const persistedHistory = nextHistory.slice(-REARM_HISTORY_LIMIT);
  return {
    removed,
    notFound,
    remaining: kept.length,
    auditEntries,
    rearmHistory: persistedHistory,
  };
}

/**
 * Snapshot of the persisted re-arm audit log. Returns a fresh array on
 * every call so callers can safely mutate the result.
 */
export function listRearmHistory(): RearmAuditEntry[] {
  return (readState().rearmHistory ?? []).map((e) => ({ ...e }));
}

// Exported for unit tests so they can pin internal state without
// reaching into module internals directly.
export const __testing = {
  resetResolvedPath: () => {
    RESOLVED_PATH = null;
  },
  // Reset the in-memory scheduler status between tests so a prior
  // test's "scheduler started" record doesn't leak into a test that
  // exercises the "never started" code path.
  resetSchedulerStatus: () => {
    schedulerLocal = { ...INITIAL_SCHEDULER_LOCAL_STATE };
  },
  // Task #397 — clear the cached per-process replica id + hostname
  // so tests can pin AVRI_REPLICA_ID per case without leaking the
  // first-run cached value into subsequent tests.
  resetReplicaIdentity: () => {
    CACHED_REPLICA_ID = null;
    CACHED_HOSTNAME = null;
  },
  currentReplicaId,
  currentHostname,
  buildLinks,
  readState,
  writeState,
  HISTORY_LIMIT,
  REARM_HISTORY_LIMIT,
  STALL_HISTORY_LIMIT,
  SCHEDULER_HEARTBEAT_LIMIT,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
};
