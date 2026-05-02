#!/usr/bin/env node
// Summarise build-if-stale's persistent cache outcomes (Task #500).
//
// scripts/build-if-stale.mjs writes a JSONL record on every invocation
// to <cache-root>/stats.jsonl describing which path it took (skip /
// fresh / restore / build / error), the source-set hash where one was
// computed, and how long it took. This helper aggregates those records
// per target so it's obvious at a glance whether the persistent cache
// is paying off, or whether something is silently invalidating it on
// every run.
//
// Usage:
//   node scripts/build-if-stale-stats.mjs [options]
//   pnpm cache-stats -- [options]
//
// Options:
//   --last N           Only consider the most recent N records (after
//                      any --target filter).
//   --target <name>    Restrict the summary to a single target.
//   --cache-dir <path> Override the cache root (defaults to
//                      $BUILD_IF_STALE_CACHE_DIR or
//                      <repo>/.cache/build-if-stale).
//   --json             Emit the per-target summary as JSON instead of
//                      the human-readable table. Useful for piping into
//                      other tooling, e.g. CI dashboards.
//   --help, -h         Print this usage and exit.
//
// Outcome glossary (kept in sync with scripts/build-if-stale.mjs):
//   fresh    dist marker is newer than every watched source; no work.
//   restore  persistent cache had a matching snapshot; copied into
//            place. Counts as a "hit" alongside fresh.
//   build    full vite/esbuild rebuild — either a true cache miss, or
//            a forced rebuild (E2E_FORCE_PROD_BUILD=1), or a run with
//            BUILD_IF_STALE_DISABLE_CACHE=1. The `reason` field on the
//            record disambiguates.
//   skip     E2E_SKIP_PROD_BUILD=1; dist trusted as-is. Excluded from
//            the cacheable hit-rate denominator since the caller
//            bypassed the cache decision entirely.
//   error    a watched source path was missing (rename detection
//            tripped). Excluded from the hit-rate too.
//
// Hit-rate is (fresh + restore) / (fresh + restore + build), i.e.
// invocations where the cache decision actually mattered. A high
// "build" share with reason="no-cache-entry" means the cache key is
// flipping more often than expected — usually a non-source file
// accidentally landed inside a watched dir.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(REPO_ROOT, ".cache", "build-if-stale");

// Order outcomes are listed in the per-target table. "fresh" first
// because it's the cheapest happy path, then "restore", then the
// expensive miss/error tail — easier to spot regressions when scanning.
const OUTCOME_ORDER = ["fresh", "restore", "build", "skip", "error"];
// Numerator of the cache hit-rate: invocations that avoided the build.
const HIT_OUTCOMES = new Set(["fresh", "restore"]);
// Denominator of the cache hit-rate: invocations where the cache
// decision was actually exercised. "skip" is excluded because the
// caller asserted dist was already built; "error" is excluded because
// it's a failure mode unrelated to cache effectiveness.
const CACHEABLE_OUTCOMES = new Set(["fresh", "restore", "build"]);

function printUsage(stream = process.stderr) {
  stream.write(
    "usage: build-if-stale-stats.mjs " +
      "[--last N] [--target <name>] [--cache-dir <path>] [--json] [--help]\n",
  );
}

function parseArgs(argv) {
  const opts = { last: null, target: null, cacheDir: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--last") {
      const v = argv[++i];
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`--last requires a positive integer (got ${v})\n`);
        process.exit(2);
      }
      opts.last = n;
    } else if (a === "--target") {
      opts.target = argv[++i];
      if (!opts.target) {
        process.stderr.write(`--target requires a value\n`);
        process.exit(2);
      }
    } else if (a === "--cache-dir") {
      opts.cacheDir = argv[++i];
      if (!opts.cacheDir) {
        process.stderr.write(`--cache-dir requires a value\n`);
        process.exit(2);
      }
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      printUsage(process.stdout);
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      printUsage();
      process.exit(2);
    }
  }
  return opts;
}

// Parse the JSONL stats file. Returns [] if the file doesn't exist
// (e.g. stats hasn't been populated yet) so the helper can print a
// friendly hint instead of crashing.
export async function loadStats(file) {
  let txt;
  try {
    txt = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Tolerate malformed lines silently. They should be vanishingly
      // rare (writes are atomic for our record sizes), and the helper
      // is informational — crashing on a half-flushed line would
      // defeat the point of having a low-friction summary command.
    }
  }
  return out;
}

