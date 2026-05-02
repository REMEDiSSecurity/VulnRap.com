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
//   5. pnpm-lock.yaml is part of the watched set (Task #499):
//      - Every target's source list includes pnpm-lock.yaml, so an
//        external npm dep version bump (which only edits the lockfile,
//        not any per-artifact source) flips both the freshness check
//        and the persistent cache key.
//      - Bumping the lockfile's mtime past the dist marker, with no
//        other source edits, makes build-if-stale.mjs decide "stale" and
//        spawn the build (covered end-to-end via the pnpm stub).
//      - Mutating the lockfile's contents flips cacheKey(), so a cold
//        container with a different lockfile won't restore a snapshot
//        built against the previous resolved tree.
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
  recordStatsEvent,
} from "./build-if-stale.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Shared scratch cache dir for any test that spawns build-if-stale.mjs
// without already pointing BUILD_IF_STALE_CACHE_DIR somewhere isolated.
// Keeps test-driven stats records (Task #500) and tmp tree out of the
// real <repo>/.cache/build-if-stale used by everyday Playwright runs.
const TEST_CACHE_DIR = path.join(
  REPO_ROOT,
  ".local",
  "tmp-build-if-stale-test-cache",
);

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
  // Task #499: every target must watch pnpm-lock.yaml, otherwise an
  // external npm dep version bump (esbuild, vite, fastify, ...) wouldn't
  // flip either the freshness check or the cache key, and a stale dist
  // built against the previous resolved tree would get reused.
  check(
    `${target}: watches pnpm-lock.yaml (external dep versions)`,
    sources.includes("pnpm-lock.yaml"),
    `sources=${JSON.stringify(sources)}`,
  );
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
    // Point the cache dir at the shared test scratch so the stats
    // record this run produces (Task #500) lands there instead of in
    // the real <repo>/.cache/build-if-stale.
    const result = await withPnpmStub(
      {
        BUILD_IF_STALE_DISABLE_CACHE: "1",
        BUILD_IF_STALE_CACHE_DIR: TEST_CACHE_DIR,
      },
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
          // Quarantine this run's stats record (Task #500) to the
          // shared test scratch instead of the real cache root.
          env: {
            ...process.env,
            BUILD_IF_STALE_ALLOW_MISSING: "",
            BUILD_IF_STALE_CACHE_DIR: TEST_CACHE_DIR,
          },
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
            // Quarantine this run's stats record (Task #500) to the
            // shared test scratch instead of the real cache root.
            BUILD_IF_STALE_CACHE_DIR: TEST_CACHE_DIR,
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

  // Task #499: explicitly verify that mutating pnpm-lock.yaml's contents
  // flips cacheKey. The general "any watched file flips the hash" property
  // is already covered above via package.json, but this one is the headline
  // case for this task -- a `pnpm up esbuild` (lockfile-only edit) must not
  // restore a stale snapshot on a cold container.
  const lockPath = path.join(REPO_ROOT, "pnpm-lock.yaml");
  const lockOriginal = await readFile(lockPath);
  const lockOriginalStat = await stat(lockPath);
  try {
    // A trailing newline is a content change yaml parsers tolerate, so the
    // working copy stays valid even if a parallel process happens to read
    // the lockfile mid-test.
    await writeFile(lockPath, lockOriginal + "\n");
    const lockMutated = await cacheKey(target);
    check(
      "cacheKey changes when pnpm-lock.yaml's contents change",
      lockMutated !== a,
      `before=${a}\nafter=${lockMutated}`,
    );
  } finally {
    await writeFile(lockPath, lockOriginal);
    await utimes(lockPath, lockOriginalStat.atime, lockOriginalStat.mtime);
  }
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

// --- Test 7: bumping pnpm-lock.yaml's mtime past the marker (with no
// other source edits) trips the freshness check, end-to-end (Task #499).
//
// This is the headline scenario for this task: a contributor runs
// `pnpm up <some-external-dep>` which only edits pnpm-lock.yaml, no
// per-artifact source touches anything else. Without the lockfile in
// the watch set the freshness check would happily reuse the existing
// dist/ that was built against the previous resolved tree. We disable
// the persistent cache here so the test asserts purely on the
// mtime-based stale path; Test 4 already covers that the lockfile's
// content is mixed into the cache key.
//
// We restore the lockfile's atime/mtime in a finally so the bump
// doesn't leak into any subsequent build-if-stale run on this working
// copy (Test 2 uses the avri-rubric src bump deliberately, but a
// permanently-future lockfile mtime is much more surprising).
if (markerExists) {
  const lockRel = "pnpm-lock.yaml";
  const lockAbs = path.join(REPO_ROOT, lockRel);
  const lockOriginalStat = await stat(lockAbs);
  const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
  try {
    await utimes(lockAbs, farFuture, farFuture);
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
      "touching pnpm-lock.yaml is detected as stale (lockfile-only edit)",
      stderr.includes("stale —") && stderr.includes("pnpm-lock.yaml"),
      `stdout=${result.stdout}\nstderr=${stderr}`,
    );
    check(
      "lockfile-only stale rebuild exits 0 (stub build succeeds)",
      result.status === 0,
      `status=${result.status}\nstderr=${stderr}`,
    );
  } finally {
    await utimes(lockAbs, lockOriginalStat.atime, lockOriginalStat.mtime);
  }
}

