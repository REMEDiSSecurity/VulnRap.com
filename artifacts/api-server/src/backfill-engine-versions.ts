// Task #937 — Backfill the `reports.engine_versions` JSONB column on
// legacy rows. Task #624 added the column and populates it for every
// new write, so this script targets only rows where engine_versions
// IS NULL. Walks the table in id-ordered pages, infers a best-effort
// pin from `vulnrap_engine_results` via inferLegacyEngineVersions(),
// and writes it. Idempotent — the SELECT and the guarded UPDATE both
// filter on engine_versions IS NULL so rerunning over an already-
// backfilled corpus reports zero updates per page, and a concurrent
// live write that sets engine_versions between our SELECT and UPDATE
// is preserved (the UPDATE no-ops because the IS NULL guard fails).
//
// Mirrors the backfill-fabricated-evidence / backfill-avri-family
// pattern: --dry-run / --limit / --batch-size flags, id-cursor
// pagination, and a one-line summary at the end.
//
// Usage (from artifacts/api-server):
//   pnpm run build && pnpm run backfill:engine-versions
// Flags:
//   --dry-run        Report what would change without writing.
//   --limit=N        Cap how many reports are processed in this run.
//   --batch-size=N   Page size when scanning the table (default 200).

import { db, reportsTable } from "@workspace/db";
import { and, eq, isNull, asc, sql } from "drizzle-orm";
import { inferLegacyEngineVersions } from "./lib/legacy-engine-versions";

interface CliOpts {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(
      `[backfill-engine-versions] ${flag} must be a positive integer, got: ${raw}`,
    );
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { dryRun: false, limit: null, batchSize: 200 };
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
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: backfill-engine-versions [--dry-run] [--limit=N] [--batch-size=N]",
      );
      process.exit(0);
    } else {
      console.error(`[backfill-engine-versions] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

export async function backfill(opts: CliOpts): Promise<void> {
  const startedAt = Date.now();

  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(isNull(reportsTable.engineVersions));
  const totalLegacy = totalRow[0]?.n ?? 0;
  console.log(
    `[backfill-engine-versions] rows with NULL engine_versions: ${totalLegacy}`,
  );
  if (opts.dryRun)
    console.log(
      "[backfill-engine-versions] dry-run mode: no writes will be performed",
    );

  let processed = 0;
  let stampedBase = 0;
  let stampedVulnrap = 0;
  let stampedAvri = 0;
  let lastId = 0;

  while (true) {
    if (opts.limit !== null && processed >= opts.limit) break;
    const remaining =
      opts.limit !== null ? opts.limit - processed : opts.batchSize;
    const pageSize = Math.min(opts.batchSize, remaining);

    const rows = await db
      .select({
        id: reportsTable.id,
        vulnrapEngineResults: reportsTable.vulnrapEngineResults,
      })
      .from(reportsTable)
      .where(
        and(
          isNull(reportsTable.engineVersions),
          sql`${reportsTable.id} > ${lastId}`,
        ),
      )
      .orderBy(asc(reportsTable.id))
      .limit(pageSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      processed++;

      const versions = inferLegacyEngineVersions(row.vulnrapEngineResults);

      if (opts.dryRun) {
        bumpTier(versions.fusion, {
          base: () => stampedBase++,
          vulnrap: () => stampedVulnrap++,
          avri: () => stampedAvri++,
        });
        console.log(
          `[backfill-engine-versions] #${row.id}: would set engine_versions=${JSON.stringify(versions)}`,
        );
        continue;
      }

      // Guard the UPDATE on engine_versions IS NULL so a live writer
      // (or a previous backfill tick) that already populated the row
      // between our SELECT and UPDATE is never clobbered.
      const wrote = await db
        .update(reportsTable)
        .set({ engineVersions: versions })
        .where(
          and(
            eq(reportsTable.id, row.id),
            isNull(reportsTable.engineVersions),
          ),
        )
        .returning({ id: reportsTable.id });

      if (wrote.length > 0) {
        bumpTier(versions.fusion, {
          base: () => stampedBase++,
          vulnrap: () => stampedVulnrap++,
          avri: () => stampedAvri++,
        });
      }

      if (opts.limit !== null && processed >= opts.limit) break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill-engine-versions] done: processed=${processed} stamped_base=${stampedBase} stamped_vulnrap=${stampedVulnrap} stamped_avri=${stampedAvri} elapsed=${elapsedMs}ms`,
  );
}

function bumpTier(
  fusionVersion: string,
  bumps: { base: () => void; vulnrap: () => void; avri: () => void },
): void {
  if (fusionVersion === "3.0.0") bumps.base();
  else if (fusionVersion === "3.5.0") bumps.vulnrap();
  else if (fusionVersion === "3.6.0") bumps.avri();
}

// Allow this file to be imported by tests without auto-running the CLI.
const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] != null &&
  /backfill-engine-versions(\.mjs|\.ts|\.js)?$/.test(process.argv[1]);

if (isCli) {
  const opts = parseArgs(process.argv);
  backfill(opts)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-engine-versions] fatal:", err);
      process.exit(1);
    });
}
