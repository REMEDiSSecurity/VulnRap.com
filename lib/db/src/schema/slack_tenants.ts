import {
  pgTable,
  text,
  uuid,
  integer,
  timestamp,
  varchar,
  index,
} from "drizzle-orm/pg-core";

/**
 * Hosted "Add to Slack" relay — per-tenant install record.
 *
 * Created by the OAuth callback when a workspace admin clicks the
 * "Add to Slack" button on the (currently unlinked) install page.
 * Holds the encrypted bot token and the per-tenant notify URL token
 * hash. The relay never persists report bodies; this table is the
 * only place tenant credentials live.
 *
 * Threat-model summary (see slack-hosted-relay-design.md):
 *   - bot token at rest = ciphertext only (AES-256-GCM via
 *     SLACK_RELAY_MASTER_KEY). plaintext never logged, never cached.
 *   - notify URL secret at rest = sha256 hash + last 4 chars (UX).
 *     The raw token is shown to the installer once and never again.
 *   - status='active' rows can post to Slack; any other status is a
 *     hard short-circuit at the notify endpoint.
 */
export const slackTenantsTable = pgTable(
  "slack_tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    teamId: text("team_id").notNull(),
    teamName: text("team_name").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name").notNull(),
    botUserId: text("bot_user_id").notNull(),

    botTokenCiphertext: text("bot_token_ciphertext").notNull(),
    botTokenNonce: text("bot_token_nonce").notNull(),
    botTokenTag: text("bot_token_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),

    notifyTokenHash: text("notify_token_hash").notNull().unique(),
    notifyTokenLast4: varchar("notify_token_last4", { length: 8 }).notNull(),

    status: varchar("status", { length: 20 }).notNull().default("active"),
    disabledReason: text("disabled_reason"),
    rateLimitedUntil: timestamp("rate_limited_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    index("slack_tenants_team_idx").on(table.teamId),
    index("slack_tenants_status_idx").on(table.status),
  ],
);

export type SlackTenant = typeof slackTenantsTable.$inferSelect;
export type InsertSlackTenant = typeof slackTenantsTable.$inferInsert;
