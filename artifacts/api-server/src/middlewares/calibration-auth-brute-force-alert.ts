import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";
import { buildPublicUrl } from "../lib/public-url";
import { __CALIBRATION_AUTH_RATE_LIMIT_DEFAULTS } from "./calibration-auth-rate-limit";

// Per-IP brute-force counter for calibration-auth wrong-token rejections.
//
// The primary alerting surface for production is the log-based query
// documented in docs/calibration-reviewer-token.md ("Brute-force
// alerts"); those queries run in the log aggregator and aggregate
// counts across all api-server replicas. This in-process counter is
// the zero-extra-infrastructure fallback that works on any deployment
// (including single-replica setups with no log shipper) — it counts
// wrong-token events PER PROCESS, so a probe spread across N replicas
// will only trip the counter if any single replica sees >= threshold
// events on its own. Use the log-aggregator query when you need cross-
// replica detection.

export type WrongTokenStatus = 401 | 429;
export type WrongTokenGate = "mutation" | "strict-read";

export interface WrongTokenEventInput {
  status: WrongTokenStatus;
  gate: WrongTokenGate;
  route: string;
  method: string;
  ip: string | null;
}

interface PerIpHistoryEntry {
  at: number;
  status: WrongTokenStatus;
  gate: WrongTokenGate;
  route: string;
  method: string;
}

interface PerIpState {
  events: PerIpHistoryEntry[];
  lastAlertedAt: number | null;
}

export interface BruteForceAlertPayload {
  event: "calibration_auth_brute_force";
  detectedAt: string;
  ip: string;
  windowMs: number;
  threshold: number;
  wrongTokenCount: number;
  rejectionsByStatus: { "401": number; "429": number };
  rejectionsByGate: { mutation: number; "strict-read": number };
  firstSeenAt: string;
  lastSeenAt: string;
  lastRoute: string;
  lastMethod: string;
  runbookUrl: string;
  recommendedActions: string[];
}

