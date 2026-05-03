#!/usr/bin/env node
// Task #723 — `drizzle-kit push` is for LOCAL DEVELOPMENT ONLY.
//
// `push` diffs the schema files against the live database and applies the
// result directly with no review step. In production this can drop columns,
// recreate indexes, or wipe data. The reviewable upgrade path is the
// versioned `drizzle-kit generate` + `pnpm migrate` flow documented in
// docs/self-hosting.md.
//
// This guard refuses to run when NODE_ENV=production or when an explicit
// opt-out env (DRIZZLE_PUSH_ALLOW_PRODUCTION=1) is not set. It is intentionally
// crude — anyone trying to bypass it is by definition asking for the
// destructive behaviour and should know what they are doing.

const env = process.env.NODE_ENV ?? "";
const override = process.env.DRIZZLE_PUSH_ALLOW_PRODUCTION === "1";

if (env === "production" && !override) {
  console.error(
    "\n[drizzle-kit push] REFUSED: NODE_ENV=production.\n\n" +
      "  `drizzle-kit push` applies a schema diff directly to the live\n" +
      "  database with no review step and CAN drop columns or wipe data.\n" +
      "  Use the versioned migration flow instead:\n\n" +
      "    1. pnpm --filter @workspace/db run generate   # create reviewable SQL\n" +
      "    2. git diff lib/db/drizzle/                   # review the SQL\n" +
      "    3. pnpm --filter @workspace/db run migrate    # apply against DATABASE_URL\n\n" +
      "  See docs/self-hosting.md for the full upgrade procedure.\n" +
      "  If you absolutely must push against production (you almost certainly\n" +
      "  should not), set DRIZZLE_PUSH_ALLOW_PRODUCTION=1 and re-run.\n",
  );
  process.exit(1);
}
