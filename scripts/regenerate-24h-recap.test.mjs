#!/usr/bin/env node
// Sanity test for scripts/regenerate-24h-recap.mjs.
//
// Asserts:
//   1. `--check` exits 0 against the committed doc.
//   2. Regen is structurally idempotent (date line ignored).
//   3. Every merged commit in the window appears exactly once in the doc.
//   4. "How the analysis got better" lists every signal with either a
//      number or the literal "no measurable change".
//   5. Headline stat chips reconcile to the bucket totals.
//   6. The marketing-draft block exists and is paste-ready.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GEN = path.join(HERE, "regenerate-24h-recap.mjs");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const headIso = git("log", "-1", "--format=%cI").trim();
const dateLabel = headIso.slice(0, 10);
const DOC = path.join(
  ROOT,
  `artifacts/api-server/docs/retrospectives/${dateLabel}-24h-recap.md`,
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

// 1. --check exits 0.
const checkRun = spawnSync("node", [GEN, "--check"], { cwd: ROOT, encoding: "utf8" });
check(
  "`--check` exits 0 against the committed doc",
  checkRun.status === 0,
  `status=${checkRun.status} stderr=${checkRun.stderr.trim()}`,
);

// 2. Idempotent regen.
const before = fs.readFileSync(DOC, "utf8");
const writeRun = spawnSync("node", [GEN], { cwd: ROOT, encoding: "utf8" });
check(
  "regeneration write succeeds",
  writeRun.status === 0,
  `status=${writeRun.status} stderr=${writeRun.stderr.trim()}`,
);
const after = fs.readFileSync(DOC, "utf8");
const strip = (s) => s.replace(/^\*\*Generated:\*\*[^\n]*\n/m, "");
check(
  "regeneration is structurally idempotent (date line ignored)",
  strip(before) === strip(after),
  "structural diff non-empty",
);
fs.writeFileSync(DOC, before);

// Pull the window the doc itself reports so we test against the same one.
// We bound queries by both --since AND --until so that any new commits
// landing between writeRun and these git queries (the workspace
// auto-commits) don't make the reconcile counts drift.
const windowMatch = after.match(/\*\*Window:\*\*[^`]*`([^`]+)`\s*→\s*`([^`]+)`/);
check("doc declares its own window", !!windowMatch, "Window header missing");
const sinceIso = windowMatch ? windowMatch[1] : null;
const untilIso = windowMatch ? windowMatch[2] : null;

// 3a. Squash-merge semantics: this repo squashes every task into trunk,
// so the recap treats every non-merge trunk commit in the window as
// the "merge" of one task. Assert the doc explains this convention so
// readers don't expect raw `git --merges` output.
check(
  "doc documents squash-merge convention for 'merge commits'",
  /squash[- ]merge/i.test(after) || /each commit corresponds to one merged task/i.test(after),
  "expected wording about squash-merge convention not found",
);

// 3b. Every merged commit in the window appears exactly once.
if (sinceIso) {
  const log = git(
    "log",
    `--since=${sinceIso}`,
    `--until=${untilIso}`,
    "--no-merges",
    "--format=%H|%s",
  ).trim();
  const lines = log ? log.split("\n") : [];
  let missing = 0;
  let dup = 0;
  for (const line of lines) {
    const [hash, subject] = line.split("|");
    const refMatch = subject.match(/Task\s*#(\d+)/i) || subject.match(/\(#(\d+)\)/);
    let needle;
    if (refMatch) {
      needle = `**Task #${refMatch[1]}**`;
    } else {
      needle = `\`${hash.slice(0, 8)}\``;
    }
    const occurrences = after.split(needle).length - 1;
    if (occurrences === 0) missing += 1;
    if (occurrences > 1) dup += 1;
  }
  check(
    "every merged commit/task appears at least once in 'What landed'",
    missing === 0,
    `${missing} missing of ${lines.length}`,
  );
  check(
    "no commit/task appears more than once",
    dup === 0,
    `${dup} duplicates of ${lines.length}`,
  );
}

// 4. Every signal in the analysis section has a number OR "no measurable change".
const SIGNALS = [
  "gold signals",
  "fabricated-evidence flags",
  "handwavy-phrase impact",
  "crash-trace",
  "hallucination cohort",
  "linguistic",
  "sloppiness (slop-signals)",
  "claim-specificity",
  "evidence-quality",
  "internal-consistency (CWE coherence)",
  "AVRI raw-http",
];
const analysisStart = after.indexOf("## 3. How the analysis got better");
const analysisEnd = after.indexOf("## 4.");
const analysis =
  analysisStart >= 0 && analysisEnd > analysisStart
    ? after.slice(analysisStart, analysisEnd)
    : "";
for (const sig of SIGNALS) {
  const lineRx = new RegExp(`\\*\\*${sig.replace(/[()]/g, "\\$&")}\\*\\*[^\\n]*`, "i");
  const m = analysis.match(lineRx);
  const ok =
    !!m && (/no measurable change/i.test(m[0]) || /[0-9]/.test(m[0]));
  check(
    `analysis section reports a number or "no measurable change" for: ${sig}`,
    ok,
    m ? `line: ${m[0]}` : "signal line missing",
  );
}

