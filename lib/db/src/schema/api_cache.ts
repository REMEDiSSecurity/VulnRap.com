import { pgTable, text, serial, timestamp, jsonb, index, varchar } from "drizzle-orm/pg-core";

export const apiCacheTable = pgTable("api_cache", {
  id: serial("id").primaryKey(),
  cacheKey: varchar("cache_key", { length: 512 }).notNull().unique(),
  responseData: jsonb("response_data").notNull(),
  ttlCategory: varchar("ttl_category", { length: 20 }).notNull().default("mutable"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("idx_api_cache_key").on(table.cacheKey),
  index("idx_api_cache_expires").on(table.expiresAt),
  index("idx_api_cache_category").on(table.ttlCategory),
]);

export type ApiCache = typeof apiCacheTable.$inferSelect;
