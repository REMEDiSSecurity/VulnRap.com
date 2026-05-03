// Task #762 — Cross-replica scheduler leadership.
//
// Background. The recurring rescore-backfill scheduler (and any
// future job that follows the same shape) is wired into every
// api-server replica's boot path. The row-level concurrency guards
// inside `backfill()` already prevent two ticks from corrupting the
// same row, but each extra replica still runs the *full candidate
// scan* on its own weekly cadence — multiplying weekly DB read load
// by the replica count. In a multi-replica deploy that means the
// "weekly" rescore effectively runs N times per week.
//
// This module elects exactly one replica per scheduling interval,
// fleet-wide. Two layers cooperate:
//
//   1. A Postgres advisory lock acquired on a dedicated session
//      (`pg_try_advisory_lock`). Replicas that fail to acquire the
//      lock skip the tick immediately. The lock is held only for the
//      duration of the actual work, so a crashed replica releases it
//      automatically when its DB session is reaped.
//
//   2. A `scheduler_runs` row per job_name records when a tick last
//      *started* (set under the lock, before the work runs). Every
//      replica that wins the lock then re-checks this timestamp; if
//      another replica already started a tick within the last
//      `minIntervalMs`, the winner releases the lock and skips. This
//      handles the common case where replicas don't tick in lockstep
//      (each one's `initialDelayMs` is offset by its boot time) so
//      ticks would otherwise round-robin across replicas instead of
//      converging to one fleet-wide cadence.
//
// `last_completed_at` is updated at the end of a successful run and
// is purely observational — exposed on the scheduler heartbeat
// endpoint so reviewers can spot a job that always starts but never
// finishes.

import { logger } from "./logger";

// Minimal structural type for a checked-out pg pool client. We avoid
// `import type pg from "pg"` because `pg` is a transitive dependency
// of @workspace/db, not a direct dependency of the api-server, so the
// types are not in this package's TS resolution. The shape below is
// the subset of pg.PoolClient that this module actually uses.
interface PoolClientLike {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
  release(): void;
}

interface PoolLike {
  connect(): Promise<PoolClientLike>;
}

// `@workspace/db` reads `DATABASE_URL` at module load and throws when
// it is unset. Importing it eagerly at the top of this file would
// crash any caller that merely *imports* the rescore scheduler in a
// no-DB environment (e.g. unit tests that don't need it, the disabled
// short-circuit path, or `pnpm test` on a fresh clone). We resolve
// the pool the first time `tryAcquire` actually needs it instead so
// no-DB callers don't pay for the import.
let cachedPoolPromise: Promise<PoolLike> | null = null;
async function getPool(): Promise<PoolLike> {
  if (!cachedPoolPromise) {
    cachedPoolPromise = (async () => {
      const mod = await import("@workspace/db");
      return mod.pool as unknown as PoolLike;
    })();
  }
  return cachedPoolPromise;
}

async function checkoutClient(): Promise<PoolClientLike> {
  const pool = await getPool();
  return pool.connect();
}

/**
 * Numeric advisory-lock key per recurring job. `pg_try_advisory_lock`
 * takes a single bigint, so the keys are hard-coded constants instead
 * of hashed at runtime — a typo would silently move the lock onto a
 * different namespace and let two replicas collide. The high bytes
 * spell `RSCB` (RescoreBackfill) to keep the key visually distinct
 * from any other advisory lock the codebase might use.
 */
export const ADVISORY_LOCK_KEYS = {
  "rescore-backfill": 0x52534342_00000001n,
} as const satisfies Record<string, bigint>;

export type SchedulerJobName = keyof typeof ADVISORY_LOCK_KEYS;

export type LeadershipSkipReason = "lock-held-elsewhere" | "recent-run";

/**
 * Distinct from `LeadershipSkipReason` on purpose: a *skip* (lock held
 * by another replica or a recent run) is the expected, healthy
 * outcome on every replica that didn't win this interval, and the
 * scheduler should re-arm at the success cadence. An *error* (DB
 * unreachable, query failed, etc.) is unhealthy and the scheduler
 * should re-arm at the shorter retry cadence so we don't suppress
 * rescoring for a full week after a transient failure.
 */
export type LeadershipErrorReason = "acquire-error";

export type LeadershipResult =
  | { acquired: true; release: (success: boolean) => Promise<void> }
  | { acquired: false; reason: LeadershipSkipReason }
  | { acquired: false; reason: LeadershipErrorReason; error: unknown };

