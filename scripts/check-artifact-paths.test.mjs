#!/usr/bin/env node
// Structural guard for `artifacts/*/.replit-artifact/artifact.toml` route
// declarations. Catches dev-mode-only path collisions BEFORE they ship.
//
// Background (task #324)
// ----------------------
// api-server declared `paths = ["/api", "/"]` and vulnrap declared
// `paths = ["/"]`. The workspace path router saw both artifacts claim "/"
// and routed every non-/api hit to the api-server, which in dev mode
// only mounts the SPA static fallback under NODE_ENV=production. Result:
// every dev-mode page load returned 404, and Playwright specs could
// only be exercised against the production bundle. The fix was a
// one-line edit; this test exists so the regression can't recur silently
// (it would otherwise only surface the next time someone tried to use
// `pnpm --filter @workspace/vulnrap run dev`).
//
// What this test enforces
// -----------------------
// For every `artifacts/*/.replit-artifact/artifact.toml`, gather the
// union of `paths` arrays declared inside `[[services]]` blocks. Any two
// artifacts whose paths overlap as routing prefixes (segment-aligned)
// produce a hard failure that names the offending artifacts and the
// specific paths that collided.
//
// Run: `node scripts/check-artifact-paths.test.mjs` (exit 0 == pass).
// Wired into BOTH the `typecheck` and `test` scripts in
// scripts/package.json. Because the root `pnpm typecheck` and `pnpm test`
// both fan out to the scripts package via pnpm filter, this guard runs
// automatically as part of either command -- catching collisions before
// they ship rather than only when someone runs `pnpm test`.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");

