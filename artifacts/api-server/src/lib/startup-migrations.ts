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
