-- Task #762 — Stop the weekly rescore from firing once per server replica.
--
-- One row per recurring background job. The api-server's scheduler-
-- leadership helper (see lib/scheduler-leader.ts) holds a Postgres
-- advisory lock for the duration of a tick and uses `last_started_at`
-- here as a fleet-wide gate so an N-replica deploy doesn't multiply
-- the weekly rescore scan load by N.
--
-- Pre-existing self-hosters who already had a runtime-managed table
-- with the same name will land on `IF NOT EXISTS` and the existing
-- rows are left alone (the migration is idempotent and additive).

CREATE TABLE IF NOT EXISTS "scheduler_runs" (
  "job_name" varchar(64) PRIMARY KEY NOT NULL,
  "last_started_at" timestamp with time zone,
  "last_completed_at" timestamp with time zone
);
