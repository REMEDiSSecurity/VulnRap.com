#!/usr/bin/env node
// Standalone sanity test for scripts/regenerate-state-of-platform.mjs.
// Verifies the generator's regex-based parsers against the current
// source tree so a future formatting change in openapi.yaml or
// families.ts can't silently degrade the doc to a count-only summary
// (the regression that triggered the doc's first rewrite).
//
// What we assert:
//   1. `--check` mode succeeds (i.e. the committed doc matches what
//      the generator would write today, ignoring the `Generated:`
//      date line).
//   2. Re-running the generator is idempotent: write -> read -> diff
//      shows zero structural changes (date line stripped).
//   3. Endpoint introspection finds at least 30 operations and
//      includes both a known reports endpoint and a known calibration
//      endpoint (so a sweeping YAML reformat that breaks the path
//      regex fails the test instead of producing an empty table).
//   4. AVRI family parser produces all 9 families AND each family's
//      signal entries are individually enumerated (not just counted).
//      A known signal id (`asan_or_sanitizer`) and a known absence
//      penalty id (`no_payload`) are both present in the rendered
//      doc with their human-readable descriptions, so a parser drift
//      that silently drops the per-entry rendering fails loudly.
//   5. Fixture cohort counts are non-zero for every tier the doc
//      reports on (T1/T2/T3/T4) and the totals match the source
//      file's id count.
//
// Run: `node scripts/regenerate-state-of-platform.test.mjs`
//      (exit 0 == pass; non-zero == one or more checks failed)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GEN = path.join(HERE, "regenerate-state-of-platform.mjs");
const DOC = path.join(
  ROOT,
  "artifacts/api-server/docs/2026-05-02-state-of-platform.md",
);

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// 1. --check exits 0 against the committed doc.
const checkRun = spawnSync("node", [GEN, "--check"], {
  cwd: ROOT,
  encoding: "utf8",
});
check(
  "`--check` exits 0 against the committed doc",
  checkRun.status === 0,
  `status=${checkRun.status} stderr=${checkRun.stderr.trim()}`,
);

// 2. Idempotent regeneration: snapshot the committed doc, regenerate,
//    diff structurally, then restore.
const before = fs.readFileSync(DOC, "utf8");
const writeRun = spawnSync("node", [GEN], { cwd: ROOT, encoding: "utf8" });
check(
  "regeneration write succeeds",
  writeRun.status === 0,
  `status=${writeRun.status} stderr=${writeRun.stderr.trim()}`,
);
const after = fs.readFileSync(DOC, "utf8");
function strip(s) {
  return s.replace(/^\*\*Generated:\*\*[^\n]*\n/m, "");
}
check(
  "regeneration is structurally idempotent (date line ignored)",
  strip(before) === strip(after),
  "structural diff non-empty -- generator output drifted between runs",
);
// Restore exact bytes so this test never leaves the working tree dirty.
fs.writeFileSync(DOC, before);

// 3. Endpoint introspection.
const opCount = (after.match(/^\| `(GET|POST|PUT|DELETE|PATCH)` \|/gm) || [])
  .length;
check(
  "endpoint table has >= 30 operations",
  opCount >= 30,
  `found ${opCount} table rows -- YAML path regex may have regressed`,
);
check(
  "endpoint table includes a known reports endpoint",
  /\| `GET` \| `\/reports\/feed`/.test(after),
  "/reports/feed missing from endpoint table",
);
check(
  "endpoint table includes a known calibration endpoint",
  /`\/feedback\/calibration\/avri-drift`/.test(after),
  "/feedback/calibration/avri-drift missing from endpoint table",
);
check(
  "narrative correctly lists /reports/lookup/{hash} as GET",
  /`GET \/reports\/lookup\/\{hash\}`/.test(after) &&
    !/`POST \/reports\/lookup\/\{hash\}`/.test(after),
  "lookup-by-hash narrative method mismatch",
);

// 4. AVRI family parser: per-family signal enumeration.
const FAMILY_HEADERS = [
  "`MEMORY_CORRUPTION`",
  "`INJECTION`",
  "`WEB_CLIENT`",
  "`AUTHN_AUTHZ`",
  "`CRYPTO`",
  "`DESERIALIZATION`",
  "`RACE_CONCURRENCY`",
  "`REQUEST_SMUGGLING`",
  "`FLAT`",
];
for (const h of FAMILY_HEADERS) {
  check(
    `signal catalog has section for family ${h}`,
    after.includes(`#### ${h}`),
    `missing #### header containing ${h}`,
  );
}
check(
  "per-family signal table renders a known gold signal id",
  after.includes("`asan_or_sanitizer`") && after.includes("AddressSanitizer"),
  "asan_or_sanitizer / AddressSanitizer description missing",
);
check(
  "per-family signal table renders a known absence penalty id",
  after.includes("`no_payload`") &&
    after.includes("No concrete injection payload"),
  "no_payload / 'No concrete injection payload' missing",
);
const goldRowCount = (
  after.match(/^\| `[a-z_0-9]+` \| .+ \| \+\d+ \|$/gm) || []
).length;
check(
  "rendered gold-signal rows >= 50 (every signal id, not just counts)",
  goldRowCount >= 50,
  `found ${goldRowCount} gold rows -- per-entry rendering may have collapsed`,
);

// 5. Fixture cohort counts. The doc renders bullets like:
//    - **`T1_LEGIT`** — well-evidenced ...: **15** fixtures
const tierFacts = {
  T1_LEGIT: after.match(/`T1_LEGIT`[\s\S]*?: \*\*(\d+)\*\* fixtures/),
  T2_BORDERLINE: after.match(/`T2_BORDERLINE`[\s\S]*?: \*\*(\d+)\*\* fixtures/),
  T3_SLOP: after.match(/`T3_SLOP`[\s\S]*?: \*\*(\d+)\*\* fixtures/),
  T4_HALLUCINATED: after.match(
    /`T4_HALLUCINATED`[\s\S]*?: \*\*(\d+)\*\* fixtures/,
  ),
};
for (const [tier, m] of Object.entries(tierFacts)) {
  const n = m ? Number(m[1]) : 0;
  check(
    `fixture battery reports a non-zero ${tier} count`,
    n > 0,
    m
      ? `parsed count = ${n} (suspicious zero)`
      : `count line for ${tier} not found`,
  );
}
const totalLine = after.match(/\*\*Total\*\*: \*\*(\d+)\*\* fixtures/);
const sourceIdCount = (
  fs
    .readFileSync(
      path.join(ROOT, "artifacts/api-server/src/routes/test-fixtures.ts"),
      "utf8",
    )
    .match(/^\s*id:\s*"/gm) || []
).length;
check(
  "fixture battery total in doc matches source id count",
  totalLine && Number(totalLine[1]) === sourceIdCount,
  `doc total=${totalLine ? totalLine[1] : "(missing)"} source=${sourceIdCount}`,
);

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