// --- minimal TOML reader specialised for our needs -------------------------
//
// Only extracts string values from `paths = [...]` keys that appear directly
// inside an `[[services]]` array-of-tables header. We deliberately avoid
// pulling in a full TOML parser:
//   (a) no other code in the repo needs one, and
//   (b) keeping this self-contained means the structural guard can't
//       silently regress because of an upstream dep change.
//
// What we deliberately ignore:
//   - sub-tables under [[services]] (e.g. [services.development],
//     [services.production.build]) — `paths` is only meaningful at the
//     [[services]] top level.
//   - other arrays-of-tables (none are currently relevant).
//   - `paths` declared anywhere outside [[services]] (e.g. the
//     [services.production.health.startup] `path = "/api/healthz"` field
//     is a singular `path` key, not the `paths` array).
//
// If a future artifact.toml puts the routing `paths` key somewhere
// unusual, this parser must learn about it. Anything we miss here just
// means the check is laxer than ideal — it can never produce a false
// positive.
export function extractServicePaths(tomlText) {
  const lines = tomlText.split(/\r?\n/);
  const result = [];
  let inServicesBlock = false;
  for (let i = 0; i < lines.length; i++) {
    // Strip end-of-line comments. Be conservative: only treat `#` as a
    // comment if it's at column 0 or preceded by whitespace, so a `#`
    // inside a quoted string isn't accidentally chopped.
    const raw = lines[i];
    const noComment = raw.replace(/(^|\s)#.*$/, "$1");
    const stripped = noComment.trim();
    if (!stripped) continue;

    // [[services]] opens a new array-of-tables entry. Any other header
    // (e.g. [services.development] or [[other]]) closes the block we
    // care about.
    if (stripped.startsWith("[[") && stripped.endsWith("]]")) {
      const inner = stripped.slice(2, -2).trim();
      inServicesBlock = inner === "services";
      continue;
    }
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      inServicesBlock = false;
      continue;
    }

    if (!inServicesBlock) continue;

    const keyMatch = stripped.match(/^paths\s*=\s*\[(.*)$/);
    if (!keyMatch) continue;

    // Greedily consume continuation lines until the closing ] — TOML
    // arrays can span multiple lines.
    let body = keyMatch[1];
    while (!body.includes("]") && i + 1 < lines.length) {
      i++;
      body += "\n" + lines[i].replace(/(^|\s)#.*$/, "$1");
    }
    const closeIdx = body.indexOf("]");
    const inner = closeIdx >= 0 ? body.slice(0, closeIdx) : body;
    // Pull out double- and single-quoted string literals. We don't try
    // to support backslash escapes because routing paths never need
    // them in practice.
    const stringMatches = inner.match(/"([^"]*)"|'([^']*)'/g) || [];
    for (const m of stringMatches) {
      result.push(m.slice(1, -1));
    }
  }
  return result;
}

// --- conflict detection ----------------------------------------------------
//
// Two routing paths conflict when one is a *segment-aligned* prefix of
// the other — i.e. requests targeting paths claimed by artifact B
// would also be matched by artifact A's prefix. After normalising
// trailing slashes:
//
//   - identical paths (`/api` vs `/api`, `/api/` vs `/api`) conflict;
//   - segment-aligned nested prefixes (`/api` vs `/api/v1`) conflict —
//     artifact A "owns" the `/api/*` subtree, so artifact B carving
//     `/api/v1` out of it produces a confusing split-ownership setup
//     even when longest-prefix-match would disambiguate at runtime.
//     This is the broad form of the task #324 regression that the
//     guard exists to head off;
//   - shared character prefixes that aren't segment-aligned (`/api` vs
//     `/apidocs`) do NOT conflict — path routers split on `/`, not on
//     character boundaries;
//   - disjoint paths (`/api` vs `/web`) do NOT conflict.
//
// Special case: `/` is the dedicated "catch-all / default" route
// (think the SPA root). It is intentionally allowed to coexist with
// any non-`/` prefix — that's the standard SPA-alongside-API layout
// (vulnrap=`/` + api-server=`/api`) and was working correctly before
// task #324 regressed it. `/` only conflicts with itself; the moment
// a second artifact also claims `/`, the router has two equally-good
// candidates for the catch-all and silently picks one (the exact
// task #324 failure mode).
//
// Examples:
//   - `/api`  vs `/api`     -> conflict (identical)
//   - `/`     vs `/`        -> conflict (task #324 regression)
//   - `/api/` vs `/api`     -> conflict (trailing slash normalised)
//   - `/api`  vs `/api/v1`  -> conflict (segment-aligned nested prefix)
//   - `/`     vs `/api`     -> NOT a conflict (`/` is the catch-all)
//   - `/api`  vs `/apidocs` -> NOT a conflict (not segment-aligned)
//   - `/api`  vs `/web`     -> NOT a conflict (disjoint)
export function pathsConflict(a, b) {
  // Normalise trailing slashes so `/foo` and `/foo/` are the same
  // route, but keep "/" as itself.
  const na = a === "/" ? "/" : a.replace(/\/+$/, "");
  const nb = b === "/" ? "/" : b.replace(/\/+$/, "");
  if (na === nb) return true;
  // `/` is the catch-all default; only conflicts with itself
  // (handled above). Anything else paired with `/` is allowed.
  if (na === "/" || nb === "/") return false;
  // Segment-aligned nested prefix: B is under A iff B starts with A
  // followed by a `/` (so `/api` matches `/api/v1` but NOT `/apidocs`).
  if (nb.startsWith(na + "/")) return true;
  if (na.startsWith(nb + "/")) return true;
  return false;
}

export function findArtifactPathConflicts(pathsByArtifact) {
  const entries = Object.entries(pathsByArtifact);
  const conflicts = [];
  for (let i = 0; i < entries.length; i++) {
    const [aName, aPaths] = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const [bName, bPaths] = entries[j];
      for (const ap of aPaths) {
        for (const bp of bPaths) {
          if (pathsConflict(ap, bp)) {
            conflicts.push({
              artifactA: aName,
              artifactB: bName,
              pathA: ap,
              pathB: bp,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

// --- runner ----------------------------------------------------------------

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

// 1) Self-tests for the helpers. These are what give the structural
//    check confidence that "Adding a deliberately-conflicting prefix to
//    a fresh artifact.toml causes the test to fail" — we exercise the
//    detection logic directly against synthetic inputs that mimic both
//    the original task #324 regression and other realistic shapes,
//    without having to mutate a real artifact.toml on disk (which is
//    gitignored and managed via verifyAndReplaceArtifactToml anyway).
{
  // pathsConflict semantics
  check(
    "pathsConflict: identical paths conflict",
    pathsConflict("/api", "/api"),
  );
  check(
    "pathsConflict: '/' duplicated across artifacts is the task #324 regression",
    pathsConflict("/", "/"),
  );
  check(
    "pathsConflict: trailing slashes are normalised (/foo vs /foo/)",
    pathsConflict("/foo", "/foo/"),
  );
  check(
    "pathsConflict: segment-aligned nested prefix is a conflict (/api vs /api/v1)",
    pathsConflict("/api", "/api/v1") && pathsConflict("/api/v1", "/api"),
  );
  check(
    "pathsConflict: deeper segment-aligned nested prefix conflicts (/api vs /api/v1/users)",
    pathsConflict("/api", "/api/v1/users"),
  );
  check(
    "pathsConflict: '/' (catch-all) coexists with any non-`/` prefix (/ vs /api)",
    !pathsConflict("/", "/api") && !pathsConflict("/api", "/"),
  );
  check(
    "pathsConflict: shared character prefix is NOT a conflict (/api vs /apidocs)",
    !pathsConflict("/api", "/apidocs") && !pathsConflict("/apidocs", "/api"),
  );
  check(
    "pathsConflict: disjoint paths do not conflict (/api vs /web)",
    !pathsConflict("/api", "/web"),
  );

  // extractServicePaths shapes
  const sample1 = `kind = "web"
[[services]]
name = "web"
paths = [ "/" ]

[services.development]
run = "x"
`;
  const paths1 = extractServicePaths(sample1);
  check(
    "extractServicePaths: pulls a single-element array",
    JSON.stringify(paths1) === JSON.stringify(["/"]),
    `got=${JSON.stringify(paths1)}`,
  );

  const sample2 = `[[services]]
paths = ["/api", "/"]

[[services]]
paths = ["/extra"]
`;
  const paths2 = extractServicePaths(sample2);
  check(
    "extractServicePaths: handles multiple [[services]] and inline arrays",
    JSON.stringify(paths2) === JSON.stringify(["/api", "/", "/extra"]),
    `got=${JSON.stringify(paths2)}`,
  );

  const sample3 = `[[services]]
paths = [
  "/foo",
  "/bar",
]
`;
  const paths3 = extractServicePaths(sample3);
  check(
    "extractServicePaths: handles multi-line arrays",
    JSON.stringify(paths3) === JSON.stringify(["/foo", "/bar"]),
    `got=${JSON.stringify(paths3)}`,
  );

  // Sub-tables under [[services]] should NOT contribute. The
  // [services.production.health.startup] block has a singular `path =`
  // key (not `paths =`) but we still want to confirm that any `paths =`
  // appearing under a sub-table is ignored.
  const sample4 = `[[services]]
paths = ["/api"]

[services.production.health.startup]
path = "/api/healthz"

[services.production.run.env]
PORT = "8080"
`;
  const paths4 = extractServicePaths(sample4);
  check(
    "extractServicePaths: ignores sub-table keys (only [[services]]-level paths count)",
    JSON.stringify(paths4) === JSON.stringify(["/api"]),
    `got=${JSON.stringify(paths4)}`,
  );

  // findArtifactPathConflicts: positive case (the original task #324
  // regression) — both artifacts claim "/". This is the exact shape of
  // the regression we exist to catch: the artifact under test (`foo`)
  // here also declares "/api", but it's the duplicated "/" that
  // matters. Asserting on the specific (artifactA/B, pathA/B) tuple
  // verifies that the failure message will name both offending
  // artifacts AND the offending path, which is "Done looks like" #1.
  const synthetic = {
    "artifacts/foo": ["/api", "/"],
    "artifacts/bar": ["/"],
  };
  const found = findArtifactPathConflicts(synthetic);
  check(
    "findArtifactPathConflicts: detects task #324's `/` vs `/` collision",
    found.length === 1 &&
      found[0].artifactA === "artifacts/foo" &&
      found[0].artifactB === "artifacts/bar" &&
      found[0].pathA === "/" &&
      found[0].pathB === "/",
    `conflicts=${JSON.stringify(found)}`,
  );

  // findArtifactPathConflicts: the CURRENT real-world layout (vulnrap=`/`,
  // api-server=`/api`) is the intended SPA-alongside-API shape and must
  // NOT be flagged. If this assertion ever flips, the conflict
  // detection has regressed into producing false positives that would
  // block legitimate setups.
  const realisticLayout = {
    "artifacts/api-server": ["/api"],
    "artifacts/vulnrap": ["/"],
  };
  const realisticConflicts = findArtifactPathConflicts(realisticLayout);
  check(
    "findArtifactPathConflicts: SPA(`/`) + API(`/api`) is NOT a conflict",
    realisticConflicts.length === 0,
    `conflicts=${JSON.stringify(realisticConflicts)}`,
  );

  // findArtifactPathConflicts: deliberately-conflicting NEW prefix on a
  // fresh artifact gets caught (Done looks like #3). Simulates "agent
  // adds a new artifact and reuses /api" without us having to actually
  // mutate a real .replit-artifact/artifact.toml on disk.
  const newCollision = {
    "artifacts/api-server": ["/api"],
    "artifacts/vulnrap": ["/"],
    "artifacts/new-thing": ["/api"],
  };
  const newCollisionConflicts = findArtifactPathConflicts(newCollision);
  check(
    "findArtifactPathConflicts: a fresh artifact reusing an existing prefix is caught",
    newCollisionConflicts.length === 1 &&
      newCollisionConflicts[0].artifactA === "artifacts/api-server" &&
      newCollisionConflicts[0].artifactB === "artifacts/new-thing" &&
      newCollisionConflicts[0].pathA === "/api" &&
      newCollisionConflicts[0].pathB === "/api",
    `conflicts=${JSON.stringify(newCollisionConflicts)}`,
  );

  // findArtifactPathConflicts: trailing-slash variants of the same
  // route are still detected.
  const trailingSlash = {
    "artifacts/foo": ["/admin"],
    "artifacts/bar": ["/admin/"],
  };
  const trailingSlashConflicts = findArtifactPathConflicts(trailingSlash);
  check(
    "findArtifactPathConflicts: trailing-slash variants of the same route collide",
    trailingSlashConflicts.length === 1,
    `conflicts=${JSON.stringify(trailingSlashConflicts)}`,
  );

  // findArtifactPathConflicts: segment-aligned nested-prefix conflict
  // gets flagged with both offending paths in the report (so the
  // failure message points at /api AND /api/v1, not just the artifact
  // names) — Done-looks-like #1.
  const nested = {
    "artifacts/foo": ["/api"],
    "artifacts/bar": ["/api/v1"],
  };
  const nestedConflicts = findArtifactPathConflicts(nested);
  check(
    "findArtifactPathConflicts: nested-prefix conflict is reported with both paths",
    nestedConflicts.length === 1 &&
      nestedConflicts[0].pathA === "/api" &&
      nestedConflicts[0].pathB === "/api/v1",
    `conflicts=${JSON.stringify(nestedConflicts)}`,
  );

  // findArtifactPathConflicts: clean disjoint prefixes produce no
  // conflicts.
  const clean = {
    "artifacts/foo": ["/api"],
    "artifacts/bar": ["/web"],
    "artifacts/baz": ["/admin"],
  };
  check(
    "findArtifactPathConflicts: disjoint prefixes produce no conflicts",
    findArtifactPathConflicts(clean).length === 0,
  );

  // findArtifactPathConflicts: shared character prefix that's NOT
  // segment-aligned is allowed (so /api and /apidocs can coexist).
  const charPrefix = {
    "artifacts/foo": ["/api"],
    "artifacts/bar": ["/apidocs"],
  };
  check(
    "findArtifactPathConflicts: /api vs /apidocs is allowed (not segment-aligned)",
    findArtifactPathConflicts(charPrefix).length === 0,
  );
}

// 2) Real-world: load every artifacts/*/.replit-artifact/artifact.toml
//    and assert no conflicts. This is the regression guard proper.
const artifactDirs = (await readdir(ARTIFACTS_DIR, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const pathsByArtifact = {};
for (const name of artifactDirs) {
  const tomlPath = path.join(
    ARTIFACTS_DIR,
    name,
    ".replit-artifact",
    "artifact.toml",
  );
  let text;
  try {
    text = await readFile(tomlPath, "utf8");
  } catch (err) {
    // Not every artifacts/<name>/ subdir is an artifact (data/ holds
    // CSV samples, for example). Missing artifact.toml is fine.
    if (err.code === "ENOENT") continue;
    throw err;
  }
  const paths = extractServicePaths(text);
  // Only artifacts that actually declare routing paths can collide.
  if (paths.length > 0) {
    pathsByArtifact[`artifacts/${name}`] = paths;
  }
}

check(
  "found at least one artifact with declared [[services]] paths",
  Object.keys(pathsByArtifact).length > 0,
  "no artifact.toml under artifacts/*/.replit-artifact/ declared any " +
    "[[services]] paths -- did the workspace layout change? If so, this " +
    "test's discovery loop probably needs updating.",
);

const realConflicts = findArtifactPathConflicts(pathsByArtifact);
const conflictReport = realConflicts.length
  ? realConflicts
      .map(
        (c) =>
          `      - ${c.artifactA} (path ${JSON.stringify(c.pathA)}) overlaps ` +
          `${c.artifactB} (path ${JSON.stringify(c.pathB)})`,
      )
      .join("\n")
  : "";

check(
  "no two artifacts declare overlapping path prefixes",
  realConflicts.length === 0,
  conflictReport
    ? `${conflictReport}\n       ` +
        `Two artifacts declared overlapping routing prefixes. Pick ` +
        `non-overlapping prefixes in each artifact's [[services]] paths ` +
        `array (e.g. /api vs /web; the catch-all "/" may coexist with ` +
        `any non-"/" prefix). Duplicating "/" across artifacts -- or ` +
        `nesting one artifact's prefix inside another (e.g. /api and ` +
        `/api/v1) -- is the regression from task #324: the workspace ` +
        `path router gets two candidates for the same request, silently ` +
        `picks one, and breaks the other artifact's dev server. Fix via ` +
        `verifyAndReplaceArtifactToml; do not edit artifact.toml in place.`
    : "",
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
