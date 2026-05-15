-- Task #1328 — REMEDiS feedback.v2 ingest queue + promoted labelled corpus.
--
-- Two tables, both additive:
--
-- 1. corpus_unreviewed: every `remedis.feedback.v2` payload received via
--    POST /api/feedback/v2 lands here. The raw payload column preserves
--    the JSON verbatim so we can re-derive structured fields later if
--    the schema evolves. The review lifecycle (pending → promoted /
--    rejected / deferred) lives on the same row so the audit trail stays
--    co-located with the payload.
--
-- 2. corpus_labelled: append-only mirror of promoted rows. The eval
--    harness will read from here once that integration lands in a later
--    task. The FK to corpus_unreviewed is RESTRICT so the audit trail
--    can never be orphaned by accidentally deleting the source row.
--
-- All statements use IF NOT EXISTS so re-running this migration on a
-- partially-applied database is a no-op.

CREATE TABLE IF NOT EXISTS "corpus_unreviewed" (
    "id" serial PRIMARY KEY NOT NULL,
    "submission_id" text NOT NULL,
    "schema_version" varchar(64) NOT NULL,
    "verdict" varchar(64) NOT NULL,
    "payload" jsonb NOT NULL,
    "received_at" timestamp with time zone NOT NULL DEFAULT now(),
    "status" varchar(16) NOT NULL DEFAULT 'pending',
    "decided_at" timestamp with time zone,
    "decided_by" text,
    "decision_reason" text
);

CREATE UNIQUE INDEX IF NOT EXISTS "corpus_unreviewed_uniq"
    ON "corpus_unreviewed" ("submission_id", "schema_version", "received_at");
CREATE INDEX IF NOT EXISTS "corpus_unreviewed_status_idx"
    ON "corpus_unreviewed" ("status");
CREATE INDEX IF NOT EXISTS "corpus_unreviewed_received_at_idx"
    ON "corpus_unreviewed" ("received_at");

CREATE TABLE IF NOT EXISTS "corpus_labelled" (
    "id" serial PRIMARY KEY NOT NULL,
    "unreviewed_id" integer NOT NULL,
    "submission_id" text NOT NULL,
    "schema_version" varchar(64) NOT NULL,
    "verdict" varchar(64) NOT NULL,
    "ground_truth" jsonb,
    "promoted_by" text NOT NULL,
    "promoted_at" timestamp with time zone NOT NULL DEFAULT now(),
    "promotion_note" text
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'corpus_labelled_unreviewed_id_fkey'
          AND table_name = 'corpus_labelled'
    ) THEN
        ALTER TABLE "corpus_labelled"
            ADD CONSTRAINT "corpus_labelled_unreviewed_id_fkey"
            FOREIGN KEY ("unreviewed_id") REFERENCES "corpus_unreviewed"("id")
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "corpus_labelled_submission_idx"
    ON "corpus_labelled" ("submission_id");
CREATE INDEX IF NOT EXISTS "corpus_labelled_unreviewed_idx"
    ON "corpus_labelled" ("unreviewed_id");
CREATE INDEX IF NOT EXISTS "corpus_labelled_promoted_at_idx"
    ON "corpus_labelled" ("promoted_at");
