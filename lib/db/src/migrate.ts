// Task #723 — Production-safe migration runner.
//
// Applies every pending file in `lib/db/drizzle/` against `DATABASE_URL`
// using the official Drizzle Postgres migrator. The migrator records
// applied migrations in `drizzle.__drizzle_migrations` so re-running is a
// safe no-op. Use this for:
//
//   * Local one-shot setup of a freshly created database (replaces the
//     destructive `drizzle-kit push` for anything other than schema
//     iteration).
//   * Production / self-hosted upgrades — after pulling a new release,
//     run `pnpm --filter @workspace/db run migrate` before restarting
//     the api-server.
//
// The api-server also calls the same migrator at boot
// (`runStartupMigrations`) so the hosted Replit deployment continues to
// get zero-touch upgrades.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;

import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The migrations directory lives at `lib/db/drizzle/`. The runner needs
// to resolve it from THREE different locations:
//
//   1. Direct invocation as `tsx lib/db/src/migrate.ts` (or via the
//      package script). __dirname → `<repo>/lib/db/src/`, so
//      `../drizzle` is correct.
//   2. Imported by the api-server's esbuild bundle. After bundling
//      __dirname → `<repo>/artifacts/api-server/dist/`, so `../drizzle`
//      points at `artifacts/api-server/drizzle` which does not exist.
//      Walk up the tree until we find a `lib/db/drizzle` directory.
//   3. Imported from a workspace consumer running ts-node / tsx where
//      __dirname is somewhere under `lib/db/dist/`. Same walk handles
//      this case.
//
// We pick the first candidate that contains `meta/_journal.json` (the
// drizzle-kit journal manifest). Falling back to a hard-coded constant
// would silently apply zero migrations, so if nothing is found we throw
// at module load time rather than wait for `runMigrations` to no-op.
function resolveMigrationsFolder(startDir: string): string {
  const candidates: string[] = [
    path.resolve(startDir, "..", "drizzle"),
    path.resolve(startDir, "..", "..", "drizzle"),
  ];
  // Walk upward from startDir looking for `lib/db/drizzle`.
  let cur = startDir;
  for (let i = 0; i < 10; i++) {
    candidates.push(path.join(cur, "lib", "db", "drizzle"));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `[migrate] Could not locate the lib/db/drizzle migrations directory. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

export const MIGRATIONS_FOLDER = resolveMigrationsFolder(__dirname);

export interface RunMigrationsOptions {
  databaseUrl?: string;
  migrationsFolder?: string;
  log?: (msg: string) => void;
  // Sentinel table used to detect "schema is non-empty but the drizzle
  // journal is empty" — i.e. an installation that predates the versioned
  // migration system and needs to be baselined. Defaults to `reports`,
  // the oldest table in the schema; every running VulnRap installation
  // has it.
  baselineProbeTable?: string;
}

// Drizzle journal table coordinates. Hard-coded because we do not pass
// a custom { migrationsSchema, migrationsTable } config to migrate()
// elsewhere; if that ever changes, plumb them through here too.
const JOURNAL_SCHEMA = "drizzle";
const JOURNAL_TABLE = "__drizzle_migrations";

/**
 * Adopt an existing, pre-versioned schema as the baseline.
 *
 * Background: VulnRap shipped for several months on a `drizzle-kit push`
 * + boot-time `runStartupMigrations()` flow. The hosted production DB
 * (and any self-hoster who has been running before task #723 lands)
 * therefore already contains every table and column that
 * `lib/db/drizzle/0000_*.sql … 0002_*.sql` would create — but
 * `drizzle.__drizzle_migrations` does not yet exist, so the migrator
 * would attempt to apply 0000 against the live DB and crash on the
 * very first `CREATE TABLE "reports"` (no IF NOT EXISTS, by design —
 * Drizzle assumes a virgin DB).
 *
 * The fix: before invoking the migrator, detect this case and stamp the
 * journal as if every existing migration had already been applied.
 * The Postgres dialect's `migrate()` only checks
 * `Number(lastDbMigration.created_at) < migration.folderMillis`, so a
 * single row with `created_at` equal to the largest journal `when` is
 * sufficient to short-circuit every existing migration. Newly-added
 * migrations (with a strictly larger `when`) will still run on the
 * next deploy.
 *
 * The probe is intentionally specific: we only baseline when (a) the
 * sentinel table from the legacy schema exists AND (b) the journal
 * either does not exist or is empty. A fresh install (no sentinel
 * table) falls through to the migrator and applies 0000 → N from
 * scratch.
 */
async function baselineExistingSchemaIfNeeded(
  pool: pg.Pool,
  folder: string,
  probeTable: string,
  log: (msg: string) => void,
): Promise<void> {
  // (a) Does the legacy schema exist? `to_regclass` returns NULL when
  // the relation is missing, without raising. Limited to the public
  // schema because that's where the schema lives.
  const probe = await pool.query<{ oid: string | null }>(
    `SELECT to_regclass($1) AS oid`,
    [`public.${probeTable}`],
  );
  if (!probe.rows[0]?.oid) {
    log(`fresh install detected (no public.${probeTable}); skipping baseline`);
    return;
  }

  // (b) Is the journal empty / missing? Create the schema + table
  // up-front so the count query is unconditional. The migrator does
  // the same thing on its happy path; doing it here means we own the
  // INSERT below cleanly.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${JOURNAL_SCHEMA}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${JOURNAL_SCHEMA}.${JOURNAL_TABLE} (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );
  const journalCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${JOURNAL_SCHEMA}.${JOURNAL_TABLE}`,
  );
  if (Number(journalCount.rows[0].count) > 0) {
    return; // Already baselined or already partially migrated; nothing to do.
  }

  // Read the journal manifest to find the largest `when`. We stamp ONE
  // row with that timestamp + a synthetic hash; the migrator will then
  // see lastDbMigration.created_at >= every existing migration's
  // folderMillis and skip them. New migrations land with a strictly
  // larger `when`, so they still apply on the next deploy.
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    log(`baseline skipped: no journal manifest at ${journalPath}`);
    return;
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { when: number; tag: string }[];
  };
  if (journal.entries.length === 0) {
    return;
  }
  const maxWhen = Math.max(...journal.entries.map((e) => Number(e.when)));
  await pool.query(
    `INSERT INTO ${JOURNAL_SCHEMA}.${JOURNAL_TABLE} (hash, created_at) VALUES ($1, $2)`,
    [`baseline-${journal.entries[journal.entries.length - 1].tag}`, maxWhen],
  );
  log(
    `baselined existing schema: ${journal.entries.length} migration(s) marked as applied (created_at=${maxWhen})`,
  );
}

export async function runMigrations(opts: RunMigrationsOptions = {}): Promise<void> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set to run migrations. Did you forget to provision a database?",
    );
  }

  const folder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;
  const log = opts.log ?? ((msg: string) => console.log(`[migrate] ${msg}`));
  const probeTable = opts.baselineProbeTable ?? "reports";

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await baselineExistingSchemaIfNeeded(pool, folder, probeTable, log);
    const db = drizzle(pool);
    log(`applying pending migrations from ${folder}`);
    await migrate(db, { migrationsFolder: folder });
    log("done");
  } finally {
    await pool.end().catch(() => {
      // pool.end can throw if the pool was never used; ignore.
    });
  }
}

// Allow `tsx ./src/migrate.ts` invocation as a CLI.
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/migrate.ts") ||
  process.argv[1]?.endsWith("/migrate.mjs") ||
  process.argv[1]?.endsWith("/migrate.js");

if (invokedAsScript) {
  runMigrations().catch((err) => {
    console.error("[migrate] FAILED:", err);
    process.exit(1);
  });
}
