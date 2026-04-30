#!/usr/bin/env node
// Re-runs the OpenAPI codegen + composite project build and fails loudly
// when either the committed generated client output drifts from a fresh
// codegen, or the project-reference build no longer succeeds against the
// freshly-regenerated sources. This is the safety net for
// `lib/api-spec/openapi.yaml` drift -- it caught task #225 retrospectively
// (manual codegen + manual rebuild required) and is intended to stop the
// same scenario from leaking to typecheck/CI again.
//
// Both halves are also wired into the root `postinstall` lifecycle (see
// package.json) so day-to-day `pnpm install` already keeps the generated
// dirs and the lib dist outputs fresh. This script is the verification
// half: typecheck and post-merge invoke it.
//
// What's checked:
//   1) `lib/api-client-react/src/generated/` and
//      `lib/api-zod/src/generated/` are committed; we re-run codegen and
//      diff them against the index. Drift here means a developer (or an
//      upstream merge) shipped a spec change without committing the
//      regenerated client.
//   2) The lib project-reference `dist/` outputs are gitignored build
//      artifacts, so they can't drift in the source-of-truth sense. We
//      verify them by *rebuilding* via `tsc --build` (incremental,
//      driven by `.tsbuildinfo`); a non-zero exit means a dist output
//      no longer typechecks against its source after the codegen
//      refresh -- e.g. a consumer in another lib relies on a renamed
//      generated symbol.
//
// Usage:
//   node scripts/verify-codegen.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Generated source paths that ARE committed -- we diff these against the
// index to detect a stale spec edit that didn't get codegenned + committed.
const GENERATED_PATHS = [
  "lib/api-client-react/src/generated",
  "lib/api-zod/src/generated",
];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: opts.captureOutput ? "pipe" : "inherit",
    encoding: "utf8",
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

console.log("[verify-codegen] regenerating @workspace/api-spec client...");
const codegen = run("pnpm", [
  "--filter",
  "@workspace/api-spec",
  "run",
  "codegen",
]);
if (codegen.status !== 0) {
  console.error(
    "[verify-codegen] codegen failed with exit code " + codegen.status,
  );
  process.exit(codegen.status ?? 1);
}

console.log(
  "[verify-codegen] checking " +
    GENERATED_PATHS.join(", ") +
    " against the index...",
);
// `--no-optional-locks` keeps this read-only diff from racing the
// platform-managed `.git/index.lock` that other workspace tooling holds.
const diff = run(
  "git",
  ["--no-optional-locks", "diff", "--exit-code", "--", ...GENERATED_PATHS],
  { captureOutput: true },
);

if (diff.status !== 0) {
  // `git diff --exit-code` returns 1 when there are differences. Anything
  // else (e.g. git not on PATH, repo not initialised) is an unexpected
  // failure mode and we surface stderr verbatim.
  if (diff.status !== 1) {
    if (diff.stderr) process.stderr.write(diff.stderr);
    if (diff.stdout) process.stdout.write(diff.stdout);
    console.error(
      "[verify-codegen] git diff exited with unexpected status " + diff.status,
    );
    process.exit(diff.status ?? 1);
  }

  process.stdout.write(diff.stdout ?? "");
  console.error("");
  console.error(
    "[verify-codegen] ERROR: generated client is out of sync with lib/api-spec/openapi.yaml.",
  );
  console.error(
    "[verify-codegen]        Run `pnpm codegen` and commit the changes under:",
  );
  for (const p of GENERATED_PATHS) {
    console.error("[verify-codegen]          - " + p);
  }
  process.exit(1);
}

// Second half: rebuild the composite project references so the
// `lib/<name>/dist/` declaration outputs are refreshed against the
// freshly-regenerated sources. These dists are gitignored, so we don't
// `git diff` them -- the rebuild itself is the verification. `tsc --build`
// is incremental (driven by `.tsbuildinfo`) so it's fast in steady state,
// and exits non-zero if any lib's source no longer typechecks against the
// new generated client (e.g. a renamed export).
console.log(
  "[verify-codegen] rebuilding lib project-reference dist outputs (tsc --build)...",
);
const tscBuild = run("pnpm", ["run", "typecheck:libs"]);
if (tscBuild.status !== 0) {
  console.error(
    "[verify-codegen] ERROR: lib project-reference build failed against the regenerated client; a consumer is out of sync.",
  );
  process.exit(tscBuild.status ?? 1);
}

console.log(
  "[verify-codegen] generated client is in sync with the spec; lib dist outputs rebuilt cleanly.",
);
process.exit(0);
