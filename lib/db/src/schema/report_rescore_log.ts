// Task #620 — Score Stability Monitor.
//
// Persists each nightly "what would today's code score this row" probe so
// the calibration page can render tier-flip counts per day, broken down by
// direction (legit→slop, slop→legit). The table is append-only and
// independent from `reports` so a re-score never mutates the canonical
// stored score; we always compare against `reports.slop_score` /
// `reports.slop_tier` at the moment of the probe.
//
// `code_version` is whatever the running process reports (env-supplied or
// best-effort from `package.json`) so an alert that fires after a deploy
// can be traced back to the exact build that flipped tiers.
import { pgTable, serial, integer, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const reportRescoreLogTable = pgTable(
  "report_rescore_log",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id")
      .notNull()
      .references(() => reportsTable.id, { onDelete: "cascade" }),
    oldScore: integer("old_score").notNull(),
    newScore: integer("new_score").notNull(),
    oldTier: varchar("old_tier", { length: 30 }).notNull(),
    newTier: varchar("new_tier", { length: 30 }).notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    codeVersion: varchar("code_version", { length: 64 }).notNull().default("unknown"),
  },
  (table) => [
    index("idx_report_rescore_log_scored_at").on(table.scoredAt),
    index("idx_report_rescore_log_report_id").on(table.reportId),
  ],
);

export type ReportRescoreLog = typeof reportRescoreLogTable.$inferSelect;
export type InsertReportRescoreLog = typeof reportRescoreLogTable.$inferInsert;
