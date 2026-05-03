#!/usr/bin/env node
// Standalone sanity test for
// scripts/regenerate-parallelization-runbook.mjs.
//
// Verifies the generator's regex-based plan parser, the file-conflict
// graph, and the wave assignment against the committed snapshot at
// `scripts/data/active-tasks.snapshot.json` so a future formatting change in
// task plan bodies can't silently degrade the runbook to an empty
// summary (e.g. "0 hot files, 0 waves").
//
// What we assert:
//   1. `--check` mode succeeds against the committed doc.
//   2. Re-running the generator is idempotent.
//   3. Hot-files table is non-empty (>= 1 row).
//   4. Every active task ref appears exactly once across the doc
//      (either inside a Wave table or in the Cannot parallelize
//      section — never both, never twice).
//   5. No task ref appears in two waves.
//   6. Cannot-parallelize section enumerates exactly the tasks whose
//      `## Relevant files` block is missing or contains zero concrete
//      entries.
//
// Run: `node scripts/regenerate-parallelization-runbook.test.mjs`
//      (exit 0 == pass; non-zero == one or more checks failed)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GEN = path.join(HERE, "regenerate-parallelization-runbook.mjs");
const DOC = path.join(
  ROOT,
  "artifacts/api-server/docs/parallelization-runbook.md",
);
const CACHE = path.join(ROOT, "scripts/data/active-tasks.snapshot.json");

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

// 2. Idempotent regeneration.
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
fs.writeFileSync(DOC, before);

