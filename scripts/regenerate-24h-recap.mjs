#!/usr/bin/env node
//
// regenerate-24h-recap.mjs
//
// Generates a 24-hour retrospective doc at
//   artifacts/api-server/docs/retrospectives/<YYYY-MM-DD>-24h-recap.md
//
// Mirrors the conventions of scripts/regenerate-state-of-platform.mjs:
//   - No external deps (Node stdlib only).
//   - --check exits non-zero if regenerating would change the doc
//     (the time-sensitive "Generated:" header line is ignored).
//   - Hand-written narrative lives inline as JS template strings.
//
// Usage:
//   node scripts/regenerate-24h-recap.mjs
//   node scripts/regenerate-24h-recap.mjs --check
//   node scripts/regenerate-24h-recap.mjs --window=48h
//   node scripts/regenerate-24h-recap.mjs --since=2026-05-02T00:00:00Z
//
// The window is anchored to the HEAD commit's timestamp (deterministic
// regen across runs even though wall-clock keeps moving). --since wins
// over --window. --window accepts <N>h or <N>d.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
let windowArg = "24h";
let sinceArg = null;
for (const a of args) {
  if (a.startsWith("--window=")) windowArg = a.slice("--window=".length);
  if (a.startsWith("--since=")) sinceArg = a.slice("--since=".length);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function headTimestampIso() {
  return git("log", "-1", "--format=%cI").trim();
}

function parseWindowMs(win) {
  const m = win.match(/^(\d+)([hd])$/);
  if (!m) throw new Error(`Bad --window value: ${win}`);
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600 * 1000 : n * 86400 * 1000;
}

// Anchor strategy: if the recap doc for HEAD's date already exists on
// disk, reuse the window it declares. This is what makes regen + --check
// deterministic in a repo where new commits keep landing between
// invocations (the doc is a snapshot, not a moving target). To force a
// fresh anchor against the latest HEAD, delete the doc and re-run.
function readExistingWindow(docPath) {
  if (!fs.existsSync(docPath)) return null;
  const src = fs.readFileSync(docPath, "utf8");
  const m = src.match(/\*\*Window:\*\*[^\n]*?`([^`]+)`\s*→\s*`([^`]+)`/);
  if (!m) return null;
  return { sinceIso: m[1], headIso: m[2] };
}

function resolveWindow(existing) {
  if (existing && !sinceArg && windowArg === "24h") {
    return { ...existing, label: "24h", reusedFromDoc: true };
  }
  const headIso = headTimestampIso();
  const headMs = Date.parse(headIso);
  let sinceIso;
  if (sinceArg) {
    const parsed = Date.parse(sinceArg);
    if (Number.isNaN(parsed)) throw new Error(`Bad --since value: ${sinceArg}`);
    sinceIso = new Date(parsed).toISOString();
  } else {
    sinceIso = new Date(headMs - parseWindowMs(windowArg)).toISOString();
  }
  return {
    sinceIso,
    headIso,
    label: sinceArg ? `since ${sinceIso}` : windowArg,
    reusedFromDoc: false,
  };
}

// Note on "merge commits": this repo squash-merges every task into the
// trunk, so `git log --merges` is empty. The retrospective treats every
// task-bearing trunk commit in the window as a "merge" in the
// squash-merge sense (each commit corresponds to one merged task /
// PR). If the repo ever switches to true merge commits, swap in
// `--merges` here and in the test.
function listCommits(sinceIso, untilIso) {
  const args = ["log", `--since=${sinceIso}`];
  if (untilIso) args.push(`--until=${untilIso}`);
  args.push("--no-merges", "--format=%H%x1f%cI%x1f%s");
  const out = git(...args);
  if (!out.trim()) return [];
  return out
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, iso, subject] = line.split("\x1f");
      return { hash, iso, subject };
    });
}

function commitNumstat(sinceIso, untilIso) {
  const args = ["log", `--since=${sinceIso}`];
  if (untilIso) args.push(`--until=${untilIso}`);
  args.push("--no-merges", "--numstat", "--format=");
  const out = git(...args);
  let added = 0;
  let removed = 0;
  const files = new Set();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    if (m[1] !== "-") added += Number(m[1]);
    if (m[2] !== "-") removed += Number(m[2]);
    files.add(m[3]);
  }
  return { added, removed, fileCount: files.size };
}