export type BruteForceDispatcher = (
  url: string,
  payload: BruteForceAlertPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

export interface BruteForceAlerterOptions {
  windowMs?: number;
  threshold?: number;
  /**
   * Webhook URL. When `undefined` (the default), the URL is re-read
   * from CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL on every alert
   * decision so flipping the env mid-process actually starts
   * dispatching without a restart. Pass an explicit string (including
   * "") to pin the value.
   */
  webhookUrl?: string | null;
  runbookUrl?: string | null;
  dispatch?: BruteForceDispatcher;
  now?: () => number;
  maxTrackedIps?: number;
  /**
   * Path to the JSON file used to persist per-IP cooldown state across
   * process restarts. When `undefined` (the default) the path is read
   * from `CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH`, falling back to
   * `artifacts/api-server/data/calibration-auth-brute-force-state.json`.
   * Pass `null` to disable persistence (memory-only — useful for unit
   * tests that don't want to touch the shipped file).
   */
  statePath?: string | null;
  /**
   * Max number of per-IP cooldown records to persist on disk. Bounded
   * so the state file stays small and trivially diffable; oldest
   * entries (by `lastAlertedAt`) are dropped first.
   */
  persistHistoryLimit?: number;
}

/**
 * Reviewer acknowledgement attached to a dispatched alert. Recorded
 * in-memory alongside the alert it acks (so an evicted alert takes
 * its ack with it — there is no orphan-ack state to reconcile). The
 * shape mirrors the persisted re-arm audit entries (reviewer + free-
 * form note + wall-clock) so the calibration UI can render both
 * surfaces with the same `formatAuditTimestamp` helper.
 */
export interface BruteForceAlertAck {
  /** ISO timestamp when the reviewer clicked "ack". */
  ackedAt: string;
  /** Optional reviewer display name supplied by the calibration UI. */
  ackedBy?: string;
  /** Optional free-form note supplied by the reviewer (e.g. "false alarm — office NAT"). */
  note?: string;
}

/**
 * Single entry in the in-process ring buffer of dispatched alerts.
 * Mirrors the webhook payload (minus the constant `event` discriminator
 * and the static `recommendedActions` runbook copy) so the calibration
 * UI can render the same IP / count / window / runbook context that
 * goes into the webhook without round-tripping through pino logs.
 *
 * `ack` is populated once a reviewer acknowledges the alert via
 * `POST /feedback/calibration/auth-brute-force-alerts/ack`; absent
 * until then.
 */
export interface RecentBruteForceAlert {
  detectedAt: string;
  ip: string;
  windowMs: number;
  threshold: number;
  wrongTokenCount: number;
  rejectionsByStatus: { "401": number; "429": number };
  rejectionsByGate: { mutation: number; "strict-read": number };
  firstSeenAt: string;
  lastSeenAt: string;
  lastRoute: string;
  lastMethod: string;
  runbookUrl: string;
  ack?: BruteForceAlertAck;
}

/** Identifying tuple a caller passes to `ackAlert` to pick the row. */
export interface BruteForceAlertAckInput {
  ip: string;
  detectedAt: string;
  reviewer?: string;
  note?: string;
  /** Override clock for deterministic tests. */
  now?: () => number;
}

export type BruteForceAlertAckResult =
  | { ok: true; alert: RecentBruteForceAlert }
  | {
      ok: false;
      reason: "not-found" | "already-acked";
      alert?: RecentBruteForceAlert;
    };

export interface BruteForceAlerter {
  recordWrongTokenEvent(ev: WrongTokenEventInput): void;
  /**
   * Bounded snapshot of the most recent alerts dispatched by this
   * process, newest-first. The buffer is in-memory only — restarts
   * clear it and a multi-replica deploy reflects whichever replica
   * handled the request. Pass `limit` to cap the response; values
   * <= 0 fall back to the default.
   */
  recentAlerts(limit?: number): RecentBruteForceAlert[];
  /**
   * Mark the alert identified by (ip, detectedAt) as acknowledged. The
   * ack rides on the same in-memory ring-buffer entry, so an alert
   * evicted by FIFO churn takes its ack with it. Returns the updated
   * alert on success, or a structured failure for the route layer to
   * map onto a 404 / 409.
   */
  ackAlert(input: BruteForceAlertAckInput): BruteForceAlertAckResult;
  /** Test-only: resolves once any in-flight dispatch promise has settled. */
  flushPending(): Promise<void>;
}

const DEFAULT_MAX_TRACKED_IPS = 1024;
// Cap the persisted cooldown table so the file stays small and
// trivially diffable. Oldest (by lastAlertedAt) drops first.
const DEFAULT_PERSIST_HISTORY_LIMIT = 256;
// Cap the in-process ring buffer well above the panel's render limit so
// reviewers can scroll back through recent flaps without the buffer
// filling up after a noisy hour. Each entry is ~300 bytes serialized,
// so 50 entries fits comfortably under 20 KB.
const RECENT_ALERTS_BUFFER_SIZE = 50;
const RECENT_ALERTS_DEFAULT_LIMIT = 10;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_FILE_NAME = "calibration-auth-brute-force-state.json";

// Resolve the state file relative to the package, then fall back to
// cwd-based candidates so the file is found regardless of where the
// process was launched from. The first candidate is also used for
// writes when no existing file is found.
const STATE_FILE_CANDIDATE_PATHS = [
  path.resolve(__dirname, "../../data", STATE_FILE_NAME),
  path.resolve(process.cwd(), "artifacts/api-server/data", STATE_FILE_NAME),
  path.resolve(process.cwd(), "data", STATE_FILE_NAME),
];

/**
 * Single record persisted to disk for one IP. Only `lastAlertedAt` is
 * load-bearing for cooldown — the in-window event list is intentionally
 * NOT persisted because it repopulates from incoming requests after
 * restart, and the cooldown check (lastAlertedAt + windowMs) is what
 * suppresses re-pages in the meantime.
 */
interface PersistedIpRecord {
  ip: string;
  lastAlertedAt: number;
}

interface PersistedState {
  _meta?: unknown;
  perIp: PersistedIpRecord[];
  /**
   * Bounded ring of dispatched alerts (oldest-first, matching the
   * in-memory buffer layout) so the calibration UI's "Recent
   * calibration auth alerts" panel survives an api-server restart.
   * Capped at `RECENT_ALERTS_BUFFER_SIZE` entries — oldest drop first.
   */
  recentAlerts?: RecentBruteForceAlert[];
}

const PERSIST_META =
  "Persisted state for the calibration-auth brute-force alerter. `perIp` records the last time an alert was dispatched for each IP so a process restart inside the cooldown window does not re-page the on-call (capped at 256 entries, oldest dropped first). `recentAlerts` mirrors the in-process ring buffer that backs the calibration UI's 'Recent calibration auth alerts' panel so reviewers keep recent forensic context across restarts (capped at 50 entries, oldest dropped first). Override the location via CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH; safe to delete or truncate to clear all state.";

function isPersistedIpRecord(value: unknown): value is PersistedIpRecord {
  if (value === null || typeof value !== "object") return false;
  const v = value as { ip?: unknown; lastAlertedAt?: unknown };
  return (
    typeof v.ip === "string" &&
    v.ip.length > 0 &&
    typeof v.lastAlertedAt === "number" &&
    Number.isFinite(v.lastAlertedAt)
  );
}

interface ReadPersistedResult {
  perIp: PersistedIpRecord[];
  recentAlerts: RecentBruteForceAlert[];
}

function isRecentBruteForceAlert(value: unknown): value is RecentBruteForceAlert {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.detectedAt !== "string" ||
    typeof v.ip !== "string" ||
    v.ip.length === 0 ||
    typeof v.windowMs !== "number" ||
    !Number.isFinite(v.windowMs) ||
    typeof v.threshold !== "number" ||
    !Number.isFinite(v.threshold) ||
    typeof v.wrongTokenCount !== "number" ||
    !Number.isFinite(v.wrongTokenCount) ||
    typeof v.firstSeenAt !== "string" ||
    typeof v.lastSeenAt !== "string" ||
    typeof v.lastRoute !== "string" ||
    typeof v.lastMethod !== "string" ||
    typeof v.runbookUrl !== "string"
  ) {
    return false;
  }
  const byStatus = v.rejectionsByStatus as
    | { "401"?: unknown; "429"?: unknown }
    | null
    | undefined;
  if (
    byStatus === null ||
    typeof byStatus !== "object" ||
    typeof byStatus["401"] !== "number" ||
    typeof byStatus["429"] !== "number"
  ) {
    return false;
  }
  const byGate = v.rejectionsByGate as
    | { mutation?: unknown; "strict-read"?: unknown }
    | null
    | undefined;
  if (
    byGate === null ||
    typeof byGate !== "object" ||
    typeof byGate.mutation !== "number" ||
    typeof byGate["strict-read"] !== "number"
  ) {
    return false;
  }
  return true;
}

