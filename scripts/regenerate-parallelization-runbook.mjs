#!/usr/bin/env node
//
// regenerate-parallelization-runbook.mjs
//
// Single-source-of-truth generator for
// artifacts/api-server/docs/parallelization-runbook.md.
//
// The doc inventories every active project task, extracts each task's
// declared `## Relevant files` block, builds a file -> tasks conflict
// graph, and groups tasks into "waves" where every task in a wave is
// file-disjoint from every other task in the same wave. The result is
// a deterministic batch plan a human can use to decide which tasks are
// safe to release together without merge collisions on hot files.
//
// Usage:
//   node scripts/regenerate-parallelization-runbook.mjs            # write doc
//   node scripts/regenerate-parallelization-runbook.mjs --check    # error if doc would change
//
// Data sources:
//   1. The on-disk project-task plan surface at `.local/tasks/*.md` —
//      authoritative for plan bodies (the `## Relevant files` block
//      we parse for the conflict graph). This is the same surface the
//      planning agent reads/writes.
//   2. `scripts/data/active-tasks.snapshot.json` — committed snapshot
//      of every active (PROPOSED / PENDING / IN_PROGRESS /
//      BLOCKED_BY_DRIFT) project task with its taskRef, state,
//      title, and description. The snapshot supplies the ref + state
//      that the on-disk plan surface does not encode.
//
//   The `--refresh` subcommand walks `.local/tasks/*.md` and rewrites
//   each matched snapshot entry's description from the live plan
//   file, so a `--refresh && regenerate && --check` cycle keeps the
//   committed runbook in sync with the on-disk plan surface without
//   external dependencies. The default (no-arg) mode reads the
//   snapshot only, so the script stays runnable in CI before
//   `pnpm install` and free of external deps.
//
// Convention mirrored from `scripts/regenerate-state-of-platform.mjs`:
//   - no external dependencies (Node stdlib + repo source only)
//   - `--check` ignores the time-sensitive `Generated:` header line
//   - sibling `*.test.mjs` runs the parser-drift checks

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(ROOT, "scripts/data/active-tasks.snapshot.json");
const OUT = path.join(
  ROOT,
  "artifacts/api-server/docs/parallelization-runbook.md",
);

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const REFRESH = args.has("--refresh");
const TASKS_DIR = path.join(ROOT, ".local/tasks");

// Concurrency limit: the platform's stated in-flight cap. Waves are
// capped at this many tasks each so the runbook never recommends a
// batch larger than the queue can actually run in parallel.
const WAVE_CAP = 10;

// A file is "hot" once this many active tasks claim it.
const HOT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Snapshot ingestion
// ---------------------------------------------------------------------------

// The platform's "active queue" — the set of states that the
// parallelization runbook is meant to plan. IMPLEMENTED tasks are
// already done and intentionally excluded so they never pollute the
// hot-file queue or wave assignments.
const ACTIVE_STATES = new Set([
  "PROPOSED",
  "PENDING",
  "IN_PROGRESS",
  "BLOCKED_BY_DRIFT",
]);

