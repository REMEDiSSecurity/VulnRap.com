#!/usr/bin/env node
// Standalone sanity test for scripts/codegen-if-stale.mjs. Verifies that
// the freshness gate around the OpenAPI codegen actually:
//   1. Skips orval when every generated marker is newer than every
//      watched source (the steady-state `pnpm install` case Task #432
//      was created to fix).
//   2. Runs orval when a watched source is touched newer than the
//      oldest marker.
//   3. Runs orval when a marker is missing, so a half-completed prior
//      run can't masquerade as fresh.
//   4. Runs orval unconditionally under FORCE_CODEGEN=1, even when the
//      markers look fresh.
//
// We stub `pnpm` on $PATH so no real codegen runs and no working-copy
// files are mutated. The original mtimes of the watched sources and
// markers are captured up-front and restored in a finally so a mid-test
// crash can't leave the working copy in a state where a real subsequent
// `pnpm install` would either over- or under-trigger codegen.
//
// Run: `node scripts/codegen-if-stale.test.mjs` (exit 0 == pass)

import { spawnSync } from "node:child_process";
import { stat, utimes, writeFile, mkdir, rm, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WATCHED_SOURCES, MARKERS } from "./codegen-if-stale.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(__dirname, "codegen-if-stale.mjs");

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// Snapshot every watched + marker file's mtime so we can put them back
// at the end. We deliberately don't touch contents -- only mtimes -- so
// restoration only needs the original timestamps.
async function snapshotMtimes(rels) {
  const out = new Map();
  for (const rel of rels) {
    try {
      const s = await stat(path.join(REPO_ROOT, rel));
      out.set(rel, { atime: s.atime, mtime: s.mtime });
    } catch (err) {
      if (err.code === "ENOENT") out.set(rel, null);
      else throw err;
    }
  }
  return out;
}

async function restoreMtimes(snap) {
  for (const [rel, ts] of snap.entries()) {
    if (ts === null) continue;
    try {
      await utimes(path.join(REPO_ROOT, rel), ts.atime, ts.mtime);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

const ALL_TRACKED = [...WATCHED_SOURCES, ...MARKERS];
const originalMtimes = await snapshotMtimes(ALL_TRACKED);

// Set up the pnpm stub once; reuse it across every spawn. The stub
// records each invocation to a marker file the test inspects to assert
// whether codegen would have spawned for real.
const stubDir = path.join(REPO_ROOT, ".local", "tmp-codegen-if-stale-test");
await mkdir(stubDir, { recursive: true });
const stubPath = path.join(stubDir, "pnpm");
const invokedMarker = path.join(stubDir, "pnpm-was-invoked");
await writeFile(
  stubPath,
  `#!/usr/bin/env sh\necho '[pnpm-stub] would run codegen'\ntouch '${invokedMarker}'\nexit 0\n`,
);
await chmod(stubPath, 0o755);

function runScript(env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      ...env,
    },
  });
}

