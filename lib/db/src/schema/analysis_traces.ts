import { pgTable, serial, integer, varchar, jsonb, timestamp, index, real } from "drizzle-orm/pg-core";

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
}

export const analysisTracesTable = pgTable("analysis_traces", {
  id: serial("id").primaryKey(),
  correlationId: varchar("correlation_id", { length: 64 }).notNull(),
  reportId: integer("report_id"),
  totalDurationMs: real("total_duration_ms").notNull(),
  trace: jsonb("trace").$type<PipelineTrace>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_analysis_traces_correlation_id").on(table.correlationId),
  index("idx_analysis_traces_report_id").on(table.reportId),
  index("idx_analysis_traces_created_at").on(table.createdAt),
]);

export type AnalysisTrace = typeof analysisTracesTable.$inferSelect;
