#!/usr/bin/env node
// Skip a known production build when its dist/ marker is newer than every
// watched source file. Used by the release-gate Playwright config so back-to-
// back runs don't pay the full vite + esbuild cost when nothing has changed.
//
// Usage:
//   node scripts/build-if-stale.mjs <target>
//
// Targets: api-server, vulnrap
//
// Env knobs:
//   E2E_SKIP_PROD_BUILD=1   force-skip the build (caller already built).
//                           No freshness check is performed -- the dist/
//                           is trusted. Use this from CI when the build
//                           step ran in a separate stage.
//   E2E_FORCE_PROD_BUILD=1  force-rebuild even if dist looks fresh.
//                           Useful when the freshness heuristic is suspect
//                           and you want belt-and-braces.
//   BUILD_IF_STALE_ALLOW_MISSING=1
//                           Downgrade a missing watched source path from a
//                           hard failure back to the legacy warn-and-continue
//                           behavior. Intended as a one-off escape hatch for
//                           local situations (e.g. a half-finished rename in
//                           a working copy); do not set this in CI.
//
// On a stale or missing dist the configured build command is executed and
// this script exits with that command's status. On a fresh dist it logs
// "fresh" and exits 0 without spawning a build, so the caller's `&&`-chained
// `start`/`serve` step proceeds immediately.
//
// The watched source list for each target is the union of:
//   - the artifact's own src/ + build configs (declared in `extras` below)
//   - every `@workspace/*` dependency declared in the artifact's package.json,
//     resolved to `lib/<short-name>/src` automatically. This means a new
//     workspace dep added to the artifact starts being watched without any
//     edit here -- crucial because a missed dep means a stale dist getting
//     reused for the release gate. If a dep doesn't follow the
//     `lib/<short-name>/src` convention, the missing-path warning at run
//     time surfaces it loudly.

import { spawn } from "node:child_process";
import { stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const TARGETS = {
  "api-server": {
    pkg: "artifacts/api-server/package.json",
    marker: "artifacts/api-server/dist/index.mjs",
    extras: [
      "artifacts/api-server/src",
      "artifacts/api-server/build.mjs",
      "artifacts/api-server/package.json",
      // build.mjs copies lib/api-spec/openapi.yaml into dist/ at the end of
      // the build; @workspace/api-spec isn't a declared dep of api-server,
      // so list it explicitly here.
      "lib/api-spec/openapi.yaml",
    ],
    build: ["pnpm", ["--filter", "@workspace/api-server", "run", "build"]],
  },
  vulnrap: {
    pkg: "artifacts/vulnrap/package.json",
    marker: "artifacts/vulnrap/dist/public/index.html",
    extras: [
      "artifacts/vulnrap/src",
      "artifacts/vulnrap/index.html",
      "artifacts/vulnrap/vite.config.ts",
      "artifacts/vulnrap/package.json",
      "artifacts/vulnrap/public",
    ],
    build: [
      "pnpm",
      ["--filter", "@workspace/vulnrap", "run", "build:no-prerender"],
    ],
  },
};

// Directory entries we never want to descend into when scanning for the
// newest source mtime. dist/ obviously, node_modules/ for performance, and
// tsconfig build artifacts because they get touched by typecheck runs that
// don't actually invalidate the production bundle.
const SKIP_ENTRIES = new Set([
  "node_modules",
  "dist",
  "tsconfig.tsbuildinfo",
]);

async function newestMtime(p) {
  let s;
  try {
    s = await stat(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (s.isFile()) return s.mtimeMs;
  if (!s.isDirectory()) return null;
  let max = s.mtimeMs;
  const entries = await readdir(p, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const child = path.join(p, entry.name);
    const m = await newestMtime(child);
    if (m !== null && m > max) max = m;
  }
  return max;
}

function runBuild(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`build killed by ${signal}`));
      else resolve(code ?? 0);
    });
  });
}