export interface AcquireLeadershipOptions {
  jobName: SchedulerJobName;
  /**
   * Suppress a tick when the previous tick *started* less than this
   * many milliseconds ago. Set to the scheduler's success interval so
   * a weekly job stays weekly across the fleet, not per-replica.
   */
  minIntervalMs: number;
}

export interface SchedulerLeadership {
  tryAcquire(opts: AcquireLeadershipOptions): Promise<LeadershipResult>;
}

/**
 * Postgres-backed leadership. Each `tryAcquire` call checks out a
 * dedicated client from the pool, holds it across the work, and
 * releases it (along with the advisory lock) inside the returned
 * `release()` callback.
 */
export function createPostgresSchedulerLeadership(): SchedulerLeadership {
  return {
    async tryAcquire({
      jobName,
      minIntervalMs,
    }: AcquireLeadershipOptions): Promise<LeadershipResult> {
      const lockKey = ADVISORY_LOCK_KEYS[jobName];
      let client: PoolClientLike | null = null;
      try {
        client = await checkoutClient();
        const lockRes = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [lockKey.toString()],
        );
        if (!lockRes.rows[0]?.locked) {
          client.release();
          return { acquired: false, reason: "lock-held-elsewhere" };
        }

        // We hold the lock from here. Any early return must release
        // it before the client goes back to the pool, otherwise the
        // next tick on this physical connection would inherit a
        // still-held lock.
        const recentRes = await client.query<{
          last_started_at: Date | null;
        }>(
          "SELECT last_started_at FROM scheduler_runs WHERE job_name = $1",
          [jobName],
        );
        const lastStartedAt = recentRes.rows[0]?.last_started_at ?? null;
        if (
          lastStartedAt &&
          Date.now() - lastStartedAt.getTime() < minIntervalMs
        ) {
          await client.query("SELECT pg_advisory_unlock($1)", [
            lockKey.toString(),
          ]);
          client.release();
          return { acquired: false, reason: "recent-run" };
        }

        await client.query(
          `INSERT INTO scheduler_runs (job_name, last_started_at)
             VALUES ($1, NOW())
           ON CONFLICT (job_name) DO UPDATE
             SET last_started_at = EXCLUDED.last_started_at`,
          [jobName],
        );

        const heldClient = client;
        client = null; // ownership transferred to release()

        return {
          acquired: true,
          release: async (success: boolean): Promise<void> => {
            try {
              if (success) {
                await heldClient
                  .query(
                    `UPDATE scheduler_runs
                       SET last_completed_at = NOW()
                       WHERE job_name = $1`,
                    [jobName],
                  )
                  .catch((err: unknown) => {
                    logger.warn(
                      { err, jobName },
                      "[scheduler-leader] failed to record last_completed_at (non-fatal)",
                    );
                  });
              }
              await heldClient
                .query("SELECT pg_advisory_unlock($1)", [lockKey.toString()])
                .catch((err: unknown) => {
                  logger.warn(
                    { err, jobName },
                    "[scheduler-leader] pg_advisory_unlock failed; session reap will release the lock",
                  );
                });
            } finally {
              heldClient.release();
            }
          },
        };
      } catch (err) {
        // Anything between checkout and the successful UPSERT lands
        // here. Make sure we never leak the client back to the pool
        // while still holding either the advisory lock or an open
        // transaction.
        if (client) {
          try {
            await client.query("SELECT pg_advisory_unlock_all()");
          } catch {
            // best-effort; the session reap will cover us.
          }
          client.release();
        }
        logger.warn(
          { err, jobName },
          "[scheduler-leader] tryAcquire failed; surfacing as acquire-error so the scheduler re-arms at the retry interval",
        );
        return { acquired: false, reason: "acquire-error", error: err };
      }
    },
  };
}

/**
 * Drop the per-job row from `scheduler_runs`. Exposed for tests and
 * for an operator who wants to force the next tick to run regardless
 * of `last_started_at` (e.g. after a manual rescore was kicked off
 * out-of-band and they want the scheduler back in sync).
 */
export async function clearSchedulerRun(
  jobName: SchedulerJobName,
): Promise<void> {
  const pool = (await getPool()) as PoolLike & {
    query: (text: string, values?: unknown[]) => Promise<unknown>;
  };
  await pool.query("DELETE FROM scheduler_runs WHERE job_name = $1", [
    jobName,
  ]);
}
