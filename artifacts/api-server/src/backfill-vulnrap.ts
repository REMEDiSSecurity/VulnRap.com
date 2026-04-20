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

import { db, reportsTable, analysisTracesTable, type PipelineTrace } from "@workspace/db";
import { and, eq, isNull, asc, sql } from "drizzle-orm";
import { analyzeWithEnginesTraced } from "./lib/engines";

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
  let skippedNoText = 0;
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
        // Reports stored with contentMode != "full" have neither column set, so
        // there is no text to re-run the engines against. Leaving them at
        // composite=NULL keeps them on the neutral 50/50 fallback, which is
        // the safest behavior for content we deliberately did not retain.
        skippedNoText++;
        console.log(`[backfill] #${row.id}: skip (no stored text)`);
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
    `[backfill] done: processed=${processed} updated=${updated} skipped_no_text=${skippedNoText} failed=${failed} elapsed=${elapsedMs}ms`,
  );
}

const opts = parseArgs(process.argv);
backfill(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
