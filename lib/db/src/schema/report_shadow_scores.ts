// Task #639 — Shadow scoring mode.
//
// When `SHADOW_SCORING_ENABLED=1`, every successfully-persisted production
// report is re-scored through the "shadow" pipeline (the in-flight scoring
// rule change being staged for promotion) and the result is appended here
// alongside the live score that the user actually saw. Reviewers can then
// browse a "shadow drift" dashboard to spot regressions before promoting
// the shadow rules to live.
//
// The table is append-only and independent from `reports` — a shadow
// score never mutates the canonical stored score, so the user-facing
// number is always the live one. Promotion of shadow → live is always
// manual (out of scope for v1).
//
// `tier_diverged` and `score_diff` are denormalized at write time so the
// `/api/internal/shadow-drift` endpoint can filter on a partial index
// without recomputing the divergence boolean for every row on every
// query.
import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const reportShadowScoresTable = pgTable(
  "report_shadow_scores",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id")
      .notNull()
      .references(() => reportsTable.id, { onDelete: "cascade" }),
    liveScore: integer("live_score").notNull(),
    liveTier: varchar("live_tier", { length: 30 }).notNull(),
    shadowScore: integer("shadow_score").notNull(),
    shadowTier: varchar("shadow_tier", { length: 30 }).notNull(),
    scoreDiff: integer("score_diff").notNull(),
    tierDiverged: boolean("tier_diverged").notNull().default(false),
    shadowVersion: varchar("shadow_version", { length: 64 })
      .notNull()
      .default("unknown"),
    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_report_shadow_scores_scored_at").on(table.scoredAt),
    index("idx_report_shadow_scores_report_id").on(table.reportId),
    index("idx_report_shadow_scores_diverged").on(table.tierDiverged),
  ],
);

export type ReportShadowScore = typeof reportShadowScoresTable.$inferSelect;
export type InsertReportShadowScore =
  typeof reportShadowScoresTable.$inferInsert;
