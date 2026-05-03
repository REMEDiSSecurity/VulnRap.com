#!/usr/bin/env node
// Release driver for VulnRap (Task #728).
//
// Runs the deterministic checklist a maintainer would otherwise have to
// remember every cut:
//
//   1. Refuse to run on a dirty tree.
//   2. Resolve the requested next version (CLI arg, env, or prompt) and
//      validate it is a clean SemVer step relative to the current
//      `package.json#version`.
//   3. typecheck + tests + build.
//   4. Compare the current `lib/api-spec/openapi.yaml` against the
//      previous release tag's spec (`scripts/openapi-breaking-diff.mjs`).
//      A breaking change is fatal unless the operator passes
//      `--allow-breaking` (and the new spec has a major bump).
//   5. Promote `CHANGELOG.md`'s "Unreleased" section into a new
//      `## [<version>] - <date>` heading.
//   6. Bump `package.json#version` and (when applicable) the spec's
//      `info.version`.
//   7. Print the exact `git commit` / `git tag` / `git push` commands
//      the maintainer should run. We deliberately do NOT push or commit
//      on the operator's behalf — Replit's workspace policy keeps git
//      mutations in human / platform hands.
//
// Usage:
//   node scripts/release.mjs <next-version> [--allow-breaking] [--dry-run]
//   RELEASE_VERSION=3.9.0 node scripts/release.mjs
//
// Env knobs:
//   RELEASE_VERSION       same as the positional arg.
//   RELEASE_ALLOW_DIRTY=1 skip the dirty-tree check (use only for rehearsals).
//   RELEASE_SKIP_TESTS=1  skip the `pnpm test` step (use only for rehearsals).

import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const positional = args.filter((a) => !a.startsWith("--"));
const dryRun = flag("--dry-run");
const allowBreaking = flag("--allow-breaking");
const allowDirty = process.env.RELEASE_ALLOW_DIRTY === "1";
const skipTests = process.env.RELEASE_SKIP_TESTS === "1";

function die(msg, code = 1) {
  console.error(`[release] FAIL: ${msg}`);
  process.exit(code);
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`[release] $ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun && opts.skipOnDryRun !== false) {
    console.log("[release]   (dry-run) skipped");
    return { status: 0, stdout: "", stderr: "" };
  }
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    stdio: opts.stdio ?? "inherit",
  });
  if (r.status !== 0 && !opts.allowFailure) {
    die(`${cmd} ${cmdArgs.join(" ")} exited with code ${r.status}`);
  }
  return r;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

function isValidNext(prev, next) {
  const p = parseSemver(prev);
  const n = parseSemver(next);
  if (!p || !n) return false;
  if (n.major === p.major + 1 && n.minor === 0 && n.patch === 0) return true;
  if (n.major === p.major && n.minor === p.minor + 1 && n.patch === 0) return true;
  if (n.major === p.major && n.minor === p.minor && n.patch === p.patch + 1) return true;
  // Allow same-or-greater pre-release tags (e.g. 3.9.0-rc.1 -> 3.9.0).
  if (p.pre && !n.pre && p.major === n.major && p.minor === n.minor && p.patch === n.patch)
    return true;
  return false;
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function readSpecVersion(specPath) {
  const text = await readFile(specPath, "utf8");
  const m = text.match(/^(\s*version:\s*)([^\s#]+)(.*)$/m);
  if (!m) die(`Could not find info.version in ${specPath}`);
  return { current: m[2].replace(/^['"]|['"]$/g, ""), full: m[0], prefix: m[1], suffix: m[3] };
}

async function bumpSpecVersionIfNeeded(specPath, nextProjectVersion) {
  // Spec SemVer is independent of the project SemVer (per docs/versioning.md),
  // so we only ever auto-bump the spec when --allow-breaking is set AND the
  // detector flagged breaking changes. Otherwise we leave the spec version
  // alone and let the maintainer bump it manually as part of the changelog.
  if (!allowBreaking) return null;
  const { current, full, prefix, suffix } = await readSpecVersion(specPath);
  const parsed = parseSemver(current);
  if (!parsed) die(`Spec version is not SemVer: ${current}`);
  const next = `${parsed.major + 1}.0.0`;
  console.log(`[release] Bumping spec info.version: ${current} -> ${next}`);
  if (dryRun) return next;
  const text = await readFile(specPath, "utf8");
  await writeFile(specPath, text.replace(full, `${prefix}${next}${suffix}`));
  void nextProjectVersion;
  return next;
}

async function promoteChangelog(version) {
  const clPath = path.resolve(ROOT, "CHANGELOG.md");
  if (!existsSync(clPath)) die("CHANGELOG.md not found at repo root.");
  const text = await readFile(clPath, "utf8");
  const headerRe = /^##\s+\[Unreleased\]\s*$/m;
  if (!headerRe.test(text)) die("CHANGELOG.md is missing a `## [Unreleased]` section.");
  const today = new Date().toISOString().slice(0, 10);
  const next = text.replace(
    headerRe,
    `## [Unreleased]\n\n_No changes yet._\n\n## [${version}] - ${today}`,
  );
  console.log(`[release] Promoting CHANGELOG Unreleased -> [${version}] - ${today}`);
  if (dryRun) return;
  await writeFile(clPath, next);
}

