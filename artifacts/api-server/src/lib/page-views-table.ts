import { pgTable, serial, varchar, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// page_views is intentionally defined OUTSIDE of @workspace/db so that
// drizzle-kit (which the Replit deploy validator runs against the lib/db
// package) cannot see it. The table is owned end-to-end by the api-server's
// startup migration (see ./startup-migrations.ts) and is queried at runtime
// using this Drizzle pgTable definition reused directly by routes/stats.ts.
export const pageViewsTable = pgTable("page_views", {
  id: serial("id").primaryKey(),
  visitorHash: varchar("visitor_hash", { length: 64 }).notNull(),
  viewDate: date("view_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_page_views_visitor_date").on(table.visitorHash, table.viewDate),
  index("idx_page_views_date").on(table.viewDate),
]);

export type PageView = typeof pageViewsTable.$inferSelect;
export type InsertPageView = typeof pageViewsTable.$inferInsert;
