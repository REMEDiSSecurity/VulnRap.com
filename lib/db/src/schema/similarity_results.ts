import { pgTable, serial, integer, varchar, real, timestamp, index } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const similarityResultsTable = pgTable("similarity_results", {
  id: serial("id").primaryKey(),
  sourceReportId: integer("source_report_id").notNull().references(() => reportsTable.id, { onDelete: "cascade" }),
  matchedReportId: integer("matched_report_id").notNull().references(() => reportsTable.id, { onDelete: "cascade" }),
  similarityScore: real("similarity_score").notNull(),
  matchType: varchar("match_type", { length: 30 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_similarity_source").on(table.sourceReportId),
  index("idx_similarity_matched").on(table.matchedReportId),
  index("idx_similarity_score").on(table.similarityScore),
]);

export type SimilarityResult = typeof similarityResultsTable.$inferSelect;
