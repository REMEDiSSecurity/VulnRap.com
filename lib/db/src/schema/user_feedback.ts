import { pgTable, serial, integer, varchar, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const userFeedbackTable = pgTable("user_feedback", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").references(() => reportsTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  helpful: boolean("helpful").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #640 — deterministic 20% holdout flag (set from `(abs(hashtext(id::text)) % 5) = 0`).
  // Holdout rows are excluded from calibration suggestions so the
  // /feedback/holdout-eval endpoint can report honest precision/recall
  // computed from data the suggestion engine never saw.
  isHoldout: boolean("is_holdout").notNull().default(false),
}, (table) => [
  index("idx_user_feedback_report_id").on(table.reportId),
  index("idx_user_feedback_is_holdout").on(table.isHoldout),
]);

export type UserFeedback = typeof userFeedbackTable.$inferSelect;
export type InsertUserFeedback = typeof userFeedbackTable.$inferInsert;
