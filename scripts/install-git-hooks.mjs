#!/usr/bin/env node
// Install lefthook git hooks. Runs as the workspace `prepare` script after
// `pnpm install`. Skipped silently when:
//   - this is not a git checkout (e.g. fresh tarball / Docker COPY)
//   - we are running in CI (CI=true) where the hooks are not useful
//   - lefthook isn't on PATH (e.g. the binary postinstall was skipped)
// Contributors can also opt out with SKIP_HOOKS_INSTALL=1.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

if (process.env["SKIP_HOOKS_INSTALL"]) {
  process.exit(0);
}
if (process.env["CI"]) {
  process.exit(0);
}
if (!existsSync(resolve(repoRoot, ".git"))) {
  process.exit(0);
}

const result = spawnSync("pnpm", ["exec", "lefthook", "install"], {
  cwd: repoRoot,
  stdio: "inherit",
});

// Don't fail the install if lefthook is unavailable for any reason.
if (result.status !== 0) {
  console.warn(
    "[install-git-hooks] lefthook install did not complete cleanly; " +
      "skipping. Re-run `pnpm exec lefthook install` later if you want " +
      "the pre-commit hook.",
  );
}
process.exit(0);
