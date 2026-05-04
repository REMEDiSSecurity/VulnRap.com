import { pgTable, serial, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const userPreferences = pgTable(
  "user_preferences",
  {
    id: serial("id").primaryKey(),
    identityHash: varchar("identity_hash", { length: 64 }).notNull(),
    key: varchar("key", { length: 64 }).notNull(),
    value: varchar("value", { length: 256 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_user_prefs_identity_key").on(
      table.identityHash,
      table.key,
    ),
  ],
);
