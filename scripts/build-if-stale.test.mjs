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
//
// Run: `node scripts/build-if-stale.test.mjs` (exit 0 == pass)

import { spawnSync } from "node:child_process";
import { stat, utimes, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TARGETS, buildSourceList } from "./build-if-stale.mjs";

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
  const markerStat = await stat(path.join(REPO_ROOT, cfg.marker));
  // Bump mtime to marker + 5s so the staleness comparison is unambiguous,
  // even on filesystems with coarse mtime granularity.
  const newer = new Date(markerStat.mtimeMs + 5000);
  await utimes(path.join(REPO_ROOT, sourceRel), newer, newer);
}

async function withPnpmStub(fn) {
  // Create a tiny "pnpm" shim in a tmp dir and prepend it to PATH so the
  // script's spawn("pnpm", ...) resolves to it instead of the real one.
  const stubDir = path.join(REPO_ROOT, ".local", "tmp-build-if-stale-test");
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, "pnpm");
  await writeFile(stubPath, "#!/usr/bin/env sh\necho '[pnpm-stub] would build'\nexit 0\n");
  await chmod(stubPath, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${stubDir}${path.delimiter}${prevPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
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
  const { readdir } = await import("node:fs/promises");
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
    const result = await withPnpmStub(() =>
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

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
