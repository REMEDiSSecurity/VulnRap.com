import { pgTable, serial, integer, varchar, index } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const reportHashesTable = pgTable("report_hashes", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").notNull().references(() => reportsTable.id, { onDelete: "cascade" }),
  hashType: varchar("hash_type", { length: 20 }).notNull(),
  hashValue: varchar("hash_value", { length: 256 }).notNull(),
}, (table) => [
  index("idx_report_hashes_hash_value").on(table.hashValue),
  index("idx_report_hashes_report_id").on(table.reportId),
  index("idx_report_hashes_type_value").on(table.hashType, table.hashValue),
]);

export type ReportHash = typeof reportHashesTable.$inferSelect;