// --- Test 8: persistent cache stats (Task #500) ---
//
// Two things to verify:
//   8a. A normal build-if-stale.mjs invocation appends one structured
//       JSONL record to <cache-root>/stats.jsonl with the expected
//       target/outcome/elapsedMs fields. We use the cheapest happy path
//       (E2E_SKIP_PROD_BUILD=1) so the test doesn't have to spawn a
//       real build, and we point BUILD_IF_STALE_CACHE_DIR at a fresh
//       scratch dir so the assertion sees exactly one record.
//   8b. Once the stats file outgrows the rotation threshold, a
//       follow-up append truncates it to the per-target cap with the
//       most-recent entries kept and the oldest dropped. We exercise
//       this by pre-populating the file with > trigger lines and then
//       calling recordStatsEvent() (the same hook the script uses on
//       every invocation), which is faster and more focused than
//       spawning the script ~1300 times.
{
  const statsCacheDir = path.join(
    REPO_ROOT,
    ".local",
    "tmp-build-if-stale-stats",
  );
  await rm(statsCacheDir, { recursive: true, force: true });
  const statsFile = path.join(statsCacheDir, "stats.jsonl");

  // 8a. End-to-end: run build-if-stale.mjs and assert a record landed.
  const skipResult = spawnSync(
    process.execPath,
    [path.join(__dirname, "build-if-stale.mjs"), "api-server"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        // E2E_SKIP_PROD_BUILD=1 exits immediately with the "skip"
        // outcome — avoids needing dist/ to exist or any pnpm stub.
        E2E_SKIP_PROD_BUILD: "1",
        BUILD_IF_STALE_CACHE_DIR: statsCacheDir,
        // Make sure no parent-shell knob silently disables stats.
        BUILD_IF_STALE_DISABLE_STATS: "",
      },
    },
  );
  check(
    "stats: skip-path invocation exits 0",
    skipResult.status === 0,
    `status=${skipResult.status}\nstderr=${skipResult.stderr}`,
  );

  let firstLines = [];
  try {
    const txt = await readFile(statsFile, "utf8");
    firstLines = txt.split("\n").filter((l) => l.length > 0);
  } catch (err) {
    check("stats: file exists after skip-path invocation", false, err.message);
  }
  check(
    "stats: file has exactly one record after one invocation",
    firstLines.length === 1,
    `lines=${firstLines.length}`,
  );
  if (firstLines.length === 1) {
    let rec;
    try {
      rec = JSON.parse(firstLines[0]);
    } catch (err) {
      check("stats: record is valid JSON", false, err.message);
    }
    if (rec) {
      check(
        "stats: record carries target=api-server, outcome=skip, " +
          "numeric elapsedMs, ISO ts",
        rec.target === "api-server" &&
          rec.outcome === "skip" &&
          typeof rec.elapsedMs === "number" &&
          rec.elapsedMs >= 0 &&
          typeof rec.ts === "string" &&
          !Number.isNaN(Date.parse(rec.ts)),
        `record=${JSON.stringify(rec)}`,
      );
    }
  }

  // 8b. Pre-fill past the rotation trigger and confirm the next
  // recordStatsEvent truncates to the cap. We have to push the file
  // past BOTH thresholds: STATS_TRUNCATE_TRIGGER (1100 lines) AND
  // STATS_ROTATE_SIZE_PROBE_BYTES (200KB), since the byte check is a
  // cheap pre-filter that skips the rewrite entirely for small files.
  // A bare record is only ~95 bytes, so we add a padding field of
  // ~150 bytes to push each line to ~250 bytes — 1500 lines then
  // weighs ~370KB, comfortably past both gates.
  const PADDING = "x".repeat(150);
  const bigLines = [];
  for (let i = 0; i < 1500; i++) {
    bigLines.push(
      JSON.stringify({
        ts: new Date(Date.now() - (1500 - i) * 1000).toISOString(),
        target: "api-server",
        outcome: "fresh",
        elapsedMs: i,
        // seq is purely a test marker so we can verify which records
        // survived rotation.
        seq: i,
        // Padding to push line size past the byte-probe threshold so
        // rotation actually fires on the next append. See comment above.
        _pad: PADDING,
      }),
    );
  }
  await writeFile(statsFile, bigLines.join("\n") + "\n");

  const prevCacheDir = process.env.BUILD_IF_STALE_CACHE_DIR;
  const prevDisable = process.env.BUILD_IF_STALE_DISABLE_STATS;
  process.env.BUILD_IF_STALE_CACHE_DIR = statsCacheDir;
  delete process.env.BUILD_IF_STALE_DISABLE_STATS;
  try {
    await recordStatsEvent({
      ts: new Date().toISOString(),
      target: "api-server",
      outcome: "fresh",
      elapsedMs: 42,
      seq: 9999,
    });
  } finally {
    if (prevCacheDir === undefined) delete process.env.BUILD_IF_STALE_CACHE_DIR;
    else process.env.BUILD_IF_STALE_CACHE_DIR = prevCacheDir;
    if (prevDisable === undefined) delete process.env.BUILD_IF_STALE_DISABLE_STATS;
    else process.env.BUILD_IF_STALE_DISABLE_STATS = prevDisable;
  }

  const txtAfter = await readFile(statsFile, "utf8");
  const linesAfter = txtAfter.split("\n").filter((l) => l.length > 0);
  check(
    "stats: rotation truncates to <= the per-target cap once oversized",
    linesAfter.length <= 1000,
    `lines=${linesAfter.length}`,
  );
  check(
    "stats: rotation keeps the most recent record at the tail",
    (() => {
      try {
        const last = JSON.parse(linesAfter[linesAfter.length - 1]);
        return last.seq === 9999;
      } catch {
        return false;
      }
    })(),
    `tail=${linesAfter[linesAfter.length - 1]}`,
  );
  check(
    "stats: rotation drops the oldest records first",
    (() => {
      try {
        const first = JSON.parse(linesAfter[0]);
        // We pre-filled 1500 records (seq 0..1499) and then appended 1
        // (seq 9999), giving 1501 total. Rotation keeps the trailing
        // STATS_MAX_RECORDS (1000), so the head should now be at index
        // 501 of the original sequence — i.e. anything > 0 means the
        // oldest entries were correctly dropped.
        return first.seq > 0;
      } catch {
        return false;
      }
    })(),
    `head=${linesAfter[0]}`,
  );

  // 8c. BUILD_IF_STALE_DISABLE_STATS=1 must short-circuit the writer
  // entirely. We start from a fresh dir, set the disable flag, run
  // the script, and assert no stats file appears.
  const disabledDir = path.join(
    REPO_ROOT,
    ".local",
    "tmp-build-if-stale-stats-disabled",
  );
  await rm(disabledDir, { recursive: true, force: true });
  const disabledResult = spawnSync(
    process.execPath,
    [path.join(__dirname, "build-if-stale.mjs"), "api-server"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_SKIP_PROD_BUILD: "1",
        BUILD_IF_STALE_CACHE_DIR: disabledDir,
        BUILD_IF_STALE_DISABLE_STATS: "1",
      },
    },
  );
  check(
    "stats: skip-path invocation still exits 0 with stats disabled",
    disabledResult.status === 0,
    `status=${disabledResult.status}\nstderr=${disabledResult.stderr}`,
  );
  let disabledHasFile = false;
  try {
    await stat(path.join(disabledDir, "stats.jsonl"));
    disabledHasFile = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  check(
    "stats: BUILD_IF_STALE_DISABLE_STATS=1 prevents the file from being created",
    disabledHasFile === false,
    `stats.jsonl unexpectedly exists under ${disabledDir}`,
  );

  await rm(statsCacheDir, { recursive: true, force: true });
  await rm(disabledDir, { recursive: true, force: true });
}

