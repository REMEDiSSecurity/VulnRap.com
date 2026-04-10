import { pgTable, serial, integer, varchar, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const userFeedbackTable = pgTable("user_feedback", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").references(() => reportsTable.id),
  rating: integer("rating").notNull(),
  helpful: boolean("helpful").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserFeedback = typeof userFeedbackTable.$inferSelect;
export type InsertUserFeedback = typeof userFeedbackTable.$inferInsert;