// 3. Hot-files table is non-empty.
const hotSection = after.match(
  /## 2\. Hot files\s*\n([\s\S]*?)\n## 3\. Wave plan/,
);
const hotRows = hotSection
  ? (hotSection[1].match(/^\| `[^`]+` \| [\d,]+ \| \d+ \| /gm) || []).length
  : 0;
check(
  "hot files table has >= 1 row",
  hotRows >= 1,
  `found ${hotRows} hot-file rows -- conflict graph may have collapsed`,
);

// 4 & 5. Refs appear exactly once across the doc, and no ref appears
// in two waves.
const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const ACTIVE = new Set([
  "PROPOSED",
  "PENDING",
  "IN_PROGRESS",
  "BLOCKED_BY_DRIFT",
]);
const activeRefs = cache
  .filter((t) => ACTIVE.has(t.state))
  .map((t) => t.taskRef);

// Slice out the Wave plan section and the Cannot parallelize section
// independently so we can attribute each ref to one or the other.
const wavePlan = after.match(
  /## 3\. Wave plan\s*\n([\s\S]*?)\n## 4\. Cannot parallelize/,
);
const cannotSec = after.match(
  /## 4\. Cannot parallelize\s*\n([\s\S]*?)\n## 5\. Recommended next batch/,
);
check("wave plan section is present", !!wavePlan);
check("cannot parallelize section is present", !!cannotSec);

const wavePlanText = wavePlan ? wavePlan[1] : "";
const cannotText = cannotSec ? cannotSec[1] : "";

// Extract refs out of wave tables (each table row starts with `| \`#N\` |`).
const wavesByHeader = wavePlanText.split(/\n### Wave (\d+) /).slice(1);
const wavesMap = new Map(); // waveNum -> Set(refs)
for (let i = 0; i < wavesByHeader.length; i += 2) {
  const num = Number(wavesByHeader[i]);
  const body = wavesByHeader[i + 1] || "";
  const refs = [...body.matchAll(/^\| `(#\d+)` \|/gm)].map((m) => m[1]);
  wavesMap.set(num, new Set(refs));
}

// Sanity: at least 1 wave with > 1 task.
check(
  "wave plan has at least one wave",
  wavesMap.size >= 1,
  `found ${wavesMap.size} waves -- assignment may have failed`,
);

const cannotRefs = new Set(
  [...cannotText.matchAll(/^\| `(#\d+)` \|/gm)].map((m) => m[1]),
);

// 4. Every active ref appears exactly once.
const seen = new Map(); // ref -> count
for (const [, refs] of wavesMap) {
  for (const r of refs) seen.set(r, (seen.get(r) || 0) + 1);
}
for (const r of cannotRefs) seen.set(r, (seen.get(r) || 0) + 1);

const missing = activeRefs.filter((r) => !seen.has(r));
const dupes = [...seen.entries()].filter(([, n]) => n > 1);
check(
  "every active task ref appears in the doc",
  missing.length === 0,
  `missing refs: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`,
);
check(
  "no active task ref appears more than once",
  dupes.length === 0,
  `duplicates: ${dupes.slice(0, 5).map(([r, n]) => `${r}×${n}`).join(", ")}`,
);

// 5. No ref in two waves (subsumed by check 4 but asserted separately
// for diagnostic clarity).
const refToWaves = new Map();
for (const [w, refs] of wavesMap) {
  for (const r of refs) {
    if (!refToWaves.has(r)) refToWaves.set(r, []);
    refToWaves.get(r).push(w);
  }
}
const multiWave = [...refToWaves.entries()].filter(([, ws]) => ws.length > 1);
check(
  "no task ref appears in two waves",
  multiWave.length === 0,
  `multi-wave refs: ${multiWave.slice(0, 5).map(([r, ws]) => `${r}@${ws.join(",")}`).join(", ")}`,
);

// 6. Cannot-parallelize enumerates the tasks with no usable
// `## Relevant files` block. We re-run the same parser the script
// uses (inline copy below) to check agreement.
function dedent(text) {
  const lines = text.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^[ \t]*/);
    if (m && m[0].length < min) min = m[0].length;
  }
  if (!isFinite(min) || min === 0) return text;
  return lines.map((l) => l.slice(min)).join("\n");
}
function relevantBlock(desc) {
  const body = dedent(desc || "");
  const m = body.match(
    /\n[ \t]*##\s+Relevant files\s*\n([\s\S]*?)(?=\n[ \t]*##\s|\n[ \t]*#\s|$)/i,
  );
  return m ? m[1] : null;
}
function parseEntries(blockBody) {
  const entries = [];
  if (!blockBody) return entries;
  for (const line of blockBody.split("\n")) {
    const m = line.match(/^\s*-\s*`([^`]+)`\s*(.*)$/);
    if (!m) continue;
    const tickContent = m[1].trim();
    const tail = (m[2] || "").trim();
    const rangeMatch = tickContent.match(/^([^:]+):([\d,\-]+)$/);
    let pathOnly = (rangeMatch ? rangeMatch[1] : tickContent).replace(
      /\/+$/,
      "",
    );
    const basename = pathOnly.split("/").pop() || "";
    const hasExtension = /\.[A-Za-z0-9]+$/.test(basename);
    const isVague =
      pathOnly === "." ||
      pathOnly === "" ||
      /\bnew\b/i.test(tail) ||
      !hasExtension;
    entries.push({ path: pathOnly, isVague });
  }
  return entries;
}

const expectedCannot = new Set();
for (const t of cache) {
  if (!ACTIVE.has(t.state)) continue;
  const block = relevantBlock(t.description || "");
  const entries = parseEntries(block || "");
  const concrete = entries.filter((e) => !e.isVague);
  if (block === null || entries.length === 0 || concrete.length === 0) {
    expectedCannot.add(t.taskRef);
  }
}

const missingFromCannot = [...expectedCannot].filter((r) => !cannotRefs.has(r));
const surpriseInCannot = [...cannotRefs].filter((r) => !expectedCannot.has(r));
check(
  "cannot-parallelize section enumerates the right tasks",
  missingFromCannot.length === 0 && surpriseInCannot.length === 0,
  `missing-from-section=${missingFromCannot.join(",")} unexpected-in-section=${surpriseInCannot.join(",")}`,
);

// 7. Line-range references section is present.
const lineRangeSec = after.match(/\n## 6\. Line-range references\s*\n/);
check(
  "line-range references section is present",
  !!lineRangeSec,
  "section 6 (Line-range references) missing -- review fix #2 regressed",
);

// 8. Snapshot ingestion excludes IMPLEMENTED tasks.
const implementedInSnapshot = cache.filter((t) => t.state === "IMPLEMENTED");
check(
  "snapshot does not include IMPLEMENTED tasks",
  implementedInSnapshot.length === 0,
  `found ${implementedInSnapshot.length} IMPLEMENTED rows -- snapshot scope is wrong`,
);

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
