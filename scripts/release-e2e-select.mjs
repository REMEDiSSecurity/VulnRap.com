#!/usr/bin/env node
// Task #497 -- Decide whether scripts/release-e2e-check.sh should run its
// curated RELEASE_SPECS list against the production builds, or skip
// entirely because the current diff doesn't touch anything that the
// release gate exercises.
//
// This re-uses the same diff-aware selector that powers
// scripts/vulnrap-e2e-check.sh + scripts/vulnrap-e2e-register.mjs (see
// scripts/vulnrap-e2e-select-specs.mjs), then narrows its result against
// the RELEASE_SPECS list passed on the command line. Keeping the policy
// in one JS file means the unit tests in
// scripts/vulnrap-e2e-select-specs.test.mjs cover both gates.
//
// Usage:
//   node scripts/release-e2e-select.mjs <release-spec-1> <release-spec-2> ...
//
// Output protocol:
//   stdout: RUN  (run the full RELEASE_SPECS list)
//           SKIP (exit 0 in the gate without invoking Playwright)
//   stderr: human-readable reasoning
//
// Exit code is always 0 -- the bash wrapper inspects stdout to decide
// what to do. A non-zero exit would defeat the whole point of "skip the
// gate", so we fail-loud only via stderr.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeChangedFiles,
  listSpecs,
  selectReleaseSpecs,
  selectSpecs,
} from "./vulnrap-e2e-select-specs.mjs";

/**
 * Pure decision helper -- separated so the test can drive it without
 * touching the live git repo or the on-disk spec list.
 *
 * @param {string[]|null} changedFiles  computeChangedFiles() output, or
 *                                      null when git is unavailable.
 * @param {string[]} allSpecs           listSpecs() output.
 * @param {string[]} releaseSpecs       The RELEASE_SPECS basenames.
 */
export function decideReleaseRun(changedFiles, allSpecs, releaseSpecs) {
  const selectorResult =
    changedFiles === null ? null : selectSpecs(changedFiles, allSpecs);
  return selectReleaseSpecs(selectorResult, releaseSpecs);
}

function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const releaseSpecs = process.argv.slice(2).filter(Boolean);
  if (releaseSpecs.length === 0) {
    console.error(
      "[release-e2e-select] ERROR: no RELEASE_SPECS basenames provided on argv.",
    );
    console.error(
      "  Usage: node scripts/release-e2e-select.mjs <spec1.spec.ts> <spec2.spec.ts> ...",
    );
    // Fail-safe: an empty argv means the bash caller is mis-wired. Print
    // RUN so the gate still runs the full list rather than silently
    // skipping every release.
    console.log("RUN");
    process.exit(0);
  }

  const changedFiles = computeChangedFiles();
  if (changedFiles === null) {
    console.error(
      "[release-e2e-select] git diff unavailable -- defaulting to RUN",
    );
  } else {
    console.error(
      `[release-e2e-select] ${changedFiles.length} changed file(s) detected.`,
    );
  }

  const decision = decideReleaseRun(changedFiles, listSpecs(), releaseSpecs);
  console.error(
    `[release-e2e-select] -> ${decision.mode.toUpperCase()} (${decision.reason})`,
  );
  console.log(decision.mode === "run" ? "RUN" : "SKIP");
}