function loadTasks() {
  if (!fs.existsSync(CACHE)) {
    throw new Error(
      `Active-task snapshot missing at ${CACHE}. Refresh it from a ` +
        `code_execution environment (see header comment).`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  return raw.filter((t) => ACTIVE_STATES.has(t.state));
}

// --refresh: walk `.local/tasks/*.md` and overwrite each matched
// snapshot entry's `description` with the live plan body. Matching
// is by exact title (the first H1 in the plan file vs. the
// snapshot's `title`). Unmatched plan files are reported but never
// invented as new snapshot rows — ref+state must come from the
// project-task surface, which only the planning agent can reach.
function refreshSnapshotFromTasksDir() {
  if (!fs.existsSync(CACHE)) {
    throw new Error(`Snapshot missing at ${CACHE}; cannot refresh.`);
  }
  if (!fs.existsSync(TASKS_DIR)) {
    throw new Error(
      `Tasks dir missing at ${TASKS_DIR}; cannot refresh from on-disk plan surface.`,
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const byTitle = new Map();
  for (const t of snapshot) {
    if (t.title) byTitle.set(t.title.trim(), t);
  }
  const files = fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => path.join(TASKS_DIR, d.name));
  let matched = 0;
  let unmatched = 0;
  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();
    const entry = byTitle.get(title);
    if (!entry) {
      unmatched++;
      continue;
    }
    entry.description = body;
    matched++;
  }
  fs.writeFileSync(CACHE, JSON.stringify(snapshot, null, 2) + "\n");
  process.stdout.write(
    `Refreshed snapshot: ${matched} plan bodies updated from ${TASKS_DIR}` +
      ` (${unmatched} on-disk plan files had no matching snapshot title).\n`,
  );
}

// ---------------------------------------------------------------------------
// Plan-body parsing
// ---------------------------------------------------------------------------

// Strip leading whitespace from each line (some descriptions arrive
// with a 2-space indent because they were quoted). This is purely
// cosmetic for parsing — original text is never written back.
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

function extractRelevantFilesBlock(description) {
  const body = dedent(description || "");
  // Tolerate leading whitespace on the heading itself — some
  // descriptions arrive with the body indented but the title
  // un-indented, which defeats `dedent` (min indent = 0).
  const m = body.match(
    /\n[ \t]*##\s+Relevant files\s*\n([\s\S]*?)(?=\n[ \t]*##\s|\n[ \t]*#\s|$)/i,
  );
  if (!m) return null;
  return m[1];
}

// Parse a `## Relevant files` block body into normalized entries.
// Each entry: { raw, path, lineRange, isVague }.
function parseRelevantFiles(blockBody) {
  const entries = [];
  if (!blockBody) return entries;
  const lines = blockBody.split("\n");
  for (const line of lines) {
    // Match `- \`path\`` or `- \`path:lines\`` (optionally followed by
    // a free-form descriptor in parens).
    const m = line.match(/^\s*-\s*`([^`]+)`\s*(.*)$/);
    if (!m) continue;
    const tickContent = m[1].trim();
    const tail = (m[2] || "").trim();
    // Split off `:line-range` suffix for the conflict graph.
    const rangeMatch = tickContent.match(/^([^:]+):([\d,\-]+)$/);
    let pathOnly = rangeMatch ? rangeMatch[1] : tickContent;
    const lineRange = rangeMatch ? rangeMatch[2] : null;
    // Strip any trailing slash so a directory ref normalizes to the
    // same node a file ref under it would collide on.
    pathOnly = pathOnly.replace(/\/+$/, "");
    // Heuristic: a `Relevant files` entry is "vague" if it does not
    // resolve to a single file. Directory-wide claims (no file
    // extension on the basename), bare top-level dirs, and entries
    // whose tail describes a not-yet-existing artifact ("new ...")
    // all qualify. Vague entries are recorded but excluded from the
    // conflict graph and route their owning task to the
    // "Cannot parallelize" section if every entry on the task is
    // vague — directory-wide claims would otherwise let a task slip
    // into a wave even though it can collide with anything inside
    // that directory.
    const basename = pathOnly.split("/").pop() || "";
    const hasExtension = /\.[A-Za-z0-9]+$/.test(basename);
    const isVague =
      pathOnly === "." ||
      pathOnly === "" ||
      /\bnew\b/i.test(tail) ||
      !hasExtension;
    entries.push({
      raw: tickContent + (tail ? ` ${tail}` : ""),
      path: pathOnly,
      lineRange,
      isVague,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Surface bucketing (mirrors the buckets used elsewhere in the project)
// ---------------------------------------------------------------------------

function bucketForPath(p) {
  if (!p) return "other";
  if (p.startsWith("artifacts/api-server/src/lib/engines")) return "engines";
  if (
    p.startsWith("artifacts/api-server/src/lib/scoring") ||
    p.startsWith("artifacts/api-server/src/lib/calibration") ||
    p.startsWith("artifacts/api-server/src/lib/avri") ||
    p.startsWith("artifacts/api-server/src/lib/llm") ||
    p.startsWith("artifacts/api-server/src/lib/score-fusion") ||
    p.startsWith("artifacts/api-server/src/lib/active-verification") ||
    p.startsWith("artifacts/api-server/src/lib/factual-verification") ||
    p.startsWith("artifacts/api-server/src/lib/triage")
  )
    return "scoring";
  if (p.startsWith("artifacts/api-server/src/routes")) return "api-routes";
  if (p.startsWith("artifacts/api-server/src/lib")) return "api-lib";
  if (p.startsWith("artifacts/api-server/docs")) return "backend-docs";
  if (p.startsWith("artifacts/api-server")) return "backend-other";
  if (p.startsWith("artifacts/vulnrap/src/pages")) return "frontend-pages";
  if (p.startsWith("artifacts/vulnrap/src/components"))
    return "frontend-components";
  if (p.startsWith("artifacts/vulnrap/src")) return "frontend-other";
  if (p.startsWith("lib/api-spec")) return "api-spec";
  if (p.startsWith("scripts")) return "scripts";
  if (p.startsWith("docs") || p.startsWith("README")) return "docs";
  return "other";
}

function bucketForTask(task) {
  // Pick the most specific bucket among the task's files. Ties broken
  // by the priority order below.
  const order = [
    "scoring",
    "engines",
    "api-routes",
    "api-lib",
    "frontend-pages",
    "frontend-components",
    "frontend-other",
    "api-spec",
    "backend-docs",
    "docs",
    "scripts",
    "backend-other",
    "other",
  ];
  const seen = new Set();
  for (const f of task.files) seen.add(bucketForPath(f.path));
  for (const b of order) if (seen.has(b)) return b;
  return "other";
}

// ---------------------------------------------------------------------------
// File LOC introspection (best-effort; missing files contribute 0).
// ---------------------------------------------------------------------------

const locCache = new Map();
function locOf(p) {
  if (locCache.has(p)) return locCache.get(p);
  let n = 0;
  try {
    const full = path.join(ROOT, p);
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      const buf = fs.readFileSync(full, "utf8");
      n = buf.length === 0 ? 0 : buf.split("\n").length;
    } else {
      // Directory ref — count contributing files at top level only,
      // bounded so a `scripts/` ref doesn't dominate the table.
      n = 0;
    }
  } catch {
    n = 0;
  }
  locCache.set(p, n);
  return n;
}

// ---------------------------------------------------------------------------
// Hydration: turn raw task records into the shape the rest of the
// pipeline needs.
// ---------------------------------------------------------------------------

function hydrate(tasks) {
  const out = [];
  for (const t of tasks) {
    const block = extractRelevantFilesBlock(t.description);
    const entries = parseRelevantFiles(block || "");
    out.push({
      ref: t.taskRef,
      refNum: Number((t.taskRef || "").replace(/^#/, "")) || 0,
      title: (t.title || "").trim(),
      state: t.state,
      dependsOn: t.dependsOn || [],
      hasRelevantSection: block !== null,
      files: entries,
    });
  }
  // For bucket/inspection convenience.
  for (const t of out) t.bucket = bucketForTask(t);
  return out;
}

// ---------------------------------------------------------------------------
// Conflict graph + wave assignment.
// ---------------------------------------------------------------------------

function buildFileGraph(tasks) {
  const fileToTasks = new Map();
  for (const t of tasks) {
    const seen = new Set();
    for (const f of t.files) {
      if (f.isVague) continue;
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      if (!fileToTasks.has(f.path)) fileToTasks.set(f.path, []);
      fileToTasks.get(f.path).push(t.ref);
    }
  }
  return fileToTasks;
}

function tasksClaimingPath(fileToTasks, p) {
  return fileToTasks.get(p) || [];
}

function isCannotParallelize(t) {
  if (!t.hasRelevantSection) return "no `Relevant files` section";
  if (t.files.length === 0) return "empty `Relevant files` section";
  const concrete = t.files.filter((f) => !f.isVague);
  if (concrete.length === 0)
    return "all `Relevant files` entries are vague (top-level dir or 'new file')";
  return null;
}

// Greedy graph-coloring. Order:
//   1. IN_PROGRESS first (so we schedule the queue around what's
//      already running; their wave is wave 1).
//   2. Then PROPOSED / PENDING / IMPLEMENTED, by surface bucket
//      (engines/scoring/api first since those are the most
//      collision-prone), then by ref number.
function orderForColoring(tasks) {
  const bucketRank = {
    scoring: 0,
    engines: 1,
    "api-routes": 2,
    "api-lib": 3,
    "frontend-pages": 4,
    "frontend-components": 5,
    "frontend-other": 6,
    "api-spec": 7,
    "backend-docs": 8,
    docs: 9,
    scripts: 10,
    "backend-other": 11,
    other: 12,
  };
  return [...tasks].sort((a, b) => {
    const aIn = a.state === "IN_PROGRESS" ? 0 : 1;
    const bIn = b.state === "IN_PROGRESS" ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    const ar = bucketRank[a.bucket] ?? 99;
    const br = bucketRank[b.bucket] ?? 99;
    if (ar !== br) return ar - br;
    return a.refNum - b.refNum;
  });
}

function assignWaves(tasks) {
  // Tasks lacking a usable `Relevant files` section are routed to the
  // "Cannot parallelize" section instead of being colored.
  const colorable = tasks.filter((t) => !isCannotParallelize(t));
  const skipped = tasks.filter((t) => isCannotParallelize(t));

  // Build per-task file set (concrete files only).
  const fileSetByRef = new Map();
  for (const t of colorable) {
    fileSetByRef.set(
      t.ref,
      new Set(t.files.filter((f) => !f.isVague).map((f) => f.path)),
    );
  }

  const ordered = orderForColoring(colorable);
  const waves = []; // each wave: { tasks: [ref], files: Set }
  const waveOfRef = new Map();

  for (const t of ordered) {
    const myFiles = fileSetByRef.get(t.ref);
    let placed = false;
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      if (w.tasks.length >= WAVE_CAP) continue;
      // Conflict iff intersection non-empty.
      let conflict = false;
      for (const f of myFiles) {
        if (w.files.has(f)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        w.tasks.push(t.ref);
        for (const f of myFiles) w.files.add(f);
        waveOfRef.set(t.ref, i + 1);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const idx = waves.length;
      waves.push({ tasks: [t.ref], files: new Set(myFiles) });
      waveOfRef.set(t.ref, idx + 1);
    }
  }

  return { waves, waveOfRef, skipped, colorable };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function pad(s, n) {
  return String(s).padEnd(n);
}

function renderHeadline(tasks) {
  const totals = {
    PROPOSED: 0,
    PENDING: 0,
    IN_PROGRESS: 0,
    BLOCKED_BY_DRIFT: 0,
    IMPLEMENTED: 0,
  };
  const buckets = new Map();
  for (const t of tasks) {
    totals[t.state] = (totals[t.state] || 0) + 1;
    buckets.set(t.bucket, (buckets.get(t.bucket) || 0) + 1);
  }
  const rows = Object.entries(totals)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `| \`${k}\` | ${n} |`);
  const bucketRows = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `| \`${k}\` | ${n} |`);
  return `### By state

| State | Count |
| ----- | ----: |
${rows.join("\n")}
| **Total active** | **${tasks.length}** |

### By surface bucket

| Bucket | Count |
| ------ | ----: |
${bucketRows.join("\n")}
`;
}

