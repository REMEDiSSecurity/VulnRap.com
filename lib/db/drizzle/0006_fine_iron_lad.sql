-- Task #974 — Scoring-gate flip-rate history table.
--
-- Append-only log of each `scripts/scoring-gate-replay.mjs` run so the
-- calibration dashboard can render a trend line of flip rates and reviewers
-- can spot slow calibration drift that no single 0.5 % gate pass can surface.
--
-- The replay test also carries a CREATE TABLE IF NOT EXISTS fallback for
-- environments where migrations haven't been applied yet, but the canonical
-- schema lives here so self-hosters get the table at boot via the versioned
-- migrator (startup-migrations.ts).

CREATE TABLE IF NOT EXISTS "scoring_gate_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "commit" varchar(64) DEFAULT 'unknown' NOT NULL,
  "total_reports" integer NOT NULL,
  "flip_count" integer NOT NULL,
  "flip_rate" real NOT NULL,
  "top_diffs" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scoring_gate_runs_timestamp" ON "scoring_gate_runs" USING btree ("timestamp");
