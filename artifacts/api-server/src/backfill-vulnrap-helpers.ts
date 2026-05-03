// Helpers extracted from backfill-vulnrap.ts so they can be unit-tested
// without triggering the script's top-level CLI parsing and DB connect.
//
// Task #193 — minimal text fragments that re-trigger each
// `detectHallucinationSignals` rule. Used to reconstruct a hallucination-
// detection input for legacy reports whose raw text was not retained but
// whose v3.5.0 score-fusion run cached the original signals into the
// `evidence` jsonb column with type `hallucination_<signalType>`. Each
// snippet is engineered to fire ONLY its named signal, so a re-detection
// over the joined snippets reproduces the original totalWeight (and thus
// the same -10 / -15 / -25 composite tier) without dragging the report
// across tier boundaries via cross-contamination.
//
// Specific cross-contamination guards:
//   - `language_confusion` uses `.js` rather than `node.js` so it does not
//     suppress `impact_escalation` (whose detector skips XSS+RCE pairs that
//     mention electron/node/server-side contexts).
//   - No snippet uses ` import ` or ` def ` so `phantom_exploit_script`
//     keeps firing whenever `exploit.py` is present.
//   - The `fabricated_addresses` snippet emits 6 round addresses so even
//     when the `fabricated_stack_trace` snippet contributes 5 non-round
//     addresses to the same text the round-fraction stays >0.5.
//   - No snippet emits `SUMMARY: AddressSanitizer`, `==N==ERROR:`, gdb
//     `bt`/`backtrace`, or `READ/WRITE of size N`, so the
//     `hasRealCrashIndicators` allowlist in the detector does NOT suppress
//     `fabricated_addresses`.

import { reportsTable, type EvidenceItem } from "@workspace/db";
import { isNull, sql, type SQL } from "drizzle-orm";

export const HALLUCINATION_TRIGGER_SNIPPETS: Record<string, string> = {
  fabricated_stack_trace: [
    "#0 0xaaaaa11111 in dup_frame",
    "#1 0xaaaaa11111 in dup_frame",
    "#2 0xaaaaa11111 in dup_frame",
    "#3 0xaaaaa11111 in dup_frame",
    "#4 0xaaaaa11111 in dup_frame",
  ].join("\n"),
  fabricated_addresses:
    "Faulting addresses 0x70000000 0x80000000 0x90000000 0xa0000000 0xb0000000 0xc0000000",
  phantom_exploit_script: "Reproduce by running exploit.py against the target.",
  // Task #206: incomplete_asan now requires a specific bug-class claim
  // alongside the missing-structure indicator, so the snippet has to name
  // the bug class explicitly (e.g. "heap-buffer-overflow") to re-fire the
  // detector at backfill time.
  incomplete_asan:
    "Reporter pasted an AddressSanitizer heap-buffer-overflow trace (truncated).",
  // Task #206: fabricated_pid no longer fires on a single magic PID when
  // no other fabrication marker is present. The snippet now seeds two
  // distinct magic PIDs so the rule fires in isolation (per-signal
  // purity) without depending on cross-talk from other snippets.
  fabricated_pid: "Crash report headers were ==12345== and ==54321==.",
  phantom_functions:
    "Mentions fab_alpha(), fab_beta(), and fab_gamma() but ships no source.",
  implausible_version: "Affects version 1.2.999 of the library.",
  impact_escalation:
    "XSS in the rendered comment escalates to RCE inside the worker.",
  language_confusion:
    "Repro mentions python pip, .js source, and #include directives.",
  repeated_sentences: [
    "Identical filler sentence with sufficient length here.",
    "Identical filler sentence with sufficient length here.",
    "Identical filler sentence with sufficient length here.",
  ].join(" "),
  empty_disclosure_claim: "Submitted under responsible disclosure.",
};

// Build trigger text for a `computeComposite` re-run from the cached
// `hallucination_*` evidence items persisted at original-analysis time.
// Returns "" when the report has no cached hallucination signals so the
// caller can pass undefined and keep the existing no-text behavior.
export function reconstructHallucinationTriggerText(
  evidence: EvidenceItem[] | null | undefined,
): string {
  if (!evidence || evidence.length === 0) return "";
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const item of evidence) {
    if (!item.type.startsWith("hallucination_")) continue;
    const signalType = item.type.slice("hallucination_".length);
    if (seen.has(signalType)) continue;
    const snippet = HALLUCINATION_TRIGGER_SNIPPETS[signalType];
    if (snippet) {
      seen.add(signalType);
      snippets.push(snippet);
    }
  }
  return snippets.join("\n\n");
}

