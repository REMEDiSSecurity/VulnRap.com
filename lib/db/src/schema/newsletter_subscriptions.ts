import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const newsletterSubscriptionsTable = pgTable(
  "newsletter_subscriptions",
  {
    id: serial("id").primaryKey(),
    emailHmac: varchar("email_hmac", { length: 64 }).notNull(),
    // Task #733 — Welcome / unsubscribe flow.
    //
    //  * `confirmedAt` is set to `createdAt` immediately when single
    //    opt-in is in effect (default), and stays NULL until the user
    //    clicks the confirm link when NEWSLETTER_DOUBLE_OPT_IN=true.
    //  * `tokenHash` stores SHA-256(token) where `token` is a random
    //    32-byte hex string handed out exactly once via the welcome /
    //    confirm email. Hashing means a DB compromise does not yield
    //    valid unsubscribe / confirm URLs. The unique index is partial
    //    so multiple rows with NULL tokens (legacy pre-#733
    //    subscribers) coexist without collision.
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    tokenHash: varchar("token_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_newsletter_subscriptions_email_hmac").on(table.emailHmac),
    uniqueIndex("uq_newsletter_subscriptions_token_hash")
      .on(table.tokenHash)
      .where(sql`"token_hash" IS NOT NULL`),
    index("idx_newsletter_subscriptions_created_at").on(table.createdAt),
  ],
);

export type NewsletterSubscription =
  typeof newsletterSubscriptionsTable.$inferSelect;
export type InsertNewsletterSubscription =
  typeof newsletterSubscriptionsTable.$inferInsert;
