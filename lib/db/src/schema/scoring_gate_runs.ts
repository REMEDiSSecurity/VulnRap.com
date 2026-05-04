import {
  pgTable,
  serial,
  integer,
  varchar,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const scoringGateRunsTable = pgTable(
  "scoring_gate_runs",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
    commit: varchar("commit", { length: 64 }).notNull().default("unknown"),
    totalReports: integer("total_reports").notNull(),
    flipCount: integer("flip_count").notNull(),
    flipRate: real("flip_rate").notNull(),
    topDiffs: jsonb("top_diffs")
      .notNull()
      .$type<
        Array<{
          id: number;
          storedTier: string;
          recomputedTier: string;
          storedScore: number;
          recomputedScore: number;
          scoreDelta: number;
        }>
      >(),
  },
  (table) => [index("idx_scoring_gate_runs_timestamp").on(table.timestamp)],
);

export type ScoringGateRun = typeof scoringGateRunsTable.$inferSelect;
export type InsertScoringGateRun = typeof scoringGateRunsTable.$inferInsert;