// 5. Headline stat chips reconcile.
const tasksMergedChip = after.match(/\*\*(\d+) tasks merged\*\*/);
const reconcileLine = after.match(/Bucket totals reconcile to (\d+) commits/);
check(
  "headline 'tasks merged' chip is present and numeric",
  !!tasksMergedChip && Number(tasksMergedChip[1]) >= 0,
  tasksMergedChip ? `chip=${tasksMergedChip[1]}` : "chip missing",
);
check(
  "bucket reconcile line is present",
  !!reconcileLine,
  "reconcile line missing",
);
if (tasksMergedChip && reconcileLine && sinceIso) {
  const totalCommits = git(
    "log",
    `--since=${sinceIso}`,
    `--until=${untilIso}`,
    "--no-merges",
    "--format=%H",
  )
    .trim()
    .split("\n")
    .filter(Boolean).length;
  check(
    "bucket reconcile total equals git's commit count for the window",
    Number(reconcileLine[1]) === totalCommits,
    `doc=${reconcileLine[1]} git=${totalCommits}`,
  );
}

// 5b. Tighten chip reconciliation: 'tasks merged' chip must equal the
// number of in-window commits whose subject parses as `Task #N`, and
// the 'commits' chip must equal git's --no-merges count for the
// window. This catches drift between the headline and the underlying
// counts the bucket section uses.
const commitsChip = after.match(/\*\*(\d+) commits\*\*/);
check(
  "headline 'commits' chip is present and numeric",
  !!commitsChip,
  commitsChip ? `chip=${commitsChip[1]}` : "chip missing",
);
if (sinceIso && tasksMergedChip && commitsChip) {
  const taskRefCount = git(
    "log",
    `--since=${sinceIso}`,
    `--until=${untilIso}`,
    "--no-merges",
    "--format=%s",
  )
    .trim()
    .split("\n")
    .filter((s) => /Task\s*#\d+/i.test(s) || /\(#\d+\)/.test(s)).length;
  const totalCommits = git(
    "log",
    `--since=${sinceIso}`,
    `--until=${untilIso}`,
    "--no-merges",
    "--format=%H",
  )
    .trim()
    .split("\n")
    .filter(Boolean).length;
  check(
    "headline 'tasks merged' chip equals git's task-ref count for the window",
    Number(tasksMergedChip[1]) === taskRefCount,
    `chip=${tasksMergedChip[1]} git-task-refs=${taskRefCount}`,
  );
  check(
    "headline 'commits' chip equals git's --no-merges count for the window",
    Number(commitsChip[1]) === totalCommits,
    `chip=${commitsChip[1]} git=${totalCommits}`,
  );
  check(
    "headline 'commits' chip equals bucket reconcile total",
    reconcileLine && Number(commitsChip[1]) === Number(reconcileLine[1]),
    `commits-chip=${commitsChip[1]} reconcile=${reconcileLine && reconcileLine[1]}`,
  );
}

// 5c. Cross-date behavior: when an older-dated recap exists alongside
// today's, regen must NOT overwrite the older one — it must target the
// HEAD-dated file. We simulate by writing a fake yesterday-recap and
// re-running the script.
{
  const dir = path.dirname(DOC);
  const head = new Date(headIso);
  const yesterday = new Date(head.getTime() - 24 * 3600 * 1000);
  const yLabel = yesterday.toISOString().slice(0, 10);
  const fakeOld = path.join(dir, `${yLabel}-24h-recap.md`);
  const sentinel = `# SENTINEL ${yLabel}\n**Window:** 24h — \`x\` → \`y\`\n`;
  const preExisted = fs.existsSync(fakeOld);
  const savedOld = preExisted ? fs.readFileSync(fakeOld, "utf8") : null;
  fs.writeFileSync(fakeOld, sentinel);
  try {
    const r = spawnSync("node", [GEN], { cwd: ROOT, encoding: "utf8" });
    check(
      "cross-date regen succeeds with older recap present",
      r.status === 0,
      `status=${r.status} stderr=${r.stderr.trim()}`,
    );
    check(
      "cross-date regen does NOT overwrite older recap",
      fs.readFileSync(fakeOld, "utf8") === sentinel,
      "older recap was overwritten",
    );
    check(
      "cross-date regen targets HEAD-dated file",
      fs.existsSync(DOC) && fs.readFileSync(DOC, "utf8").includes(`(${dateLabel})`),
      "HEAD-dated recap missing or malformed",
    );
  } finally {
    if (preExisted) fs.writeFileSync(fakeOld, savedOld);
    else fs.unlinkSync(fakeOld);
    // Restore the HEAD-dated doc so we don't leave drift behind.
    fs.writeFileSync(DOC, before);
  }
}

// 5d. New chips and surface-quality assertions per task spec.
check(
  "headline includes 'new integrations live' chip",
  /\*\*\d+ new integrations live\*\*/.test(after),
  "integrations chip missing",
);
check(
  "section 4 uses 'Value-prop' column when new routes exist",
  !/\*No new routes/.test(after) ? /\| Route \| Value-prop \|/.test(after) : true,
  "Value-prop column header missing",
);
check(
  "section 5 reports IN_PROGRESS + PENDING from snapshot when present",
  !fs.existsSync(path.join(ROOT, ".local/tasks/_status-snapshot.json")) ||
    /IN_PROGRESS \+ \d+ PENDING/.test(after),
  "expected 'N IN_PROGRESS + M PENDING' wording when snapshot exists",
);

// 6. Marketing draft is paste-ready.
check(
  "marketing draft section exists",
  /## Marketing draft/.test(after) && /paste-ready/i.test(after),
  "Marketing draft block missing or not labeled paste-ready",
);

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
