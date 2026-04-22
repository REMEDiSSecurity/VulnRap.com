#!/usr/bin/env node
// Task #118 — CLI wrapper around the calibration hand-wavy phrase preview /
// confirm flow. Mirrors what the calibration UI does in
// artifacts/vulnrap/src/pages/feedback-analytics.tsx: first POSTs with
// `dryRun: true` to render a corpus-impact preview (per-tier counts, sample
// fixture ids, GREEN/YELLOW false-positive warning), then asks the operator
// to confirm before re-POSTing without `dryRun` to actually persist the
// phrase. Intended for reviewers running release checklists from a shell.
//
// Usage:
//   node scripts/preview-handwavy-phrase.mjs --phrase "as far as i can tell" \
//     [--category absence|hedging|buzzword] \
//     [--api-url http://localhost:3001] \
//     [--token <reviewer-token>] \
//     [--yes]   # skip the interactive confirmation prompt
//
// Environment fallbacks:
//   API_URL              base URL of the running API server (default http://localhost:3001)
//   CALIBRATION_TOKEN    reviewer token sent as `X-Calibration-Token` on every
//                        request — required whenever the API server has its own
//                        CALIBRATION_TOKEN env var set (see
//                        artifacts/api-server/src/middlewares/require-calibration-auth.ts).
//
// Exit codes:
//   0  phrase added (or already existed)
//   1  validation / network / auth error, or operator declined confirmation
//   2  bad arguments

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function color(name, str) {
  return useColor ? `${ANSI[name]}${str}${ANSI.reset}` : String(str);
}

