#!/usr/bin/env node
// Run `tsc --noEmit` for each workspace package containing one of the
// staged TypeScript files passed as CLI args. Invoked from lefthook
// pre-commit so the slow full-monorepo typecheck stays out of the hot path.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const staged = process.argv.slice(2).filter(Boolean);
if (staged.length === 0) {
  process.exit(0);
}

function findPackageDir(filePath) {
  let dir = dirname(resolve(filePath));
  while (dir.startsWith(repoRoot) && dir !== repoRoot) {
    if (existsSync(resolve(dir, "tsconfig.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

const pkgs = new Set();
for (const f of staged) {
  const pkg = findPackageDir(f);
  if (pkg) pkgs.add(pkg);
}

if (pkgs.size === 0) {
  process.exit(0);
}

let failed = false;
for (const pkg of pkgs) {
  const rel = relative(repoRoot, pkg) || ".";
  process.stdout.write(`\u2192 typecheck ${rel}\n`);
  const result = spawnSync(
    "pnpm",
    ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
    { cwd: pkg, stdio: "inherit" },
  );
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