function readPersistedState(filePath: string): ReadPersistedResult {
  if (!existsSync(filePath)) return { perIp: [], recentAlerts: [] };
  try {
    const raw = readFileSync(filePath, "utf8");
    if (raw.trim().length === 0) return { perIp: [], recentAlerts: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const ipList = Array.isArray(parsed.perIp) ? parsed.perIp : [];
    const cleanedIps: PersistedIpRecord[] = [];
    for (const entry of ipList) {
      if (isPersistedIpRecord(entry)) {
        cleanedIps.push({ ip: entry.ip, lastAlertedAt: entry.lastAlertedAt });
      }
    }
    const alertList = Array.isArray(parsed.recentAlerts)
      ? parsed.recentAlerts
      : [];
    const cleanedAlerts: RecentBruteForceAlert[] = [];
    for (const entry of alertList) {
      if (isRecentBruteForceAlert(entry)) {
        cleanedAlerts.push({
          detectedAt: entry.detectedAt,
          ip: entry.ip,
          windowMs: entry.windowMs,
          threshold: entry.threshold,
          wrongTokenCount: entry.wrongTokenCount,
          rejectionsByStatus: { ...entry.rejectionsByStatus },
          rejectionsByGate: { ...entry.rejectionsByGate },
          firstSeenAt: entry.firstSeenAt,
          lastSeenAt: entry.lastSeenAt,
          lastRoute: entry.lastRoute,
          lastMethod: entry.lastMethod,
          runbookUrl: entry.runbookUrl,
        });
      }
    }
    return { perIp: cleanedIps, recentAlerts: cleanedAlerts };
  } catch (err) {
    logger.warn(
      { err, path: filePath },
      "calibration auth: failed to read persisted brute-force state; starting from empty",
    );
    return { perIp: [], recentAlerts: [] };
  }
}

function writePersistedState(
  filePath: string,
  records: PersistedIpRecord[],
  limit: number,
  recentAlerts: RecentBruteForceAlert[],
): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Keep the most recently alerted entries when over the cap. Sort
  // descending by lastAlertedAt so the slice keeps the freshest N.
  const trimmed = [...records]
    .sort((a, b) => b.lastAlertedAt - a.lastAlertedAt)
    .slice(0, limit);
  // Bound the persisted alert ring to the in-memory buffer size; if the
  // caller passes a longer list (it shouldn't, but be defensive), keep
  // the freshest entries by dropping from the head (oldest end).
  const trimmedAlerts =
    recentAlerts.length > RECENT_ALERTS_BUFFER_SIZE
      ? recentAlerts.slice(recentAlerts.length - RECENT_ALERTS_BUFFER_SIZE)
      : recentAlerts;
  const payload: PersistedState = {
    _meta: PERSIST_META,
    perIp: trimmed,
    recentAlerts: trimmedAlerts,
  };
  const serialized = JSON.stringify(payload, null, 2) + "\n";

  // Atomic write: serialize to a unique sibling temp file, fsync the
  // bytes to disk, then rename over the destination. POSIX rename(2)
  // is atomic on the same filesystem, so a crash (deploy / OOM /
  // power loss) at any point during the write leaves either the old
  // file or the fully-written new file in place — never a half-
  // written JSON blob that the next start would log-and-discard,
  // silently dropping all cooldowns. The random suffix prevents two
  // concurrent writers (e.g. overlapping alerts) from clobbering each
  // other's temp file before rename.
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o644);
    writeSync(fd, serialized, 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function resolveStatePath(opt: string | null | undefined): string | null {
  if (opt === null) return null;
  if (typeof opt === "string" && opt.trim().length > 0) {
    return path.resolve(opt);
  }
  const envOverride = process.env.CALIBRATION_AUTH_BRUTE_FORCE_STATE_PATH;
  if (typeof envOverride === "string" && envOverride.trim().length > 0) {
    return path.resolve(envOverride);
  }
  for (const p of STATE_FILE_CANDIDATE_PATHS) {
    if (existsSync(p)) return p;
  }
  // Fall back to the first candidate so writes can create it on demand.
  return STATE_FILE_CANDIDATE_PATHS[0]!;
}

const RECOMMENDED_ACTIONS: ReadonlyArray<string> = [
  "Confirm the source IP is not a legitimate reviewer (NAT / office Wi-Fi).",
  "Block the offending IP at the upstream proxy / WAF.",
  "Rotate CALIBRATION_TOKEN per docs/calibration-reviewer-token.md (Rotation).",
  "If the alert is too noisy, tune CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD / CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS.",
];

const RUNBOOK_URL_PATH = "docs/calibration-reviewer-token.md#rotation";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Window/threshold defaults intentionally inherit the limiter's own
// envs so a single CALIBRATION_AUTH_RATE_LIMIT_* change keeps
// throttling and alerting in sync. CALIBRATION_AUTH_BRUTE_FORCE_*
// overrides exist for operators who want them to diverge.
function readWindowMsEnv(): number {
  return readPositiveIntEnv(
    "CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS",
    readPositiveIntEnv(
      "CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS",
      __CALIBRATION_AUTH_RATE_LIMIT_DEFAULTS.windowMs,
    ),
  );
}

function readThresholdEnv(): number {
  return readPositiveIntEnv(
    "CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD",
    readPositiveIntEnv(
      "CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES",
      __CALIBRATION_AUTH_RATE_LIMIT_DEFAULTS.max,
    ),
  );
}

function readWebhookUrlEnv(): string {
  return (process.env.CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL ?? "").trim();
}

function readRunbookUrlOverrideEnv(): string {
  return (process.env.CALIBRATION_AUTH_BRUTE_FORCE_RUNBOOK_URL ?? "").trim();
}

const defaultDispatcher: BruteForceDispatcher = async (url, payload) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "vulnrap-calibration-brute-force-alerter/1.0",
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

function resolveRunbookUrl(override: string | null | undefined): string {
  const explicit = (override ?? "").trim();
  if (explicit.length > 0) return explicit;
  const envOverride = readRunbookUrlOverrideEnv();
  if (envOverride.length > 0) return envOverride;
  return `${buildPublicUrl()}/${RUNBOOK_URL_PATH}`;
}

function buildPayload(
  ip: string,
  state: PerIpState,
  cfg: { windowMs: number; threshold: number; runbookUrl: string },
  now: number,
): BruteForceAlertPayload {
  const events = state.events;
  const last = events[events.length - 1]!;
  const first = events[0]!;
  let count401 = 0;
  let count429 = 0;
  let countMutation = 0;
  let countStrictRead = 0;
  for (const ev of events) {
    if (ev.status === 401) count401 += 1;
    else if (ev.status === 429) count429 += 1;
    if (ev.gate === "mutation") countMutation += 1;
    else if (ev.gate === "strict-read") countStrictRead += 1;
  }
  return {
    event: "calibration_auth_brute_force",
    detectedAt: new Date(now).toISOString(),
    ip,
    windowMs: cfg.windowMs,
    threshold: cfg.threshold,
    wrongTokenCount: events.length,
    rejectionsByStatus: { "401": count401, "429": count429 },
    rejectionsByGate: {
      mutation: countMutation,
      "strict-read": countStrictRead,
    },
    firstSeenAt: new Date(first.at).toISOString(),
    lastSeenAt: new Date(last.at).toISOString(),
    lastRoute: last.route,
    lastMethod: last.method,
    runbookUrl: cfg.runbookUrl,
    recommendedActions: [...RECOMMENDED_ACTIONS],
  };
}

export function createBruteForceAlerter(
  opts: BruteForceAlerterOptions = {},
): BruteForceAlerter {
  const windowMs = opts.windowMs ?? readWindowMsEnv();
  const threshold = opts.threshold ?? readThresholdEnv();
  const dispatch = opts.dispatch ?? defaultDispatcher;
  const now = opts.now ?? (() => Date.now());
  const maxTrackedIps = opts.maxTrackedIps ?? DEFAULT_MAX_TRACKED_IPS;
  const runbookUrl = resolveRunbookUrl(opts.runbookUrl);

  // When a caller pins `webhookUrl` (including ""), use that. Otherwise
  // re-read the env on every alert so an operator can flip
  // CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL without restarting the
  // process and have the next alert dispatch.
  const webhookOverridden = opts.webhookUrl !== undefined;
  const pinnedWebhook = opts.webhookUrl ?? "";

  const statePath = resolveStatePath(opts.statePath);
  const persistHistoryLimit =
    opts.persistHistoryLimit ?? DEFAULT_PERSIST_HISTORY_LIMIT;

  const perIp = new Map<string, PerIpState>();
  const inFlight = new Set<Promise<unknown>>();
  // Ring buffer of dispatched alerts. Newer entries get pushed to the
  // tail; once the buffer hits RECENT_ALERTS_BUFFER_SIZE the oldest
  // entry at the head is dropped on the next push. The accessor flips
  // the order so callers see newest-first without re-sorting.
  const recentAlertsBuffer: RecentBruteForceAlert[] = [];

  function pushRecentAlert(payload: BruteForceAlertPayload): void {
    const entry: RecentBruteForceAlert = {
      detectedAt: payload.detectedAt,
      ip: payload.ip,
      windowMs: payload.windowMs,
      threshold: payload.threshold,
      wrongTokenCount: payload.wrongTokenCount,
      rejectionsByStatus: { ...payload.rejectionsByStatus },
      rejectionsByGate: { ...payload.rejectionsByGate },
      firstSeenAt: payload.firstSeenAt,
      lastSeenAt: payload.lastSeenAt,
      lastRoute: payload.lastRoute,
      lastMethod: payload.lastMethod,
      runbookUrl: payload.runbookUrl,
    };
    recentAlertsBuffer.push(entry);
    if (recentAlertsBuffer.length > RECENT_ALERTS_BUFFER_SIZE) {
      recentAlertsBuffer.splice(
        0,
        recentAlertsBuffer.length - RECENT_ALERTS_BUFFER_SIZE,
      );
    }
  }

  // Defensive deep-clone for outbound entries so callers can't mutate
  // the buffer (or, after `ackAlert`, the persisted ack) by editing the
  // returned object in place.
  function cloneAlert(entry: RecentBruteForceAlert): RecentBruteForceAlert {
    const out: RecentBruteForceAlert = {
      detectedAt: entry.detectedAt,
      ip: entry.ip,
      windowMs: entry.windowMs,
      threshold: entry.threshold,
      wrongTokenCount: entry.wrongTokenCount,
      rejectionsByStatus: { ...entry.rejectionsByStatus },
      rejectionsByGate: { ...entry.rejectionsByGate },
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      lastRoute: entry.lastRoute,
      lastMethod: entry.lastMethod,
      runbookUrl: entry.runbookUrl,
    };
    if (entry.ack) {
      const ack: BruteForceAlertAck = { ackedAt: entry.ack.ackedAt };
      if (entry.ack.ackedBy !== undefined) ack.ackedBy = entry.ack.ackedBy;
      if (entry.ack.note !== undefined) ack.note = entry.ack.note;
      out.ack = ack;
    }
    return out;
  }

  // Seed the in-memory cooldown table from the persisted state file so
  // an attack that crossed the threshold before a deploy doesn't re-fire
  // the alert for the same IP inside its cooldown window after restart.
  // Only `lastAlertedAt` is loaded; the in-window event list rebuilds
  // itself from incoming traffic — the cooldown check (driven by
  // lastAlertedAt) is what suppresses the re-page in the meantime.
  if (statePath !== null) {
    const persisted = readPersistedState(statePath);
    // Sort ascending by lastAlertedAt so Map insertion order matches
    // recency: the most-recently alerted IP is the most-recently
    // touched, which keeps the LRU eviction in `evictOldestIfFull`
    // consistent with what we wrote out.
    persisted.perIp.sort((a, b) => a.lastAlertedAt - b.lastAlertedAt);
    for (const rec of persisted.perIp) {
      if (perIp.size >= maxTrackedIps) {
        const oldestKey = perIp.keys().next().value;
        if (oldestKey !== undefined) perIp.delete(oldestKey);
      }
      perIp.set(rec.ip, { events: [], lastAlertedAt: rec.lastAlertedAt });
    }
    // Hydrate the recent-alerts ring buffer so the calibration UI's
    // panel survives an api-server restart. The persisted list is
    // already oldest-first (matches the in-memory layout); cap it at
    // the buffer size in case an older file overflows the current cap.
    const hydratedAlerts =
      persisted.recentAlerts.length > RECENT_ALERTS_BUFFER_SIZE
        ? persisted.recentAlerts.slice(
            persisted.recentAlerts.length - RECENT_ALERTS_BUFFER_SIZE,
          )
        : persisted.recentAlerts;
    for (const entry of hydratedAlerts) {
      recentAlertsBuffer.push(entry);
    }
  }

  function persistState(): void {
    if (statePath === null) return;
    const records: PersistedIpRecord[] = [];
    for (const [ip, state] of perIp) {
      if (state.lastAlertedAt !== null) {
        records.push({ ip, lastAlertedAt: state.lastAlertedAt });
      }
    }
    try {
      writePersistedState(
        statePath,
        records,
        persistHistoryLimit,
        recentAlertsBuffer,
      );
    } catch (err) {
      // A failure to persist must not crash the request that triggered
      // the alert — we still alerted in-memory and via the dispatcher,
      // so degraded operation here just means the cooldown / recent-
      // alerts panel won't survive a restart this one time.
      logger.warn(
        { err, path: statePath },
        "calibration auth: failed to persist brute-force state (cooldown and recent-alerts buffer will not survive a restart for this alert)",
      );
    }
  }

  function pruneIp(state: PerIpState, cutoff: number): void {
    let dropUntil = 0;
    while (
      dropUntil < state.events.length &&
      state.events[dropUntil]!.at < cutoff
    ) {
      dropUntil += 1;
    }
    if (dropUntil > 0) {
      state.events.splice(0, dropUntil);
    }
  }

  function evictOldestIfFull(): void {
    if (perIp.size < maxTrackedIps) return;
    // Map iteration order is insertion order; we re-touch on every
    // record, so the first key is the least-recently-touched IP.
    const oldestKey = perIp.keys().next().value;
    if (oldestKey !== undefined) {
      perIp.delete(oldestKey);
    }
  }

  function touch(ip: string, state: PerIpState): void {
    perIp.delete(ip);
    perIp.set(ip, state);
  }

  function fireAlert(ip: string, state: PerIpState, t: number): void {
    const cfg = { windowMs, threshold, runbookUrl };
    const payload = buildPayload(ip, state, cfg, t);
    state.lastAlertedAt = t;
    // Always retain the alert in the in-process ring buffer, regardless
    // of whether a webhook is configured or whether dispatch later
    // succeeds. The point of the buffer is to give reviewers a "what
    // just tripped?" view from the calibration UI even on installs that
    // never set CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL. Push BEFORE
    // we persist so this alert lands in the on-disk recent-alerts ring
    // alongside the bumped cooldown timestamp.
    pushRecentAlert(payload);
    // Persist the bumped cooldown timestamp AND the freshly-pushed
    // recent-alerts entry BEFORE we await the webhook dispatch so a
    // crash mid-dispatch still leaves the cooldown intact (no
    // immediate re-page on a fast restart) and the calibration UI's
    // "Recent calibration auth alerts" panel survives the restart with
    // forensic context for the just-fired alert.
    persistState();

    const webhookUrl = webhookOverridden ? pinnedWebhook : readWebhookUrlEnv();

    // Always log the alert decision at warn level so log-based alerting
    // works even when no webhook URL is configured.
    logger.warn(
      {
        ip,
        windowMs,
        threshold,
        wrongTokenCount: payload.wrongTokenCount,
        rejectionsByStatus: payload.rejectionsByStatus,
        webhookConfigured: webhookUrl.length > 0,
        runbookUrl,
      },
      "calibration auth: brute-force probe threshold crossed",
    );

    if (webhookUrl.length === 0) return;

    const promise = (async () => {
      const result = await dispatch(webhookUrl, payload);
      if (!result.ok) {
        logger.warn(
          { ip, dispatchResult: result },
          "calibration auth: brute-force webhook dispatch FAILED (alert dedup remains in effect for this window)",
        );
      } else {
        logger.info(
          { ip, status: result.status },
          "calibration auth: brute-force webhook dispatched",
        );
      }
    })()
      .catch((err) => {
        // A bug in the injected dispatcher must not crash the request
        // that triggered the alert.
        logger.warn(
          { ip, err },
          "calibration auth: brute-force webhook dispatcher threw unexpectedly (non-fatal)",
        );
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  }

  function recordWrongTokenEvent(ev: WrongTokenEventInput): void {
    // Skip events with no IP — we can't actionably page anyone for an
    // unknown source, and bucketing them under a sentinel would let one
    // unknown-IP request flap an alert for an entirely different attacker.
    if (!ev.ip || ev.ip.trim().length === 0) return;
    const ip = ev.ip;
    const t = now();
    const cutoff = t - windowMs;

    let state = perIp.get(ip);
    if (state === undefined) {
      evictOldestIfFull();
      state = { events: [], lastAlertedAt: null };
      perIp.set(ip, state);
    } else {
      pruneIp(state, cutoff);
    }

    state.events.push({
      at: t,
      status: ev.status,
      gate: ev.gate,
      route: ev.route,
      method: ev.method,
    });
    touch(ip, state);

    // Cooldown: once we've alerted for this IP, suppress further alerts
    // for one full window so an in-progress attack doesn't re-page the
    // on-call every request.
    if (state.lastAlertedAt !== null && t - state.lastAlertedAt < windowMs) {
      return;
    }

    if (state.events.length >= threshold) {
      fireAlert(ip, state, t);
    }
  }

  return {
    recordWrongTokenEvent,
    recentAlerts(limit?: number): RecentBruteForceAlert[] {
      const requested =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? Math.min(Math.floor(limit), RECENT_ALERTS_BUFFER_SIZE)
          : RECENT_ALERTS_DEFAULT_LIMIT;
      // Buffer is oldest-first; flip to newest-first so the dashboard
      // can render the most recent alert at the top of the list.
      const newestFirst = [...recentAlertsBuffer].reverse().map(cloneAlert);
      return newestFirst.slice(0, requested);
    },
    ackAlert(input: BruteForceAlertAckInput): BruteForceAlertAckResult {
      // (ip, detectedAt) is the row identity exposed to the calibration
      // UI — it's also the React key the panel uses, so the dashboard's
      // "ack this row" click maps 1:1 to this lookup. Two alerts can
      // share the tuple only if the alerter's clock didn't advance
      // between dispatches (extremely rare); in that case we ack the
      // newest match — that's the row a reviewer scrolling newest-first
      // would have clicked.
      let target: RecentBruteForceAlert | undefined;
      for (let i = recentAlertsBuffer.length - 1; i >= 0; i -= 1) {
        const entry = recentAlertsBuffer[i]!;
        if (entry.ip === input.ip && entry.detectedAt === input.detectedAt) {
          target = entry;
          break;
        }
      }
      if (target === undefined) {
        return { ok: false, reason: "not-found" };
      }
      if (target.ack !== undefined) {
        // Already acked — don't silently overwrite the prior reviewer's
        // attribution. The route maps this onto a 409 so the UI can
        // tell the reviewer that someone already handled it.
        return { ok: false, reason: "already-acked", alert: cloneAlert(target) };
      }
      const reviewer =
        typeof input.reviewer === "string" ? input.reviewer.trim() : "";
      const note = typeof input.note === "string" ? input.note.trim() : "";
      const ackNow = (input.now ?? now)();
      const ack: BruteForceAlertAck = {
        ackedAt: new Date(ackNow).toISOString(),
      };
      if (reviewer.length > 0) ack.ackedBy = reviewer;
      if (note.length > 0) ack.note = note;
      target.ack = ack;
      return { ok: true, alert: cloneAlert(target) };
    },
    async flushPending(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled(Array.from(inFlight));
      }
    },
  };
}

// Lazy singleton — production gets one alerter built from env on first
// wrong-token event; tests inject a deterministic instance.
let alerterInstance: BruteForceAlerter | null = null;

function getAlerter(): BruteForceAlerter {
  if (alerterInstance === null) {
    alerterInstance = createBruteForceAlerter();
  }
  return alerterInstance;
}

/**
 * Top-level entry point used by the 401 paths in
 * `require-calibration-auth.ts` and the 429 path in
 * `calibration-auth-rate-limit.ts`. Always safe to call.
 */
export function reportCalibrationAuthRejection(ev: WrongTokenEventInput): void {
  getAlerter().recordWrongTokenEvent(ev);
}

/**
 * Top-level accessor for the in-process ring buffer of dispatched
 * alerts. Backs `GET /feedback/calibration/auth-brute-force-alerts`
 * so the calibration dashboard can render a "recent calibration auth
 * alerts" panel without scraping pino logs.
 */
export function getRecentCalibrationAuthBruteForceAlerts(
  limit?: number,
): RecentBruteForceAlert[] {
  return getAlerter().recentAlerts(limit);
}

/**
 * Top-level entry point for the "ack from the dashboard" workflow.
 * Backs `POST /feedback/calibration/auth-brute-force-alerts/ack` so a
 * reviewer can mark the row identified by (ip, detectedAt) as
 * investigated / false-alarm without leaving the calibration page.
 */
export function ackCalibrationAuthBruteForceAlert(
  input: BruteForceAlertAckInput,
): BruteForceAlertAckResult {
  return getAlerter().ackAlert(input);
}

/** Test seam — replace the lazy alerter (or null to reset). */
export function __setBruteForceAlerterForTests(
  alerter: BruteForceAlerter | null,
): void {
  alerterInstance = alerter;
}

export const __CALIBRATION_AUTH_BRUTE_FORCE_DEFAULTS = {
  maxTrackedIps: DEFAULT_MAX_TRACKED_IPS,
  runbookPath: RUNBOOK_URL_PATH,
  recommendedActions: RECOMMENDED_ACTIONS,
  persistHistoryLimit: DEFAULT_PERSIST_HISTORY_LIMIT,
  stateFileName: STATE_FILE_NAME,
  recentAlertsBufferSize: RECENT_ALERTS_BUFFER_SIZE,
  recentAlertsDefaultLimit: RECENT_ALERTS_DEFAULT_LIMIT,
};