// Group records by target and tally counts/sums per outcome. Exported
// for the test suite so it can verify aggregation directly without
// shelling out and parsing the formatted table.
export function summariseStats(records) {
  const byTarget = new Map();
  for (const r of records) {
    if (typeof r.target !== "string") continue;
    if (!byTarget.has(r.target)) {
      byTarget.set(r.target, {
        total: 0,
        counts: Object.fromEntries(OUTCOME_ORDER.map((o) => [o, 0])),
        sums: Object.fromEntries(OUTCOME_ORDER.map((o) => [o, 0])),
        reasons: {},
        first: r.ts ?? "",
        last: r.ts ?? "",
      });
    }
    const t = byTarget.get(r.target);
    t.total++;
    // Records with a future, unknown outcome get bucketed into "build"
    // so they still count toward the cacheable denominator instead of
    // being silently dropped — better to surface a slight miscategori-
    // sation than to lose visibility entirely.
    const outcome = OUTCOME_ORDER.includes(r.outcome) ? r.outcome : "build";
    t.counts[outcome]++;
    const elapsed = Number(r.elapsedMs);
    if (Number.isFinite(elapsed)) t.sums[outcome] += elapsed;
    if (r.reason) {
      const key = `${outcome}:${r.reason}`;
      t.reasons[key] = (t.reasons[key] ?? 0) + 1;
    }
    // ISO 8601 timestamps sort lexicographically the same way they
    // sort chronologically, so plain string comparison is enough.
    if (r.ts && (!t.first || r.ts < t.first)) t.first = r.ts;
    if (r.ts && (!t.last || r.ts > t.last)) t.last = r.ts;
  }
  return byTarget;
}

function hitRate(stats) {
  const cacheable = [...CACHEABLE_OUTCOMES].reduce(
    (a, k) => a + stats.counts[k],
    0,
  );
  const hits = [...HIT_OUTCOMES].reduce((a, k) => a + stats.counts[k], 0);
  return { hits, cacheable };
}

function formatPercent(n, d) {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function formatSummary(byTarget) {
  const out = [];
  for (const [target, s] of [...byTarget.entries()].sort()) {
    const { hits, cacheable } = hitRate(s);
    out.push("");
    const span = s.first === s.last ? s.first : `${s.first} → ${s.last}`;
    out.push(
      `${target}: ${s.total} run${s.total === 1 ? "" : "s"} (${span})`,
    );
    out.push(
      `  hit-rate: ${formatPercent(hits, cacheable)} ` +
        `(${hits}/${cacheable} cacheable invocations hit)`,
    );
    out.push("  outcome    count    pct      avg ms");
    out.push("  --------   -----   ------   --------");
    for (const k of OUTCOME_ORDER) {
      const n = s.counts[k];
      if (n === 0) continue;
      const pct = formatPercent(n, s.total).padStart(6);
      const avg = Math.round(s.sums[k] / n);
      out.push(
        `  ${k.padEnd(8)}  ${String(n).padStart(5)}   ${pct}   ${String(avg).padStart(8)}`,
      );
    }
    // Reason breakdown is only interesting for the "build" and "error"
    // buckets; "fresh"/"restore"/"skip" don't carry one. Surface it
    // when present so a sudden shift in why builds keep happening
    // (e.g. cache-key flipping) is easy to spot.
    const reasonLines = Object.entries(s.reasons).sort();
    if (reasonLines.length > 0) {
      out.push("  reasons:");
      for (const [key, n] of reasonLines) {
        out.push(`    ${key.padEnd(28)} ${String(n).padStart(5)}`);
      }
    }
  }
  return out.join("\n");
}

function summaryToJson(byTarget) {
  const obj = {};
  for (const [target, s] of byTarget.entries()) {
    const { hits, cacheable } = hitRate(s);
    const outcomes = {};
    for (const k of OUTCOME_ORDER) {
      if (s.counts[k] === 0) continue;
      outcomes[k] = {
        count: s.counts[k],
        avgMs: Math.round(s.sums[k] / s.counts[k]),
      };
    }
    obj[target] = {
      total: s.total,
      first: s.first,
      last: s.last,
      hits,
      cacheable,
      hitRate: cacheable === 0 ? null : hits / cacheable,
      outcomes,
      reasons: s.reasons,
    };
  }
  return obj;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cacheRoot =
    opts.cacheDir ?? process.env.BUILD_IF_STALE_CACHE_DIR ?? DEFAULT_CACHE_ROOT;
  const file = path.join(cacheRoot, "stats.jsonl");
  let records = await loadStats(file);
  if (records.length === 0) {
    if (opts.json) {
      process.stdout.write("{}\n");
      return;
    }
    process.stdout.write(`No build-if-stale stats found at ${file}.\n`);
    process.stdout.write(
      "Run a release-gate Playwright config (or invoke build-if-stale.mjs " +
        "directly) to populate stats.\n",
    );
    return;
  }
  if (opts.target) {
    records = records.filter((r) => r.target === opts.target);
  }
  if (opts.last) {
    records = records.slice(-opts.last);
  }
  if (records.length === 0) {
    if (opts.json) {
      process.stdout.write("{}\n");
      return;
    }
    process.stdout.write(
      `No matching records in ${file}` +
        `${opts.target ? ` for target=${opts.target}` : ""}.\n`,
    );
    return;
  }
  const byTarget = summariseStats(records);
  if (opts.json) {
    process.stdout.write(JSON.stringify(summaryToJson(byTarget), null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `build-if-stale cache stats — ${records.length} record` +
      `${records.length === 1 ? "" : "s"} from ${file}\n`,
  );
  process.stdout.write(formatSummary(byTarget) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
