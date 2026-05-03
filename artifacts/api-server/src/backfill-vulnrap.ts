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
// Both branches (engine re-run + cached-signal reconstruction) feed the
// report text into `computeComposite` so the v3.6.0 fabricated-evidence
// composite penalty fires for legacy reports during a re-backfill. The
// engine path forwards persisted redactedText/contentText; the
// reconstruction path rebuilds a synthetic trigger text from the cached
// `hallucination_*` evidence entries so legacy reports stored without raw
// text still get rescored when the cached signals warrant it.
//
// Usage (from artifacts/api-server):
//   pnpm run build && node --enable-source-maps ./dist/backfill-vulnrap.mjs
// Flags:
//   --dry-run        Report what would change without writing.
//   --limit=N        Cap how many reports are processed in this run.
//   --batch-size=N   Page size when scanning the table (default 50).
//   --rescore        Also process rows that already have a composite,
//                    rewriting them with a fresh engine run (or a fresh
//                    reconstruction). Without this flag the script keeps
//                    its NULL-only behavior so scheduled jobs are
//                    unaffected.
//   --only-with-cached-hallucination
//                    Restrict the scan to rows whose `evidence` jsonb
//                    contains `hallucination_*` entries. Pairs with
//                    --rescore to re-rate already-scored fabricated
//                    legacy reports without pointlessly rebuilding traces
//                    for clean ones.

import crypto from "crypto";
import { fileURLToPath } from "url";
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
import {
  analyzeWithEnginesTraced,
  computeComposite,
  type EngineResult,
  type CompositeResult,
} from "./lib/engines";
import {
  reconstructHallucinationTriggerText,
  parseArgs,
  chooseConcurrencyGuard,
  buildBackfillRescoreAuditEntry,
  appendRescoreHistory,
  buildRescoreCandidateFilters,
  CliExit,
  type CliOpts,
  type BackfillStats,
  type ConcurrencyGuard,
} from "./backfill-vulnrap-helpers";
import { getCurrentEngineVersions } from "./lib/engine-versions";
import type { SQL } from "drizzle-orm";

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
//
// Task #193 — when the cached evidence list contains `hallucination_*`
// entries (persisted by score-fusion at original-analysis time), we
// reconstruct a synthetic trigger text from those signals and pass it to
// `computeComposite` so the v3.6.0 fabricated-evidence composite penalty
// re-fires for legacy fabricated reports during a re-backfill.
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
  const strongCount = evidenceItems.filter((e) =>
    STRONG_EVIDENCE_TYPES.has(e.type),
  ).length;
  const evidenceWeightSum = evidenceItems.reduce(
    (a, e) => a + (e.weight || 0),
    0,
  );
  const evidenceBoost = Math.max(-8, Math.min(15, evidenceWeightSum / 4));
  const e2Score = Math.round(
    clamp(validity * 0.6 + quality * 0.4 + evidenceBoost),
  );
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
    note: "Reconstructed from cached validity/quality scores + evidence list (legacy report stored without raw text).",
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

  // Task #193 — pass a synthetic hallucination-trigger text rebuilt from the
  // cached `hallucination_*` evidence entries so the v3.6.0 fabricated-
  // evidence composite penalty fires for legacy fabricated reports too.
  // Reports with no cached hallucination signals get an empty string, which
  // computeComposite treats as no-text (no override) — same as before.
  const triggerText = reconstructHallucinationTriggerText(s.evidence);
  const composite = computeComposite(
    [e1, e2, e3],
    triggerText.length > 0 ? triggerText : undefined,
  );
  composite.warnings = [
    ...composite.warnings,
    triggerText.length > 0
      ? "Composite reconstructed from cached v3.5.0 signals; hallucination penalty re-derived from cached fabrication signals."
      : "Composite reconstructed from cached v3.5.0 signals; no cached fabrication signals to re-evaluate.",
  ];
  return composite;
}

