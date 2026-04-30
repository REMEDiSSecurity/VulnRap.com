#!/usr/bin/env node
// Standalone sanity test for scripts/vulnrap-e2e-select-specs.mjs.
//
// Run: `node scripts/vulnrap-e2e-select-specs.test.mjs` (exit 0 == pass)
//
// Covers the decision policy documented at the top of the selector:
//   1. Empty / missing diff -> ALL (safe default).
//   2. Shared file in FULL_SUITE_PATTERNS -> ALL (with reason).
//   3. Spec file directly touched -> SUBSET containing only that spec.
//   4. Only-unrelated-files diff -> NONE.
//   5. Subset + shared file in same diff -> still ALL (shared wins).
//   6. Touched spec basename that doesn't exist on disk is dropped from
//      the subset (typo / deleted spec / rename safety).
//   7. The CLI integration: invoking the script as a subprocess emits the
//      expected stdout protocol.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FULL_SUITE_PATTERNS,
  selectSpecs,
  listSpecs,
} from "./vulnrap-e2e-select-specs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "vulnrap-e2e-select-specs.mjs");

let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const ALL_SPECS = listSpecs();
check(
  "listSpecs returns the on-disk specs (>= 20 expected for the current suite)",
  ALL_SPECS.length >= 20,
  `got ${ALL_SPECS.length} spec(s): ${ALL_SPECS.slice(0, 3).join(", ")}...`,
);

// --- Policy (1): missing diff -> ALL ---
{
  const r = selectSpecs(undefined, ALL_SPECS);
  check("missing diff -> mode=all", r.mode === "all", JSON.stringify(r));
}
{
  const r = selectSpecs([], ALL_SPECS);
  check("empty diff -> mode=all", r.mode === "all", JSON.stringify(r));
}

// --- Policy (2): each FULL_SUITE_PATTERNS entry must trigger ALL ---
// Hand-pick a representative path per category so we don't just rely on the
// patterns silently matching themselves.
const SHARED_FILE_SAMPLES = [
  "scripts/vulnrap-e2e-check.sh",
  "scripts/vulnrap-e2e-select-specs.mjs",
  "scripts/vulnrap-e2e-select-specs.test.mjs",
  "scripts/vulnrap-e2e-register.mjs",
  "scripts/vulnrap-e2e-register.test.mjs",
  "scripts/build-if-stale.mjs",
  "artifacts/vulnrap/playwright.config.ts",
  "artifacts/vulnrap/e2e/helpers/handwavy.ts",
  "artifacts/vulnrap/src/pages/feedback-analytics.tsx",
  "artifacts/vulnrap/public/favicon.ico",
  "artifacts/vulnrap/index.html",
  "artifacts/vulnrap/vite.config.ts",
  "artifacts/vulnrap/package.json",
  "artifacts/vulnrap/tsconfig.json",
  "artifacts/vulnrap/components.json",
  "artifacts/api-server/src/routes/feedback.ts",
  "artifacts/api-server/src/routes/calibration.ts",
  "artifacts/api-server/src/lib/redactor.ts",
  "artifacts/api-server/src/middlewares/anything.ts",
  "artifacts/api-server/build.mjs",
  "artifacts/api-server/package.json",
  "artifacts/api-server/tsconfig.json",
  "lib/api-spec/openapi.yaml",
  "lib/api-spec/src/index.ts",
  "lib/avri-rubric/src/foo.ts",
  "lib/avri-rubric/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "tsconfig.base.json",
  ".npmrc",
];
for (const f of SHARED_FILE_SAMPLES) {
  const r = selectSpecs([f], ALL_SPECS);
  check(
    `shared file forces ALL: ${f}`,
    r.mode === "all" && /shared file changed/.test(r.reason ?? ""),
    JSON.stringify(r),
  );
}

