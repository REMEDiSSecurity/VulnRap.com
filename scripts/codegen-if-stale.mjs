#!/usr/bin/env node
// Skip the OpenAPI client codegen when no input has changed since the
// generated client was last written. Mirrors the freshness-marker pattern
// in scripts/build-if-stale.mjs, but specialised for the
// `pnpm --filter @workspace/api-spec run codegen` step that the root
// `postinstall` runs on every `pnpm install`.
//
// Why this exists:
//   Task #306 wired codegen into `postinstall` so the generated client
//   never goes stale. The trade-off was that orval ran end-to-end
//   (~14s locally) on every install even when nobody had touched
//   lib/api-spec/openapi.yaml. This script gates the codegen behind a
//   freshness check so the common "spec didn't change" install pays
//   nothing, while a real spec edit still triggers a clean regen.
//
// What's checked:
//   - Watched sources: lib/api-spec/openapi.yaml (the spec) and
//     lib/api-spec/orval.config.ts (changing generator options also
//     requires a regen).
//   - Markers: lib/api-client-react/src/generated/api.ts and
//     lib/api-zod/src/generated/api.ts. We compare against the *oldest*
//     marker so a half-completed prior run that only wrote one of the
//     two still re-triggers codegen.
//   - If any marker is missing, codegen runs unconditionally.
//   - If every marker is at least as new as every watched source,
//     codegen is skipped.
//
// Usage:
//   node scripts/codegen-if-stale.mjs
//
// Env knobs:
//   FORCE_CODEGEN=1        force-run codegen even if the markers look fresh.
//   E2E_FORCE_CODEGEN=1    alias for FORCE_CODEGEN=1, kept so callers that
//                          already follow the E2E_FORCE_* convention used by
//                          scripts/build-if-stale.mjs (E2E_FORCE_PROD_BUILD=1)
//                          can use the same prefix here. Either flag wins;
//                          there is no semantic difference. Use when the
//                          freshness heuristic is suspect (e.g. mtimes were
//                          stomped by a sync tool) and you want a
//                          belt-and-braces regeneration.
//
// Note: scripts/verify-codegen.mjs deliberately does NOT call this script.
// That wrapper is the safety net that runs codegen unconditionally and
// diffs the result against the index, so it must keep paying the full
// cost regardless of mtimes.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Inputs that, when newer than the generated client, mean we need to
// regenerate. Kept narrow on purpose -- broader watches (e.g. the whole
// lib/api-spec/ dir) would re-trigger codegen on unrelated edits like
// README tweaks.
const WATCHED_SOURCES = [
  "lib/api-spec/openapi.yaml",
  "lib/api-spec/orval.config.ts",
];

// Files orval writes on every codegen run. Each one is the "marker" for
// its generated dir; if any is missing we treat the whole codegen as
// stale so a partial prior run can't masquerade as fresh.
const MARKERS = [
  "lib/api-client-react/src/generated/api.ts",
  "lib/api-zod/src/generated/api.ts",
];

const CODEGEN_CMD = "pnpm";
const CODEGEN_ARGS = ["--filter", "@workspace/api-spec", "run", "codegen"];

function log(msg) {
  process.stderr.write(`[codegen-if-stale] ${msg}\n`);
}

async function mtime(rel) {
  try {
    const s = await stat(path.join(REPO_ROOT, rel));
    return s.mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function runCodegen() {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEGEN_CMD, CODEGEN_ARGS, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`codegen killed by ${signal}`));
      else resolve(code ?? 0);
    });
  });
}

async function main() {
  // Accept either the local FORCE_CODEGEN=1 name or the E2E_FORCE_*
  // alias so callers that already follow the build-if-stale.mjs prefix
  // convention don't have to learn a second knob.
  if (
    process.env.FORCE_CODEGEN === "1" ||
    process.env.E2E_FORCE_CODEGEN === "1"
  ) {
    const which =
      process.env.FORCE_CODEGEN === "1" ? "FORCE_CODEGEN" : "E2E_FORCE_CODEGEN";
    log(`${which}=1 — regenerating unconditionally`);
    const code = await runCodegen();
    process.exit(code);
  }

  // Find the oldest marker. If any marker is missing, the codegen output
  // is incomplete and we must regenerate.
  let oldestMarker = Infinity;
  let oldestMarkerPath = null;
  for (const rel of MARKERS) {
    const m = await mtime(rel);
    if (m === null) {
      log(`marker ${rel} missing — running codegen`);
      const code = await runCodegen();
      process.exit(code);
    }
    if (m < oldestMarker) {
      oldestMarker = m;
      oldestMarkerPath = rel;
    }
  }

  // Find the newest watched source. If a watched source is missing, the
  // spec setup is broken in a way codegen itself will surface more
  // clearly than this script can -- fall through and let orval complain.
  let newestSource = 0;
  let newestSourcePath = null;
  for (const rel of WATCHED_SOURCES) {
    const m = await mtime(rel);
    if (m === null) {
      log(
        `watched source ${rel} missing — running codegen so orval can ` +
          `surface the real error`,
      );
      const code = await runCodegen();
      process.exit(code);
    }
    if (m > newestSource) {
      newestSource = m;
      newestSourcePath = rel;
    }
  }

  if (newestSource <= oldestMarker) {
    log(
      `fresh — every marker (oldest: ${oldestMarkerPath} @ ` +
        `${new Date(oldestMarker).toISOString()}) is newer than every ` +
        `watched source (latest: ${newestSourcePath} @ ` +
        `${new Date(newestSource).toISOString()}); skipping codegen`,
    );
    process.exit(0);
  }

  log(
    `stale — ${newestSourcePath} (${new Date(newestSource).toISOString()}) ` +
      `is newer than ${oldestMarkerPath} ` +
      `(${new Date(oldestMarker).toISOString()}); running codegen`,
  );
  const code = await runCodegen();
  process.exit(code);
}

// Only run main() when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { WATCHED_SOURCES, MARKERS };
