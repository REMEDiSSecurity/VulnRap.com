import { pgTable, varchar, integer, timestamp } from "drizzle-orm/pg-core";

export const reportStatsTable = pgTable("report_stats", {
  key: varchar("key", { length: 50 }).primaryKey(),
  value: integer("value").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ReportStat = typeof reportStatsTable.$inferSelect;