function renderHotFiles(fileToTasks, tasksByRef) {
  const hot = [];
  for (const [p, refs] of fileToTasks.entries()) {
    if (refs.length >= HOT_THRESHOLD) hot.push({ path: p, refs });
  }
  hot.sort((a, b) => {
    if (b.refs.length !== a.refs.length) return b.refs.length - a.refs.length;
    return locOf(b.path) - locOf(a.path);
  });
  const rows = hot.map((h) => {
    const loc = locOf(h.path);
    const refList = h.refs
      .slice()
      .sort((a, b) => Number(a.replace("#", "")) - Number(b.replace("#", "")))
      .map((r) => `\`${r}\``)
      .join(", ");
    return `| \`${h.path}\` | ${loc.toLocaleString("en-US")} | ${h.refs.length} | ${refList} |`;
  });
  if (rows.length === 0) {
    return `_(No file is currently claimed by ${HOT_THRESHOLD} or more active tasks. The queue is parallelizable without hot-file serialization.)_\n`;
  }
  return `| File | LOC | Tasks claiming | Refs |
| ---- | --: | -------------: | ---- |
${rows.join("\n")}

**Recommendations per hot file:**

${hot
  .map((h) => {
    const loc = locOf(h.path);
    const note =
      loc >= 5000
        ? "split the file (LOC is large enough that even sequential edits compound review burden)"
        : h.refs.length >= 6
          ? "route through a single owning task (the queue is too long to drain serially before the next wave)"
          : "keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)";
    return `- \`${h.path}\` (${h.refs.length} tasks, ${loc.toLocaleString("en-US")} LOC) — **${note}**`;
  })
  .join("\n")}
