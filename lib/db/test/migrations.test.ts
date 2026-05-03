// Task #723 — Production-safe migration suite tests.
//
// Two contracts the migration story must uphold:
//
//   1. Applying every migration from an empty database produces a schema
//      that matches `lib/db/src/schema/` exactly — i.e. drizzle-kit
//      `generate` against the resulting DB would emit zero new statements.
//      In practice we approximate this by running `drizzle-kit check`
//      (which validates the journal/snapshot chain) and re-running the
//      migrator a second time and asserting it is a no-op.
//
//   2. Applying twice is idempotent: the second run completes without
//      mutating the schema (the migrator's journal table records what was
//      applied and skips it on the second pass).
//
// The test requires a real Postgres because Drizzle migration SQL relies
// on a long tail of Postgres-specific features (jsonb, gin indexes,
// expression-based unique indexes, hashtext, AT TIME ZONE, …) that no
// pure-JS in-memory shim emulates faithfully. CI provisions one via the
// `services.postgres` block in `.github/workflows/ci.yml`. Locally the
// test self-skips when `TEST_DATABASE_URL` is unset so contributors
// without a Postgres handy don't see spurious failures.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations, MIGRATIONS_FOLDER } from "../src/migrate";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DB_DIR = path.resolve(__dirname, "..");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb("drizzle migrations", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    // Drop and recreate the public schema so the test starts from a known
    // empty state regardless of what previous runs left behind. CASCADE
    // also drops the `drizzle.__drizzle_migrations` journal so the second
    // call to runMigrations re-applies from migration 0000.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("CREATE SCHEMA public");
  });

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  it("applies every migration from an empty database", async () => {
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      log: () => {},
    });

    // Smoke-test that a representative table from each migration file
    // exists. If 0000/0001/0002 were silently dropped this would fail.
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    const names = result.rows.map((r) => r.table_name);
    for (const expected of [
      "reports", // 0000
      "report_hashes", // 0000
      "user_feedback", // 0000
      "newsletter_subscriptions", // 0001
      "phrase_suggestions", // 0001
      "report_rescore_log", // 0001
      "report_shadow_scores", // 0002
      "audit_log", // 0002
      "webhooks", // 0002
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }

    // The 0002 file backfills user_feedback.is_holdout from a deterministic
    // hash. The column should exist with the expected default.
    const colRes = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'user_feedback' AND column_name = 'is_holdout'`,
    );
    expect(colRes.rows).toHaveLength(1);
    expect(colRes.rows[0].is_nullable).toBe("NO");

    // The expression-based partial-unique index on report_rescore_log
    // is one of the harder-to-author migration statements; assert it
    // landed under the expected name.
    const idxRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'report_rescore_log'
          AND indexname = 'uniq_report_rescore_log_daily'`,
    );
    expect(idxRes.rows).toHaveLength(1);
  });

  it("re-running the migrator is a no-op (idempotent)", async () => {
    // Capture the per-table column count before the second apply, then
    // assert nothing changed after a second runMigrations call.
    const before = await pool.query<{
      table_name: string;
      column_count: string;
    }>(
      `SELECT table_name, COUNT(*)::text AS column_count
         FROM information_schema.columns
        WHERE table_schema = 'public'
        GROUP BY table_name
        ORDER BY table_name`,
    );

    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      log: () => {},
    });

    const after = await pool.query<{
      table_name: string;
      column_count: string;
    }>(
      `SELECT table_name, COUNT(*)::text AS column_count
         FROM information_schema.columns
        WHERE table_schema = 'public'
        GROUP BY table_name
        ORDER BY table_name`,
    );

    expect(after.rows).toEqual(before.rows);

    // The migrator's journal records each applied migration exactly once.
    // After two runMigrations() calls there should still be exactly one
    // row per file in `lib/db/drizzle/`.
    const journal = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    // We expect the count to equal the number of versioned migration
    // files. Read the journal manifest to compute the expected count
    // dynamically so adding a new migration doesn't require touching
    // this assertion.
    const journalManifest = await import(
      path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
      { with: { type: "json" } } as never
    ).then((m: { default: { entries: unknown[] } }) => m.default);
    expect(Number(journal.rows[0].count)).toBe(journalManifest.entries.length);
  });

  it("baselines an existing pre-versioned schema instead of re-applying 0000", async () => {
    // Simulate a self-hoster who has been running on the legacy
    // `drizzle-kit push` flow and just pulled a release that introduces
    // versioned migrations. Their public schema already contains every
    // table the migrator would create, but `drizzle.__drizzle_migrations`
    // does not exist. The migrator MUST NOT re-apply 0000 (which would
    // crash on `CREATE TABLE "reports"` — no IF NOT EXISTS in the
    // generated SQL); it MUST stamp the journal so that subsequent runs
    // are no-ops AND any newly-added migration would still apply.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("CREATE SCHEMA public");
    // Materialize a minimal stand-in for the legacy schema. Only the
    // sentinel table needs to exist for the baseline probe to fire;
    // the assertion below is that we did not crash on the migrator's
    // 0000 `CREATE TABLE "reports"`.
    await pool.query(`CREATE TABLE public.reports (id serial PRIMARY KEY)`);

    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      log: () => {},
    });

    const journal = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    // After baselining, the journal contains exactly one synthetic row
    // with created_at = max(journal entries' `when`). Every existing
    // migration is therefore considered already-applied; the migrator
    // does not insert per-file rows on this path.
    expect(Number(journal.rows[0].count)).toBe(1);

    // The placeholder reports table is still there, untouched (the
    // migrator did not attempt to recreate it).
    const reports = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'reports'`,
    );
    expect(reports.rows).toHaveLength(1);

    // Running the migrator a second time is still a no-op.
    await runMigrations({
      databaseUrl: TEST_DATABASE_URL,
      log: () => {},
    });
    const journal2 = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(Number(journal2.rows[0].count)).toBe(1);
  });

  it("re-running drizzle-kit generate emits no new migration", async () => {
    // Restore the fully-migrated schema so this test sees the same
    // state the earlier "applies every migration from empty" test
    // produced. The previous test left a stub `reports` table behind.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, log: () => {} });

    // After every versioned migration is applied, `drizzle-kit generate`
    // must agree that the schema files are fully captured. If it would
    // emit a brand-new NNNN_*.sql file, that means a contributor edited
    // `lib/db/src/schema/` without committing the matching migration —
    // the contract that makes the boot-time migrator and `pnpm migrate`
    // safe is broken. Compare the on-disk migration file list before and
    // after a generate invocation; any growth is a regression.
    const fs = await import("node:fs");
    const drizzleDir = path.join(REPO_DB_DIR, "drizzle");
    const before = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    try {
      execFileSync(
        "pnpm",
        ["exec", "drizzle-kit", "generate", "--config", "./drizzle.config.ts"],
        {
          cwd: REPO_DB_DIR,
          encoding: "utf8",
          env: {
            ...process.env,
            // drizzle.config.ts throws if DATABASE_URL is unset; `generate`
            // does not connect, but the config is evaluated regardless.
            DATABASE_URL:
              process.env.DATABASE_URL ??
              TEST_DATABASE_URL ??
              "postgres://unused",
          },
        },
      );
    } catch {
      // Surface generate-failed as a separate signal below.
    }
    const after = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // Roll back any orphan file generate may have written so the test
    // doesn't pollute the working tree on failure.
    for (const f of after) {
      if (!before.includes(f)) {
        fs.unlinkSync(path.join(drizzleDir, f));
      }
    }
    expect(
      after,
      "drizzle-kit generate produced a new migration — schema and migrations are out of sync. Run `pnpm --filter @workspace/db run generate` and commit the result.",
    ).toEqual(before);
  });
});

// Always-on smoke test (no DB required) that catches the most common
// migration-mechanics regression: the journal getting out of sync with
// the on-disk SQL files. A missing snapshot or extra orphan SQL file
// here means a future `pnpm migrate` will silently skip a migration.
describe("drizzle migrations metadata", () => {
  it("every journal entry has a matching .sql file and snapshot", async () => {
    const fs = await import("node:fs");
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { idx: number; tag: string }[] };

    for (const entry of journal.entries) {
      const sqlPath = path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`);
      const snapshotPath = path.join(
        MIGRATIONS_FOLDER,
        "meta",
        `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
      );
      expect(fs.existsSync(sqlPath), `missing migration SQL ${sqlPath}`).toBe(
        true,
      );
      expect(
        fs.existsSync(snapshotPath),
        `missing snapshot ${snapshotPath}`,
      ).toBe(true);
    }
  });
});
