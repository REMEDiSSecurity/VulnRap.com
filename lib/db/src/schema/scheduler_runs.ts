// Task #762 — Cross-replica scheduler run-tracking.
//
// Singleton-per-job row used by the scheduler-leadership helper in the
// api-server (see `artifacts/api-server/src/lib/scheduler-leader.ts`).
// One row per recurring background job (`job_name` is the primary key)
// records when a tick last started and last completed across the entire
// fleet — not per replica. Combined with a Postgres advisory lock, it
// lets every replica's in-process scheduler still tick on its own
// timer while ensuring at most one replica actually performs the work
// per scheduling interval, instead of multiplying weekly DB load by the
// replica count.
//
// `last_started_at` is set BEFORE the underlying work runs and is the
// gate every replica reads: a tick is suppressed when the elapsed time
// since `last_started_at` is less than the job's success interval.
// `last_completed_at` is set AFTER the work succeeds and exists so the
// calibration heartbeat panel can distinguish "started but never
// finished" from "finished cleanly".

import { pgTable, varchar, timestamp } from "drizzle-orm/pg-core";

export const schedulerRunsTable = pgTable("scheduler_runs", {
  jobName: varchar("job_name", { length: 64 }).primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
});

export type SchedulerRun = typeof schedulerRunsTable.$inferSelect;
export type InsertSchedulerRun = typeof schedulerRunsTable.$inferInsert;
