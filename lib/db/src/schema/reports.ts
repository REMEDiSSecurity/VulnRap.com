import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
  varchar,
  boolean,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // Task #431: optional structured marker IDs (string[]) forwarded from
  // signals that aggregate multiple tells (e.g. impossible_http_response).
  markers?: string[];
  /**
   * Task #435: optional structured payload for richer rendering. Only
   * `hallucination_structural_fabrication` populates this today — the
   * `markers` array is the same shape as `StructuralMarker` from
   * `crash-trace.ts` (id + human-readable description), persisted so the
   * results UI can render one bullet per fabrication tell that fired
   * without re-running detectors.
   */
  context?: { markers?: Array<{ id: string; description: string }> };
}

export interface HumanIndicatorItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

export const reportsTable = pgTable(
  "reports",
  {
    id: serial("id").primaryKey(),
    deleteToken: varchar("delete_token", { length: 64 }).notNull().default(""),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    simhash: varchar("simhash", { length: 128 }).notNull(),
    minhashSignature: jsonb("minhash_signature").notNull().$type<number[]>(),
    lshBuckets: jsonb("lsh_buckets").notNull().$type<string[]>().default([]),
    contentText: text("content_text"),
    redactedText: text("redacted_text"),
    contentMode: varchar("content_mode", { length: 20 })
      .notNull()
      .default("full"),
    slopScore: integer("slop_score").notNull().default(0),
    slopTier: varchar("slop_tier", { length: 30 }).notNull().default("Unknown"),
    qualityScore: integer("quality_score").notNull().default(50),
    confidence: real("confidence").notNull().default(0.5),
    breakdown: jsonb("breakdown").$type<ScoreBreakdown>().default({
      linguistic: 0,
      factual: 0,
      template: 0,
      llm: null,
      quality: 50,
    }),
    evidence: jsonb("evidence").$type<EvidenceItem[]>().default([]),
    similarityMatches: jsonb("similarity_matches")
      .notNull()
      .$type<SimilarityMatch[]>()
      .default([]),
    sectionHashes: jsonb("section_hashes")
      .$type<Record<string, string>>()
      .default({}),
    sectionMatches: jsonb("section_matches")
      .$type<SectionMatch[]>()
      .default([]),
    redactionSummary: jsonb("redaction_summary")
      .$type<RedactionSummary>()
      .default({ totalRedactions: 0, categories: {} }),
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
    quadrant: varchar("quadrant", { length: 30 })
      .notNull()
      .default("WEAK_HUMAN"),
    archetype: varchar("archetype", { length: 30 })
      .notNull()
      .default("REQUEST_DETAILS"),
    humanIndicators: jsonb("human_indicators")
      .$type<HumanIndicatorItem[]>()
      .default([]),
    templateHash: varchar("template_hash", { length: 64 }),
    // Sprint 9 Phase 1: VulnRap multi-engine composite scoring (3 engines).
    // These columns sit alongside the legacy slop_score / authenticity_score /
    // validity_score columns so existing trend dashboards keep populating.
    vulnrapCompositeScore: integer("vulnrap_composite_score"),
    vulnrapCompositeLabel: varchar("vulnrap_composite_label", { length: 32 }),
    vulnrapEngineResults: jsonb("vulnrap_engine_results").$type<unknown>(),
    vulnrapOverridesApplied: jsonb("vulnrap_overrides_applied").$type<
      string[]
    >(),
    vulnrapCorrelationId: varchar("vulnrap_correlation_id", { length: 64 }),
    vulnrapDurationMs: real("vulnrap_duration_ms"),
    // Task #624 — Engine version pinning per report. Holds a semver per
    // engine ({linguistic, substance, cwe, avri, fusion}) captured at
    // write time so reproducibility audits ("was this scored under v3.10
    // or v3.11?") and the score-evolution timeline have an exact pin
    // instead of inferring from git history.
    engineVersions: jsonb("engine_versions").$type<{
      linguistic: string;
      substance: string;
      cwe: string;
      avri: string;
      fusion: string;
    }>(),
    // Sprint 12 — Cached AVRI rubric family for the report. Persisted at write
    // time from the AVRI composite (`vulnrapEngineResults.avri.family`) so the
    // drift dashboard and any per-family filters can read it without
    // re-running classifyReport over contentText for every row.
    avriFamily: varchar("avri_family", { length: 32 }),
    // Cached AVRI Engine 2 fabricated-evidence flags, persisted at write
    // time from `vulnrapEngineResults` so the feed's fabricated-evidence
    // filter hits a partial btree index instead of jsonb_path_exists.
    // Legacy rows default to false until backfill-fabricated-evidence runs.
    fakeRawHttp: boolean("fake_raw_http").notNull().default(false),
    strippedCrashTrace: boolean("stripped_crash_trace")
      .notNull()
      .default(false),
    showInFeed: boolean("show_in_feed").notNull().default(false),
    fileName: varchar("file_name", { length: 255 }),
    fileSize: integer("file_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Lifecycle tracking. Default 'ok' so every existing row remains
    // healthy after the additive migration. Non-'ok' rows are visible
    // to the retry endpoint and to the prune scheduler — see
    // artifacts/api-server/src/lib/reports-prune-scheduler.ts. Values:
    //   'ok'         — scored cleanly, available via GET /api/reports/:id
    //   'failed'     — scoring threw before persisting full result;
    //                  the row exists so the user can retry / inspect
    //   'retry_pending' — set by POST /reports/:id/retry while a
    //                  re-score is in flight
    //   'abandoned'  — failed past max retries; pruned after the
    //                  ABANDONED retention window
    healthStatus: varchar("health_status", { length: 20 })
      .notNull()
      .default("ok"),
    healthFailureClass: varchar("health_failure_class", { length: 40 }),
    healthFailureReason: text("health_failure_reason"),
    healthRetryCount: integer("health_retry_count").notNull().default(0),
    healthLastRetryAt: timestamp("health_last_retry_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    index("idx_reports_content_hash").on(table.contentHash),
    index("idx_reports_simhash").on(table.simhash),
    index("idx_reports_created_at").on(table.createdAt),
    index("idx_reports_show_in_feed").on(table.showInFeed, table.createdAt),
    index("idx_reports_slop_score").on(table.slopScore),
    index("idx_reports_template_hash").on(table.templateHash),
    index("idx_reports_avri_family").on(table.avriFamily),
    // Partial indexes for the AVRI fabricated-evidence feed filter — keyed
    // on (show_in_feed, created_at) since the filter always pairs with the
    // feed gate and the default sort is created_at desc.
    index("idx_reports_fake_raw_http")
      .on(table.showInFeed, table.createdAt)
      .where(sql`${table.fakeRawHttp} = true`),
    index("idx_reports_stripped_crash_trace")
      .on(table.showInFeed, table.createdAt)
      .where(sql`${table.strippedCrashTrace} = true`),
    index("idx_reports_lsh_buckets").using("gin", table.lshBuckets),
    // Task #726 — Performance audit indexes. Each was added in
    // 0003_perf_audit_indexes.sql; the schema declarations below keep
    // drizzle-kit's introspection diff clean so a future `drizzle-kit
    // generate` doesn't recreate them.
    index("idx_reports_delete_token")
      .on(table.deleteToken)
      .where(sql`${table.deleteToken} <> ''`),
    index("idx_reports_content_mode_similarity")
      .on(table.contentMode)
      .where(sql`${table.contentMode} <> 'full'`),
    index("idx_reports_vulnrap_composite_null")
      .on(table.createdAt)
      .where(sql`${table.vulnrapCompositeScore} IS NULL`),
    // Partial index: the health columns are 'ok' / 0 for the vast
    // majority of rows. The retry queue + prune scheduler scan only
    // unhealthy rows ordered by created_at, so an index on a tiny
    // subset is far cheaper than a btree on the whole column.
    index("idx_reports_health_unhealthy")
      .on(table.createdAt)
      .where(sql`${table.healthStatus} <> 'ok'`),
  ],
);

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
