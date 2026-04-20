// Maintenance script: backfill v3.6.0 vulnrap composite + engine results on
// reports analyzed before v3.6.0. Reports stored before the new composite
// existed have vulnrapCompositeScore IS NULL, which makes
// buildV36TriageContext return undefined and the matrix triage falls back to
// the neutral 50/50 baseline. This script re-runs analyzeWithEnginesTraced
// over the redacted text we already persisted and writes the composite,
// engine results, label, overrides, correlation id, duration, and the
// pipeline trace row, so subsequent /reports/:id and /reports/check responses
// get matrix-driven recommendations for those legacy reports.
//
// Usage (from artifacts/api-server):
//   pnpm run build && node --enable-source-maps ./dist/backfill-vulnrap.mjs
// Flags:
//   --dry-run        Report what would change without writing.
//   --limit=N        Cap how many reports are processed in this run.
//   --batch-size=N   Page size when scanning the table (default 50).

import {
  db,
  reportsTable,
  analysisTracesTable,
  type PipelineTrace,
  type EvidenceItem,
  type HumanIndicatorItem,
  type ScoreBreakdown,
} from "@workspace/db";
import { and, eq, isNull, asc, sql } from "drizzle-orm";
import crypto from "crypto";
import {
  analyzeWithEnginesTraced,
  computeComposite,
  type EngineResult,
  type CompositeResult,
} from "./lib/engines";

// Evidence types that count as "strong" for the v3.6.0 triage matrix's
// strongEvidenceCount input. Mirrors the strength multipliers in
// extractors.ts (>=1.5x), so a reconstructed report's matrix gating matches
// what a freshly-analyzed report would receive.
const STRONG_EVIDENCE_TYPES = new Set<string>([
  "CRASH_OUTPUT",
  "CODE_DIFF",
  "STACK_TRACE",
  "SHELL_COMMAND",
  "HTTP_REQUEST",
  "MEMORY_ADDRESS",
]);

interface CachedSignals {
  slopScore: number;
  qualityScore: number;
  validityScore: number;
  authenticityScore: number;
  breakdown: ScoreBreakdown | null;
  evidence: EvidenceItem[] | null;
  humanIndicators: HumanIndicatorItem[] | null;
}

