// Reports lifecycle prune scheduler.
//
// Two distinct hygiene concerns, both bounded by env-configurable
// retention windows. Disabled by default (REPORTS_PRUNE_ENABLED must
// be "1" or "true") so a fresh install never deletes data without
// explicit opt-in.
//
// Pass 1 — Quarantine failed reports past their retry budget.
//   `health_status='failed' AND health_retry_count >= MAX_RETRIES AND
//    health_last_retry_at < quarantine_cutoff` → set 'abandoned'.
//
// Pass 2 — Delete abandoned reports past the abandoned retention.
//   `health_status='abandoned' AND created_at < abandoned_cutoff`
//   → DELETE.
//
// Pass 3 (opt-in via REPORTS_PRUNE_DUST_ENABLED) — Delete private
// dust: rows that nobody indexed into the public feed, with a
// composite score below the threshold, after the dust retention.
//   `show_in_feed=false AND vulnrap_composite_score < threshold AND
//    created_at < dust_cutoff` → DELETE.
//
// All queries scan the partial index `idx_reports_health_unhealthy`
// for passes 1+2 and the existing feed/composite indexes for pass 3.
// The scheduler runs once per day on a single replica; concurrent
// runs are idempotent because each query is its own transaction and
// the predicates exclude already-pruned rows.

import { logger } from "./logger";

const DEFAULT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_INITIAL_DELAY_MS = 60_000; // 1 minute after boot
const DEFAULT_FAILED_MAX_RETRIES = 3;
const DEFAULT_FAILED_QUARANTINE_HOURS = 24;
const DEFAULT_ABANDONED_RETENTION_DAYS = 7;
const DEFAULT_DUST_COMPOSITE_THRESHOLD = 25;
const DEFAULT_DUST_RETENTION_DAYS = 30;

function parseIntegerEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoolEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const t = raw.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

export interface PruneScheduleConfig {
  enabled: boolean;
  dustEnabled: boolean;
  tickIntervalMs: number;
  initialDelayMs: number;
  failedMaxRetries: number;
  failedQuarantineHours: number;
  abandonedRetentionDays: number;
  dustCompositeThreshold: number;
  dustRetentionDays: number;
}

export function readPruneConfig(): PruneScheduleConfig {
  return {
    enabled: parseBoolEnv(process.env.REPORTS_PRUNE_ENABLED),
    dustEnabled: parseBoolEnv(process.env.REPORTS_PRUNE_DUST_ENABLED),
    tickIntervalMs: parseIntegerEnv(
      process.env.REPORTS_PRUNE_INTERVAL_MS,
      DEFAULT_TICK_INTERVAL_MS,
    ),
    initialDelayMs: parseIntegerEnv(
      process.env.REPORTS_PRUNE_INITIAL_DELAY_MS,
      DEFAULT_INITIAL_DELAY_MS,
    ),
    failedMaxRetries: parseIntegerEnv(
      process.env.REPORTS_FAILED_MAX_RETRIES,
      DEFAULT_FAILED_MAX_RETRIES,
    ),
    failedQuarantineHours: parseIntegerEnv(
      process.env.REPORTS_FAILED_QUARANTINE_HOURS,
      DEFAULT_FAILED_QUARANTINE_HOURS,
    ),
    abandonedRetentionDays: parseIntegerEnv(
      process.env.REPORTS_ABANDONED_RETENTION_DAYS,
      DEFAULT_ABANDONED_RETENTION_DAYS,
    ),
    dustCompositeThreshold: parseIntegerEnv(
      process.env.REPORTS_DUST_COMPOSITE_THRESHOLD,
      DEFAULT_DUST_COMPOSITE_THRESHOLD,
    ),
    dustRetentionDays: parseIntegerEnv(
      process.env.REPORTS_DUST_RETENTION_DAYS,
      DEFAULT_DUST_RETENTION_DAYS,
    ),
  };
}

export interface PruneTickResult {
  ranTick: boolean;
  abandonedMarked: number;
  abandonedDeleted: number;
  dustDeleted: number;
}

/**
 * Run one prune tick. Resolves with counters for each pass. When the
 * scheduler is disabled, returns `{ ranTick: false, ... 0s }` without
 * touching the DB.
 */
