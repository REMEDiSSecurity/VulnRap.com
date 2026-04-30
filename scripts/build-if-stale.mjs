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
//   BUILD_IF_STALE_CACHE_DIR=<path>
//                           override where the persistent dist/ cache lives
//                           (defaults to <repo>/.cache/build-if-stale).
//   BUILD_IF_STALE_DISABLE_CACHE=1
//                           skip both the cache restore and the post-build
//                           cache save. Use when debugging cache behaviour
//                           or when disk pressure is more painful than the
//                           ~15s rebuild.
//
// On a stale or missing dist the configured build command is executed and
// this script exits with that command's status. On a fresh dist it logs
// "fresh" and exits 0 without spawning a build, so the caller's `&&`-chained
// `start`/`serve` step proceeds immediately.
//
// Persistent cache (Task #351):
//   When the per-container `dist/` is missing or stale we don't immediately
//   rebuild -- we first compute a SHA-256 digest of the watched source set
//   (the same source list the freshness check walks, plus each file's
//   contents and the configured build command) and look for a matching
//   `dist/` snapshot under `.cache/build-if-stale/<target>/<hash>/dist`.
//   On a hit we copy that snapshot into place, touch the marker forward in
//   time (so the next freshness check passes without re-reading every
//   source file), and exit 0 without spawning vite/esbuild. On a miss we
//   build from sources and then snapshot the resulting `dist/` into the
//   cache so the next cold container hits.
//
//   The cache survives across full container restarts because it lives in
//   the workspace's `.cache/` (which persists), not under `dist/` (which
//   gets wiped by `artifacts/api-server/build.mjs`'s pre-build cleanup or
//   by ad-hoc `rm -rf dist/` invocations). Each target keeps the most
//   recent few entries; older snapshots are pruned automatically so the
//   cache directory doesn't grow without bound.
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
import {
  stat,
  readdir,
  readFile,
  mkdir,
  cp,
  rm,
  rename,
  utimes,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const TARGETS = {
  "api-server": {
    pkg: "artifacts/api-server/package.json",
    dist: "artifacts/api-server/dist",
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
    dist: "artifacts/vulnrap/dist",
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

// Persistent cross-restart cache root. Lives in the workspace's `.cache/`
// (which is gitignored and survives full container restarts) so a fresh
// container with the same source set can restore the prior dist/ instead
// of paying the full vite + esbuild cost.
const DEFAULT_CACHE_ROOT = path.join(REPO_ROOT, ".cache", "build-if-stale");

// How many cached dist/ snapshots to keep per target before evicting the
// oldest. Three is enough to cover "current branch + the branch I just
// switched away from + the merge commit I just rebased onto" without
// letting the cache grow unbounded across a long working session.
const MAX_CACHE_ENTRIES_PER_TARGET = 3;

function cacheRoot() {
  return process.env.BUILD_IF_STALE_CACHE_DIR || DEFAULT_CACHE_ROOT;
}

function cacheEntryDir(target, hash) {
  return path.join(cacheRoot(), target, hash);
}

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

// Recursively yield every file path under `p`, in a deterministic
// (lexicographic) order so the cache-key digest is stable across runs.
// Skips the same entries the freshness scan does. Returns nothing if the
// path doesn't exist (the caller surfaces the drift via the same
// "watched source ... does not exist" warning the freshness check uses).
async function* walkFiles(p) {
  let s;
  try {
    s = await stat(p);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (s.isFile()) {
    yield p;
    return;
  }
  if (!s.isDirectory()) return;
  const entries = await readdir(p, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    yield* walkFiles(path.join(p, entry.name));
  }
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

// Compute a content-addressed cache key for `target` derived from the same
// source list the freshness check walks. We hash:
//   1. the build command (so changing build args invalidates the cache
//      without needing a source edit)
//   2. the dist marker path (defence in depth: a marker move would cache
//      against the wrong layout)
//   3. for every file under every watched source path (in sorted order):
//      the file's relative path and a SHA-256 of its contents.
//
// Mtimes are deliberately *not* mixed in: a fresh container clone has
// brand-new mtimes everywhere and would never hit the cache otherwise.
// Content hashing means an identical source tree on a cold container
// produces the same key as the warm container that originally populated
// the cache.
export async function cacheKey(target) {
  const cfg = TARGETS[target];
  const sources = await buildSourceList(target);
  const sortedSources = [...sources].sort();
  const hash = createHash("sha256");
  hash.update(`cmd:${JSON.stringify(cfg.build)}\n`);
  hash.update(`marker:${cfg.marker}\n`);
  for (const rel of sortedSources) {
    const abs = path.join(REPO_ROOT, rel);
    for await (const file of walkFiles(abs)) {
      const fileRel = path.relative(REPO_ROOT, file);
      const buf = await readFile(file);
      const fileHash = createHash("sha256").update(buf).digest("hex");
      hash.update(`${fileRel}\0${fileHash}\n`);
    }
  }
  return hash.digest("hex");
}

// Try to restore `target`'s dist/ from the persistent cache. Returns true
// if a matching snapshot was found and copied into place; false if no hit.
// The marker mtime is bumped to now so the very next freshness check
// passes without re-reading every watched source.
export async function restoreFromCache(target, hash, log = () => {}) {
  const cfg = TARGETS[target];
  const distAbs = path.join(REPO_ROOT, cfg.dist);
  const markerAbs = path.join(REPO_ROOT, cfg.marker);
  const cacheDir = cacheEntryDir(target, hash);
  const cacheDist = path.join(cacheDir, "dist");
  try {
    await stat(cacheDist);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  // Copy the cached snapshot into a sibling tmp dir, then atomically swap
  // it into place. This avoids leaving a half-populated dist/ behind if
  // the copy gets interrupted mid-run.
  const parentDir = path.dirname(distAbs);
  await mkdir(parentDir, { recursive: true });
  const tmpRestore = path.join(
    parentDir,
    `.dist.restore-${process.pid}-${Date.now()}`,
  );
  await rm(tmpRestore, { recursive: true, force: true });
  await cp(cacheDist, tmpRestore, { recursive: true });
  await rm(distAbs, { recursive: true, force: true });
  await rename(tmpRestore, distAbs);
  // Bump the marker forward so the freshness comparison done by future
  // build-if-stale runs (and by this run's caller, e.g. Playwright) sees
  // the restored dist as newer than every watched source. cp preserves
  // the cache's mtimes, which can be older than freshly-cloned sources.
  const now = new Date();
  try {
    await utimes(markerAbs, now, now);
  } catch (err) {
    // Marker missing post-restore would mean the cache snapshot itself was
    // corrupt -- bail loudly so the caller falls back to a real build.
    log(
      `WARN: cache restore left no marker at ${cfg.marker}: ${err.message}; ` +
        `treating restore as a miss`,
    );
    await rm(distAbs, { recursive: true, force: true });
    return false;
  }
  return true;
}

// Snapshot a successful build's dist/ into the cache under the current
// source-set hash. Uses tmp + rename so a crash mid-copy doesn't leave a
// partially-populated cache entry that a later run would mistake for a
// hit. After saving, prunes any older entries beyond the per-target cap.
export async function saveToCache(target, hash, log = () => {}) {
  const cfg = TARGETS[target];
  const distAbs = path.join(REPO_ROOT, cfg.dist);
  try {
    const s = await stat(distAbs);
    if (!s.isDirectory()) {
      log(`WARN: ${cfg.dist} is not a directory; skipping cache save`);
      return false;
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      log(`WARN: ${cfg.dist} missing post-build; skipping cache save`);
      return false;
    }
    throw err;
  }
  const targetDir = path.join(cacheRoot(), target);
  await mkdir(targetDir, { recursive: true });
  const finalDir = cacheEntryDir(target, hash);
  const tmpDir = path.join(
    targetDir,
    `.tmp-${process.pid}-${Date.now()}-${hash.slice(0, 8)}`,
  );
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await cp(distAbs, path.join(tmpDir, "dist"), { recursive: true });
  // Replace any existing entry under this hash (e.g. from a partially-
  // completed prior save) with the freshly-staged copy.
  await rm(finalDir, { recursive: true, force: true });
  await rename(tmpDir, finalDir);
  await pruneCache(target, log);
  return true;
}

async function pruneCache(target, log = () => {}) {
  const targetDir = path.join(cacheRoot(), target);
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Stale tmp dirs from interrupted saves; reap eagerly.
    if (entry.name.startsWith(".tmp-") || entry.name.startsWith(".dist.")) {
      await rm(path.join(targetDir, entry.name), {
        recursive: true,
        force: true,
      });
      continue;
    }
    const p = path.join(targetDir, entry.name);
    const s = await stat(p);
    dirs.push({ path: p, mtimeMs: s.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const d of dirs.slice(MAX_CACHE_ENTRIES_PER_TARGET)) {
    log(`evicting old cache entry ${path.relative(REPO_ROOT, d.path)}`);
    await rm(d.path, { recursive: true, force: true });
  }
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
  const cacheDisabled = process.env.BUILD_IF_STALE_DISABLE_CACHE === "1";
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
        `checking persistent cache before rebuilding`,
    );
  } else if (force) {
    log("E2E_FORCE_PROD_BUILD=1 — rebuilding (cache restore skipped)");
  } else {
    log(
      `no marker at ${cfg.marker} — checking persistent cache before building`,
    );
  }

  // Try the persistent cache before paying for a full build. A force-
  // rebuild bypasses both the restore *and* the post-build save, since
  // the operator asked for a known-good fresh artifact.
  if (!force && !cacheDisabled) {
    try {
      const hash = await cacheKey(target);
      const restored = await restoreFromCache(target, hash, log);
      if (restored) {
        log(
          `restored ${cfg.dist} from persistent cache ` +
            `(${path.relative(REPO_ROOT, cacheEntryDir(target, hash))}); ` +
            `skipping rebuild`,
        );
        process.exit(0);
      }
      log(
        `no persistent-cache entry for source-set hash ${hash.slice(0, 12)}; ` +
          `building from sources`,
      );
    } catch (err) {
      // Cache failures must never block a build -- log and fall through.
      log(`WARN: persistent cache restore failed (${err.message}); building`);
    }
  } else if (cacheDisabled) {
    log(
      "BUILD_IF_STALE_DISABLE_CACHE=1 — skipping persistent-cache restore",
    );
  }

  const code = await runBuild(cfg.build[0], cfg.build[1]);
  if (code === 0 && !cacheDisabled) {
    try {
      const hash = await cacheKey(target);
      const saved = await saveToCache(target, hash, log);
      if (saved) {
        log(
          `cached ${cfg.dist} for source-set hash ${hash.slice(0, 12)} ` +
            `under ${path.relative(REPO_ROOT, cacheEntryDir(target, hash))}`,
        );
      }
    } catch (err) {
      // Same as restore: never fail the script because the cache save
      // misbehaved -- the build itself succeeded, that's what matters.
      log(`WARN: persistent cache save failed (${err.message})`);
    }
  }
  process.exit(code);
}

// Only run main() when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
