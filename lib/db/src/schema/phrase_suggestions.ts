import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Task #634 — User-suggested phrase pipeline. Anonymous end users can
// propose new handwavy / ai-self-disclosure phrases through the public
// transparency page; submissions land here in `status = "pending"` and
// are surfaced to reviewers in the feedback-analytics dashboard. Nothing
// is auto-applied — reviewers approve via the existing add endpoints and
// then mark the suggestion approved/rejected.
//
// `ip_hmac` is a SHA-256 HMAC of the submitter IP (keyed with the
// existing VISITOR_HMAC_KEY) so we can rate-limit and dedupe per-IP
// without persisting raw addresses.
export const phraseSuggestionsTable = pgTable(
  "phrase_suggestions",
  {
    id: serial("id").primaryKey(),
    text: varchar("text", { length: 240 }).notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    context: text("context"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    ipHmac: varchar("ip_hmac", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_phrase_suggestions_status_created_at").on(
      table.status,
      table.createdAt,
    ),
    index("idx_phrase_suggestions_ip_hmac_created_at").on(
      table.ipHmac,
      table.createdAt,
    ),
  ],
);

export type PhraseSuggestion = typeof phraseSuggestionsTable.$inferSelect;
export type InsertPhraseSuggestion = typeof phraseSuggestionsTable.$inferInsert;
