import {
  pgTable,
  serial,
  integer,
  varchar,
  jsonb,
  timestamp,
  index,
  real,
} from "drizzle-orm/pg-core";

export interface PipelineStageTiming {
  stage: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
}

export interface PipelineTrace {
  correlationId: string;
  reportId?: number | null;
  totalDurationMs: number;
  stages: PipelineStageTiming[];
  enginesUsed: string[];
  composite: {
    overallScore: number;
    label: string;
    overridesApplied: string[];
    warnings: string[];
  } | null;
  signalsSummary: {
    wordCount: number;
    codeBlockCount: number;
    realUrlCount: number;
    completenessScore: number;
    claimEvidenceRatio: number;
    claimedCwes: string[];
  } | null;
  featureFlags: Record<string, boolean | string>;
  notes: string[];
  /**
   * AVRI substance-engine breakdown captured for post-flip calibration work.
   *
   * Populated only when the trace is produced by the AVRI pipeline
   * (VULNRAP_USE_AVRI=true / forceAvri:true). Carries the raw AVRI score and
   * the legacy substance score that feed the `avriWeight` blend inside
   * `runEngine2Avri` plus the resulting blended score, so a future query
   * against analysis_traces can reconstruct the AVRI-vs-legacy disagreement
   * distribution per family without re-running scoring. The ratio change
   * tracked by task #298 is deferred until ~2 weeks of these enriched traces
   * are on disk; see CHANGELOG v3.9.1.
   *
   * Stays optional so legacy-path traces (and historical rows that predate
   * this field) remain valid against the PipelineTrace shape.
   */
  avriBreakdown?: {
    family: string;
    rawAvriScore: number;
    legacyScore: number;
    blendedScore: number;
  };
}

export const analysisTracesTable = pgTable(
  "analysis_traces",
  {
    id: serial("id").primaryKey(),
    correlationId: varchar("correlation_id", { length: 64 }).notNull(),
    reportId: integer("report_id"),
    totalDurationMs: real("total_duration_ms").notNull(),
    trace: jsonb("trace").$type<PipelineTrace>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_analysis_traces_correlation_id").on(table.correlationId),
    index("idx_analysis_traces_report_id").on(table.reportId),
    index("idx_analysis_traces_created_at").on(table.createdAt),
  ],
);

export type AnalysisTrace = typeof analysisTracesTable.$inferSelect;
