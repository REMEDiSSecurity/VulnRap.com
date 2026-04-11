import { pgTable, text, serial, integer, timestamp, jsonb, index, varchar, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface RedactionSummary {
  totalRedactions: number;
  categories: Record<string, number>;
}

export const reportsTable = pgTable("reports", {
  id: serial("id").primaryKey(),
  deleteToken: varchar("delete_token", { length: 64 }).notNull().default(""),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  simhash: varchar("simhash", { length: 128 }).notNull(),
  minhashSignature: jsonb("minhash_signature").notNull().$type<number[]>(),
  lshBuckets: jsonb("lsh_buckets").notNull().$type<string[]>().default([]),
  contentText: text("content_text"),
  redactedText: text("redacted_text"),
  contentMode: varchar("content_mode", { length: 20 }).notNull().default("full"),
  slopScore: integer("slop_score").notNull().default(0),
  slopTier: varchar("slop_tier", { length: 30 }).notNull().default("Unknown"),
  similarityMatches: jsonb("similarity_matches").notNull().$type<SimilarityMatch[]>().default([]),
  sectionHashes: jsonb("section_hashes").$type<Record<string, string>>().default({}),
  sectionMatches: jsonb("section_matches").$type<SectionMatch[]>().default([]),
  redactionSummary: jsonb("redaction_summary").$type<RedactionSummary>().default({ totalRedactions: 0, categories: {} }),
  feedback: jsonb("feedback").notNull().$type<string[]>().default([]),
  showInFeed: boolean("show_in_feed").notNull().default(false),
  fileName: varchar("file_name", { length: 255 }),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_reports_content_hash").on(table.contentHash),
  index("idx_reports_simhash").on(table.simhash),
  index("idx_reports_created_at").on(table.createdAt),
  index("idx_reports_show_in_feed").on(table.showInFeed, table.createdAt),
  index("idx_reports_slop_score").on(table.slopScore),
]);

export interface SimilarityMatch {
  reportId: number;
  similarity: number;
  matchType: string;
}

export interface SectionMatch {
  sectionTitle: string;
  matchedReportId: number;
  matchedSectionTitle: string;
  similarity: number;
}

export const insertReportSchema = createInsertSchema(reportsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reportsTable.$inferSelect;