// Drizzle SQL fragment for the per-row UPDATE WHERE clause; the choice
// itself lives in chooseConcurrencyGuard so it stays unit-testable.
function guardToSql(guard: ConcurrencyGuard): SQL {
  switch (guard.kind) {
    case "isNullComposite":
      return isNull(reportsTable.vulnrapCompositeScore) as SQL;
    case "matchCorrelationId":
      return eq(reportsTable.vulnrapCorrelationId, guard.correlationId) as SQL;
    case "isNullCorrelationAndScore":
      // Already-scored legacy row with no correlation id: pin the UPDATE
      // to (composite still equals what we read AND correlation id still
      // null) so a concurrent re-check that meanwhile populated either
      // field is left alone.
      return and(
        eq(reportsTable.vulnrapCompositeScore, guard.compositeScore),
        isNull(reportsTable.vulnrapCorrelationId),
      ) as SQL;
  }
}

export async function backfill(opts: CliOpts): Promise<BackfillStats> {
  const startedAt = Date.now();
  // Wall-clock deadline (Task #388) — when set, the inner loop bails after
  // the current row finishes so the recurring rescore scheduler can't
  // saturate the DB if the candidate set ever blows up. `null` = no
  // deadline, preserving the original "run to completion" semantics for
  // operator-driven invocations.
  const deadlineAt =
    opts.maxRuntimeMs !== null ? startedAt + opts.maxRuntimeMs : null;
  let deadlineReached = false;

  // EXISTS over the evidence jsonb array matches any element whose `type`
  // starts with `hallucination_` — exactly the rows the v3.6.0 fabricated-
  // evidence composite override can re-penalize. coalesce handles legacy
  // rows where evidence is NULL. The predicate logic is built in the
  // helpers module so the integration test can exercise the same SQL
  // against a real Postgres test schema (see backfill-vulnrap-rescore-
  // filters.test.ts).
  const baseFilters = buildRescoreCandidateFilters(opts);

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(and(...baseFilters));
  const totalCandidates = totalRow[0]?.n ?? 0;
  const scopeLabel = opts.rescore
    ? opts.onlyWithCachedHallucination
      ? "candidate reports (rescore + cached-hallucination only)"
      : "candidate reports (rescore: includes already-scored rows)"
    : opts.onlyWithCachedHallucination
      ? "legacy reports without composite (with cached hallucination signals)"
      : "legacy reports without composite";
  console.log(`[backfill] ${scopeLabel}: ${totalCandidates}`);
  if (opts.dryRun)
    console.log("[backfill] dry-run mode: no writes will be performed");

  let processed = 0;
  let updated = 0;
  let reconstructed = 0;
  let rescoredUpdated = 0;
  let rescoredReconstructed = 0;
  let skippedNoSignals = 0;
  let skippedConcurrent = 0;
  let failed = 0;
  let lastId = 0;

  while (true) {
    if (opts.limit !== null && processed >= opts.limit) break;
    if (deadlineAt !== null && Date.now() >= deadlineAt) {
      deadlineReached = true;
      console.log(
        `[backfill] max-runtime budget (${opts.maxRuntimeMs}ms) reached before next page; stopping`,
      );
      break;
    }

    const remaining =
      opts.limit !== null ? opts.limit - processed : opts.batchSize;
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
        // Used by chooseConcurrencyGuard and before/after logging when the
        // row is being rescored.
        priorCompositeScore: reportsTable.vulnrapCompositeScore,
        priorCompositeLabel: reportsTable.vulnrapCompositeLabel,
        priorCorrelationId: reportsTable.vulnrapCorrelationId,
        // Task #389 — read the prior engine-results blob so we can carry
        // any existing rescoreHistory forward when this row is rescored
        // again. Legacy/unrescored rows just have undefined here.
        priorEngineResults: reportsTable.vulnrapEngineResults,
      })
      .from(reportsTable)
      .where(and(...baseFilters, sql`${reportsTable.id} > ${lastId}`))
      .orderBy(asc(reportsTable.id))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      processed++;

      const wasRescore = row.priorCompositeScore !== null;
      const beforeLabel = wasRescore
        ? `${row.priorCompositeScore} (${row.priorCompositeLabel ?? "?"})`
        : null;
      const concurrencyGuard = guardToSql(
        chooseConcurrencyGuard(row.priorCompositeScore, row.priorCorrelationId),
      );

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
        // Task #389 — synthesize the new correlation id up-front so the
        // audit entry below (and the UPDATE below it) can both reference
        // the same value, and reviewers can join the audit row to
        // diagnostics by correlation id later.
        const correlationId = `recon-${crypto.randomUUID()}`;
        // Task #389 — when this run is rewriting an already-scored row,
        // append a "backfill-rescore" audit entry to the blob's
        // rescoreHistory so the row itself records the prior composite +
        // label + correlation id and the source/timestamp of this
        // rewrite. First-time scores (wasRescore=false) leave the field
        // off so unrescored rows stay untouched.
        const rescoreHistory = wasRescore
          ? appendRescoreHistory(
              row.priorEngineResults,
              buildBackfillRescoreAuditEntry({
                mode: "reconstruction",
                priorCompositeScore: row.priorCompositeScore as number,
                priorCompositeLabel: row.priorCompositeLabel,
                priorCorrelationId: row.priorCorrelationId,
                newCompositeScore: composite.overallScore,
                newCompositeLabel: composite.label,
                newCorrelationId: correlationId,
              }),
            )
          : undefined;
        const engineResultsBlob = {
          engines: composite.engineResults,
          compositeBreakdown: composite.compositeBreakdown,
          warnings: composite.warnings,
          engineCount: composite.engineCount,
          reconstructed: true,
          ...(rescoreHistory ? { rescoreHistory } : {}),
        };

        if (opts.dryRun) {
          if (wasRescore) {
            console.log(
              `[backfill] #${row.id}: would rescore composite ${beforeLabel} → ${composite.overallScore} (${composite.label}) from cached signals`,
            );
            rescoredReconstructed++;
          } else {
            console.log(
              `[backfill] #${row.id}: would reconstruct composite=${composite.overallScore} (${composite.label}) from cached signals`,
            );
            reconstructed++;
          }
          continue;
        }

        // Synthetic correlation id (built above so the rescoreHistory entry
        // and the row's vulnrap_correlation_id reference the same value)
        // makes reconstructed rows easy to find in logs / analytics; we
        // deliberately do NOT insert an analysis_traces row because no
        // real pipeline ran and the trace shape requires stage timings
        // we don't have.
        const wrote = await db
          .update(reportsTable)
          .set({
            vulnrapCompositeScore: composite.overallScore,
            vulnrapCompositeLabel: composite.label,
            vulnrapEngineResults: engineResultsBlob,
            vulnrapOverridesApplied: composite.overridesApplied,
            vulnrapCorrelationId: correlationId,
            vulnrapDurationMs: 0,
            engineVersions: getCurrentEngineVersions(),
          })
          .where(and(eq(reportsTable.id, row.id), concurrencyGuard))
          .returning({ id: reportsTable.id });

        if (wrote.length > 0) {
          if (wasRescore) {
            rescoredReconstructed++;
            console.log(
              `[backfill] #${row.id}: rescored composite ${beforeLabel} → ${composite.overallScore} (${composite.label}) from cached signals`,
            );
          } else {
            reconstructed++;
            console.log(
              `[backfill] #${row.id}: reconstructed composite=${composite.overallScore} (${composite.label}) from cached signals`,
            );
          }
        } else {
          skippedConcurrent++;
          console.log(
            `[backfill] #${row.id}: skip (composite changed concurrently)`,
          );
        }
        continue;
      }

      try {
        const { composite, trace } = analyzeWithEnginesTraced(text, {
          reportId: row.id,
        });
        // Task #389 — rescored rows get an audit entry on the engine-
        // results blob so the row records the prior composite + label +
        // correlation id, the source ("backfill-rescore"), and the
        // timestamp / new correlation id for this rewrite. First-time
        // scores leave the field off so unrescored rows stay untouched.
        const rescoreHistory = wasRescore
          ? appendRescoreHistory(
              row.priorEngineResults,
              buildBackfillRescoreAuditEntry({
                mode: "engine",
                priorCompositeScore: row.priorCompositeScore as number,
                priorCompositeLabel: row.priorCompositeLabel,
                priorCorrelationId: row.priorCorrelationId,
                newCompositeScore: composite.overallScore,
                newCompositeLabel: composite.label,
                newCorrelationId: trace.correlationId,
              }),
            )
          : undefined;
        const engineResultsBlob = {
          engines: composite.engineResults,
          compositeBreakdown: composite.compositeBreakdown,
          warnings: composite.warnings,
          engineCount: composite.engineCount,
          ...(rescoreHistory ? { rescoreHistory } : {}),
        };

        if (opts.dryRun) {
          if (wasRescore) {
            console.log(
              `[backfill] #${row.id}: would rescore composite ${beforeLabel} → ${composite.overallScore} (${composite.label}), engines=${composite.engineResults.length}`,
            );
            rescoredUpdated++;
          } else {
            console.log(
              `[backfill] #${row.id}: would set composite=${composite.overallScore} (${composite.label}), engines=${composite.engineResults.length}`,
            );
            updated++;
          }
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
              engineVersions: getCurrentEngineVersions(),
            })
            .where(and(eq(reportsTable.id, row.id), concurrencyGuard))
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
          if (wasRescore) {
            rescoredUpdated++;
            console.log(
              `[backfill] #${row.id}: rescored composite ${beforeLabel} → ${composite.overallScore} (${composite.label}) duration=${persistedTrace.totalDurationMs}ms`,
            );
          } else {
            updated++;
            console.log(
              `[backfill] #${row.id}: composite=${composite.overallScore} (${composite.label}) duration=${persistedTrace.totalDurationMs}ms`,
            );
          }
        } else {
          skippedConcurrent++;
          console.log(
            `[backfill] #${row.id}: skip (composite changed concurrently)`,
          );
        }
      } catch (err) {
        failed++;
        console.error(`[backfill] #${row.id}: failed`, err);
      }

      if (opts.limit !== null && processed >= opts.limit) break;
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        deadlineReached = true;
        console.log(
          `[backfill] max-runtime budget (${opts.maxRuntimeMs}ms) reached mid-page; stopping after #${row.id}`,
        );
        break;
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill] done: processed=${processed} updated=${updated} reconstructed=${reconstructed} ` +
      `rescored_updated=${rescoredUpdated} rescored_reconstructed=${rescoredReconstructed} ` +
      `skipped_no_signals=${skippedNoSignals} skipped_concurrent=${skippedConcurrent} ` +
      `failed=${failed} deadline_reached=${deadlineReached} elapsed=${elapsedMs}ms`,
  );

  return {
    processed,
    updated,
    reconstructed,
    rescoredUpdated,
    rescoredReconstructed,
    skippedNoSignals,
    skippedConcurrent,
    failed,
    deadlineReached,
    elapsedMs,
  };
}

// Auto-run guard (Task #388): the recurring rescore scheduler imports
// `backfill` from this module, so the side-effecting CLI parse + DB
// kickoff at the bottom must only fire when the file is invoked as the
// process entry point (e.g. `node ./dist/backfill-vulnrap.mjs`).
//
// Task #404 also gates on the entry-point's basename: esbuild inlines
// this module into the api-server's `dist/index.mjs`, where
// `import.meta.url` resolves to the bundle's own path and matches
// `process.argv[1]` at api-server startup — which previously triggered
// the CLI and `process.exit(0)`'d before `app.listen` bound a port.
function isInvokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Reject the bundled-into-index.mjs case by basename.
  const entryBase = entry.split(/[\\/]/).pop() ?? "";
  if (!/^backfill-vulnrap(?:\.|$)/.test(entryBase)) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    if (entry === here) return true;
    // Tolerate the .mjs vs .ts difference between the bundled dist file
    // and the source path so dev-time invocations through tsx still
    // trigger the script entry.
    const stripExt = (p: string) => p.replace(/\.(?:mjs|js|ts)$/, "");
    return stripExt(entry) === stripExt(here);
  } catch {
    return false;
  }
}

if (isInvokedAsScript()) {
  // parseArgs throws CliExit so it stays unit-testable; translate to a
  // real process.exit here at the script entry.
  let parsed: CliOpts;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof CliExit) {
      if (err.code === 0) console.log(err.message);
      else console.error(err.message);
      process.exit(err.code);
    }
    throw err;
  }
  backfill(parsed)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill] fatal:", err);
      process.exit(1);
    });
}