export async function runPruneTick(
  config: PruneScheduleConfig = readPruneConfig(),
): Promise<PruneTickResult> {
  if (!config.enabled) {
    return {
      ranTick: false,
      abandonedMarked: 0,
      abandonedDeleted: 0,
      dustDeleted: 0,
    };
  }

  // Lazy import so unit tests can mock @workspace/db.
  const { db, reportsTable } = await import("@workspace/db");
  const { and, eq, lt, sql, isNotNull } = await import("drizzle-orm");

  const now = Date.now();

  // Pass 1: failed → abandoned when over retry budget AND past quarantine.
  const quarantineCutoff = new Date(
    now - config.failedQuarantineHours * 60 * 60 * 1000,
  );
  const markedRows = await db
    .update(reportsTable)
    .set({
      healthStatus: "abandoned",
    })
    .where(
      and(
        eq(reportsTable.healthStatus, "failed"),
        sql`${reportsTable.healthRetryCount} >= ${config.failedMaxRetries}`,
        isNotNull(reportsTable.healthLastRetryAt),
        lt(reportsTable.healthLastRetryAt, quarantineCutoff),
      ),
    )
    .returning({ id: reportsTable.id });
  const abandonedMarked = markedRows.length;

  // Pass 2: abandoned past retention → DELETE.
  const abandonedCutoff = new Date(
    now - config.abandonedRetentionDays * 24 * 60 * 60 * 1000,
  );
  const abandonedDeletedRows = await db
    .delete(reportsTable)
    .where(
      and(
        eq(reportsTable.healthStatus, "abandoned"),
        lt(reportsTable.createdAt, abandonedCutoff),
      ),
    )
    .returning({ id: reportsTable.id });
  const abandonedDeleted = abandonedDeletedRows.length;

  // Pass 3 (opt-in): private dust past retention → DELETE.
  let dustDeleted = 0;
  if (config.dustEnabled) {
    const dustCutoff = new Date(
      now - config.dustRetentionDays * 24 * 60 * 60 * 1000,
    );
    const dustDeletedRows = await db
      .delete(reportsTable)
      .where(
        and(
          eq(reportsTable.showInFeed, false),
          eq(reportsTable.healthStatus, "ok"),
          isNotNull(reportsTable.vulnrapCompositeScore),
          sql`${reportsTable.vulnrapCompositeScore} < ${config.dustCompositeThreshold}`,
          lt(reportsTable.createdAt, dustCutoff),
        ),
      )
      .returning({ id: reportsTable.id });
    dustDeleted = dustDeletedRows.length;
  }

  if (abandonedMarked + abandonedDeleted + dustDeleted > 0) {
    logger.info(
      {
        scheduler: "reports-prune",
        abandonedMarked,
        abandonedDeleted,
        dustDeleted,
      },
      "reports prune tick complete",
    );
  }
  return {
    ranTick: true,
    abandonedMarked,
    abandonedDeleted,
    dustDeleted,
  };
}

export interface PruneScheduler {
  stop: () => void;
}

/**
 * Start the periodic prune scheduler. Returns a `stop()` handle for
 * the api-server's graceful-shutdown sequence. When disabled, the
 * scheduler does not arm a timer at all — zero overhead.
 */
export function startReportsPruneScheduler(
  config: PruneScheduleConfig = readPruneConfig(),
): PruneScheduler {
  if (!config.enabled) {
    logger.info(
      { scheduler: "reports-prune" },
      "reports prune scheduler disabled (REPORTS_PRUNE_ENABLED is unset)",
    );
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tickAndReschedule = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runPruneTick(config);
    } catch (err) {
      logger.error(
        { scheduler: "reports-prune", err: String(err) },
        "reports prune tick failed",
      );
    }
    if (stopped) return;
    timer = setTimeout(tickAndReschedule, config.tickIntervalMs);
    timer.unref?.();
  };

  timer = setTimeout(tickAndReschedule, config.initialDelayMs);
  timer.unref?.();
  logger.info(
    {
      scheduler: "reports-prune",
      tickIntervalMs: config.tickIntervalMs,
      dustEnabled: config.dustEnabled,
    },
    "reports prune scheduler armed",
  );

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