`;
}

function renderWaves(waves, tasksByRef) {
  const out = [];
  waves.forEach((w, i) => {
    const wave = i + 1;
    const blast = w.tasks.reduce((acc, ref) => {
      const t = tasksByRef.get(ref);
      const totalLoc = t.files
        .filter((f) => !f.isVague)
        .reduce((a, f) => a + locOf(f.path), 0);
      return acc + totalLoc;
    }, 0);
    out.push(
      `### Wave ${wave} — ${w.tasks.length} task${w.tasks.length === 1 ? "" : "s"} (combined blast radius: ${blast.toLocaleString("en-US")} LOC)\n`,
    );
    out.push("| Ref | Title | Files | LOC (sum) | State | Bucket |");
    out.push("| --- | ----- | ----: | --------: | ----- | ------ |");
    const sorted = w.tasks
      .slice()
      .sort((a, b) => Number(a.replace("#", "")) - Number(b.replace("#", "")));
    for (const ref of sorted) {
      const t = tasksByRef.get(ref);
      const concrete = t.files.filter((f) => !f.isVague);
      const loc = concrete.reduce((a, f) => a + locOf(f.path), 0);
      const title = (t.title || "").replace(/\|/g, "\\|");
      out.push(
        `| \`${t.ref}\` | ${title} | ${concrete.length} | ${loc.toLocaleString("en-US")} | \`${t.state}\` | \`${t.bucket}\` |`,
      );
    }
    out.push("");
  });
  return out.join("\n");
}

