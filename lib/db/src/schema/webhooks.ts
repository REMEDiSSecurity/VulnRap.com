// Task #673 — Reviewer-managed webhook delivery system.
//
// Reviewers can register a destination URL that will receive a signed
// POST whenever a chosen event fires. v1 only emits `report.scored`
// (after a /api/reports submission completes). Registration, listing,
// and deletion are gated behind CALIBRATION_TOKEN.
//
// `secret_hash` is the SHA-256 of the per-webhook signing secret. The
// raw secret is returned exactly once at creation time so the caller
// can persist it on their side; we never store the plaintext, so a
// rotated/lost secret means re-registering the webhook.
//
// `event_types` is a Postgres text[] today (only `report.scored` is
// supported in v1) so adding new event types in the future does not
// require an ALTER.

import { pgTable, serial, varchar, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const webhooksTable = pgTable(
  "webhooks",
  {
    id: serial("id").primaryKey(),
    url: varchar("url", { length: 1000 }).notNull(),
    secretHash: varchar("secret_hash", { length: 64 }).notNull(),
    eventTypes: text("event_types").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (table) => [
    index("idx_webhooks_created_at").on(table.createdAt),
  ],
);

export type Webhook = typeof webhooksTable.$inferSelect;
export type InsertWebhook = typeof webhooksTable.$inferInsert;
