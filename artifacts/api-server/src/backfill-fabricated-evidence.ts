// Maintenance script: backfill the cached fabricated-evidence columns
// (`fake_raw_http`, `stripped_crash_trace`) on legacy rows. New rows
// are populated at insert time by routes/reports.ts, so this script
// targets rows whose `vulnrap_engine_results` was written before the
// columns existed. Walks the table in id-ordered pages, derives the
// flags via the shared helper, and writes the values when they differ
// from the currently-cached defaults. Idempotent — re-running over a
// fully backfilled corpus reports zero updates per page.
//
// Usage (from artifacts/api-server):
//   pnpm run build && node --enable-source-maps ./dist/backfill-fabricated-evidence.mjs
// Flags:
//   --dry-run        Report what would change without writing.
//   --limit=N        Cap how many reports are processed in this run.
//   --batch-size=N   Page size when scanning the table (default 200).

import { db, reportsTable } from "@workspace/db";
import { and, eq, asc, sql } from "drizzle-orm";
import { deriveFabricatedEvidenceFlags } from "./lib/fabricated-evidence-flags";

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[backfill-fabricated-evidence] ${flag} must be a positive integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dryRun: false, limit: null, batchSize: 200 };
  for (const arg of argv.slice(2)) {
    if (arg === "--" || arg === "") continue;
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--limit=")) opts.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
    else if (arg.startsWith("--batch-size=")) opts.batchSize = parsePositiveInt(arg.slice("--batch-size=".length), "--batch-size");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: backfill-fabricated-evidence [--dry-run] [--limit=N] [--batch-size=N]");
      process.exit(0);
    } else {
      console.error(`[backfill-fabricated-evidence] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

async function backfill(opts: CliOpts): Promise<void> {
  const startedAt = Date.now();

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportsTable);
  const totalRows = totalRow[0]?.n ?? 0;
  console.log(`[backfill-fabricated-evidence] reports table size: ${totalRows}`);
  if (opts.dryRun) console.log("[backfill-fabricated-evidence] dry-run mode: no writes will be performed");

  let processed = 0;
  let setFakeRawHttp = 0;
  let setStrippedCrashTrace = 0;
  let unchanged = 0;
  let lastId = 0;

  while (true) {
    if (opts.limit !== null && processed >= opts.limit) break;
    const remaining = opts.limit !== null ? opts.limit - processed : opts.batchSize;
    const pageSize = Math.min(opts.batchSize, remaining);

    const rows = await db
      .select({
        id: reportsTable.id,
        vulnrapEngineResults: reportsTable.vulnrapEngineResults,
        fakeRawHttp: reportsTable.fakeRawHttp,
        strippedCrashTrace: reportsTable.strippedCrashTrace,
      })
      .from(reportsTable)
      .where(sql`${reportsTable.id} > ${lastId}`)
      .orderBy(asc(reportsTable.id))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      processed++;

      const derived = deriveFabricatedEvidenceFlags(row.vulnrapEngineResults);
      const needsFake = derived.fakeRawHttp !== row.fakeRawHttp;
      const needsStripped =
        derived.strippedCrashTrace !== row.strippedCrashTrace;

      if (!needsFake && !needsStripped) {
        unchanged++;
        continue;
      }

      if (opts.dryRun) {
        if (needsFake) setFakeRawHttp++;
        if (needsStripped) setStrippedCrashTrace++;
        console.log(
          `[backfill-fabricated-evidence] #${row.id}: would set fake_raw_http=${derived.fakeRawHttp} stripped_crash_trace=${derived.strippedCrashTrace} (was ${row.fakeRawHttp}/${row.strippedCrashTrace})`,
        );
        continue;
      }

      // Guard the UPDATE on the prior values so concurrent writers (e.g.
      // a re-analysis racing against this script) never get clobbered by
      // a stale page snapshot.
      const wrote = await db
        .update(reportsTable)
        .set({
          fakeRawHttp: derived.fakeRawHttp,
          strippedCrashTrace: derived.strippedCrashTrace,
        })
        .where(
          and(
            eq(reportsTable.id, row.id),
            eq(reportsTable.fakeRawHttp, row.fakeRawHttp),
            eq(reportsTable.strippedCrashTrace, row.strippedCrashTrace),
          ),
        )
        .returning({ id: reportsTable.id });

      if (wrote.length > 0) {
        if (needsFake) setFakeRawHttp++;
        if (needsStripped) setStrippedCrashTrace++;
      }

      if (opts.limit !== null && processed >= opts.limit) break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill-fabricated-evidence] done: processed=${processed} set_fake_raw_http=${setFakeRawHttp} set_stripped_crash_trace=${setStrippedCrashTrace} unchanged=${unchanged} elapsed=${elapsedMs}ms`,
  );
}

const opts = parseArgs(process.argv);
backfill(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-fabricated-evidence] fatal:", err);
    process.exit(1);
  });
