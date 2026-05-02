import { pgTable, serial, varchar, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const newsletterSubscriptionsTable = pgTable("newsletter_subscriptions", {
  id: serial("id").primaryKey(),
  emailHmac: varchar("email_hmac", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_newsletter_subscriptions_email_hmac").on(table.emailHmac),
  index("idx_newsletter_subscriptions_created_at").on(table.createdAt),
]);

export type NewsletterSubscription = typeof newsletterSubscriptionsTable.$inferSelect;
export type InsertNewsletterSubscription = typeof newsletterSubscriptionsTable.$inferInsert;
