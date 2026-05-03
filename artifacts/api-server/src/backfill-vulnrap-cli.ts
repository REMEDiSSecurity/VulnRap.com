// CLI entry for the legacy report rescore backfill (Task #760).
//
// The backfill implementation lives in `./backfill-vulnrap` so the
// recurring rescore scheduler (and the unit tests) can import the
// `backfill` function without dragging a top-level `process.exit` /
// argv parser into the api-server bundle. Earlier the CLI runner lived
// at the bottom of `backfill-vulnrap.ts` behind an `isInvokedAsScript`
// guard, but esbuild inlined that file into `dist/index.mjs` and the
// guard's identity check was fragile enough that any regression in it
// silently kicked off the backfill on every API server start. Splitting
// the CLI entry into its own module removes the auto-run path
// entirely: `dist/index.mjs` no longer contains a `backfill(...)` call
// site, only this file's bundle (`dist/backfill-vulnrap-cli.mjs`) does.
//
// Usage (from artifacts/api-server):
//   pnpm run build && node --enable-source-maps ./dist/backfill-vulnrap-cli.mjs
// Flags: see `parseArgs` in `backfill-vulnrap-helpers.ts`.

import { backfill } from "./backfill-vulnrap";
import { parseArgs, CliExit, type CliOpts } from "./backfill-vulnrap-helpers";

let parsed: CliOpts;
try {
  parsed = parseArgs(process.argv);
} catch (err) {
  if (err instanceof CliExit) {
    if (err.code === 0) console.log(err.message);
    else console.error(err.message);
    process.exit(err.code);
  }
  throw err;
}

backfill(parsed)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
