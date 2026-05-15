import {
  pgTable,
  serial,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Task #1328 — REMEDiS feedback.v2 ingest queue.
 *
 * Holds raw `remedis.feedback.v2` payloads received from the REMEDiS
 * integration, one row per submission. Treated as **structured, tied-
 * to-features signals from one trusted customer** — never authoritative.
 * Every row is reviewed by a human, who either promotes it into
 * `corpus_labelled` or rejects it with a reason. Promotion / rejection
 * decisions live on this row itself (status + decided_at + decided_by +
 * reason), keeping the audit trail co-located with the raw payload.
 *
 * The raw JSON column is preserved verbatim so we can re-derive
 * structured fields later if the schema evolves; the parsed columns are
 * convenience extractions for the review UI and the dashboard tile.
 *
 * Uniqueness: `(submission_id, schema_version, received_at)` — REMEDiS
 * may legitimately re-send a payload for the same submission (e.g. when
 * ground truth changes), so submission_id alone is not unique. The
 * received_at tiebreaker lets duplicate-on-resend behave as append-only
 * history rather than as silent overwrites.
 */
export const corpusUnreviewedTable = pgTable(
  "corpus_unreviewed",
  {
    id: serial("id").primaryKey(),

    // Parsed convenience fields. submissionId / reportId mirror the
    // payload's `report_id` (REMEDiS calls it that; we use submission_id
    // throughout the api-server). schemaVersion is parsed from
    // payload.schema_version so a future migration can filter on it.
    submissionId: text("submission_id").notNull(),
    schemaVersion: varchar("schema_version", { length: 64 }).notNull(),
    verdict: varchar("verdict", { length: 64 }).notNull(),

    // Full raw payload — the source of truth. Parsed columns are
    // derived from this and only kept in sync at insert time.
    payload: jsonb("payload").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Review lifecycle:
    //   pending  — fresh, awaiting human review
    //   promoted — copied into corpus_labelled (append-only there)
    //   rejected — reviewer declined with a reason
    //   deferred — reviewer wants to revisit; still counts toward queue
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decisionReason: text("decision_reason"),
  },
  (table) => [
    uniqueIndex("corpus_unreviewed_uniq").on(
      table.submissionId,
      table.schemaVersion,
      table.receivedAt,
    ),
    index("corpus_unreviewed_status_idx").on(table.status),
    index("corpus_unreviewed_received_at_idx").on(table.receivedAt),
  ],
);

export type CorpusUnreviewed = typeof corpusUnreviewedTable.$inferSelect;
export type InsertCorpusUnreviewed =
  typeof corpusUnreviewedTable.$inferInsert;
