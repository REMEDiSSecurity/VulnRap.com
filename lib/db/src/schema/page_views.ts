import { pgTable, serial, varchar, integer, date, uniqueIndex } from "drizzle-orm/pg-core";

export const pageViewsTable = pgTable("page_views", {
  id: serial("id").primaryKey(),
  path: varchar("path", { length: 255 }).notNull(),
  viewDate: date("view_date", { mode: "string" }).notNull(),
  count: integer("count").notNull().default(1),
}, (table) => [
  uniqueIndex("page_views_path_date_idx").on(table.path, table.viewDate),
]);

export type PageView = typeof pageViewsTable.$inferSelect;