// CLI options for backfill-vulnrap. Lives here (not in the script entry)
// so unit tests can import parseArgs without tripping the script's
// top-level db connection and backfill kickoff.
//
// `maxRuntimeMs` (Task #388) is a wall-clock budget the loop checks
// after every row so a runaway scan can't saturate the DB when the
// script is invoked from the recurring rescore scheduler. `null`
// preserves the historical "run to completion" behavior for operator-
// driven invocations that pair with `--limit` instead.
export interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  rescore: boolean;
  onlyWithCachedHallucination: boolean;
  maxRuntimeMs: number | null;
}

// Counters surfaced by `backfill()` so callers (the rescore scheduler)
// can persist them into the heartbeat / status surface without having
// to scrape stdout. Fields mirror the final summary line the script
// has historically logged.
export interface BackfillStats {
  processed: number;
  updated: number;
  reconstructed: number;
  rescoredUpdated: number;
  rescoredReconstructed: number;
  skippedNoSignals: number;
  skippedConcurrent: number;
  failed: number;
  /** True iff the loop exited because `maxRuntimeMs` was reached. */
  deadlineReached: boolean;
  elapsedMs: number;
}

// Throwing instead of process.exit keeps parseArgs unit-testable; the
// script entry catches CliExit and translates it to a real exit code.
export class CliExit extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CliExit";
  }
}

// Task #389 — audit-trail entry persisted onto a rescored report's
// `vulnrap_engine_results.rescoreHistory` array. Lets reviewers tell from
// the row itself that the composite was rewritten by a backfill rescore
// (vs. a normal recheck), what the prior composite was, and which run did
// it. Plain JSON shape so it survives a roundtrip through the jsonb column
// without needing schema migrations.
//
// `mode` distinguishes the two rescore branches (`engine` re-runs the live
// pipeline; `reconstruction` rebuilds from cached v3.5.0 signals because
// the report has no stored text). The history is appended-to, so multiple
// rescores leave a chronological trail (oldest first).
export interface BackfillRescoreAuditEntry {
  source: "backfill-rescore";
  mode: "engine" | "reconstruction";
  rescoredAt: string;
  priorCompositeScore: number;
  priorCompositeLabel: string | null;
  priorCorrelationId: string | null;
  newCompositeScore: number;
  newCompositeLabel: string;
  newCorrelationId: string;
}

// Build an audit entry for a single rescored row. `now` is injectable so
// tests can pin the timestamp; the script default uses `new Date()`.
export function buildBackfillRescoreAuditEntry(args: {
  mode: "engine" | "reconstruction";
  priorCompositeScore: number;
  priorCompositeLabel: string | null;
  priorCorrelationId: string | null;
  newCompositeScore: number;
  newCompositeLabel: string;
  newCorrelationId: string;
  now?: Date;
}): BackfillRescoreAuditEntry {
  const ts = (args.now ?? new Date()).toISOString();
  return {
    source: "backfill-rescore",
    mode: args.mode,
    rescoredAt: ts,
    priorCompositeScore: args.priorCompositeScore,
    priorCompositeLabel: args.priorCompositeLabel,
    priorCorrelationId: args.priorCorrelationId,
    newCompositeScore: args.newCompositeScore,
    newCompositeLabel: args.newCompositeLabel,
    newCorrelationId: args.newCorrelationId,
  };
}

// Append a fresh audit entry to whatever rescoreHistory already lives on
// the prior `vulnrap_engine_results` blob. Tolerates a missing/non-array
// field (legacy rows never had this), and silently drops malformed entries
// from the existing history rather than throwing — reviewers care about
// the most recent rescore, not historical schema drift.
export function appendRescoreHistory(
  priorBlob: unknown,
  entry: BackfillRescoreAuditEntry,
): BackfillRescoreAuditEntry[] {
  const prior = (priorBlob ?? {}) as { rescoreHistory?: unknown };
  const existing = Array.isArray(prior.rescoreHistory)
    ? prior.rescoreHistory
    : [];
  const cleaned = existing.filter((e): e is BackfillRescoreAuditEntry => {
    if (!e || typeof e !== "object") return false;
    const r = e as Record<string, unknown>;
    return (
      r.source === "backfill-rescore" &&
      (r.mode === "engine" || r.mode === "reconstruction") &&
      typeof r.rescoredAt === "string" &&
      typeof r.priorCompositeScore === "number" &&
      typeof r.newCompositeScore === "number" &&
      typeof r.newCorrelationId === "string"
    );
  });
  return [...cleaned, entry];
}