function readFileAtCommit(hash, relPath) {
  try {
    return execFileSync("git", ["show", `${hash}:${relPath}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task ref + bucket parsing
// ---------------------------------------------------------------------------

function parseTaskRef(subject) {
  // "Task #N: ..." | "Task #N — ..." | "... (Task #N)" | "... (#N)" | "... #N"
  const m = subject.match(/Task\s*#(\d+)/i) || subject.match(/\(#(\d+)\)/);
  return m ? Number(m[1]) : null;
}

function commitTitle(subject) {
  // Strip a leading "Task #N[:—-] " or trailing "(Task #N)" so the
  // bucket-bullet reads as a plain English outcome.
  return subject
    .replace(/^Task\s*#\d+\s*[:\-—]\s*/i, "")
    .replace(/\s*\(Task\s*#\d+\)\s*$/i, "")
    .replace(/\s*\(#\d+\)\s*$/i, "")
    .trim();
}

// Surface buckets. Order matters — first match wins.
// If a parallelization runbook bucketing helper ships later (Task #927),
// this list is the place to swap it in.
const BUCKET_RULES = [
  {
    bucket: "engine/scoring",
    rx: /\b(engine|scoring|signal|hallucination|fabricat|avri|substance|rubric|composite|cwe|crash[- ]?trace|raw[- ]?http|slop|perplex|extractor|deserializ|xxe|sqli|xss|payload|injection|sanitizer)\b/i,
  },
  {
    bucket: "calibration/reviewer",
    rx: /\b(calibration|reviewer|drift|handwavy|self[- ]?disclosure|brute[- ]?force|cooldown|alert|rescore|backfill|rollup|rearm|re[- ]?arm|audit log|token)\b/i,
  },
  {
    bucket: "test infra",
    rx: /\b(test|fixture|corpus|e2e|regression|benchmark|ci|lint|prettier|eslint|typecheck|codegen|playwright|scoring[- ]?gate)\b/i,
  },
  {
    bucket: "security",
    rx: /\b(security|threat|vulnerab|allowed[- ]?origins|disclosure|csp|cors|sbom|codeql|dependabot|proof[- ]?of[- ]?work)\b/i,
  },
  {
    bucket: "platform/ops",
    rx: /\b(deploy|docker|helm|migration|drizzle|observability|status|incident|uptime|healthz|metrics|cache|replica|scheduler|version pin|api[- ]?version|breaking[- ]?change|release|semver|webhook|resilience|robots|sitemap|atom|rss|i18n|theme|dark|light|print|markdown export)\b/i,
  },
  {
    bucket: "content/integration",
    rx: /\b(blog|press|case study|case-study|podcast|whitepaper|sdk|recipe|integration|hackerone|bugcrowd|jira|slack|discord|github action|vs code|browser extension|bookmarklet|mcp|postman|badge|og card|iframe|widget|community|newsletter|mailing|email|gallery|showcase|roadmap|changelog|glossary|faq|quickstart|how[- ]?it[- ]?works|architecture|methodology|video|storyboard|signal explainer|deep[- ]?dive)\b/i,
  },
  {
    bucket: "UI",
    rx: /\b(page|panel|banner|button|tour|onboarding|frontend|ui|component|layout|footer|nav|sidebar|modal|dialog|toast|chart|radar|heatmap|preview|toggle|slider|accessibility|a11y|wcag|keyboard|theme|design)\b/i,
  },
];

function bucketFor(subject) {
  for (const { bucket, rx } of BUCKET_RULES) {
    if (rx.test(subject)) return bucket;
  }
  return "other";
}

const BUCKET_ORDER = [
  "engine/scoring",
  "content/integration",
  "UI",
  "security",
  "calibration/reviewer",
  "platform/ops",
  "test infra",
  "other",
];

const BUCKET_NARRATIVE = {
  "engine/scoring":
    "Substance, fabrication, and rubric-shape work. Changes here move composite scores on real reports — they are the load-bearing improvements of the burn.",
  "content/integration":
    "Public surfaces a submitter or integrator can read or call: docs, recipes, SDKs, badges, embeds, marketing pages.",
  UI: "Frontend polish: pages, panels, components, accessibility, navigation, theming.",
  security:
    "Hardening: spam controls, secret hygiene, supply-chain scans, allow-list misconfig warnings.",
  "calibration/reviewer":
    "Reviewer-only surface: drift dashboards, handwavy-phrase workflow, brute-force alerts, rescore plumbing.",
  "platform/ops":
    "Backend / deployment / observability / release plumbing. Quiet by design — visible only when something goes wrong.",
  "test infra":
    "Tests, fixtures, gates, codegen. Not user-visible but the reason any of the above can ship safely.",
  other:
    "Commits whose subjects didn't match any bucket heuristic. Cited as-is so the count reconciles.",
};

// ---------------------------------------------------------------------------
// Signals touched in window
// ---------------------------------------------------------------------------

// The retrospective lists every signal the burn touched. We detect "touched"
// by file paths in the window's diff matching known signal source files.
const SIGNAL_FILES = [
  { id: "gold-signals", signal: "gold signals", path: "artifacts/api-server/src/lib/engines/avri/families.ts" },
  { id: "fabricated-evidence-flags", signal: "fabricated-evidence flags", path: "artifacts/api-server/src/lib/engines/avri/fabricated-evidence-flags.ts" },
  { id: "handwavy-phrase-impact", signal: "handwavy-phrase impact", path: "artifacts/api-server/src/lib/handwavy-phrases.ts" },
  { id: "crash-trace", signal: "crash-trace", path: "artifacts/api-server/src/lib/engines/avri/crash-trace.ts" },
  { id: "hallucination-cohort", signal: "hallucination cohort", path: "artifacts/api-server/src/lib/hallucination-detector.ts" },
  { id: "linguistic", signal: "linguistic", path: "artifacts/api-server/src/lib/engines/engines.ts" },
  { id: "slop-signals", signal: "sloppiness (slop-signals)", path: "artifacts/api-server/src/lib/engines/avri/slop-signals.ts" },
  { id: "claim-specificity", signal: "claim-specificity", path: "artifacts/api-server/src/lib/engines/extractors.ts" },
  { id: "evidence-quality", signal: "evidence-quality", path: "artifacts/api-server/src/lib/engines/avri/engine2-avri.ts" },
  { id: "cwe-coherence", signal: "internal-consistency (CWE coherence)", path: "artifacts/api-server/src/lib/engines/avri/coherence.ts" },
  { id: "avri-raw-http", signal: "AVRI raw-http", path: "artifacts/api-server/src/lib/engines/avri/raw-http.ts" },
];

function filesTouchedInWindow(sinceIso, untilIso) {
  const args = ["log", `--since=${sinceIso}`];
  if (untilIso) args.push(`--until=${untilIso}`);
  args.push("--no-merges", "--name-only", "--format=");
  const out = git(...args);
  const set = new Set();
  for (const line of out.split("\n")) {
    if (line.trim()) set.add(line.trim());
  }
  return set;
}

// Look for an on-disk scoring-regression / real-world-corpus output
// produced by the test runner. We do NOT run the corpus from this
// script (slow + flaky); we only summarize what's already on disk.
//
// Expected JSON shape (the script handles missing keys gracefully):
//   {
//     "generatedAt": "ISO",
//     "perSignal": {
//       "<signal-id>": { "before": { "mean": N }, "after": { "mean": N } }
//     },
//     "benchmarks": {
//       "legit": { "before": N, "after": N },
//       "slop":  { "before": N, "after": N }
//     },
//     "newFixtures": [ { "id": "...", "tier": "T1_LEGIT" } ]
//   }
// Returns { latest, prior } relative paths to the two most-recent
// scoring artifacts in any of the candidate dirs. The script compares
// the latest against the prior to produce a real before/after delta
// (the "run immediately preceding the window" the spec calls for).
// Returns null when no artifacts exist.
function findScoringOutput() {
  const candidates = [
    "artifacts/api-server/test-output",
    "artifacts/api-server/test-results",
    "artifacts/api-server/.scoring-output",
  ];
  for (const rel of candidates) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const files = fs
      .readdirSync(abs)
      .filter((f) => /real-?world-?corpus|scoring-regression/i.test(f))
      .sort(); // alphabetical (filenames typically embed ISO date) -> deterministic
    if (files.length === 0) continue;
    const latest = path.join(rel, files[files.length - 1]);
    const prior = files.length >= 2 ? path.join(rel, files[files.length - 2]) : null;
    return { latest, prior };
  }
  return null;
}

function loadScoringOutput(relPath) {
  if (!relPath) return null;
  try {
    const raw = fs.readFileSync(path.join(ROOT, relPath), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Compute a per-signal delta. Prefer in-file before/after when present
// (some runners pre-bake it). Otherwise compare the latest run against
// the prior run we found on disk (the "run immediately preceding the
// window" the spec asks for).
function signalDelta(latest, prior, signalId) {
  if (!latest || !latest.perSignal || !latest.perSignal[signalId]) return null;
  const s = latest.perSignal[signalId];
  let b = s?.before?.mean;
  let a = s?.after?.mean;
  if (typeof a !== "number") a = s?.mean;
  if (typeof b !== "number" && prior?.perSignal?.[signalId]) {
    const p = prior.perSignal[signalId];
    b = p?.after?.mean ?? p?.mean;
  }
  if (typeof b !== "number" || typeof a !== "number") return null;
  const delta = a - b;
  const sign = delta >= 0 ? "+" : "";
  return `mean composite ${b.toFixed(2)} → ${a.toFixed(2)} (${sign}${delta.toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// Route inventory: routes added in window
// ---------------------------------------------------------------------------

function extractRoutes(src) {
  if (!src) return new Set();
  const routes = new Set();
  const rx = /<Route\s+path="([^"]+)"/g;
  let m;
  while ((m = rx.exec(src)) !== null) routes.add(m[1]);
  return routes;
}

function newRoutesInWindow(sinceIso, untilIso) {
  const commits = listCommits(sinceIso, untilIso);
  if (commits.length === 0) return [];
  // Oldest commit in window — its parent is "the state immediately before the window".
  const oldest = commits[commits.length - 1].hash;
  const newest = commits[0].hash;
  const beforeSrc = readFileAtCommit(`${oldest}^`, "artifacts/vulnrap/src/App.tsx");
  const afterSrc = readFileAtCommit(newest, "artifacts/vulnrap/src/App.tsx");
  const before = extractRoutes(beforeSrc);
  const after = extractRoutes(afterSrc);
  const added = [...after].filter((r) => !before.has(r));
  added.sort();
  return added;
}

// ---------------------------------------------------------------------------
// In-flight task best-effort
// ---------------------------------------------------------------------------

// Read the on-disk task ledger so commit→title/bucket assignment hydrates
// from the project_tasks plan instead of relying purely on commit-subject
// regex. Only `task-N.md` files in `.local/tasks/` are referenced (those
// are the deterministic, ref-keyed plans). Slug-named plans aren't keyed
// by ref so we can't hydrate from them.
function loadTaskLedger() {
  const dir = path.join(ROOT, ".local/tasks");
  const ledger = new Map();
  if (!fs.existsSync(dir)) return ledger;
  for (const f of fs.readdirSync(dir).sort()) {
    const m = f.match(/^task-(\d+)\.md$/);
    if (!m) continue;
    const ref = Number(m[1]);
    let title = null;
    let bucket = null;
    try {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const fmMatch = src.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const tm = fmMatch[1].match(/^title:\s*(.+?)\s*$/m);
        if (tm) title = tm[1].replace(/^["']|["']$/g, "").trim();
        const bm = fmMatch[1].match(/^bucket:\s*(.+?)\s*$/m);
        if (bm) bucket = bm[1].replace(/^["']|["']$/g, "").trim();
      }
      if (!title) {
        const h1 = src.match(/^#\s+(.+?)\s*$/m);
        if (h1) title = h1[1].trim();
      }
      if (!bucket && title) bucket = bucketFor(title);
    } catch {
      /* best effort */
    }
    if (title) ledger.set(ref, { title, bucket });
  }
  return ledger;
}

// Prefer the explicit status snapshot at .local/tasks/_status-snapshot.json
// (produced by calling listProjectTasks and writing the result to disk —
// see this script's section in artifacts/api-server/docs/README.md). The
// snapshot is the source-of-truth for IN_PROGRESS + PENDING counts. If
// missing, fall back to the on-disk task-plan proxy (best-effort).
function inflightTasks(mergedRefs) {
  const snapPath = path.join(ROOT, ".local/tasks/_status-snapshot.json");
  if (fs.existsSync(snapPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
      const inProgress = (snap.inProgress || []).length;
      const pending = (snap.pending || []).length;
      const all = [...(snap.inProgress || []), ...(snap.pending || [])];
      const byBucket = {};
      for (const t of all) {
        const b = bucketFor(t.title || t.taskRef || "");
        (byBucket[b] = byBucket[b] || []).push(t);
      }
      return {
        total: inProgress + pending,
        inProgress,
        pending,
        byBucket,
        fromSnapshot: true,
        sourcePath: ".local/tasks/_status-snapshot.json",
        snapshotAt: snap.generatedAt || "unknown",
      };
    } catch {
      /* fall through to proxy */
    }
  }
  const tasksDir = path.join(ROOT, ".local/tasks");
  if (!fs.existsSync(tasksDir)) return { total: null, byBucket: {}, fromSnapshot: false };
  const merged = new Set(mergedRefs);
  const inflight = [];
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith(".md")) continue;
    const refMatch = f.match(/^task-(\d+)\.md$/);
    if (refMatch) {
      const ref = Number(refMatch[1]);
      if (!merged.has(ref)) inflight.push({ ref, file: f, slug: null });
    } else {
      const slug = f.replace(/\.md$/, "");
      inflight.push({ ref: null, file: f, slug });
    }
  }
  const byBucket = {};
  for (const t of inflight) {
    const b = bucketFor(t.slug || t.file);
    (byBucket[b] = byBucket[b] || []).push(t);
  }
  return { total: inflight.length, byBucket, fromSnapshot: false };
}

// ---------------------------------------------------------------------------
// Doc renderers
// ---------------------------------------------------------------------------

function renderHeadline(stats, newRoutes, signalsTouched, integrationsLive) {
  const chips = [
    `**${stats.taskCount} tasks merged**`,
    `**${stats.fileCount.toLocaleString()} files changed**`,
    `**+${stats.added.toLocaleString()} / −${stats.removed.toLocaleString()} lines**`,
    `**${newRoutes.length} new pages live**`,
    `**${integrationsLive} new integrations live**`,
    `**${signalsTouched.length} engine signals touched**`,
    `**${stats.commitCount} commits**`,
  ];
  return chips.join("  ·  ");
}

// Per-route value-prop lookup. Keys are exact route paths registered in
// artifacts/vulnrap/src/App.tsx. Routes not in the table fall back to a
// component-name based generic note. Add entries here as new pages ship.
const ROUTE_VALUE_PROPS = {
  "/architecture": "system architecture overview — every engine, queue, and storage layer in one diagram.",
  "/community": "community hub — Discord, Slack, GitHub discussions, and contributor onboarding.",
  "/sdks/go": "Go SDK landing — install snippet, quickstart, and reference for the Go client.",
  "/sdks/python": "Python SDK landing — install snippet, quickstart, and reference for the Python client.",
  "/sdks/typescript": "TypeScript SDK landing — install snippet, quickstart, and reference for the TS client.",
  "/recipes/hackerone": "HackerOne recipe — wire VulnRap into HackerOne triage pipelines step-by-step.",
  "/recipes/bugcrowd": "Bugcrowd recipe — wire VulnRap into Bugcrowd triage pipelines step-by-step.",
  "/recipes/intigriti": "Intigriti recipe — wire VulnRap into Intigriti triage pipelines step-by-step.",
  "/integrations/discord": "Discord bot — `/check` slash command for triaging reports inside Discord.",
  "/integrations/slack": "Slack bot — `/check` slash command for triaging reports inside Slack.",
  "/integrations/github": "GitHub action — auto-score security reports filed as issues or PRs.",
  "/newsletter": "newsletter signup — weekly digest of new signals, fixtures, and corpus deltas.",
  "/blog": "engineering blog — deep-dives on signals, calibration, and corpus methodology.",
  "/changelog": "changelog — paste-ready public-facing summary of every recent ship.",
  "/compare": "side-by-side report comparison — diff two scoring runs.",
  "/compare-detectors": "detector comparison — compare per-signal output across detectors.",
  "/reports": "reports explorer — browse and filter every scored submission.",
  "/feedback-analytics": "feedback analytics — slice human-marked verdicts by signal, tier, and detector.",
  "/corpus-stats": "corpus statistics — per-tier counts, churn, and signal coverage.",
  "/use-cases": "use-cases gallery — playable examples of VulnRap on real reports.",
  "/security": "security disclosure page — how to report a vuln in VulnRap itself.",
  "/terms": "terms of service.",
  "/privacy": "privacy policy.",
  "/history": "scoring history — how the scoring formula evolved over time.",
  "/batch": "batch upload — score multiple reports at once.",
  "/stats": "platform stats — submissions, signals fired, and per-tier rates.",
  "/developers": "developer portal — REST API reference, auth, rate limits, examples.",
};

function valuePropFor(route) {
  if (ROUTE_VALUE_PROPS[route]) return ROUTE_VALUE_PROPS[route];
  // Strip params and try again.
  const base = route.replace(/\/:[^/]+/g, "");
  if (ROUTE_VALUE_PROPS[base]) return ROUTE_VALUE_PROPS[base];
  return "new top-level page (no value-prop entry yet — add one to `ROUTE_VALUE_PROPS` in `scripts/regenerate-24h-recap.mjs`).";
}

// Non-route surfaces shipped during the window: SDK packages added to
// the workspace, docs files added under common doc dirs. Detected from
// git diffs rather than a hand-curated list.
function nonRouteAdditions(sinceIso, untilIso) {
  const args = ["log", `--since=${sinceIso}`];
  if (untilIso) args.push(`--until=${untilIso}`);
  args.push("--no-merges", "--diff-filter=A", "--name-only", "--format=");
  const out = git(...args);
  const added = new Set();
  for (const line of out.split("\n")) {
    if (line.trim()) added.add(line.trim());
  }
  const items = [];
  // SDK packages: a new package.json under packages/sdk-*
  const sdkPkgs = [...added].filter((f) => /^packages\/sdk-[^/]+\/package\.json$/.test(f));
  for (const f of sdkPkgs.sort()) {
    const name = f.match(/^packages\/(sdk-[^/]+)\//)[1];
    items.push({ kind: "SDK package", path: name, note: `new SDK package added to the workspace at \`packages/${name}/\`.` });
  }
  // Recipe / integration docs added under artifacts/api-server/docs/integrations/
  const recipeDocs = [...added].filter((f) =>
    /^artifacts\/api-server\/docs\/(integrations|recipes)\//.test(f) && f.endsWith(".md"),
  );
  for (const f of recipeDocs.sort()) {
    items.push({ kind: "integration recipe", path: f, note: `new integration recipe doc.` });
  }
  return items;
}

function renderWhatLanded(byBucket, totalCount) {
  const out = [];
  for (const bucket of BUCKET_ORDER) {
    const items = byBucket[bucket] || [];
    if (items.length === 0) continue;
    out.push(`\n### ${bucket} — ${items.length} task${items.length === 1 ? "" : "s"}\n`);
    out.push(BUCKET_NARRATIVE[bucket] + "\n");
    for (const c of items) {
      const refLabel = c.ref ? `Task #${c.ref}` : `\`${c.hash.slice(0, 8)}\``;
      out.push(`- **${refLabel}** — ${c.title}`);
    }
  }
  out.push(`\n*Bucket totals reconcile to ${totalCount} commits in window.*`);
  return out.join("\n");
}

function renderAnalysisSection(signalsTouchedObjs, scoringPaths, latest, prior) {
  const out = [];
  if (scoringPaths?.latest && latest) {
    const baselineNote = scoringPaths.prior
      ? ` Baseline for delta is the immediately preceding run (\`${scoringPaths.prior}\`).`
      : ` No prior run on disk; deltas only emit when the latest artifact pre-bakes \`before\`/\`after\`.`;
    out.push(
      `Scoring-regression artifact loaded from \`${scoringPaths.latest}\`.${baselineNote} ` +
        `The script does not re-run the corpus.`,
    );
  } else if (scoringPaths?.latest && !latest) {
    out.push(
      `Scoring-regression artifact found at \`${scoringPaths.latest}\` but failed to parse as JSON. ` +
        `Per-signal entries fall back to **no measurable change**.`,
    );
  } else {
    out.push(
      `No on-disk scoring-regression / real-world-corpus output was found ` +
        `under \`artifacts/api-server/test-output/\` (or sibling paths) at regen time. ` +
        `Per-signal entries fall back to **no measurable change** rather than guessing.`,
    );
  }
  out.push("");
  const touchedIds = new Set(signalsTouchedObjs.map((s) => s.id));
  for (const { id, signal, path: p } of SIGNAL_FILES) {
    const touched = touchedIds.has(id);
    const delta = signalDelta(latest, prior, id);
    if (delta) {
      out.push(`- **${signal}** (\`${p}\`) — ${touched ? "touched in window. " : ""}${delta}.`);
    } else if (touched) {
      out.push(
        `- **${signal}** (\`${p}\`) — touched in window; no measurable change (no per-signal entry in scoring artifact).`,
      );
    } else {
      out.push(`- **${signal}** (\`${p}\`) — no measurable change (file untouched in window).`);
    }
  }
  if (latest?.benchmarks) {
    out.push("");
    out.push("**Benchmark composite (latest vs prior run):**");
    for (const [name, b] of Object.entries(latest.benchmarks)) {
      let before = typeof b?.before === "number" ? b.before : prior?.benchmarks?.[name]?.after;
      let after = typeof b?.after === "number" ? b.after : b?.mean;
      if (typeof before !== "number" || typeof after !== "number") continue;
      const d = after - before;
      out.push(`- \`${name}\`: ${before.toFixed(2)} → ${after.toFixed(2)} (${d >= 0 ? "+" : ""}${d.toFixed(2)})`);
    }
  }
  return out.join("\n");
}

function fixtureDelta(sinceIso, untilIso, scoringData) {
  const commits = listCommits(sinceIso, untilIso);
  if (commits.length === 0) return null;
  const oldest = commits[commits.length - 1].hash;
  const newest = commits[0].hash;
  const before = readFileAtCommit(`${oldest}^`, "artifacts/api-server/src/routes/test-fixtures.ts");
  const after = readFileAtCommit(newest, "artifacts/api-server/src/routes/test-fixtures.ts");
  function count(src) {
    if (!src) return { total: 0, T1: 0, T2: 0, T3: 0, T4: 0 };
    const total = (src.match(/^\s*id:\s*"/gm) || []).length;
    const tier = (label) =>
      (src.match(new RegExp(`tier:\\s*"${label}"`, "g")) || []).length;
    return {
      total,
      T1: tier("T1_LEGIT"),
      T2: tier("T2_BORDERLINE"),
      T3: tier("T3_SLOP"),
      T4: tier("T4_HALLUCINATED"),
    };
  }
  const b = count(before);
  const a = count(after);
  return { before: b, after: a, delta: a.total - b.total };
}

function renderNewRoutes(newRoutes, nonRoutes) {
  const out = [];
  if (newRoutes.length === 0) {
    out.push("*No new routes registered in `artifacts/vulnrap/src/App.tsx` during the window.*");
  } else {
    out.push("| Route | Value-prop |");
    out.push("| ----- | ---------- |");
    for (const r of newRoutes) {
      out.push(`| \`${r}\` | ${valuePropFor(r)} |`);
    }
  }
  if (nonRoutes && nonRoutes.length > 0) {
    out.push("");
    out.push("**Non-route additions in window:**");
    out.push("");
    out.push("| Surface | Path | Note |");
    out.push("| ------- | ---- | ---- |");
    for (const n of nonRoutes) {
      out.push(`| ${n.kind} | \`${n.path}\` | ${n.note} |`);
    }
  }
  return out.join("\n");
}

function renderInflight(inflight) {
  if (inflight.total === null) {
    return "*Task ledger not available at regen time — count unknown.*";
  }
  const out = [];
  if (inflight.fromSnapshot) {
    out.push(
      `**${inflight.inProgress} IN_PROGRESS + ${inflight.pending} PENDING ` +
        `= ${inflight.total} tasks in flight** ` +
        `(source: \`${inflight.sourcePath}\`, snapshot taken \`${inflight.snapshotAt}\` via \`listProjectTasks\`).`,
    );
  } else {
    out.push(
      `**${inflight.total} task plan${inflight.total === 1 ? "" : "s"} on disk under \`.local/tasks/\` ` +
        `with no matching merged commit in the window** — best-effort proxy for IN_PROGRESS + PENDING ` +
        `(no \`.local/tasks/_status-snapshot.json\` was found at regen time; snapshot the live ledger ` +
        `and re-run for accurate status counts).`,
    );
  }
  out.push("");
  out.push("Top buckets:");
  out.push("");
  out.push("| Bucket | Count |");
  out.push("| ------ | ----: |");
  const rows = Object.entries(inflight.byBucket)
    .map(([b, items]) => ({ b, n: items.length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  for (const r of rows) out.push(`| ${r.b} | ${r.n} |`);
  return out.join("\n");
}

function renderMarketingDraft(stats, newRoutes) {
  const lines = [];
  lines.push(`**24-hour burn — ${stats.taskCount} tasks merged.**`);
  lines.push("");
  lines.push(
    `In the last 24 hours we shipped ${stats.taskCount} tracked tasks across ` +
      `${stats.fileCount.toLocaleString()} files (+${stats.added.toLocaleString()} / −${stats.removed.toLocaleString()} lines), ` +
      `including ${newRoutes.length} new public pages.`,
  );
  if (newRoutes.length > 0) {
    lines.push("");
    lines.push("New surfaces:");
    for (const r of newRoutes.slice(0, 8)) lines.push(`- \`${r}\``);
  }
  lines.push("");
  lines.push(
    "_Paste-ready draft for `artifacts/vulnrap/src/pages/changelog.tsx`. " +
      "This file is intentionally not edited by the regenerator (hot file, " +
      "owned by the changelog task)._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Build doc
// ---------------------------------------------------------------------------

function buildDocument(existingWindow) {
  const { sinceIso, headIso, label, reusedFromDoc } = resolveWindow(existingWindow);
  const untilIso = reusedFromDoc ? headIso : null;
  const commits = listCommits(sinceIso, untilIso);
  const numstat = commitNumstat(sinceIso, untilIso);
  const ledger = loadTaskLedger();

  const enriched = commits.map((c) => {
    const ref = parseTaskRef(c.subject);
    const ledgerEntry = ref != null ? ledger.get(ref) : null;
    return {
      ...c,
      ref,
      title: ledgerEntry?.title || commitTitle(c.subject),
      bucket: ledgerEntry?.bucket || bucketFor(c.subject),
      ledgerHydrated: !!ledgerEntry,
    };
  });
  // Sort within buckets by ref ascending (deterministic).
  const byBucket = {};
  for (const c of enriched) {
    (byBucket[c.bucket] = byBucket[c.bucket] || []).push(c);
  }
  for (const b of Object.keys(byBucket)) {
    byBucket[b].sort((x, y) => {
      if (x.ref && y.ref) return x.ref - y.ref;
      if (x.ref) return -1;
      if (y.ref) return 1;
      return x.hash.localeCompare(y.hash);
    });
  }
  const taskCount = enriched.filter((c) => c.ref !== null).length;

  const touchedFiles = filesTouchedInWindow(sinceIso, untilIso);
  const signalsTouched = SIGNAL_FILES.filter((s) => touchedFiles.has(s.path));
  const scoringPaths = findScoringOutput();
  const scoringLatest = loadScoringOutput(scoringPaths?.latest);
  const scoringPrior = loadScoringOutput(scoringPaths?.prior);
  const newRoutes = newRoutesInWindow(sinceIso, untilIso);
  const nonRoutes = nonRouteAdditions(sinceIso, untilIso);
  const fixtureDeltaInfo = fixtureDelta(sinceIso, untilIso, scoringLatest);
  const integrationsLive =
    (byBucket["content/integration"] || []).length + nonRoutes.length;
  const mergedRefs = enriched.map((c) => c.ref).filter((r) => r !== null);
  const inflight = inflightTasks(mergedRefs);

  const stats = {
    taskCount,
    commitCount: enriched.length,
    fileCount: numstat.fileCount,
    added: numstat.added,
    removed: numstat.removed,
  };

  const dateLabel = headIso.slice(0, 10);

  return `# 24-Hour Recap — VulnRap (${dateLabel})

**Generated:** ${new Date().toISOString().slice(0, 10)} (regenerate with \`node scripts/regenerate-24h-recap.mjs\`)
**Window:** ${label} — \`${sinceIso}\` → \`${headIso}\` (anchored to HEAD commit timestamp)
**Source:** \`git log --since\` + \`artifacts/vulnrap/src/App.tsx\` route diff + \`artifacts/api-server/src/routes/test-fixtures.ts\` diff

## 1. Headline

In the last 24 hours the team shipped ${stats.taskCount} tracked tasks across ${stats.fileCount.toLocaleString()} files, touching ${signalsTouched.length} engine signals and registering ${newRoutes.length} new top-level routes in the public SPA.

${renderHeadline(stats, newRoutes, signalsTouched, integrationsLive)}

---

## 2. What landed

Grouped by surface bucket. **Note on "merge commits":** this repo squash-merges every task into trunk, so \`git log --merges\` is empty — each commit corresponds to one merged task / PR, and the recap treats every non-merge trunk commit in the window as the merge unit. Bucket assignment is hydrated from the on-disk task ledger (\`.local/tasks/task-N.md\`) when present, falling back to keyword regex on the commit subject (see \`BUCKET_RULES\` in the regenerator); when the parallelization runbook (Task #927) ships its bucketing helper, the rules will move there.
${renderWhatLanded(byBucket, enriched.length)}

---

## 3. How the analysis got better

${renderAnalysisSection(signalsTouched, scoringPaths, scoringLatest, scoringPrior)}

${
  fixtureDeltaInfo
    ? `**Fixture-battery delta (\`test-fixtures.ts\`):** ${fixtureDeltaInfo.before.total} → ${fixtureDeltaInfo.after.total} fixtures (${fixtureDeltaInfo.delta >= 0 ? "+" : ""}${fixtureDeltaInfo.delta}). Per-tier: T1 ${fixtureDeltaInfo.before.T1}→${fixtureDeltaInfo.after.T1}, T2 ${fixtureDeltaInfo.before.T2}→${fixtureDeltaInfo.after.T2}, T3 ${fixtureDeltaInfo.before.T3}→${fixtureDeltaInfo.after.T3}, T4 ${fixtureDeltaInfo.before.T4}→${fixtureDeltaInfo.after.T4}.`
    : "Fixture-battery delta: window contained no commits, no diff to compute."
}

---

## 4. What's now visible to users

Routes registered in \`artifacts/vulnrap/src/App.tsx\` during the window (HEAD vs. parent of the window's oldest in-window commit):

${renderNewRoutes(newRoutes, nonRoutes)}

Screenshots are intentionally not auto-captured by this script — adding one for any row above is a manual step (drop a JPEG into \`artifacts/api-server/docs/retrospectives/img/\` and link it inline).

---

## 5. What's still in flight

${renderInflight(inflight)}

---

## 6. What we learned (operational)

These are short, citation-backed lessons from the burn. Each one names task refs so future agents can chase the receipts.

- **Hot files serialize the queue.** Files like \`artifacts/vulnrap/src/pages/feedback-analytics.tsx\` (~18k LOC) accumulate edits from many tasks and become merge-conflict choke points. Task #927 (parallelization runbook) is the planned mitigation — it should produce a hot-file inventory and wave plan that future batches consume.
- **Bucketing is keyword-fragile.** Until Task #927's bucketing helper lands, this recap classifies via regex on commit subjects. Any commit whose subject doesn't say what it is (e.g. \`Git commit prior to merge\`) lands in the \`other\` bucket and shows up in the reconcile total.
- **\`/check\` modes work.** Every regenerator script in \`scripts/\` (including this one) supports \`--check\`; CI catches stale docs without re-running expensive analysis. The convention came from \`scripts/regenerate-state-of-platform.mjs\` — keep it.
- **The scoring corpus needs an on-disk artifact.** Section 3 above degrades gracefully to "no measurable change" because no \`real-world-corpus\` output is durably written. When the test runner persists per-signal before/after JSON under \`artifacts/api-server/test-output/\`, this section gets numerical without a code change here.
- **Route inventory beats narrative.** Diffing \`App.tsx\` route tables is a cheap, deterministic answer to "what's new for users this week" — much harder to fudge than a hand-written list. The same trick is reusable for any longer recap window via \`--window=7d\`.

---

## 7. Credit accounting

Best-effort numbers from what's actually on disk at regen time:

- **Merged commits in window:** ${stats.commitCount} (\`git log --since=${sinceIso} --no-merges\`).
- **Tracked task refs merged:** ${stats.taskCount} (commits whose subject parses as \`Task #N\`).
- **Files touched:** ${stats.fileCount.toLocaleString()}.
- **Lines added / removed:** +${stats.added.toLocaleString()} / −${stats.removed.toLocaleString()}.
- **Wall-clock window:** ${sinceIso} → ${headIso}.
- **Per-task-agent run count:** *unknown* — no in-tree ledger of agent invocations; only merged commits are observable from this script.
- **Token / credit spend:** *unknown* — billing data is not in the repo.

---

## Marketing draft

The block below is paste-ready for \`artifacts/vulnrap/src/pages/changelog.tsx\`. **This script does not edit \`changelog.tsx\` directly** — that file is hot and owned by the changelog task. Copy/edit manually.

> ${renderMarketingDraft(stats, newRoutes).split("\n").join("\n> ")}

---

## Regenerating this document

\`\`\`bash
node scripts/regenerate-24h-recap.mjs            # write
node scripts/regenerate-24h-recap.mjs --check    # CI-safe, exits non-zero if stale
node scripts/regenerate-24h-recap.mjs --window=48h
node scripts/regenerate-24h-recap.mjs --since=2026-05-02T00:00:00Z
\`\`\`

The window anchors to the HEAD commit's timestamp (not wall-clock), so regenerating the same repo state produces the same doc. The \`Generated:\` line is the only date-sensitive field and is ignored by \`--check\`.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function stripGeneratedDate(s) {
  return s.replace(/^\*\*Generated:\*\*[^\n]*\n/m, "");
}

function outPath() {
  const dateLabel = headTimestampIso().slice(0, 10);
  return path.join(
    ROOT,
    `artifacts/api-server/docs/retrospectives/${dateLabel}-24h-recap.md`,
  );
}

function main() {
  // We always write to today's HEAD-dated file. Only reuse the
  // declared window when a recap for *that exact date* already exists,
  // so cross-day regen creates a fresh file instead of overwriting
  // yesterday's snapshot.
  const OUT = outPath();
  const existingWindow = readExistingWindow(OUT);
  const next = buildDocument(existingWindow);
  if (CHECK_ONLY) {
    let current = "";
    try {
      current = fs.readFileSync(OUT, "utf8");
    } catch {
      console.error(`[--check] ${OUT} does not exist; regenerate to create it.`);
      process.exit(2);
    }
    if (stripGeneratedDate(current) !== stripGeneratedDate(next)) {
      console.error(
        `[--check] ${OUT} is out of date. Re-run \`node scripts/regenerate-24h-recap.mjs\`.`,
      );
      process.exit(1);
    }
    console.log(`[--check] ${OUT} is up to date (date line ignored).`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.join(path.dirname(OUT), "img"), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(`Wrote ${OUT} (${next.length} bytes).`);
}

main();