function renderCannotParallelize(skipped) {
  if (skipped.length === 0) {
    return "_(All active tasks declare a usable `## Relevant files` section. Nothing to replan.)_\n";
  }
  const lines = [
    "These tasks are excluded from wave assignment because their",
    "`## Relevant files` section is missing, empty, or so vague (e.g.",
    "claims a whole top-level directory) that the conflict graph can't",
    "reason about them. They need replanning before they can be batched.",
    "",
    "| Ref | Title | Reason | State |",
    "| --- | ----- | ------ | ----- |",
  ];
  const sorted = skipped
    .slice()
    .sort((a, b) => a.refNum - b.refNum);
  for (const t of sorted) {
    const reason = isCannotParallelize(t);
    const title = (t.title || "").replace(/\|/g, "\\|");
    lines.push(
      `| \`${t.ref}\` | ${title} | ${reason} | \`${t.state}\` |`,
    );
  }
  return lines.join("\n") + "\n";
}

function renderLineRangeRefs(tasks) {
  const rows = [];
  const sorted = tasks.slice().sort((a, b) => a.refNum - b.refNum);
  for (const t of sorted) {
    const ranged = t.files.filter((f) => f.lineRange && !f.isVague);
    if (ranged.length === 0) continue;
    for (const f of ranged) {
      rows.push({ ref: t.ref, title: t.title, path: f.path, lines: f.lineRange });
    }
  }
  if (rows.length === 0) {
    return "_(No active task currently pins a line range in its `## Relevant files` block.)_\n";
  }
  const out = [
    "Some tasks scope their work to specific line ranges within a",
    "shared file. Two such tasks **may** be safely co-scheduled even if",
    "they share the file path, provided their line ranges do not",
    "overlap. The wave planner above conservatively treats any path",
    "collision as a conflict; this table preserves the original",
    "line-range hints so a human reviewer can override that conservatism",
    "when the ranges are clearly disjoint.",
    "",
    "| Ref | File | Lines | Title |",
    "| --- | ---- | ----- | ----- |",
  ];
  for (const r of rows) {
    const title = (r.title || "").replace(/\|/g, "\\|");
    out.push(`| \`${r.ref}\` | \`${r.path}\` | \`${r.lines}\` | ${title} |`);
  }
  return out.join("\n") + "\n";
}