// Optimistic concurrency guard chosen for an UPDATE of one row. Returned
// as a discriminated union so the SQL builder lives in the script (where
// drizzle is in scope) but the decision logic stays pure and testable.
//
// `matchCorrelationId` pins the UPDATE to the correlation id read at
// SELECT time (the normal rescore case). `isNullCorrelationAndScore` is
// the fallback for already-scored legacy rows whose correlation id was
// never persisted — without it, `eq(corrId, null)` evaluates to NULL in
// SQL and the row would be silently skipped, defeating the rescore.
// `isNullComposite` is the original NULL-only behavior, kept for rows
// that were never scored (whether or not --rescore is on).
export type ConcurrencyGuard =
  | { kind: "isNullComposite" }
  | { kind: "matchCorrelationId"; correlationId: string }
  | { kind: "isNullCorrelationAndScore"; compositeScore: number };

export function chooseConcurrencyGuard(
  priorCompositeScore: number | null,
  priorCorrelationId: string | null,
): ConcurrencyGuard {
  if (priorCompositeScore === null) return { kind: "isNullComposite" };
  if (priorCorrelationId !== null) {
    return { kind: "matchCorrelationId", correlationId: priorCorrelationId };
  }
  return {
    kind: "isNullCorrelationAndScore",
    compositeScore: priorCompositeScore,
  };
}

// SQL predicates that scope the rescore-mode SELECT in `backfill()` to the
// rows the run intends to touch. Returned as an array so the caller can
// spread it into `and(...)` alongside its own pagination predicate.
//
// Two flags drive the shape of the filter:
//   - `rescore`: when false, restrict to rows whose composite is still
//     NULL (the original "legacy reports without composite" behavior).
//     When true, accept every row so already-scored rows get re-rated.
//   - `onlyWithCachedHallucination`: when true, only rows whose
//     `evidence` jsonb contains at least one element of type
//     `hallucination_*` are considered. The `coalesce` keeps NULL
//     evidence rows from breaking the EXISTS scan.
//
// Kept here (rather than inline in `backfill()`) so an integration test
// can run the same SQL against a real Postgres test schema and verify
// the candidate set without invoking the full backfill pipeline.
export function buildRescoreCandidateFilters(opts: {
  rescore: boolean;
  onlyWithCachedHallucination: boolean;
}): SQL[] {
  const hallucinationFilter = sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(${reportsTable.evidence}, '[]'::jsonb)) AS e
    WHERE e->>'type' LIKE 'hallucination_%'
  )`;
  return [
    opts.rescore
      ? sql`true`
      : (isNull(reportsTable.vulnrapCompositeScore) as SQL),
    opts.onlyWithCachedHallucination ? hallucinationFilter : sql`true`,
  ];
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliExit(
      2,
      `[backfill] ${flag} must be a positive integer, got: ${raw}`,
    );
  }
  return n;
}

export function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    dryRun: false,
    limit: null,
    batchSize: 50,
    rescore: false,
    onlyWithCachedHallucination: false,
    maxRuntimeMs: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--" || arg === "") continue;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--limit="))
      opts.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    else if (arg.startsWith("--batch-size="))
      opts.batchSize = parsePositiveInt(
        arg.slice("--batch-size=".length),
        "--batch-size",
      );
    else if (arg === "--rescore") opts.rescore = true;
    else if (arg === "--only-with-cached-hallucination")
      opts.onlyWithCachedHallucination = true;
    else if (arg.startsWith("--max-runtime-ms=")) {
      opts.maxRuntimeMs = parsePositiveInt(
        arg.slice("--max-runtime-ms=".length),
        "--max-runtime-ms",
      );
    } else if (arg === "--help" || arg === "-h") {
      throw new CliExit(
        0,
        "Usage: backfill-vulnrap [--dry-run] [--limit=N] [--batch-size=N]" +
          " [--rescore] [--only-with-cached-hallucination] [--max-runtime-ms=N]",
      );
    } else {
      throw new CliExit(2, `[backfill] unknown argument: ${arg}`);
    }
  }
  return opts;
}
