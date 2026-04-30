#!/usr/bin/env node
// Standalone sanity test for scripts/build-if-stale.mjs. Verifies:
//   1. The watch list for each release-gate target includes every
//      currently-declared @workspace/* dependency, so a new shared lib can't
//      be silently omitted (this is what regressed in task #202's first
//      pass: lib/avri-rubric/src was missing from both targets).
//   2. The freshness logic in build-if-stale.mjs actually treats a touched
//      file in a watched workspace dep as "stale" and would trigger a
//      rebuild. We invoke the script with the build command stubbed out to
//      `true` so no real esbuild/vite work runs -- the test only cares
//      whether the script decided to spawn the build at all.
//   3. A missing watched source path (e.g. a renamed @workspace lib) makes
//      the script fail loudly by default, but BUILD_IF_STALE_ALLOW_MISSING=1
//      restores the legacy warn-and-continue behavior.
//   4. The persistent cross-restart cache (Task #351):
//      - cacheKey() is stable across calls when source contents don't
//        change, but flips when a watched file's contents change (so a new
//        @workspace/* dep, whose new lib/<short>/src is freshly hashed,
//        invalidates automatically).
//      - saveToCache + restoreFromCache round-trip a dist/ snapshot, and
//        the restored marker mtime is bumped past the watched-source mtime
//        so the next freshness check sees it as fresh.
//      - A cold start (no dist/) with a populated cache short-circuits
//        the build and restores the prior dist/ instead of spawning the
//        configured build command.
//
// Run: `node scripts/build-if-stale.test.mjs` (exit 0 == pass)

import { spawnSync } from "node:child_process";
import {
  stat,
  utimes,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TARGETS,
  buildSourceList,
  cacheKey,
  saveToCache,
  restoreFromCache,
} from "./build-if-stale.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// --- Test 1: every @workspace/* dep is covered by the watch list ---
for (const [target, cfg] of Object.entries(TARGETS)) {
  const pkgPath = path.join(REPO_ROOT, cfg.pkg);
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const deps = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  }).filter((d) => d.startsWith("@workspace/"));
  const sources = await buildSourceList(target);
  for (const dep of deps) {
    const short = dep.slice("@workspace/".length);
    const expected = `lib/${short}/src`;
    check(
      `${target}: watches ${expected} (from ${dep})`,
      sources.includes(expected),
      `sources=${JSON.stringify(sources)}`,
    );
  }
}

// --- Test 2: touching a watched dep triggers the rebuild path ---
//
// We use the api-server target because @workspace/avri-rubric is a real
// declared dep there and was the specific gap that the first pass of this
// task missed. We bump the mtime of one of its source files past the
// dist/index.mjs marker, then invoke build-if-stale.mjs with $PATH munged
// so its `pnpm` invocation resolves to a stub that just exits 0 (no real
// build). The script's own log line on stderr tells us which path it took.

async function fileNewerThanMarker(target, sourceRel) {
  const cfg = TARGETS[target];
  // Bump the touched file's mtime to a fixed point well in the future so
  // it's guaranteed to be the newest watched source -- otherwise an
  // mtime leaked by a different file (e.g. package.json from an earlier
  // test run, or an editor save) would beat it and the assertion that
  // mentions this specific source by name would fail.
  const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await utimes(path.join(REPO_ROOT, sourceRel), farFuture, farFuture);
  // Sanity check: the marker must exist (callers already checked) so
  // touching a future mtime here can only ever produce a "stale" result.
  await stat(path.join(REPO_ROOT, cfg.marker));
}

