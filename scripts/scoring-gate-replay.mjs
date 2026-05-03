#!/usr/bin/env node
// Task #641 — Pre-merge scoring gate: thin Node wrapper that drives the
// vitest-hosted replay test. Lives at the repo root next to the bash
// gate so the post-merge hook can invoke it without knowing where the
// api-server's vitest config lives.
//
// Why a wrapper at all (instead of just `vitest run …` from the bash
// script)?
//   1. We pin the activation env (SCORING_GATE_REPLAY=1) and the test
//      file path in one place, so a future move of the test file does
//      not silently turn the gate into a no-op.
//   2. We translate vitest's exit code into a gate-specific error
//      message that explains the bypass procedure, instead of dumping
//      a raw "vitest exited 1" on the post-merge log.
//   3. It gives us a single entrypoint to extend with extra replay
//      modes later (e.g. swap to a stored fixture battery) without
//      touching post-merge.sh or scoring-gate.sh.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testFile = path.join(
  "test",
  "regression",
  "scoring-replay.test.ts",
);
const apiServerDir = path.join(repoRoot, "artifacts", "api-server");
const absoluteTestPath = path.join(apiServerDir, testFile);

if (!existsSync(absoluteTestPath)) {
  console.error(
    `[scoring-gate-replay] expected replay test at ${absoluteTestPath} but it is missing.`,
  );
  process.exit(2);
}

const env = {
  ...process.env,
  SCORING_GATE_REPLAY: "1",
};

console.log(
  `[scoring-gate-replay] running replay test (${testFile})...`,
);
const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@workspace/api-server",
    "exec",
    "vitest",
    "run",
    testFile,
    "--reporter=verbose",
  ],
  { stdio: "inherit", env, cwd: repoRoot },
);

if (result.error) {
  console.error(
    `[scoring-gate-replay] failed to spawn vitest: ${result.error.message}`,
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `[scoring-gate-replay] FAIL: replay exited with code ${result.status}. ` +
      "If this is an intentional calibration change, set SCORING_GATE_BYPASS=1 " +
      "before merging (see README 'Pre-merge scoring gate').",
  );
  process.exit(result.status ?? 1);
}

console.log("[scoring-gate-replay] OK: replay passed.");
