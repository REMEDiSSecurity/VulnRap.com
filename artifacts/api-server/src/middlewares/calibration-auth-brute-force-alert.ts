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
}

export interface BruteForceAlerter {
  recordWrongTokenEvent(ev: WrongTokenEventInput): void;
  /** Test-only: resolves once any in-flight dispatch promise has settled. */
  flushPending(): Promise<void>;
}

const DEFAULT_MAX_TRACKED_IPS = 1024;

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
    rejectionsByGate: { mutation: countMutation, "strict-read": countStrictRead },
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

  const perIp = new Map<string, PerIpState>();
  const inFlight = new Set<Promise<unknown>>();

  function pruneIp(state: PerIpState, cutoff: number): void {
    let dropUntil = 0;
    while (dropUntil < state.events.length && state.events[dropUntil]!.at < cutoff) {
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
    if (
      state.lastAlertedAt !== null &&
      t - state.lastAlertedAt < windowMs
    ) {
      return;
    }

    if (state.events.length >= threshold) {
      fireAlert(ip, state, t);
    }
  }

  return {
    recordWrongTokenEvent,
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
export function reportCalibrationAuthRejection(
  ev: WrongTokenEventInput,
): void {
  getAlerter().recordWrongTokenEvent(ev);
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
};
