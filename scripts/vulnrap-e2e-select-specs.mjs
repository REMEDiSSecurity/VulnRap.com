#!/usr/bin/env node
// Task #251 -- Change-aware filter for the vulnrap Playwright e2e suite.
//
// The full suite already runs ~22 specs against the PRODUCTION builds of
// @workspace/vulnrap and @workspace/api-server. Wall-clock cost grows
// linearly as new specs land, so this helper inspects the current branch's
// changed files and prints either:
//
//   ALL                            -- run the full suite (a shared file
//                                     that can ripple into any spec was
//                                     touched). This is the safe default.
//   NONE                           -- skip the suite entirely (no file
//                                     touched can affect the e2e surface
//                                     area).
//   <spec1.spec.ts>\n<spec2...>    -- run only the listed specs (one per
//                                     line). Used when only the spec
//                                     files themselves were touched.
//
// stdout is the machine-readable selection above. All human-facing
// breadcrumbs go to stderr so a caller can `output=$(node ...)` cleanly.
//
// Decision policy (kept conservative on purpose -- we'd rather rerun a
// few extra specs than miss a regression):
//
//   1. If git is unavailable or the diff cannot be computed, return ALL.
//      An unknown change set MUST NOT silently shrink the test surface.
//   2. If E2E_RUN_ALL_SPECS=1 is set, return ALL. Escape hatch for
//      callers that want to force the full suite (e.g. nightly cron).
//   3. If any changed file matches a `FULL_SUITE_PATTERNS` entry, return
//      ALL. These are files that any e2e spec implicitly depends on:
//      the production frontend bundle, the production api-server bundle,
//      the Playwright config, the shared test helpers, the script
//      wrappers themselves, the workspace-level lockfile, and any
//      workspace lib that those bundles consume.
//   4. Otherwise, return only the spec files that were directly touched.
//      (A spec file change can only affect that spec's pass/fail.)
//   5. If no spec files were touched and rule (3) didn't fire, return
//      NONE. Examples: a change confined to artifacts/mockup-sandbox/ or
//      to a non-vulnrap artifact.
//
// To extend this in the future:
//   - Add a regex to `FULL_SUITE_PATTERNS` if a new shared file should
//     trigger the full suite (e.g. a new shared seed helper file).
//   - Per-spec narrowing (e.g. "diagnostics-panel.spec.ts only depends
//     on these specific src files") is intentionally NOT modelled here:
//     the production builds are monolithic, so any src/ change rebuilds
//     the whole bundle and can ripple into every spec. Modelling
//     per-spec coverage would require static analysis we don't have.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const E2E_DIR = "artifacts/vulnrap/e2e";

// Files that, when changed, force the full suite to run. Each entry has a
// short comment so the next maintainer can tell why it's release-blocking.
export const FULL_SUITE_PATTERNS = [
  // The selection logic itself + the bash wrapper that consumes its output.
  // Touching either of these can change which specs we'd otherwise pick, so
  // the safest reaction is "rerun everything once to catch the regression".
  /^scripts\/vulnrap-e2e-check\.sh$/,
  /^scripts\/vulnrap-e2e-select-specs\.mjs$/,
  /^scripts\/vulnrap-e2e-select-specs\.test\.mjs$/,
  // The build helper the Playwright webServer chains in front of every
  // start/serve. A regression here changes whether dist/ gets rebuilt and
  // therefore which code the browser actually exercises.
  /^scripts\/build-if-stale\.mjs$/,

  // Playwright config: changes to projects, webServer env, baseURL, or the
  // calibration-token plumbing land in every spec.
  /^artifacts\/vulnrap\/playwright\.config\.ts$/,
  // Shared seed/cleanup helpers used by every handwavy-* spec.
  /^artifacts\/vulnrap\/e2e\/helpers\//,

  // Vulnrap frontend production bundle. The vite build is monolithic, so
  // any source change can affect any spec that exercises the bundle.
  /^artifacts\/vulnrap\/(src|public)\//,
  /^artifacts\/vulnrap\/index\.html$/,
  /^artifacts\/vulnrap\/vite\.config\.ts$/,
  /^artifacts\/vulnrap\/package\.json$/,
  /^artifacts\/vulnrap\/tsconfig\.json$/,
  /^artifacts\/vulnrap\/components\.json$/,

  // Api-server bundle. Same monolithic-build argument: anything under src/
  // (routes, middlewares, lib, app.ts, seed.ts, etc.) gets bundled into
  // dist/index.mjs which the e2e suite hits via the vite preview proxy.
  /^artifacts\/api-server\/src\//,
  /^artifacts\/api-server\/build\.mjs$/,
  /^artifacts\/api-server\/package\.json$/,
  /^artifacts\/api-server\/tsconfig\.json$/,

  // Shared workspace libraries get bundled into both production builds, so
  // a change in lib/<name>/src/ can ripple into either tier. Conservative
  // pattern: any *.ts/*.json/openapi.yaml under any lib's src/ or top-level
  // package.json triggers the full suite. (We deliberately do NOT walk the
  // package.json deps to figure out which libs ship into which artifact --
  // that's the build-if-stale.mjs job; here we just stay safe.)
  /^lib\/[^/]+\/src\//,
  /^lib\/[^/]+\/package\.json$/,
  /^lib\/[^/]+\/openapi\.yaml$/,

  // Top-level workspace plumbing. A pnpm-lock.yaml change can swap a
  // transitive dep that affects the bundles; tsconfig.base.json affects
  // every package's typecheck/build.
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^tsconfig\.base\.json$/,
  /^\.npmrc$/,
];

