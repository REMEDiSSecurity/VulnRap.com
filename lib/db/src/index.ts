import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
// NOTE: page_views is NOT defined in this package. It is owned by the
// api-server (see artifacts/api-server/src/lib/page-views-table.ts and
// startup-migrations.ts) so that drizzle-kit, which the Replit deploy
// validator runs against this package, has no reference to it and never
// generates an ALTER for its columns.