async function bumpPackageVersion(version) {
  const pkgPath = path.resolve(ROOT, "package.json");
  const pkg = await readJson(pkgPath);
  pkg.version = version;
  console.log(`[release] Bumping root package.json#version -> ${version}`);
  if (dryRun) return;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

async function ensureCleanTree() {
  if (allowDirty) {
    console.log("[release] RELEASE_ALLOW_DIRTY=1 — skipping dirty-tree check.");
    return;
  }
  const r = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (r.status !== 0) die("git status failed; are we in a git checkout?");
  if (r.stdout.trim().length > 0) {
    die(
      "Working tree has uncommitted changes. Commit or stash before releasing, or set RELEASE_ALLOW_DIRTY=1 for rehearsals.",
    );
  }
}

function previousReleaseTag() {
  const r = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

async function readSpecAtTag(tag, specRelPath) {
  const r = spawnSync("git", ["show", `${tag}:${specRelPath}`], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "vulnrap-release-"));
  const out = path.join(dir, "openapi.previous.yaml");
  await writeFile(out, r.stdout);
  return out;
}

async function main() {
  const pkgPath = path.resolve(ROOT, "package.json");
  const pkg = await readJson(pkgPath);
  const currentVersion = pkg.version;
  const nextVersion = positional[0] ?? process.env.RELEASE_VERSION;
  if (!nextVersion) {
    die(
      "Pass the next version as an arg (e.g. `node scripts/release.mjs 3.9.0`) or set RELEASE_VERSION.",
    );
  }
  if (!parseSemver(nextVersion)) die(`Not a valid SemVer: ${nextVersion}`);
  if (!isValidNext(currentVersion, nextVersion)) {
    die(
      `Refusing to step ${currentVersion} -> ${nextVersion}. Only major / minor / patch single-step bumps are allowed.`,
    );
  }
  console.log(`[release] Current version: ${currentVersion}`);
  console.log(`[release] Next    version: ${nextVersion}`);

  await ensureCleanTree();

  console.log("[release] Step 1/5 — typecheck");
  run("pnpm", ["run", "typecheck"]);

  if (skipTests) {
    console.log("[release] RELEASE_SKIP_TESTS=1 — skipping tests.");
  } else {
    console.log("[release] Step 2/5 — tests");
    run("pnpm", ["run", "test"]);
  }

  console.log("[release] Step 3/5 — build");
  run("pnpm", ["run", "build"]);

  console.log("[release] Step 4/5 — OpenAPI breaking-change diff");
  const specRel = "lib/api-spec/openapi.yaml";
  const specCur = path.resolve(ROOT, specRel);
  const tag = previousReleaseTag();
  if (!tag) {
    console.log("[release] No previous v* tag found — skipping OpenAPI diff (first release).");
  } else {
    console.log(`[release] Diffing ${specRel} against ${tag}`);
    const prevSpec = await readSpecAtTag(tag, specRel);
    if (!prevSpec) {
      console.log(`[release] ${tag} did not contain ${specRel}; skipping diff.`);
    } else {
      const r = spawnSync(
        process.execPath,
        [path.resolve(__dirname, "openapi-breaking-diff.mjs"), prevSpec, specCur],
        { stdio: "inherit" },
      );
      if (r.status === 1 && !allowBreaking) {
        die(
          "Breaking OpenAPI changes detected. Re-run with --allow-breaking after bumping the spec's major version, or revert the breaking change.",
        );
      } else if (r.status === 1 && allowBreaking) {
        console.log("[release] --allow-breaking: continuing despite breaking changes.");
        await bumpSpecVersionIfNeeded(specCur, nextVersion);
      } else if (r.status !== 0 && r.status !== 1) {
        die(`openapi-breaking-diff exited with ${r.status}`);
      }
    }
  }

  console.log("[release] Step 5/5 — manifest + CHANGELOG bump");
  await promoteChangelog(nextVersion);
  await bumpPackageVersion(nextVersion);

  console.log("");
  console.log("[release] Done. Final manual steps:");
  console.log("");
  console.log("  git add package.json CHANGELOG.md lib/api-spec/openapi.yaml");
  console.log(`  git commit -m "release: v${nextVersion}"`);
  console.log(`  git tag -a v${nextVersion} -m "v${nextVersion}"`);
  console.log("  git push origin HEAD");
  console.log(`  git push origin v${nextVersion}`);
  console.log("");
  console.log(
    "  The `v*` tag push triggers .github/workflows/release.yml and .github/workflows/release-sbom.yml,",
  );
  console.log(
    "  which build the Docker image, generate the SBOM, and attach both to the GitHub Release.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