const SPEC_PATTERN = /^artifacts\/vulnrap\/e2e\/([^/]+\.spec\.ts)$/;

/**
 * Decide which specs to run for a given changed-file list.
 *
 * @param {string[]} changedFiles  Repo-relative paths.
 * @param {string[]} allSpecs      All known *.spec.ts file basenames.
 * @returns {{mode:"all"|"none"|"subset", reason?:string, specs?:string[]}}
 */
export function selectSpecs(changedFiles, allSpecs) {
  if (process.env.E2E_RUN_ALL_SPECS === "1") {
    return { mode: "all", reason: "E2E_RUN_ALL_SPECS=1" };
  }
  if (!Array.isArray(changedFiles)) {
    return { mode: "all", reason: "no diff information available" };
  }
  // An *empty* diff means "no changes detected". We could in theory return
  // NONE here, but in practice an empty diff usually means we ran from a
  // detached state we can't trust -- return ALL to stay safe. The CLI
  // wrapper distinguishes this from "git unavailable" via stderr breadcrumbs.
  if (changedFiles.length === 0) {
    return { mode: "all", reason: "diff was empty (no changed files seen)" };
  }
  for (const file of changedFiles) {
    for (const pat of FULL_SUITE_PATTERNS) {
      if (pat.test(file)) {
        return {
          mode: "all",
          reason: `shared file changed: ${file} (matched ${pat})`,
        };
      }
    }
  }
  const touched = new Set();
  const knownSpecs = new Set(allSpecs);
  for (const file of changedFiles) {
    const m = file.match(SPEC_PATTERN);
    if (m && knownSpecs.has(m[1])) {
      touched.add(m[1]);
    }
  }
  if (touched.size === 0) {
    return { mode: "none", reason: "no vulnrap e2e surface area touched" };
  }
  return { mode: "subset", specs: [...touched].sort() };
}

/**
 * Enumerate all *.spec.ts files in artifacts/vulnrap/e2e/ (basenames).
 */
export function listSpecs() {
  const dir = path.join(REPO_ROOT, E2E_DIR);
  return readdirSync(dir)
    .filter((n) => n.endsWith(".spec.ts"))
    .sort();
}

/**
 * Compute the union of:
 *   1. Uncommitted (staged + unstaged) changes vs HEAD.
 *   2. Untracked (non-ignored) files.
 *   3. Committed diff between merge-base(HEAD, baseRef) and HEAD,
 *      where baseRef is the first of {opts.baseRef, "origin/main",
 *      "main"} that resolves.
 *
 * Returns null if `git` is unavailable / errored on every read -- the
 * caller should treat that as "rerun everything" (see selectSpecs).
 *
 * Replit's task agent runs validation against an uncommitted working tree
 * on `main`, so step (1) carries the real signal there. CI runs hit step
 * (3) instead, since the diff lives on a branch.
 */
export function computeChangedFiles({ baseRef = process.env.E2E_DIFF_BASE } = {}) {
  // Use execFileSync with an argv array (NOT a shell string) so a refspec
  // sourced from CI / branch / user input can't smuggle in extra shell
  // tokens. Defense-in-depth: today the only inputs are HEAD, origin/main,
  // main, and E2E_DIFF_BASE (operator-controlled), but future callers
  // shouldn't have to audit this for shell escapes.
  const git = (...args) => {
    try {
      return execFileSync(
        "git",
        ["--no-optional-locks", ...args],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      return null;
    }
  };

  const set = new Set();
  let gotAny = false;

  const uncommitted = git("diff", "--name-only", "HEAD");
  if (uncommitted !== null) {
    gotAny = true;
    for (const line of uncommitted.split("\n")) {
      const t = line.trim();
      if (t) set.add(t);
    }
  }

  const untracked = git("ls-files", "--others", "--exclude-standard");
  if (untracked !== null) {
    gotAny = true;
    for (const line of untracked.split("\n")) {
      const t = line.trim();
      if (t) set.add(t);
    }
  }

  const candidates = [baseRef, "origin/main", "main"].filter(Boolean);
  for (const ref of candidates) {
    const mergeBase = git("merge-base", "HEAD", ref)?.trim();
    if (!mergeBase) continue;
    const committed = git("diff", "--name-only", mergeBase, "HEAD");
    if (committed !== null) {
      gotAny = true;
      for (const line of committed.split("\n")) {
        const t = line.trim();
        if (t) set.add(t);
      }
      break;
    }
  }

  return gotAny ? [...set] : null;
}

// CLI entry point. Output protocol:
//   stdout: ALL | NONE | one spec basename per line
//   stderr: human-readable reasoning
function isMain() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const files = computeChangedFiles();
  if (files === null) {
    console.error(
      "[vulnrap-e2e-select-specs] git diff unavailable -- defaulting to ALL specs",
    );
    console.log("ALL");
    process.exit(0);
  }
  console.error(
    `[vulnrap-e2e-select-specs] ${files.length} changed file(s) detected:`,
  );
  for (const f of files) console.error(`  - ${f}`);
  const result = selectSpecs(files, listSpecs());
  if (result.mode === "all") {
    console.error(`[vulnrap-e2e-select-specs] -> ALL (${result.reason})`);
    console.log("ALL");
  } else if (result.mode === "none") {
    console.error(`[vulnrap-e2e-select-specs] -> NONE (${result.reason})`);
    console.log("NONE");
  } else {
    console.error(
      `[vulnrap-e2e-select-specs] -> ${result.specs.length} spec(s): ${result.specs.join(", ")}`,
    );
    for (const spec of result.specs) console.log(spec);
  }
}