function parseArgs(argv) {
  const args = { phrase: null, category: "absence", apiUrl: null, token: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phrase" || a === "-p") args.phrase = argv[++i];
    else if (a === "--category" || a === "-c") args.category = argv[++i];
    else if (a === "--api-url") args.apiUrl = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Preview a candidate hand-wavy phrase against the curated benchmark
corpus, then confirm before persisting.

Usage:
  preview-handwavy-phrase.mjs --phrase "<text>" [--category absence|hedging|buzzword]
                              [--api-url http://localhost:3001] [--yes]

Options:
  -p, --phrase     Candidate phrase to preview (required)
  -c, --category   Category bucket (default: absence)
      --api-url    Base URL of the API (default: $API_URL or http://localhost:3001)
      --token      Reviewer token for X-Calibration-Token (default: $CALIBRATION_TOKEN)
  -y, --yes        Skip the interactive confirmation prompt
  -h, --help       Show this help
`);
}

async function postJson(url, body, token) {
  let res;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Calibration-Token"] = token;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Network error talking to ${url}: ${err.message}`);
  }
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return { status: res.status, ok: res.ok, payload };
}

function renderPreview(phrase, category, m) {
  const lines = [];
  lines.push("");
  lines.push(color("bold", `Corpus impact for "${phrase}" (${category})`));
  lines.push(color("dim", `Evaluated against ${m.corpusSize} curated benchmark fixtures.`));
  lines.push("");
  // Per-tier table — GREEN/YELLOW are false positives, RED tiers are the
  // intended catches. Match the UI's color semantics.
  const rows = [
    { label: "GREEN  (T1 legit)",       count: m.byTier.t1Legit,       negative: true },
    { label: "YELLOW (T2 borderline)",  count: m.byTier.t2Borderline,  negative: true },
    { label: "RED    (T3 slop)",        count: m.byTier.t3Slop,        negative: false },
    { label: "RED    (T4 hallucinated)",count: m.byTier.t4Hallucinated,negative: false },
  ];
  for (const r of rows) {
    const c = r.negative
      ? (r.count > 0 ? "red" : "dim")
      : (r.count > 0 ? "green" : "dim");
    lines.push(`  ${color(c, r.label.padEnd(28))} ${color(c, String(r.count).padStart(3))}`);
  }
  lines.push("");
  lines.push(`  Total matches: ${color("bold", String(m.total))}`);
  lines.push(`  False positives (GREEN+YELLOW): ${
    m.falsePositives > 0
      ? color("red", String(m.falsePositives))
      : color("green", "0")
  }`);
  if (m.warning) {
    lines.push("");
    lines.push(color("red", `  ⚠  ${m.warning}`));
  } else if (m.total === 0) {
    lines.push("");
    lines.push(color("yellow", "  Note: this phrase did not match any fixture in the curated corpus."));
  }
  if (m.sampleMatches && m.sampleMatches.length > 0) {
    lines.push("");
    lines.push(color("bold", `  Sample matched fixtures (${m.sampleMatches.length}):`));
    for (const s of m.sampleMatches) {
      lines.push(`    - ${s.id}  ${color("dim", `[${s.tier}]`)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// Task #123 — render overlap with the existing curated phrase list as
// prominently as the GREEN/YELLOW false-positive warning. Substring overlap
// is the most common reason a reviewer should NOT add a candidate, so we
// surface it in red before the confirmation prompt.
function describeOverlapRelation(rel) {
  switch (rel) {
    case "equal":
      return "exact duplicate of";
    case "candidate-contains-existing":
      return "broader than (would supersede)";
    case "existing-contains-candidate":
      return "already covered by";
    default:
      return "overlaps with";
  }
}

function renderOverlaps(overlaps) {
  if (!overlaps || !overlaps.matches || overlaps.matches.length === 0) {
    return "";
  }
  const lines = [];
  const noun = overlaps.total === 1 ? "entry" : "entries";
  lines.push(color("red", `  ⚠  Overlaps with ${overlaps.total} existing curated ${noun} — adding may be redundant:`));
  for (const o of overlaps.matches) {
    const rel = describeOverlapRelation(o.relation);
    lines.push(
      `    - ${color("red", rel)} "${o.phrase}" ${color("dim", `[${o.category}]`)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function confirm(question) {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.phrase || typeof args.phrase !== "string" || args.phrase.trim().length === 0) {
    console.error("Error: --phrase is required.");
    printHelp();
    process.exit(2);
  }
  if (!["absence", "hedging", "buzzword"].includes(args.category)) {
    console.error(`Error: --category must be one of 'absence', 'hedging', 'buzzword' (got '${args.category}').`);
    process.exit(2);
  }
  const baseUrl = (args.apiUrl ?? process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/feedback/calibration/handwavy-phrases`;
  // Calibration mutation endpoints are gated by requireCalibrationAuth in the
  // API server. When the server has CALIBRATION_TOKEN set, both the dry-run
  // and the real add need to present the same token via X-Calibration-Token,
  // otherwise both POSTs return 401. We accept the token via --token or the
  // CALIBRATION_TOKEN env var so the script works in either mode.
  const token = args.token ?? process.env.CALIBRATION_TOKEN ?? null;

  console.log(color("dim", `→ Previewing against ${endpoint} ...`));
  const dry = await postJson(endpoint, {
    phrase: args.phrase,
    category: args.category,
    dryRun: true,
  }, token);
  if (dry.status === 401 || dry.status === 403) {
    console.error(color("red", "Preview failed: the calibration endpoint rejected the request as unauthorized. Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment."));
    process.exit(1);
  }
  if (!dry.ok) {
    const msg = dry.payload && typeof dry.payload === "object" && "error" in dry.payload
      ? dry.payload.error
      : `HTTP ${dry.status}`;
    console.error(color("red", `Preview failed: ${msg}`));
    process.exit(1);
  }
  if (!dry.payload || typeof dry.payload !== "object" || !dry.payload.dryRunMatches) {
    // Match the UI's fail-closed behavior: never fall through to a real add
    // if the server didn't return the preview block.
    console.error(color("red", "Preview unavailable: server response did not include a corpus impact preview. Aborting without adding the phrase."));
    process.exit(1);
  }
  const matches = dry.payload.dryRunMatches;
  const normalizedPhrase = dry.payload.phrase ?? args.phrase;
  const effectiveCategory = dry.payload.category ?? args.category;

  console.log(renderPreview(normalizedPhrase, effectiveCategory, matches));

  // Task #123 — surface overlap with already-curated phrases between the
  // corpus-impact preview and the confirm prompt, mirroring how the
  // GREEN/YELLOW false-positive warning is displayed.
  const overlaps = dry.payload.dryRunOverlaps ?? null;
  const overlapText = renderOverlaps(overlaps);
  if (overlapText) console.log(overlapText);

  let proceed = args.yes;
  if (!proceed) {
    const overlapCount = overlaps?.total ?? 0;
    let prompt;
    if (matches.falsePositives > 0 && overlapCount > 0) {
      prompt = color("red", `Add this phrase anyway despite the false positives AND ${overlapCount} curated overlap(s)? [y/N] `);
    } else if (matches.falsePositives > 0) {
      prompt = color("red", "Add this phrase anyway despite the false positives? [y/N] ");
    } else if (overlapCount > 0) {
      prompt = color("red", `Add this phrase anyway despite ${overlapCount} curated overlap(s)? [y/N] `);
    } else {
      prompt = "Add this phrase to the active list? [y/N] ";
    }
    proceed = await confirm(prompt);
  }
  if (!proceed) {
    console.log(color("yellow", "Aborted — no changes were made."));
    process.exit(1);
  }

  console.log(color("dim", "→ Adding phrase ..."));
  const real = await postJson(endpoint, {
    phrase: args.phrase,
    category: args.category,
  }, token);
  if (real.status === 401 || real.status === 403) {
    console.error(color("red", "Add failed: the calibration endpoint rejected the request as unauthorized. Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment."));
    process.exit(1);
  }
  if (!real.ok) {
    const msg = real.payload && typeof real.payload === "object" && "error" in real.payload
      ? real.payload.error
      : `HTTP ${real.status}`;
    console.error(color("red", `Add failed: ${msg}`));
    process.exit(1);
  }
  const result = real.payload ?? {};
  if (result.added === false) {
    console.log(color("yellow", `Phrase "${result.phrase ?? normalizedPhrase}" was already in the active list (total: ${result.total ?? "?"}).`));
  } else {
    console.log(color("green", `✓ Added "${result.phrase ?? normalizedPhrase}" (${result.category ?? effectiveCategory}). Active list size: ${result.total ?? "?"}.`));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(color("red", `Unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
