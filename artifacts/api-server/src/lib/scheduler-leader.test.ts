// Task #762 — Coverage for the cross-replica scheduler-leadership
// helper. The DB-backed implementation is exercised against the live
// Postgres test database when DATABASE_URL is set; otherwise the
// suite skips itself the same way `scoring-replay.test.ts` does so a
// fresh clone without a DB still completes `pnpm test`.
//
// All DB-bound imports happen lazily inside `beforeAll` so the test
// file can be loaded by vitest in a no-DB environment without
// resolving `@workspace/db` at module load time. The scheduler-leader
// module itself is also lazy-imported for the same reason — even
// though it now uses a dynamic `import("@workspace/db")`, keeping the
// imports symmetric makes the no-DB skip path obviously safe.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe("createPostgresSchedulerLeadership", () => {
  if (!HAS_DB) {
    it.skip("skipped: DATABASE_URL not set", () => {});
    return;
  }

  let leaderMod: typeof import("./scheduler-leader");
  let pool: typeof import("@workspace/db").pool;

  beforeAll(async () => {
    leaderMod = await import("./scheduler-leader");
    const dbMod = await import("@workspace/db");
    pool = dbMod.pool;
  });

  beforeEach(async () => {
    // Make sure the table exists in dev DBs that haven't run the
    // 0005 migration yet.
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "scheduler_runs" (
         "job_name" varchar(64) PRIMARY KEY NOT NULL,
         "last_started_at" timestamp with time zone,
         "last_completed_at" timestamp with time zone
       )`,
    );
    await leaderMod.clearSchedulerRun("rescore-backfill");
  });

  afterAll(async () => {
    if (HAS_DB && leaderMod) {
      await leaderMod
        .clearSchedulerRun("rescore-backfill")
        .catch(() => undefined);
    }
  });

  it("acquires a lease, blocks a concurrent acquire, then releases on the first lease", async () => {
    const leadership = leaderMod.createPostgresSchedulerLeadership();
    const first = await leadership.tryAcquire({
      jobName: "rescore-backfill",
      minIntervalMs: 0,
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    // While the first lease is still held, a second acquire must lose
    // the advisory-lock race and report it explicitly so the loser's
    // scheduler can skip the tick.
    const second = await leadership.tryAcquire({
      jobName: "rescore-backfill",
      minIntervalMs: 0,
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("lock-held-elsewhere");
    }

    await first.release(true);

    // After release the lock is free again, but `last_started_at` is
    // very recent — `minIntervalMs > 0` should now report "recent-run"
    // instead of "lock-held-elsewhere".
    const third = await leadership.tryAcquire({
      jobName: "rescore-backfill",
      minIntervalMs: 60_000,
    });
    expect(third.acquired).toBe(false);
    if (!third.acquired) {
      expect(third.reason).toBe("recent-run");
    }
  });

  it("records last_started_at on acquire and last_completed_at on successful release", async () => {
    const leadership = leaderMod.createPostgresSchedulerLeadership();
    const lease = await leadership.tryAcquire({
      jobName: "rescore-backfill",
      minIntervalMs: 0,
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    const startedRow = await pool.query<{
      last_started_at: Date | null;
      last_completed_at: Date | null;
    }>(
      `SELECT last_started_at, last_completed_at FROM scheduler_runs WHERE job_name = $1`,
      ["rescore-backfill"],
    );
    expect(startedRow.rows[0]?.last_started_at).not.toBeNull();
    // Not yet released, so the completed timestamp must still be NULL.
    expect(startedRow.rows[0]?.last_completed_at).toBeNull();

    await lease.release(true);

    const completedRow = await pool.query<{
      last_completed_at: Date | null;
    }>(
      `SELECT last_completed_at FROM scheduler_runs WHERE job_name = $1`,
      ["rescore-backfill"],
    );
    expect(completedRow.rows[0]?.last_completed_at).not.toBeNull();
  });

  it("does NOT update last_completed_at when the runner reports failure", async () => {
    const leadership = leaderMod.createPostgresSchedulerLeadership();
    const lease = await leadership.tryAcquire({
      jobName: "rescore-backfill",
      minIntervalMs: 0,
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) return;

    await lease.release(false);
    const row = await pool.query<{ last_completed_at: Date | null }>(
      `SELECT last_completed_at FROM scheduler_runs WHERE job_name = $1`,
      ["rescore-backfill"],
    );
    // last_completed_at is reserved for "the scan ran end-to-end". A
    // failed lease leaves it untouched (NULL on a fresh row) so the
    // heartbeat panel can spot a job that always starts but never
    // finishes.
    expect(row.rows[0]?.last_completed_at).toBeNull();
  });

  it("exposes a stable, non-zero advisory lock key for rescore-backfill", () => {
    // Hard-coded so a typo can never silently move the lock onto a
    // different namespace and let two replicas collide.
    expect(leaderMod.ADVISORY_LOCK_KEYS["rescore-backfill"]).toBe(
      0x52534342_00000001n,
    );
  });
});