async function pnpmWasInvoked() {
  try {
    await stat(invokedMarker);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Push every marker forward, every watched source backward, so the
// freshness check has unambiguous "newer/older" relationships to test
// against. Using fixed-offset times (rather than Date.now()) keeps the
// test deterministic across slow CI runs.
async function makeMarkersFresh() {
  const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const newDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  for (const rel of WATCHED_SOURCES) {
    await utimes(path.join(REPO_ROOT, rel), oldDate, oldDate);
  }
  for (const rel of MARKERS) {
    await utimes(path.join(REPO_ROOT, rel), newDate, newDate);
  }
}

async function makeMarkersStale() {
  const oldDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const newDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  for (const rel of MARKERS) {
    await utimes(path.join(REPO_ROOT, rel), oldDate, oldDate);
  }
  for (const rel of WATCHED_SOURCES) {
    await utimes(path.join(REPO_ROOT, rel), newDate, newDate);
  }
}

try {
  // --- Test 1: every marker newer than every watched source -> skip ---
  await rm(invokedMarker, { force: true });
  await makeMarkersFresh();
  let result = runScript();
  let stderr = result.stderr ?? "";
  check(
    "fresh markers -> exits 0",
    result.status === 0,
    `status=${result.status}\nstderr=${stderr}`,
  );
  check(
    "fresh markers -> logs 'fresh' decision",
    stderr.includes("fresh —"),
    `stderr=${stderr}`,
  );
  check(
    "fresh markers -> does NOT spawn codegen",
    !(await pnpmWasInvoked()),
    `stderr=${stderr}`,
  );

  // --- Test 2: a watched source newer than the oldest marker -> run ---
  await rm(invokedMarker, { force: true });
  await makeMarkersStale();
  result = runScript();
  stderr = result.stderr ?? "";
  check(
    "stale spec -> exits 0 (stub returns 0)",
    result.status === 0,
    `status=${result.status}\nstderr=${stderr}`,
  );
  check(
    "stale spec -> logs 'stale' decision naming the spec",
    stderr.includes("stale —") && stderr.includes("openapi.yaml"),
    `stderr=${stderr}`,
  );
  check(
    "stale spec -> spawns codegen",
    await pnpmWasInvoked(),
    `stderr=${stderr}`,
  );

  // --- Test 3: FORCE_CODEGEN=1 bypasses the freshness check ---
  await rm(invokedMarker, { force: true });
  await makeMarkersFresh();
  result = runScript({ FORCE_CODEGEN: "1" });
  stderr = result.stderr ?? "";
  check(
    "FORCE_CODEGEN=1 -> exits 0",
    result.status === 0,
    `status=${result.status}\nstderr=${stderr}`,
  );
  check(
    "FORCE_CODEGEN=1 -> logs the force override",
    stderr.includes("FORCE_CODEGEN=1"),
    `stderr=${stderr}`,
  );
  check(
    "FORCE_CODEGEN=1 -> spawns codegen even when fresh",
    await pnpmWasInvoked(),
    `stderr=${stderr}`,
  );

  // --- Test 3b: E2E_FORCE_CODEGEN=1 alias also bypasses the
  // freshness check. The alias exists so callers that already follow
  // the E2E_FORCE_* convention used by scripts/build-if-stale.mjs
  // (E2E_FORCE_PROD_BUILD=1) don't have to learn a second knob.
  await rm(invokedMarker, { force: true });
  await makeMarkersFresh();
  // Explicitly clear FORCE_CODEGEN so we know the regen was driven by
  // the alias and not the primary name leaking from the parent shell.
  result = runScript({ E2E_FORCE_CODEGEN: "1", FORCE_CODEGEN: "" });
  stderr = result.stderr ?? "";
  check(
    "E2E_FORCE_CODEGEN=1 alias -> exits 0",
    result.status === 0,
    `status=${result.status}\nstderr=${stderr}`,
  );
  check(
    "E2E_FORCE_CODEGEN=1 alias -> logs the alias name",
    stderr.includes("E2E_FORCE_CODEGEN=1"),
    `stderr=${stderr}`,
  );
  check(
    "E2E_FORCE_CODEGEN=1 alias -> spawns codegen even when fresh",
    await pnpmWasInvoked(),
    `stderr=${stderr}`,
  );

  // --- Test 4: a missing marker forces a regen even when other
  // markers are newer than the spec. We simulate "missing" by pointing
  // the script at a temp WATCHED set we control via env-injected paths
  // is not feasible (the script doesn't accept overrides), so instead
  // we exercise the missing-marker branch by *moving* one marker out
  // of the way for the duration of the spawn and putting it back in
  // a finally. Mtime restoration at the bottom of the file recovers
  // the original timestamps regardless. ---
  await rm(invokedMarker, { force: true });
  await makeMarkersFresh();
  const victim = MARKERS[0];
  const victimAbs = path.join(REPO_ROOT, victim);
  const stash = victimAbs + ".codegen-if-stale-test-stash";
  // Use rename so the file is atomically gone for the duration of the
  // test; cp+rm would leave a window where both copies coexist.
  const { rename } = await import("node:fs/promises");
  await rename(victimAbs, stash);
  try {
    result = runScript();
    stderr = result.stderr ?? "";
    check(
      "missing marker -> exits 0 (stub returns 0)",
      result.status === 0,
      `status=${result.status}\nstderr=${stderr}`,
    );
    check(
      "missing marker -> logs the missing-marker reason",
      stderr.includes(`marker ${victim} missing`),
      `stderr=${stderr}`,
    );
    check(
      "missing marker -> spawns codegen",
      await pnpmWasInvoked(),
      `stderr=${stderr}`,
    );
  } finally {
    await rename(stash, victimAbs);
  }
} finally {
  // Always put mtimes back so a real subsequent `pnpm install` makes
  // the same skip/regen decision it would have made before the test ran.
  await restoreMtimes(originalMtimes);
  // Best-effort cleanup of the stub dir so it doesn't accumulate.
  await rm(stubDir, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
