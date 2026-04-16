import { pgTable, serial, varchar, date, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

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