// Reconstruct a CompositeResult for legacy reports stored without raw text.
// We can't re-run the engines (the pipeline has nothing to extract from), but
// we *do* have the v3.5.0 cached signals: slop / authenticity / validity /
// quality scores, the evidence list, and the score breakdown. This function
// maps them onto the 3-engine shape so buildV36TriageContext can lift the
// report off the neutral 50/50 matrix fallback. The result is explicitly
// flagged as reconstructed in every signalBreakdown so reviewers can tell it
// apart from a real engine run.
function reconstructFromCachedSignals(s: CachedSignals): CompositeResult {
  const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

  // Engine 1 — AI authorship (higher = more AI = bad). The legacy slopScore
  // is a direct proxy: it was derived in v3.5.0 by the same linguistic /
  // template / quality breakdown the new Engine 1 also feeds on.
  const aiScore = Math.round(clamp(s.slopScore));
  const e1: EngineResult = {
    engine: "AI Authorship Detector",
    score: aiScore,
    verdict: aiScore <= 25 ? "GREEN" : aiScore <= 74 ? "YELLOW" : "RED",
    confidence: "LOW",
    triggeredIndicators: [
      {
        signal: "RECONSTRUCTED_FROM_CACHE",
        value: aiScore,
        strength: "LOW",
        explanation:
          "Engine 1 score reconstructed from cached slopScore; the original report text was not retained for re-analysis.",
      },
    ],
    signalBreakdown: {
      source: "reconstructed",
      legacySlopScore: s.slopScore,
      legacyBreakdown: s.breakdown ?? null,
    },
    note: "Reconstructed from cached slopScore (legacy report stored without raw text).",
  };

  // Engine 2 — Technical Substance. Blend cached validity + quality, then add
  // an evidence-strength bonus from the persisted EvidenceItem list. The
  // strongCount sub-field is the input the v3.6.0 triage matrix actually
  // reads, so we surface it in the same signalBreakdown shape as a live run.
  const validity = clamp(s.validityScore);
  const quality = clamp(s.qualityScore);
  const evidenceItems = s.evidence ?? [];
  const strongCount = evidenceItems.filter(e => STRONG_EVIDENCE_TYPES.has(e.type)).length;
  const evidenceWeightSum = evidenceItems.reduce((a, e) => a + (e.weight || 0), 0);
  const evidenceBoost = Math.max(-8, Math.min(15, evidenceWeightSum / 4));
  const e2Score = Math.round(clamp(validity * 0.6 + quality * 0.4 + evidenceBoost));
  const e2: EngineResult = {
    engine: "Technical Substance Analyzer",
    score: e2Score,
    verdict: e2Score >= 61 ? "GREEN" : e2Score >= 41 ? "YELLOW" : "RED",
    confidence: "LOW",
    triggeredIndicators: [
      {
        signal: "RECONSTRUCTED_FROM_CACHE",
        value: e2Score,
        strength: "LOW",
        explanation:
          `Engine 2 score reconstructed from cached validityScore=${validity}, qualityScore=${quality}, ` +
          `${evidenceItems.length} evidence item(s) (${strongCount} strong).`,
      },
    ],
    signalBreakdown: {
      source: "reconstructed",
      legacyValidityScore: s.validityScore,
      legacyQualityScore: s.qualityScore,
      legacyAuthenticityScore: s.authenticityScore,
      humanIndicatorCount: s.humanIndicators?.length ?? 0,
      evidenceStrength: {
        bonus: Number(evidenceBoost.toFixed(1)),
        strongCount,
        signalCount: evidenceItems.length,
      },
    },
    note:
      "Reconstructed from cached validity/quality scores + evidence list (legacy report stored without raw text).",
  };

  // Engine 3 — CWE coherence. We don't persist claimedCwes for these reports,
  // so leave the score at neutral 50 with LOW confidence. This matches the
  // "no CWE claimed" path of the live engine but tagged as reconstructed.
  const e3: EngineResult = {
    engine: "CWE Coherence Checker",
    score: 50,
    verdict: "YELLOW",
    confidence: "LOW",
    triggeredIndicators: [
      {
        signal: "NO_CACHED_CWE",
        value: false,
        strength: "LOW",
        explanation:
          "No CWE claim was retained in cache for this legacy report; using neutral 50.",
      },
    ],
    signalBreakdown: {
      source: "reconstructed",
      claimedCWEs: [],
    },
    note: "CWE coherence neutralized (50) — claimed CWEs were not retained in cache.",
  };

  const composite = computeComposite([e1, e2, e3]);
  composite.warnings = [
    ...composite.warnings,
    "Composite reconstructed from cached v3.5.0 signals; raw report text was not retained.",
  ];
  return composite;
}

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[backfill] ${flag} must be a positive integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dryRun: false, limit: null, batchSize: 50 };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--limit=")) opts.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    else if (arg.startsWith("--batch-size=")) opts.batchSize = parsePositiveInt(arg.slice("--batch-size=".length), "--batch-size");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: backfill-vulnrap [--dry-run] [--limit=N] [--batch-size=N]");
      process.exit(0);
    } else {
      console.error(`[backfill] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function backfill(opts: CliOpts): Promise<void> {
  const startedAt = Date.now();

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(isNull(reportsTable.vulnrapCompositeScore));
  const totalLegacy = totalRow[0]?.n ?? 0;
  console.log(`[backfill] legacy reports without composite: ${totalLegacy}`);
  if (opts.dryRun) console.log("[backfill] dry-run mode: no writes will be performed");

  let processed = 0;
  let updated = 0;
  let reconstructed = 0;
  let skippedNoSignals = 0;
  let failed = 0;
  let lastId = 0;

  while (true) {
    if (opts.limit !== null && processed >= opts.limit) break;

    const remaining = opts.limit !== null ? opts.limit - processed : opts.batchSize;
    const pageSize = Math.min(opts.batchSize, remaining);

    const rows = await db
      .select({
        id: reportsTable.id,
        redactedText: reportsTable.redactedText,
        contentText: reportsTable.contentText,
        slopScore: reportsTable.slopScore,
        qualityScore: reportsTable.qualityScore,
        validityScore: reportsTable.validityScore,
        authenticityScore: reportsTable.authenticityScore,
        breakdown: reportsTable.breakdown,
        evidence: reportsTable.evidence,
        humanIndicators: reportsTable.humanIndicators,
      })
      .from(reportsTable)
      .where(
        and(
          isNull(reportsTable.vulnrapCompositeScore),
          sql`${reportsTable.id} > ${lastId}`,
        ),
      )
      .orderBy(asc(reportsTable.id))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      processed++;

      const text = row.redactedText ?? row.contentText;
      if (!text) {
        // Reports stored with contentMode != "full" have neither column set,
        // so the engine pipeline has nothing to re-analyze. Instead of
        // leaving them stuck on the neutral 50/50 matrix fallback, rebuild
        // an approximate composite from the v3.5.0 cached signals (slop,
        // validity, quality, evidence list) we *did* persist for every row.
        // Reports with no usable cached signals at all are still skipped
        // and counted under skipped_no_signals.
        const hasAnySignal =
          row.slopScore > 0 ||
          row.qualityScore !== 50 ||
          row.validityScore > 0 ||
          row.authenticityScore > 0 ||
          (row.evidence?.length ?? 0) > 0 ||
          (row.humanIndicators?.length ?? 0) > 0;
        if (!hasAnySignal) {
          skippedNoSignals++;
          console.log(
            `[backfill] #${row.id}: skip (no stored text and no cached signals to reconstruct from)`,
          );
          continue;
        }

        const composite = reconstructFromCachedSignals({
          slopScore: row.slopScore,
          qualityScore: row.qualityScore,
          validityScore: row.validityScore,
          authenticityScore: row.authenticityScore,
          breakdown: row.breakdown,
          evidence: row.evidence,
          humanIndicators: row.humanIndicators,
        });
        const engineResultsBlob = {
          engines: composite.engineResults,
          compositeBreakdown: composite.compositeBreakdown,
          warnings: composite.warnings,
          engineCount: composite.engineCount,
          reconstructed: true,
        };

        if (opts.dryRun) {
          console.log(
            `[backfill] #${row.id}: would reconstruct composite=${composite.overallScore} (${composite.label}) from cached signals`,
          );
          reconstructed++;
          continue;
        }

        // Synthetic correlation id makes reconstructed rows easy to find in
        // logs / analytics; we deliberately do NOT insert an analysis_traces
        // row because no real pipeline ran and the trace shape requires
        // stage timings we don't have.
        const correlationId = `recon-${crypto.randomUUID()}`;
        const wrote = await db
          .update(reportsTable)
          .set({
            vulnrapCompositeScore: composite.overallScore,
            vulnrapCompositeLabel: composite.label,
            vulnrapEngineResults: engineResultsBlob,
            vulnrapOverridesApplied: composite.overridesApplied,
            vulnrapCorrelationId: correlationId,
            vulnrapDurationMs: 0,
          })
          .where(
            and(
              eq(reportsTable.id, row.id),
              isNull(reportsTable.vulnrapCompositeScore),
            ),
          )
          .returning({ id: reportsTable.id });

        if (wrote.length > 0) {
          reconstructed++;
          console.log(
            `[backfill] #${row.id}: reconstructed composite=${composite.overallScore} (${composite.label}) from cached signals`,
          );
        } else {
          console.log(`[backfill] #${row.id}: skip (composite populated concurrently)`);
        }
        continue;
      }

      try {
        const { composite, trace } = analyzeWithEnginesTraced(text, { reportId: row.id });
        const engineResultsBlob = {
          engines: composite.engineResults,
          compositeBreakdown: composite.compositeBreakdown,
          warnings: composite.warnings,
          engineCount: composite.engineCount,
        };

        if (opts.dryRun) {
          console.log(
            `[backfill] #${row.id}: would set composite=${composite.overallScore} (${composite.label}), engines=${composite.engineResults.length}`,
          );
          updated++;
          continue;
        }

        const persistedTrace: PipelineTrace = { ...trace, reportId: row.id };

        const wrote = await db.transaction(async (tx) => {
          const updateResult = await tx
            .update(reportsTable)
            .set({
              vulnrapCompositeScore: composite.overallScore,
              vulnrapCompositeLabel: composite.label,
              vulnrapEngineResults: engineResultsBlob,
              vulnrapOverridesApplied: composite.overridesApplied,
              vulnrapCorrelationId: persistedTrace.correlationId,
              vulnrapDurationMs: persistedTrace.totalDurationMs,
            })
            .where(
              and(
                eq(reportsTable.id, row.id),
                // Concurrency guard: do not overwrite a row that another process
                // (e.g. a re-check) populated between the SELECT and UPDATE.
                isNull(reportsTable.vulnrapCompositeScore),
              ),
            )
            .returning({ id: reportsTable.id });

          // Only persist the trace when the UPDATE actually claimed the row,
          // otherwise a concurrent re-check already wrote its own composite +
          // trace and ours would be an orphan whose correlation id is not
          // referenced by reports.vulnrap_correlation_id.
          if (updateResult.length === 0) return false;

          await tx.insert(analysisTracesTable).values({
            correlationId: persistedTrace.correlationId,
            reportId: row.id,
            totalDurationMs: persistedTrace.totalDurationMs,
            trace: persistedTrace,
          });
          return true;
        });

        if (wrote) {
          updated++;
          console.log(
            `[backfill] #${row.id}: composite=${composite.overallScore} (${composite.label}) duration=${persistedTrace.totalDurationMs}ms`,
          );
        } else {
          console.log(`[backfill] #${row.id}: skip (composite populated concurrently)`);
        }
      } catch (err) {
        failed++;
        console.error(`[backfill] #${row.id}: failed`, err);
      }

      if (opts.limit !== null && processed >= opts.limit) break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill] done: processed=${processed} updated=${updated} reconstructed=${reconstructed} skipped_no_signals=${skippedNoSignals} failed=${failed} elapsed=${elapsedMs}ms`,
  );
}

const opts = parseArgs(process.argv);
backfill(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
