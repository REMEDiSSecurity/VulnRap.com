import {
  pgTable,
  serial,
  integer,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { corpusUnreviewedTable } from "./corpus_unreviewed";

/**
 * Task #1328 — Promoted REMEDiS feedback rows form the seed labelled
 * corpus. Append-only: rows here are only created via a promotion from
 * `corpus_unreviewed`. Edits / retractions happen by inserting a new
 * row that references the same `unreviewedId`, not by mutating an
 * existing row, so the audit trail is preserved verbatim.
 *
 * The eval harness reads from this table once the harness integration
 * lands in a later task (REMEDiS eval harness on 170-report corpus).
 * Until then this is a write-mostly table — promotions accumulate, no
 * downstream readers yet.
 *
 * `groundTruth` is denormalized from the payload's `ground_truth` block
 * so the harness can query labels without re-parsing the full payload.
 * The full payload is still recoverable via `unreviewed_id` →
 * `corpus_unreviewed.payload`.
 */
export const corpusLabelledTable = pgTable(
  "corpus_labelled",
  {
    id: serial("id").primaryKey(),

    // Always set: the source row this label was promoted from.
    // ON DELETE RESTRICT is used at the SQL level (see the migration) —
    // we never want the audit trail orphaned by accidentally removing
    // the corpus_unreviewed row.
    unreviewedId: integer("unreviewed_id")
      .notNull()
      .references(() => corpusUnreviewedTable.id),

    submissionId: text("submission_id").notNull(),
    schemaVersion: varchar("schema_version", { length: 64 }).notNull(),
    verdict: varchar("verdict", { length: 64 }).notNull(),

    // Denormalized convenience: payload.ground_truth subtree. The full
    // payload still lives on corpus_unreviewed.payload.
    groundTruth: jsonb("ground_truth"),

    promotedBy: text("promoted_by").notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    promotionNote: text("promotion_note"),
  },
  (table) => [
    index("corpus_labelled_submission_idx").on(table.submissionId),
    index("corpus_labelled_unreviewed_idx").on(table.unreviewedId),
    index("corpus_labelled_promoted_at_idx").on(table.promotedAt),
  ],
);

export type CorpusLabelled = typeof corpusLabelledTable.$inferSelect;
export type InsertCorpusLabelled = typeof corpusLabelledTable.$inferInsert;
