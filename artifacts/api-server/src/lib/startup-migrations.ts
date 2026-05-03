import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { runMigrations } from "@workspace/db/migrate";
import { logger } from "./logger";

// Task #723 — Boot-time migration runner.
//
// Two distinct concerns live in this file, in this order:
//
//   1. The official Drizzle file-based migrator. This applies every
//      versioned migration in `lib/db/drizzle/` against `DATABASE_URL`
//      and records what it has applied in the
//      `drizzle.__drizzle_migrations` journal table, so re-running is a
//      safe no-op. This is the canonical upgrade path for self-hosters
//      AND for the hosted Replit deployment — keeping the boot-time
//      runner here means a self-hoster who deploys via "git pull &&
//      restart" continues to get zero-touch upgrades and never has to
//      remember the separate `pnpm migrate` step.
//
//      Self-hosters who prefer an explicit deploy-then-migrate flow can
//      set `RUN_STARTUP_MIGRATIONS=0`, in which case the boot-time
//      migrator short-circuits and the operator is expected to run
//      `pnpm --filter @workspace/db run migrate` separately as part of
//      their deploy pipeline.
//
//   2. A small set of *runtime-managed* DDL operations that intentionally
//      do not live in the versioned migration set:
//
//        * `page_views` — owned entirely by the api-server (excluded
//          from drizzle's schema scan, see lib/db/src/schema/index.ts)
//          because the Replit deploy validator's dev↔prod schema diff
//          would otherwise reject any reshape of its historical broken
//          column shapes. Runs in production only; in dev page_views is
//          deliberately absent and the two raw-SQL queries that read it
//          will 500 (acceptable: visitor analytics is non-critical).
//
// All idempotent additive migrations that previously lived here as
// inline `ALTER TABLE … IF NOT EXISTS` statements have been folded into
// the versioned migration set (`lib/db/drizzle/0000_*.sql` →
// `lib/db/drizzle/0002_*.sql`). They no longer need a runtime
// counterpart because the migrator's journal makes the apply
// exactly-once-per-DB.

type RuntimeMigration = {
  id: string;
  description: string;
  statements: string[];
  // When true, the migration is skipped unless NODE_ENV === "production".
  // Used for migrations that materialize tables which would otherwise create
  // a dev↔prod schema diff that the Replit deploy validator misinterprets.
  productionOnly?: boolean;
};

const RUNTIME_MIGRATIONS: RuntimeMigration[] = [
  {
    // page_views is materialized only in production. Replit's deploy validator
    // performs a live dev↔prod schema diff; if the dev DB had page_views with
    // the desired shape and production had the historical broken shape, the
    // validator would generate an uncastable ALTER and refuse to deploy. By
    // keeping page_views absent from dev (this migration is gated by
    // productionOnly), the diff has nothing to generate for it. In prod the
    // migration still runs, drops any pre-existing broken table, and creates
    // it with the correct shape before the server starts handling requests.
    // Dev runtime behaviour: the two raw-SQL queries in routes/stats.ts will
    // 500 in development (table doesn't exist) — this is acceptable because
    // visitor analytics is a non-critical read/write path.
    id: "2026-04-25-rebuild-page-views-visitor-schema",
    description:
      "Rebuild page_views table whenever its column shape doesn't match the expected (visitor_hash varchar(64), view_date date, created_at timestamptz) layout (production only)",
    productionOnly: true,
    statements: [
      `DO $$
       DECLARE
         needs_rebuild boolean := false;
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM information_schema.tables WHERE table_name = 'page_views'
         ) THEN
           RETURN;
         END IF;

         IF NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'page_views'
             AND column_name = 'visitor_hash'
             AND data_type = 'character varying'
             AND character_maximum_length = 64
         ) THEN
           needs_rebuild := true;
         END IF;

         IF NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'page_views'
             AND column_name = 'view_date'
             AND data_type = 'date'
         ) THEN
           needs_rebuild := true;
         END IF;

         IF NOT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'page_views'
             AND column_name = 'created_at'
             AND data_type = 'timestamp with time zone'
         ) THEN
           needs_rebuild := true;
         END IF;

         IF needs_rebuild THEN
           DROP TABLE page_views CASCADE;
         END IF;
       END $$`,
      `CREATE TABLE IF NOT EXISTS page_views (
         id serial PRIMARY KEY,
         visitor_hash varchar(64) NOT NULL,
         view_date date NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_page_views_visitor_date ON page_views (visitor_hash, view_date)`,
      `CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views (view_date)`,
    ],
  },
];

export async function runStartupMigrations(): Promise<void> {
  // (1) Versioned Drizzle migrations. Opt-out for self-hosters who prefer
  // an explicit `pnpm migrate` step in their deploy pipeline.
  const isProduction = process.env.NODE_ENV === "production";
  const runVersioned = process.env.RUN_STARTUP_MIGRATIONS !== "0";
  if (runVersioned) {
    try {
      await runMigrations({
        log: (msg) => logger.info({ migrator: "drizzle" }, `[startup-migrations] ${msg}`),
      });
    } catch (err) {
      // FAIL-FAST in production. Serving requests against an unknown
      // schema state can corrupt data (e.g. an INSERT against a table
      // that doesn't have its newest NOT NULL column) or silently 500
      // every request that hits a missing table. The default policy
      // is therefore to refuse to start. Self-hosters who explicitly
      // want the legacy "log + continue" behaviour (e.g. they apply
      // migrations through a separate pipeline and the boot-time
      // runner is just a safety net) can set
      // `IGNORE_MIGRATION_FAILURES=1`.
      const ignoreFailures = process.env.IGNORE_MIGRATION_FAILURES === "1";
      if (isProduction && !ignoreFailures) {
        logger.fatal(
          { err },
          "[startup-migrations] versioned migration runner FAILED in production — refusing to start. Inspect the error, run `pnpm --filter @workspace/db run migrate` manually, then restart. Override (NOT recommended) with IGNORE_MIGRATION_FAILURES=1.",
        );
        process.exit(1);
      }
      logger.error(
        { err },
        "[startup-migrations] versioned migration runner FAILED — continuing anyway (NODE_ENV is not production or IGNORE_MIGRATION_FAILURES=1). Schema may be out of date.",
      );
    }
  } else {
    logger.info(
      "[startup-migrations] RUN_STARTUP_MIGRATIONS=0; skipping versioned migrator (run `pnpm --filter @workspace/db run migrate` manually before this process is expected to serve)",
    );
  }

  // (2) Runtime-managed DDL (page_views). `isProduction` is declared above.
  for (const migration of RUNTIME_MIGRATIONS) {
    if (migration.productionOnly && !isProduction) {
      logger.info(
        { migrationId: migration.id },
        `[startup-migrations] skipped (productionOnly, NODE_ENV=${process.env.NODE_ENV ?? "undefined"}): ${migration.description}`,
      );
      continue;
    }

    try {
      for (const stmt of migration.statements) {
        await db.execute(sql.raw(stmt));
      }
      logger.info(
        { migrationId: migration.id },
        `[startup-migrations] applied: ${migration.description}`,
      );
    } catch (err) {
      logger.error(
        { err, migrationId: migration.id },
        `[startup-migrations] FAILED: ${migration.description} — server will continue but dependent endpoints may 500`,
      );
    }
  }
}
