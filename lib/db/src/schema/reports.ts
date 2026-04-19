import { pgTable, text, serial, integer, timestamp, jsonb, index, varchar, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface RedactionSummary {
  totalRedactions: number;
  categories: Record<string, number>;
}

export interface ScoreBreakdown {
  linguistic: number;
  factual: number;
  template: number;
  llm: number | null;
  quality: number;
  llmUsed?: boolean;
  redactionApplied?: boolean;
}

export interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

export interface HumanIndicatorItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
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
  qualityScore: integer("quality_score").notNull().default(50),
  confidence: real("confidence").notNull().default(0.5),
  breakdown: jsonb("breakdown").$type<ScoreBreakdown>().default({ linguistic: 0, factual: 0, template: 0, llm: null, quality: 50 }),
  evidence: jsonb("evidence").$type<EvidenceItem[]>().default([]),
  similarityMatches: jsonb("similarity_matches").notNull().$type<SimilarityMatch[]>().default([]),
  sectionHashes: jsonb("section_hashes").$type<Record<string, string>>().default({}),
  sectionMatches: jsonb("section_matches").$type<SectionMatch[]>().default([]),
  redactionSummary: jsonb("redaction_summary").$type<RedactionSummary>().default({ totalRedactions: 0, categories: {} }),
  feedback: jsonb("feedback").notNull().$type<string[]>().default([]),
  llmSlopScore: integer("llm_slop_score"),
  llmFeedback: jsonb("llm_feedback").$type<string[]>(),
  llmBreakdown: jsonb("llm_breakdown").$type<{
    claimSpecificity?: number;
    evidenceQuality?: number;
    internalConsistency?: number;
    hallucinationSignals?: number;
    validityScore?: number;
    redFlags?: string[];
    greenFlags?: string[];
    verdict?: string;
    specificity?: number;
    originality?: number;
    voice?: number;
    coherence?: number;
    hallucination?: number;
  }>(),
  authenticityScore: integer("authenticity_score").notNull().default(0),
  validityScore: integer("validity_score").notNull().default(0),
  quadrant: varchar("quadrant", { length: 30 }).notNull().default("WEAK_HUMAN"),
  archetype: varchar("archetype", { length: 30 }).notNull().default("REQUEST_DETAILS"),
  humanIndicators: jsonb("human_indicators").$type<HumanIndicatorItem[]>().default([]),
  templateHash: varchar("template_hash", { length: 64 }),
  // Sprint 9 Phase 1: VulnRap multi-engine composite scoring (3 engines).
  // These columns sit alongside the legacy slop_score / authenticity_score /
  // validity_score columns so existing trend dashboards keep populating.
  vulnrapCompositeScore: integer("vulnrap_composite_score"),
  vulnrapCompositeLabel: varchar("vulnrap_composite_label", { length: 32 }),
  vulnrapEngineResults: jsonb("vulnrap_engine_results").$type<unknown>(),
  vulnrapOverridesApplied: jsonb("vulnrap_overrides_applied").$type<string[]>(),
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
  index("idx_reports_template_hash").on(table.templateHash),
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