// --- Policy (3): touching a spec file selects only that spec ---
const SAMPLE_SPEC = ALL_SPECS.find((s) => s === "handwavy-undo.spec.ts");
check(
  "fixture spec exists on disk: handwavy-undo.spec.ts",
  Boolean(SAMPLE_SPEC),
);
{
  const r = selectSpecs([`artifacts/vulnrap/e2e/${SAMPLE_SPEC}`], ALL_SPECS);
  check(
    "single touched spec -> mode=subset with that spec only",
    r.mode === "subset" &&
      r.specs.length === 1 &&
      r.specs[0] === SAMPLE_SPEC,
    JSON.stringify(r),
  );
}
{
  const two = ALL_SPECS.slice(0, 2);
  const r = selectSpecs(
    two.map((s) => `artifacts/vulnrap/e2e/${s}`),
    ALL_SPECS,
  );
  check(
    "two touched specs -> mode=subset with both, sorted",
    r.mode === "subset" &&
      JSON.stringify(r.specs) === JSON.stringify([...two].sort()),
    JSON.stringify(r),
  );
}

// --- Policy (4): unrelated files -> NONE ---
const UNRELATED_FILES = [
  "artifacts/mockup-sandbox/src/index.tsx",
  "artifacts/mockup-sandbox/package.json",
  "README.md",
  ".local/tasks/task-251.md",
  "replit.md",
];
for (const f of UNRELATED_FILES) {
  const r = selectSpecs([f], ALL_SPECS);
  check(
    `unrelated file -> mode=none: ${f}`,
    r.mode === "none",
    JSON.stringify(r),
  );
}

// --- Policy (5): shared + spec in same diff -> ALL wins ---
{
  const r = selectSpecs(
    [
      `artifacts/vulnrap/e2e/${SAMPLE_SPEC}`,
      "artifacts/vulnrap/playwright.config.ts",
    ],
    ALL_SPECS,
  );
  check(
    "shared + spec in same diff -> mode=all (shared wins)",
    r.mode === "all",
    JSON.stringify(r),
  );
}

// --- Policy (6): typo / nonexistent spec basename is ignored ---
{
  const r = selectSpecs(
    ["artifacts/vulnrap/e2e/totally-not-a-real-spec.spec.ts"],
    ALL_SPECS,
  );
  check(
    "nonexistent spec basename is dropped -> mode=none",
    r.mode === "none",
    JSON.stringify(r),
  );
}

// --- Sanity: every FULL_SUITE_PATTERNS entry has at least one sample
// covering it so we don't silently lose a category. ---
for (const pat of FULL_SUITE_PATTERNS) {
  const matched = SHARED_FILE_SAMPLES.some((f) => pat.test(f));
  check(`FULL_SUITE_PATTERNS coverage: ${pat}`, matched);
}

// --- Policy (8): E2E_RUN_ALL_SPECS=1 forces ALL even on a NONE diff ---
{
  const prev = process.env.E2E_RUN_ALL_SPECS;
  process.env.E2E_RUN_ALL_SPECS = "1";
  try {
    const r = selectSpecs(["README.md"], ALL_SPECS);
    check(
      "E2E_RUN_ALL_SPECS=1 forces ALL",
      r.mode === "all" && r.reason === "E2E_RUN_ALL_SPECS=1",
      JSON.stringify(r),
    );
  } finally {
    if (prev === undefined) delete process.env.E2E_RUN_ALL_SPECS;
    else process.env.E2E_RUN_ALL_SPECS = prev;
  }
}

// --- CLI integration: subprocess returns one of the expected protocols ---
{
  const env = { ...process.env, E2E_RUN_ALL_SPECS: "1" };
  const res = spawnSync("node", [SCRIPT], { encoding: "utf8", env });
  check(
    "CLI: E2E_RUN_ALL_SPECS=1 prints exactly 'ALL' on stdout",
    res.status === 0 && res.stdout.trim() === "ALL",
    `status=${res.status} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