// --- Test 9: build-if-stale-stats.mjs summary helper (Task #500) ---
//
// Drive the helper with a synthetic stats log that has a known mix of
// outcomes per target, then assert:
//   - The default human-readable output names every target, reports
//     the expected hit-rate (fresh + restore over the cacheable
//     denominator), and shows the average wall-clock for the build
//     bucket so a regression in build time is visible.
//   - --target filters out other targets.
//   - --last N keeps only the trailing N records (after the target
//     filter, matching the helper's documented order).
//   - --json emits a parseable summary so downstream tooling has a
//     stable shape to consume.
{
  const helperCacheDir = path.join(
    REPO_ROOT,
    ".local",
    "tmp-build-if-stale-stats-helper",
  );
  await rm(helperCacheDir, { recursive: true, force: true });
  await mkdir(helperCacheDir, { recursive: true });
  const helperStatsFile = path.join(helperCacheDir, "stats.jsonl");
  // Synthetic log: 4 cacheable api-server invocations (2 fresh + 1
  // restore + 1 build) -> hit-rate = 75.0%. One vulnrap fresh.
  const synth = [
    {
      ts: "2026-01-01T00:00:00.000Z",
      target: "api-server",
      outcome: "fresh",
      elapsedMs: 100,
    },
    {
      ts: "2026-01-01T00:01:00.000Z",
      target: "api-server",
      outcome: "restore",
      elapsedMs: 800,
      hash: "abc123def456",
    },
    {
      ts: "2026-01-01T00:02:00.000Z",
      target: "api-server",
      outcome: "build",
      elapsedMs: 15000,
      reason: "no-cache-entry",
      hash: "abc123def456",
      success: true,
    },
    {
      ts: "2026-01-01T00:03:00.000Z",
      target: "api-server",
      outcome: "fresh",
      elapsedMs: 110,
    },
    {
      ts: "2026-01-01T00:04:00.000Z",
      target: "vulnrap",
      outcome: "fresh",
      elapsedMs: 90,
    },
  ];
  await writeFile(
    helperStatsFile,
    synth.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const baseSpawn = (extraArgs) =>
    spawnSync(
      process.execPath,
      [
        path.join(__dirname, "build-if-stale-stats.mjs"),
        "--cache-dir",
        helperCacheDir,
        ...extraArgs,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

  const summary = baseSpawn([]);
  check(
    "stats helper: default summary exits 0",
    summary.status === 0,
    `status=${summary.status}\nstderr=${summary.stderr}`,
  );
  const summaryOut = summary.stdout ?? "";
  check(
    "stats helper: default summary names both targets",
    summaryOut.includes("api-server") && summaryOut.includes("vulnrap"),
    `out=${summaryOut}`,
  );
  check(
    "stats helper: api-server hit-rate is 75.0% (2 fresh + 1 restore over " +
      "4 cacheable)",
    summaryOut.includes("75.0%"),
    `out=${summaryOut}`,
  );
  check(
    "stats helper: build outcome's avg ms surfaces in the table",
    /build\s+1\s+25\.0%\s+15000/.test(summaryOut) ||
      summaryOut.includes("15000"),
    `out=${summaryOut}`,
  );
  check(
    "stats helper: per-outcome reason breakdown surfaces no-cache-entry",
    summaryOut.includes("build:no-cache-entry"),
    `out=${summaryOut}`,
  );

  const filtered = baseSpawn(["--target", "vulnrap"]);
  check(
    "stats helper: --target filters out other targets",
    !(filtered.stdout ?? "").includes("api-server") &&
      (filtered.stdout ?? "").includes("vulnrap"),
    `out=${filtered.stdout}`,
  );

  const last2 = baseSpawn(["--last", "2"]);
  check(
    "stats helper: --last N reports only the trailing N records",
    (last2.stdout ?? "").includes("2 records"),
    `out=${last2.stdout}`,
  );

  const jsonResult = baseSpawn(["--json"]);
  check(
    "stats helper: --json exits 0",
    jsonResult.status === 0,
    `status=${jsonResult.status}\nstderr=${jsonResult.stderr}`,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(jsonResult.stdout ?? "");
  } catch (err) {
    check("stats helper: --json emits parseable JSON", false, err.message);
  }
  if (parsed) {
    check(
      "stats helper: --json summary has expected per-target shape",
      parsed["api-server"] &&
        parsed["api-server"].total === 4 &&
        parsed["api-server"].hits === 3 &&
        parsed["api-server"].cacheable === 4 &&
        Math.abs(parsed["api-server"].hitRate - 0.75) < 1e-9 &&
        parsed["api-server"].outcomes.build &&
        parsed["api-server"].outcomes.build.avgMs === 15000,
      `parsed=${JSON.stringify(parsed)}`,
    );
  }

  // Empty / missing stats file path: helper must exit 0 with a
  // friendly hint instead of crashing.
  const emptyDir = path.join(
    REPO_ROOT,
    ".local",
    "tmp-build-if-stale-stats-empty",
  );
  await rm(emptyDir, { recursive: true, force: true });
  const emptyResult = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "build-if-stale-stats.mjs"),
      "--cache-dir",
      emptyDir,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  check(
    "stats helper: missing stats file exits 0 with a hint",
    emptyResult.status === 0 &&
      (emptyResult.stdout ?? "").includes("No build-if-stale stats found"),
    `status=${emptyResult.status}\nout=${emptyResult.stdout}`,
  );

  await rm(helperCacheDir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
}

// Final cleanup of the shared test scratch (Tests 2 + 3 use it for
// stats quarantine; nothing else should have written there).
await rm(TEST_CACHE_DIR, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