function renderRecommendedNextBatch(allTasks, waves, tasksByRef) {
  // Count *every* IN_PROGRESS task across the whole active queue
  // (not just the first wave that happens to contain one). Tasks
  // listed in "Cannot parallelize" still occupy concurrency slots if
  // they are IN_PROGRESS, so we count them too.
  const inFlightTasks = allTasks.filter((t) => t.state === "IN_PROGRESS");
  const inFlightCount = inFlightTasks.length;
  const remainingSlots = Math.max(0, WAVE_CAP - inFlightCount);

  // Build the union of file paths claimed by the in-flight set.
  // Concrete files only — vague entries can't be reasoned about and
  // are conservatively ignored here (the owning task will already be
  // surfaced in "Cannot parallelize").
  const inFlightFiles = new Set();
  for (const t of inFlightTasks) {
    for (const f of t.files) {
      if (!f.isVague) inFlightFiles.add(f.path);
    }
  }

  if (remainingSlots === 0) {
    return `_(All ${WAVE_CAP} concurrency slots are occupied by in-flight tasks. Wait for one to drain before releasing the next batch.)_\n`;
  }

  // Find the first wave that (a) contains zero IN_PROGRESS tasks and
  // (b) is file-disjoint from the entire in-flight set. We do not
  // assume the wave assignment already enforced (b) — IN_PROGRESS
  // tasks may be spread across multiple waves and the disjointness
  // guarantee inside `assignWaves` is only intra-wave.
  let pick = null;
  let pickIdx = -1;
  let pickReleasable = [];
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const hasInFlight = w.tasks.some(
      (r) => tasksByRef.get(r).state === "IN_PROGRESS",
    );
    if (hasInFlight) continue;
    // Per-task disjointness vs. the in-flight file set.
    const disjoint = w.tasks.filter((r) => {
      const t = tasksByRef.get(r);
      for (const f of t.files) {
        if (!f.isVague && inFlightFiles.has(f.path)) return false;
      }
      return true;
    });
    if (disjoint.length === 0) continue;
    pick = w;
    pickIdx = i + 1;
    pickReleasable = disjoint;
    break;
  }

  if (!pick) {
    return `_(No fully in-flight-disjoint wave is currently releasable: every wave either contains an in-flight task or shares a file with one. Wait for the in-flight set (${inFlightCount} task${inFlightCount === 1 ? "" : "s"}) to drain a hot file before releasing the next batch.)_\n`;
  }

  const sortedRefs = pickReleasable
    .slice()
    .sort((a, b) => Number(a.replace("#", "")) - Number(b.replace("#", "")));
  const nextN = sortedRefs.slice(0, remainingSlots);
  const lines = [
    `**Next batch: Wave ${pickIdx}** — ${pickReleasable.length} task${pickReleasable.length === 1 ? "" : "s"} in this wave are file-disjoint from each other AND from every currently in-flight task.`,
    "",
    `In-flight set: **${inFlightCount}** task${inFlightCount === 1 ? "" : "s"} occupying ${inFlightCount} of ${WAVE_CAP} slots; **${remainingSlots}** slot${remainingSlots === 1 ? "" : "s"} are open right now. Recommended releases (in ref order):`,
    "",
  ];
  for (const r of nextN) {
    const t = tasksByRef.get(r);
    lines.push(`- \`${t.ref}\` — ${t.title} (\`${t.bucket}\`)`);
  }
  const remaining = pickReleasable.length - nextN.length;
  if (remaining > 0) {
    lines.push("");
    lines.push(
      `_(${remaining} additional task${remaining === 1 ? "" : "s"} in this wave can be released as in-flight slots open up; they're already known to be file-disjoint from the rest of the wave and from the in-flight set.)_`,
    );
  }
  const heldByCollision = pick.tasks.length - pickReleasable.length;
  if (heldByCollision > 0) {
    lines.push("");
    lines.push(
      `_(${heldByCollision} task${heldByCollision === 1 ? "" : "s"} in this wave share files with the in-flight set and are held back from this batch.)_`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Document body
// ---------------------------------------------------------------------------

function buildDocument() {
  const raw = loadTasks();
  const tasks = hydrate(raw);
  const tasksByRef = new Map(tasks.map((t) => [t.ref, t]));
  const fileToTasks = buildFileGraph(tasks);
  const { waves, skipped } = assignWaves(tasks);
  const generatedAt = new Date().toISOString().slice(0, 10);

  const inFlight = tasks.filter((t) => t.state === "IN_PROGRESS").length;

  return `# Parallelization runbook — active task queue

**Generated:** ${generatedAt} (regenerate with \`node scripts/regenerate-parallelization-runbook.mjs\`)
**Snapshot:** \`scripts/data/active-tasks.snapshot.json\` — ${tasks.length} active tasks (${inFlight} in flight)
**Wave cap:** ${WAVE_CAP} concurrent tasks per wave
**Hot-file threshold:** ≥ ${HOT_THRESHOLD} active tasks claiming the same file

This document is the single source of truth for "which batch is safe
to release next?". It inventories every active task, extracts each
task's declared \`## Relevant files\` block, builds the
file → tasks conflict graph, and groups tasks into ordered "waves"
where every task in a wave is file-disjoint from every other task in
the same wave.

The runbook is read-only guidance. It does not start, stop, or modify
any task — it only tells the human (or the next planning session)
which combination of tasks can run concurrently without colliding on
hot files.

---

## 1. Headline counts

${renderHeadline(tasks)}

---

## 2. Hot files

A "hot file" is one that ≥ ${HOT_THRESHOLD} active tasks declare in their
\`## Relevant files\` block. These force serialization: if two tasks
both edit the same hot file, they cannot run in the same wave without
producing merge conflicts at apply time.

${renderHotFiles(fileToTasks, tasksByRef)}

---

## 3. Wave plan

Tasks are assigned to numbered waves by greedy graph coloring on the
file-conflict graph. Every task in a wave is file-disjoint from every
other task in the same wave. Waves are ordered so the most
collision-prone surfaces (scoring / engines / API routes) drain first
and hot-file queues are flushed last. Each wave is capped at
${WAVE_CAP} tasks (the platform's stated in-flight concurrency limit).

Read this top-to-bottom: Wave 1 is what's currently running or what
should be released next; later waves are safe to release once their
predecessors clear the hot files they share.

${renderWaves(waves, tasksByRef)}

---

## 4. Cannot parallelize

${renderCannotParallelize(skipped)}

---

## 5. Recommended next batch

${renderRecommendedNextBatch(tasks, waves, tasksByRef)}

---

## 6. Line-range references

${renderLineRangeRefs(tasks)}

---

## Regenerating this document

Run from the repo root:

\`\`\`bash
node scripts/regenerate-parallelization-runbook.mjs
\`\`\`

The script reads \`scripts/data/active-tasks.snapshot.json\` and emits this doc
deterministically.

To pull fresh plan bodies from the on-disk project-task surface
(\`.local/tasks/*.md\`) into the snapshot before regenerating:

\`\`\`bash
node scripts/regenerate-parallelization-runbook.mjs --refresh
\`\`\`

\`--refresh\` walks every \`.local/tasks/*.md\` plan file, matches each by
its H1 title against the snapshot, and overwrites the matched
snapshot entry's description with the live plan body. Ref + state
are preserved from the snapshot because they live on the project-task
surface that only the planning agent can mutate. Plan files with no
matching snapshot title are reported and skipped (a snapshot rebuild
from the project-task surface is needed to pick them up).

This keeps the script free of external dependencies and safe to run
in CI before \`pnpm install\`.

CI-friendly check (exits non-zero if regenerating would change the
file; the time-sensitive \`Generated:\` line is ignored):

\`\`\`bash
node scripts/regenerate-parallelization-runbook.mjs --check
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function stripGeneratedDate(s) {
  return s.replace(/^\*\*Generated:\*\*[^\n]*\n/m, "");
}

function main() {
  if (REFRESH) {
    refreshSnapshotFromTasksDir();
  }
  const next = buildDocument();
  if (CHECK_ONLY) {
    let current = "";
    try {
      current = fs.readFileSync(OUT, "utf8");
    } catch {
      console.error(
        `[--check] ${OUT} does not exist; regenerate to create it.`,
      );
      process.exit(2);
    }
    if (stripGeneratedDate(current) !== stripGeneratedDate(next)) {
      console.error(
        `[--check] ${OUT} is out of date. Re-run \`node scripts/regenerate-parallelization-runbook.mjs\`.`,
      );
      process.exit(1);
    }
    console.log(`[--check] ${OUT} is up to date (date line ignored).`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(
    `Wrote ${OUT} (${next.length} bytes, ${next.split(/\s+/).length} words approx).`,
  );
}

main();