async function withPnpmStub(env, fn) {
  // Create a tiny "pnpm" shim in a tmp dir and prepend it to PATH so the
  // script's spawn("pnpm", ...) resolves to it instead of the real one.
  // The shim records its invocation to a marker file so the test can
  // assert whether the build was spawned at all (not just whether the
  // script exited 0 after a cache hit).
  const stubDir = path.join(REPO_ROOT, ".local", "tmp-build-if-stale-test");
  await mkdir(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, "pnpm");
  const invokedMarker = path.join(stubDir, "pnpm-was-invoked");
  await rm(invokedMarker, { force: true });
  await writeFile(
    stubPath,
    `#!/usr/bin/env sh\necho '[pnpm-stub] would build'\ntouch '${invokedMarker}'\nexit 0\n`,
  );
  await chmod(stubPath, 0o755);
  const prevPath = process.env.PATH;
  const prevEnv = {};
  for (const k of Object.keys(env || {})) prevEnv[k] = process.env[k];
  process.env.PATH = `${stubDir}${path.delimiter}${prevPath}`;
  for (const [k, v] of Object.entries(env || {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const wasInvoked = async () => {
      try {
        await stat(invokedMarker);
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    };
    return await fn(wasInvoked);
  } finally {
    process.env.PATH = prevPath;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const target = "api-server";
const cfg = TARGETS[target];
// Make sure dist marker exists; if not, the test environment isn't set up
// (developer should run `pnpm --filter @workspace/api-server run build` once).
let markerExists = true;
try {
  await stat(path.join(REPO_ROOT, cfg.marker));
} catch (err) {
  if (err.code === "ENOENT") markerExists = false;
  else throw err;
}
check(
  "api-server dist marker exists (prereq for staleness test)",
  markerExists,
  `expected ${cfg.marker} to exist; run the api-server build once first`,
);

if (markerExists) {
  // Pick a real source file inside lib/avri-rubric/src to touch.
  const rubricSrc = "lib/avri-rubric/src";
  const entries = await readdir(path.join(REPO_ROOT, rubricSrc), {
    withFileTypes: true,
    recursive: true,
  });
  const file = entries.find((e) => e.isFile());
  check(
    "lib/avri-rubric/src has at least one file to touch",
    Boolean(file),
  );

  if (file) {
    const touched = path.join(rubricSrc, file.name);
    await fileNewerThanMarker(target, touched);
    // Disable the persistent cache so this test purely exercises the
    // mtime-based staleness path. (Tests 5 and 6 below exercise the cache.)
    const result = await withPnpmStub(
      { BUILD_IF_STALE_DISABLE_CACHE: "1" },
      () =>
        spawnSync(
          process.execPath,
          [path.join(__dirname, "build-if-stale.mjs"), target],
          { cwd: REPO_ROOT, encoding: "utf8" },
        ),
    );
    const stderr = result.stderr ?? "";
    check(
      "touching lib/avri-rubric/src is detected as stale",
      stderr.includes("stale —") && stderr.includes("avri-rubric"),
      `stdout=${result.stdout}\nstderr=${stderr}`,
    );
    check(
      "stub build exit code propagates as 0",
      result.status === 0,
      `status=${result.status}`,
    );
  }
}

// --- Test 3: a missing watched source path (e.g. a renamed @workspace lib)
// causes the script to fail loudly by default, but can be downgraded back to
// the legacy warn-and-continue behavior with BUILD_IF_STALE_ALLOW_MISSING=1.
//
// We simulate a renamed lib by temporarily injecting a fake `@workspace/<x>`
// dep into the api-server package.json -- the script will resolve it to
// `lib/<x>/src`, which doesn't exist on disk, exercising the new branch.
// The package.json is restored in a finally so a mid-test crash can't leave
// the working copy dirty.
//
// We also disable the persistent cache (BUILD_IF_STALE_DISABLE_CACHE=1) for
// the warn-and-continue path so the script reaches the fresh/stale decision
// the assertion below expects, instead of restoring from a cache populated
// by an earlier test run.

async function withInjectedFakeDep(fakeDep, fn) {
  const pkgRel = TARGETS["api-server"].pkg;
  const pkgAbs = path.join(REPO_ROOT, pkgRel);
  const original = await readFile(pkgAbs, "utf8");
  // Capture the original atime/mtime so we can restore them after the test.
  // build-if-stale.mjs uses package.json's mtime as a watched source, so a
  // bumped mtime here would leak into Test 2 (and any future invocation of
  // the freshness check) and falsely flag the artifact as stale.
  const originalStat = await stat(pkgAbs);
  try {
    const parsed = JSON.parse(original);
    parsed.dependencies = { ...(parsed.dependencies ?? {}), [fakeDep]: "workspace:*" };
    // Preserve trailing newline if the original had one, to minimize churn.
    const trailingNewline = original.endsWith("\n") ? "\n" : "";
    await writeFile(
      pkgAbs,
      JSON.stringify(parsed, null, 2) + trailingNewline,
    );
    return await fn();
  } finally {
    await writeFile(pkgAbs, original);
    await utimes(pkgAbs, originalStat.atime, originalStat.mtime);
  }
}

if (markerExists) {
  // The fake dep name must not collide with anything real in lib/. Use a
  // sentinel that's obviously test-only.
  const fakeDep = "@workspace/__renamed_for_test__";
  const expectedMissingPath = "lib/__renamed_for_test__/src";

  // Default: missing watched path -> hard failure with a clear rename hint.
  const failResult = await withInjectedFakeDep(fakeDep, () =>
    withPnpmStub({}, () =>
      spawnSync(
        process.execPath,
        [path.join(__dirname, "build-if-stale.mjs"), "api-server"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          // Ensure no stale env knob bleeds in from the parent shell.
          env: { ...process.env, BUILD_IF_STALE_ALLOW_MISSING: "" },
        },
      ),
    ),
  );
  const failStderr = failResult.stderr ?? "";
  // Exit status 3 is the dedicated rename-detected code in build-if-stale.mjs;
  // asserting it exactly catches the case where the script crashed for some
  // unrelated reason and happened to produce a non-zero status.
  check(
    "missing watched source exits with the rename-detected status (3)",
    failResult.status === 3,
    `status=${failResult.status}\nstderr=${failStderr}`,
  );
  check(
    "missing watched source error mentions rename + the missing path",
    failStderr.includes("ERROR: rename detected") &&
      failStderr.includes(expectedMissingPath),
    `stderr=${failStderr}`,
  );
  check(
    "missing watched source error points operator at BUILD_IF_STALE_ALLOW_MISSING",
    failStderr.includes("BUILD_IF_STALE_ALLOW_MISSING=1"),
    `stderr=${failStderr}`,
  );

  // Opt-out: BUILD_IF_STALE_ALLOW_MISSING=1 restores the legacy
  // warn-and-continue behavior so the freshness check still completes.
  // Disable the persistent cache here so the script doesn't short-circuit
  // by restoring from a cached snapshot (which would skip past the
  // fresh/stale decision the assertion below looks for).
  const allowResult = await withInjectedFakeDep(fakeDep, () =>
    withPnpmStub({}, () =>
      spawnSync(
        process.execPath,
        [path.join(__dirname, "build-if-stale.mjs"), "api-server"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            BUILD_IF_STALE_ALLOW_MISSING: "1",
            BUILD_IF_STALE_DISABLE_CACHE: "1",
          },
        },
      ),
    ),
  );
  const allowStderr = allowResult.stderr ?? "";
  check(
    "BUILD_IF_STALE_ALLOW_MISSING=1 still warns about the missing path",
    allowStderr.includes("WARN:") && allowStderr.includes(expectedMissingPath),
    `stderr=${allowStderr}`,
  );
  check(
    "BUILD_IF_STALE_ALLOW_MISSING=1 continues past the missing path " +
      "(reaches fresh/stale decision)",
    allowStderr.includes("fresh —") || allowStderr.includes("stale —"),
    `stderr=${allowStderr}`,
  );
  // With the stub pnpm in place both code paths (fresh, or stale-then-
  // stub-build) finish with status 0, so we can assert exactly on that --
  // a non-zero status here would mean the opt-out path itself broke or
  // the script reached the rename-detected exit (3) anyway.
  check(
    "BUILD_IF_STALE_ALLOW_MISSING=1 exits 0 (freshness check completed)",
    allowResult.status === 0,
    `status=${allowResult.status}\nstderr=${allowStderr}`,
  );
}

// --- Test 4: cacheKey() is content-addressed and stable ---
//
// We assert two things:
//   - Calling cacheKey() twice in a row with no changes yields the same
//     digest. Mtimes alone (which can drift with no content change) must
//     not influence the key, otherwise a fresh container clone would
//     produce a different digest from the warm container that populated
//     the cache.
//   - Modifying a watched source file's *contents* changes the digest.
//     This is what makes "add a new @workspace/* dep" automatically
//     invalidate: the new dep's lib/<short>/src files contribute to the
//     hash, and they didn't exist in the previous source set.
{
  const a = await cacheKey(target);
  const b = await cacheKey(target);
  check(
    "cacheKey is stable across back-to-back calls",
    a === b,
    `a=${a}\nb=${b}`,
  );

  // Mutate a source file's contents (append a comment) to verify the
  // hash flips. Restore the original contents AND original mtime/atime
  // afterwards so the change doesn't poison subsequent test runs or
  // developer workflows -- in particular, leaking a bumped package.json
  // mtime into Test 2 falsely flags the wrong source as the newest.
  const probePath = path.join(REPO_ROOT, "artifacts/api-server/package.json");
  const original = await readFile(probePath);
  const originalProbeStat = await stat(probePath);
  try {
    await writeFile(probePath, original + "\n");
    const c = await cacheKey(target);
    check(
      "cacheKey changes when a watched source's contents change",
      c !== a,
      `before=${a}\nafter=${c}`,
    );
  } finally {
    await writeFile(probePath, original);
    await utimes(probePath, originalProbeStat.atime, originalProbeStat.mtime);
  }

  // After restoring the file the hash should match the original again,
  // confirming the digest is purely content-addressed (no hidden state).
  const d = await cacheKey(target);
  check(
    "cacheKey returns to the original digest once contents are restored",
    d === a,
    `original=${a}\nrestored=${d}`,
  );
}

// --- Test 5: save/restore round-trip via an isolated cache directory ---
//
// Use BUILD_IF_STALE_CACHE_DIR to point at a scratch dir so we don't
// pollute the real cache with test artifacts. Save the current dist/,
// wipe dist/, then restore from cache and assert the marker re-appears
// AND its mtime is newer than every watched source (so the very next
// freshness check would treat dist/ as fresh).
if (markerExists) {
  const scratchCache = path.join(
    REPO_ROOT,
    ".local",
    "tmp-build-if-stale-cache",
  );
  await rm(scratchCache, { recursive: true, force: true });
  const prevCacheDir = process.env.BUILD_IF_STALE_CACHE_DIR;
  process.env.BUILD_IF_STALE_CACHE_DIR = scratchCache;

  const distAbs = path.join(REPO_ROOT, cfg.dist);
  const markerAbs = path.join(REPO_ROOT, cfg.marker);
  // Snapshot dist into the scratch cache. We have to do this *before*
  // wiping dist below.
  const hash = await cacheKey(target);
  const saved = await saveToCache(target, hash);
  check("saveToCache reports a successful snapshot", saved === true);

  // Backup dist/ before wiping so we can restore it manually if the
  // restore-from-cache path fails (the test should never destroy a
  // developer's dist/ permanently).
  const distBackup = path.join(
    REPO_ROOT,
    ".local",
    `tmp-build-if-stale-dist-backup-${process.pid}`,
  );
  await rm(distBackup, { recursive: true, force: true });
  // Use cp via child_process to avoid pulling in fs.promises.cp here too.
  spawnSync("cp", ["-a", distAbs, distBackup], { stdio: "inherit" });

  try {
    // Wipe dist/ to simulate a fresh container.
    await rm(distAbs, { recursive: true, force: true });
    let preRestoreMissing = false;
    try {
      await stat(markerAbs);
    } catch (err) {
      if (err.code === "ENOENT") preRestoreMissing = true;
      else throw err;
    }
    check("dist/ is wiped before restore (precondition)", preRestoreMissing);

    const restored = await restoreFromCache(target, hash);
    check("restoreFromCache reports a hit", restored === true);

    // Marker should exist again.
    let restoredMarkerStat;
    try {
      restoredMarkerStat = await stat(markerAbs);
    } catch (err) {
      check("marker exists after restore", false, err.message);
      throw err;
    }
    check("marker exists after restore", true);

    // Marker mtime should be >= the newest watched-source mtime, so a
    // follow-up freshness check would see it as fresh. This is the
    // critical bit: cp preserves the cache snapshot's mtimes, which can
    // be older than freshly-cloned sources, so the restore path bumps
    // the marker forward.
    const sources = await buildSourceList(target);
    let newestSource = 0;
    for (const rel of sources) {
      const abs = path.join(REPO_ROOT, rel);
      let s;
      try {
        s = await stat(abs);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      if (s.mtimeMs > newestSource) newestSource = s.mtimeMs;
    }
    check(
      "restored marker mtime is >= newest watched source mtime",
      restoredMarkerStat.mtimeMs >= newestSource,
      `marker=${restoredMarkerStat.mtimeMs} newestSource=${newestSource}`,
    );

    // --- Test 6: end-to-end cold-start cache hit via the script ---
    //
    // Wipe dist/ AGAIN, then invoke build-if-stale.mjs as a subprocess.
    // The pnpm stub records whether it was invoked. With a populated
    // cache and a matching source set the stub should NOT run.
    await rm(distAbs, { recursive: true, force: true });
    const result = await withPnpmStub(
      { BUILD_IF_STALE_CACHE_DIR: scratchCache },
      async (wasInvoked) => {
        const r = spawnSync(
          process.execPath,
          [path.join(__dirname, "build-if-stale.mjs"), target],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: {
              ...process.env,
              BUILD_IF_STALE_CACHE_DIR: scratchCache,
            },
          },
        );
        return { result: r, invoked: await wasInvoked() };
      },
    );
    check(
      "cold-start with populated cache exits 0",
      result.result.status === 0,
      `status=${result.result.status}\nstderr=${result.result.stderr}`,
    );
    check(
      "cold-start with populated cache does NOT spawn the build",
      result.invoked === false,
      `pnpm stub invocation marker existed (build was spawned)`,
    );
    check(
      "cold-start log mentions cache restore",
      (result.result.stderr ?? "").includes("restored"),
      `stderr=${result.result.stderr}`,
    );

    // Marker is back on disk after the restore.
    let postScriptMarker = false;
    try {
      await stat(markerAbs);
      postScriptMarker = true;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    check(
      "marker exists on disk after the script restored from cache",
      postScriptMarker,
    );
  } finally {
    // Restore the developer's original dist/ from the backup we made,
    // regardless of whether the assertions above passed.
    await rm(distAbs, { recursive: true, force: true });
    spawnSync("cp", ["-a", distBackup, distAbs], { stdio: "inherit" });
    await rm(distBackup, { recursive: true, force: true });
    await rm(scratchCache, { recursive: true, force: true });
    if (prevCacheDir === undefined) {
      delete process.env.BUILD_IF_STALE_CACHE_DIR;
    } else {
      process.env.BUILD_IF_STALE_CACHE_DIR = prevCacheDir;
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