// Resolve all @workspace/* deps declared in a package.json to relative
// `lib/<short-name>/src` paths. We deliberately union both `dependencies`
// and `devDependencies` because esbuild/vite bundle from anywhere on the
// import graph regardless of which bucket the dep was declared in.
async function workspaceDepSources(pkgRel) {
  const pkg = JSON.parse(
    await readFile(path.join(REPO_ROOT, pkgRel), "utf8"),
  );
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const deps = Object.keys(all).filter((d) => d.startsWith("@workspace/"));
  return deps.map((d) => `lib/${d.slice("@workspace/".length)}/src`);
}

export async function buildSourceList(target) {
  const cfg = TARGETS[target];
  const fromDeps = await workspaceDepSources(cfg.pkg);
  // De-dup: if `extras` already lists a dep's src/ (e.g. for special-case
  // ordering or commentary), don't double-walk it.
  return Array.from(new Set([...cfg.extras, ...fromDeps]));
}

async function main() {
  const target = process.argv[2];
  if (!target || !Object.prototype.hasOwnProperty.call(TARGETS, target)) {
    console.error(
      `usage: build-if-stale.mjs <${Object.keys(TARGETS).join("|")}>`,
    );
    process.exit(2);
  }

  const log = (msg) =>
    process.stderr.write(`[build-if-stale:${target}] ${msg}\n`);

  const cfg = TARGETS[target];

  if (process.env.E2E_SKIP_PROD_BUILD === "1") {
    log("E2E_SKIP_PROD_BUILD=1 — trusting existing dist/, skipping build");
    process.exit(0);
  }

  const force = process.env.E2E_FORCE_PROD_BUILD === "1";
  const markerPath = path.join(REPO_ROOT, cfg.marker);
  let markerMtime = null;
  try {
    markerMtime = (await stat(markerPath)).mtimeMs;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (!force && markerMtime !== null) {
    const sources = await buildSourceList(target);
    const allowMissing = process.env.BUILD_IF_STALE_ALLOW_MISSING === "1";
    let newest = 0;
    let newestPath = null;
    for (const rel of sources) {
      const m = await newestMtime(path.join(REPO_ROOT, rel));
      if (m === null) {
        // Drift detection: a watched path doesn't exist on disk, which
        // usually means a workspace lib was renamed/removed or doesn't
        // follow the lib/<short-name>/src convention. Treating that as
        // "fresh" lets a stale dist get reused indefinitely, so by default
        // we fail loudly. Operators can opt back into the legacy
        // warn-and-continue with BUILD_IF_STALE_ALLOW_MISSING=1.
        const detail =
          `watched source ${rel} does not exist. This usually means a ` +
          `@workspace/* lib was renamed or removed. Update the TARGETS ` +
          `entry in scripts/build-if-stale.mjs (or fix the dep name in ` +
          `the artifact's package.json) so the staleness check can find ` +
          `it. To bypass this check for a one-off local run, set ` +
          `BUILD_IF_STALE_ALLOW_MISSING=1.`;
        if (allowMissing) {
          log(
            `WARN: ${detail} (BUILD_IF_STALE_ALLOW_MISSING=1; continuing)`,
          );
          continue;
        }
        log(`ERROR: rename detected — ${detail}`);
        process.exit(3);
      }
      if (m > newest) {
        newest = m;
        newestPath = rel;
      }
    }
    if (newest <= markerMtime) {
      log(
        `fresh — ${cfg.marker} (${new Date(markerMtime).toISOString()}) is ` +
          `newer than every watched source ` +
          `(latest: ${newestPath} @ ${new Date(newest).toISOString()})`,
      );
      process.exit(0);
    }
    log(
      `stale — ${newestPath} (${new Date(newest).toISOString()}) is newer ` +
        `than ${cfg.marker} (${new Date(markerMtime).toISOString()}); ` +
        `rebuilding`,
    );
  } else if (force) {
    log("E2E_FORCE_PROD_BUILD=1 — rebuilding");
  } else {
    log(`no marker at ${cfg.marker} — building`);
  }

  const code = await runBuild(cfg.build[0], cfg.build[1]);
  process.exit(code);
}

// Only run main() when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
