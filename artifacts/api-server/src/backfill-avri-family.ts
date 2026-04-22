// Maintenance script: backfill the Sprint 12 `reports.avri_family` cache on
// historical rows. Reports analyzed before the cache existed have
// avri_family IS NULL even though most of them carry an `avri.family` block
// inside vulnrap_engine_results from when the AVRI composite ran. This
// script copies that family onto the dedicated column, and as a fallback
// re-runs the AVRI classifier on contentText for rows that have neither
// (e.g. pre-AVRI reports whose drift-dashboard inclusion still depends on
// the cohort filter rejecting them).
//
// Usage (from artifacts/api-server):
//   pnpm run build && node --enable-source-maps ./dist/backfill-avri-family.mjs
// Flags:
//   --dry-run        Report what would change without writing.
//   --limit=N        Cap how many reports are processed in this run.
//   --batch-size=N   Page size when scanning the table (default 200).

import { db, reportsTable } from "@workspace/db";
import { and, eq, isNull, asc, sql } from "drizzle-orm";
import { classifyReport } from "./lib/engines/avri/classify";
import type { FamilyId } from "./lib/engines/avri/families";

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[backfill-avri-family] ${flag} must be a positive integer, got: ${raw}`);
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
      console.log("Usage: backfill-avri-family [--dry-run] [--limit=N] [--batch-size=N]");
      process.exit(0);
    } else {
      console.error(`[backfill-avri-family] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function familyFromBlob(blob: unknown): FamilyId | null {
  const stored = (blob ?? {}) as { avri?: { family?: unknown } };
  const f = stored.avri?.family;
  if (typeof f === "string" && f.length > 0 && f.length <= 32) {
    return f as FamilyId;
  }
  return null;
}

async function backfill(opts: CliOpts): Promise<void> {
  const startedAt = Date.now();

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(isNull(reportsTable.avriFamily));
  const totalLegacy = totalRow[0]?.n ?? 0;
  console.log(`[backfill-avri-family] rows with NULL avri_family: ${totalLegacy}`);
  if (opts.dryRun) console.log("[backfill-avri-family] dry-run mode: no writes will be performed");

  let processed = 0;
  let copiedFromBlob = 0;
  let classifiedFromText = 0;
  let skippedNoSource = 0;
  let failed = 0;
  let lastId = 0;

  while (true) {
    if (opts.limit !== null && processed >= opts.limit) break;
    const remaining = opts.limit !== null ? opts.limit - processed : opts.batchSize;
    const pageSize = Math.min(opts.batchSize, remaining);

    const rows = await db
      .select({
        id: reportsTable.id,
        vulnrapEngineResults: reportsTable.vulnrapEngineResults,
        contentText: reportsTable.contentText,
      })
      .from(reportsTable)
      .where(
        and(
          isNull(reportsTable.avriFamily),
          sql`${reportsTable.id} > ${lastId}`,
        ),
      )
      .orderBy(asc(reportsTable.id))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      processed++;

      let family: FamilyId | null = familyFromBlob(row.vulnrapEngineResults);
      let source: "blob" | "classify" | null = family ? "blob" : null;

      if (!family && row.contentText && row.contentText.length > 0) {
        try {
          family = classifyReport(row.contentText, undefined).family.id;
          source = "classify";
        } catch (err) {
          failed++;
          console.error(`[backfill-avri-family] #${row.id}: classify failed`, err);
          continue;
        }
      }

      if (!family) {
        skippedNoSource++;
        continue;
      }

      if (opts.dryRun) {
        if (source === "blob") copiedFromBlob++;
        else classifiedFromText++;
        console.log(`[backfill-avri-family] #${row.id}: would set avri_family=${family} (source=${source})`);
        continue;
      }

      const wrote = await db
        .update(reportsTable)
        .set({ avriFamily: family })
        .where(and(eq(reportsTable.id, row.id), isNull(reportsTable.avriFamily)))
        .returning({ id: reportsTable.id });

      if (wrote.length > 0) {
        if (source === "blob") copiedFromBlob++;
        else classifiedFromText++;
      }

      if (opts.limit !== null && processed >= opts.limit) break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill-avri-family] done: processed=${processed} copied_from_blob=${copiedFromBlob} classified_from_text=${classifiedFromText} skipped_no_source=${skippedNoSource} failed=${failed} elapsed=${elapsedMs}ms`,
  );
}

const opts = parseArgs(process.argv);
backfill(opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-avri-family] fatal:", err);
    process.exit(1);
  });
