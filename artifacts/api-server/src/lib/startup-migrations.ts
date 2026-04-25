import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

type AdditiveMigration = {
  id: string;
  description: string;
  statements: string[];
};

const ADDITIVE_MIGRATIONS: AdditiveMigration[] = [
  {
    id: "2026-04-23-add-reports-avri-family",
    description: "Add nullable avri_family column + index to reports",
    statements: [
      `ALTER TABLE reports ADD COLUMN IF NOT EXISTS avri_family varchar(32)`,
      `CREATE INDEX IF NOT EXISTS idx_reports_avri_family ON reports (avri_family)`,
    ],
  },
  {
    id: "2026-04-23-add-lsh-buckets-gin-index",
    description: "Add GIN index on lsh_buckets JSONB for efficient containment queries",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_reports_lsh_buckets ON reports USING gin (lsh_buckets)`,
    ],
  },
  {
    // page_views was originally provisioned with (path varchar, count int) but the
    // visitor-analytics rewrite expects (visitor_hash, view_date, created_at).
    // Idempotent: only drops the table if the legacy "path" column is still present;
    // otherwise the CREATE IF NOT EXISTS no-ops on already-correct deployments.
    id: "2026-04-25-rebuild-page-views-visitor-schema",
    description: "Rebuild page_views table with visitor_hash + view_date schema",
    statements: [
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'page_views' AND column_name = 'path'
         ) THEN
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
  for (const migration of ADDITIVE_MIGRATIONS) {
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
