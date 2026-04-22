#!/usr/bin/env node
// Task #122 — CLI wrapper around the calibration hand-wavy phrase DELETE
// endpoint, mirroring the preview/add helper in
// artifacts/api-server/scripts/preview-handwavy-phrase.mjs. First GETs the
// active list to confirm each phrase exists and to render the entries that
// would be removed (category, who added it, when, rationale), then asks for
// confirmation before issuing the DELETEs. Intended for reviewers retiring
// phrases from a release checklist or shell script without hand-crafting curl.
//
// Task #127 — accepts multiple phrases per invocation, either via repeated
// `--phrase` flags or via `--phrases-file <path>` (one phrase per line, blank
// lines and `#` comments ignored). The confirmation summary lists every
// phrase with its lookup outcome, a single combined yes/no confirms the
// batch, and per-phrase results (removed / not-found / auth-failed / error)
// are reported at the end. The exit code is 0 only when every requested
// removal succeeded.
//
// Usage:
//   node scripts/remove-handwavy-phrase.mjs --phrase "as far as i can tell" \
//     [--phrase "another phrase" ...] \
//     [--phrases-file ./retired.txt] \
//     [--api-url http://localhost:3001] \
//     [--token <reviewer-token>] \
//     [--reviewer "alice@example.com"] \
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
//   0  every requested phrase was removed
//   1  at least one phrase failed (not found, auth, network), or operator declined
//   2  bad arguments

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";

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
  const args = {
    phrases: [],
    phrasesFile: null,
    apiUrl: null,
    token: null,
    reviewer: null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phrase" || a === "-p") args.phrases.push(argv[++i]);
    else if (a === "--phrases-file") args.phrasesFile = argv[++i];
    else if (a === "--api-url") args.apiUrl = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--reviewer") args.reviewer = argv[++i];
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
  console.log(`Confirm-then-delete one or more curated hand-wavy phrases via the
calibration API.

Usage:
  remove-handwavy-phrase.mjs --phrase "<text>" [--phrase "<text>" ...]
                             [--phrases-file <path>]
                             [--api-url http://localhost:3001]
                             [--token <reviewer-token>] [--reviewer "<name>"] [--yes]

Options:
  -p, --phrase         Phrase to remove (may be repeated for batch removal)
      --phrases-file   Path to a file with one phrase per line; blank lines
                       and lines beginning with '#' are ignored. May be
                       combined with --phrase.
      --api-url        Base URL of the API (default: $API_URL or http://localhost:3001)
      --token          Reviewer token for X-Calibration-Token (default: $CALIBRATION_TOKEN)
      --reviewer       Reviewer name/email recorded on every removal history entry
  -y, --yes            Skip the interactive confirmation prompt
  -h, --help           Show this help
`);
}

function normalizePhrase(raw) {
  // Mirror artifacts/api-server/src/lib/engines/avri/handwavy-phrases.ts so
  // the local "does it exist?" lookup matches what the server would do.
  return String(raw).toLowerCase().replace(/\s+/g, " ").trim();
}

function readPhrasesFile(path) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    console.error(color("red", `Failed to read --phrases-file ${path}: ${err.message}`));
    process.exit(2);
  }
  const out = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

async function request(method, url, body, token) {
  let res;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Calibration-Token"] = token;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

function renderEntry(item) {
  const lines = [];
  lines.push("");
  if (item.entry) {
    lines.push(color("bold", `• "${item.entry.phrase}"`));
    lines.push(`    Category:  ${item.entry.category}`);
    if (item.entry.addedBy) lines.push(`    Added by:  ${item.entry.addedBy}`);
    if (item.entry.addedAt) lines.push(`    Added at:  ${item.entry.addedAt}`);
    if (item.entry.rationale) lines.push(`    Rationale: ${item.entry.rationale}`);
    if (!item.entry.addedBy && !item.entry.addedAt) {
      lines.push(color("dim", "    (curated default — no add-history metadata)"));
    }
  } else {
    lines.push(color("yellow", `• "${item.normalized}"`));
    lines.push(color("yellow", "    Not in the active list — will be skipped."));
  }
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

  const collected = [...args.phrases];
  if (args.phrasesFile) {
    collected.push(...readPhrasesFile(args.phrasesFile));
  }
  const validRaw = collected.filter(
    (p) => typeof p === "string" && p.trim().length > 0,
  );
  if (validRaw.length === 0) {
    console.error("Error: at least one --phrase or a --phrases-file with content is required.");
    printHelp();
    process.exit(2);
  }

  // Dedupe by normalized form, preserving the first-seen original spelling so
  // the DELETE body matches what the operator typed (the server normalizes
  // again on its side).
  const seen = new Map();
  for (const raw of validRaw) {
    const normalized = normalizePhrase(raw);
    if (!seen.has(normalized)) seen.set(normalized, { raw, normalized });
  }
  const requests = [...seen.values()];

  const baseUrl = (args.apiUrl ?? process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/feedback/calibration/handwavy-phrases`;
  // The DELETE endpoint is gated by requireCalibrationAuth. The GET endpoint
  // is not, but we send the token on both requests anyway so a misconfigured
  // token surfaces immediately during the lookup rather than after the
  // operator has already typed "yes".
  const token = args.token ?? process.env.CALIBRATION_TOKEN ?? null;

  console.log(color("dim", `→ Fetching active list from ${endpoint} ...`));
  const list = await request("GET", endpoint, undefined, token);
  if (list.status === 401 || list.status === 403) {
    console.error(color("red", "Lookup failed: the calibration endpoint rejected the request as unauthorized. Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment."));
    process.exit(1);
  }
  if (!list.ok) {
    const msg = list.payload && typeof list.payload === "object" && "error" in list.payload
      ? list.payload.error
      : `HTTP ${list.status}`;
    console.error(color("red", `Lookup failed: ${msg}`));
    process.exit(1);
  }
  const phrases = Array.isArray(list.payload?.phrases) ? list.payload.phrases : null;
  if (!phrases) {
    console.error(color("red", "Lookup failed: server response did not include a 'phrases' array. Aborting."));
    process.exit(1);
  }

  // Build a normalized -> entry index for O(1) lookups.
  const byNormalized = new Map();
  for (const p of phrases) {
    if (p && typeof p === "object" && typeof p.phrase === "string") {
      byNormalized.set(p.phrase, p);
    }
  }

  const items = requests.map((r) => ({
    raw: r.raw,
    normalized: r.normalized,
    entry: byNormalized.get(r.normalized) ?? null,
  }));
  const presentItems = items.filter((it) => it.entry);
  const missingItems = items.filter((it) => !it.entry);

  console.log("");
  console.log(color("bold", `Phrases to remove (${requests.length} requested, ${presentItems.length} found, ${missingItems.length} not in active list):`));
  for (const it of items) console.log(renderEntry(it));
  console.log("");

  if (presentItems.length === 0) {
    console.error(color("red", `None of the requested phrases are in the active list (${phrases.length} entr${phrases.length === 1 ? "y" : "ies"}). Nothing to remove.`));
    process.exit(1);
  }

  let proceed = args.yes;
  if (!proceed) {
    const noun = presentItems.length === 1 ? "this phrase" : `these ${presentItems.length} phrases`;
    proceed = await confirm(color("red", `Remove ${noun} from the active list? [y/N] `));
  }
  if (!proceed) {
    console.log(color("yellow", "Aborted — no changes were made."));
    process.exit(1);
  }

  // Per-phrase results. status ∈ "removed" | "not-found" | "auth-failed" | "error" | "skipped-not-found"
  const results = [];
  let authFailedSticky = false;
  let lastTotal = null;

  for (const it of items) {
    if (!it.entry) {
      results.push({ ...it, status: "skipped-not-found", message: "not in active list at lookup time" });
      continue;
    }
    if (authFailedSticky) {
      results.push({ ...it, status: "auth-failed", message: "skipped after earlier auth failure" });
      continue;
    }
    console.log(color("dim", `→ Removing "${it.normalized}" ...`));
    const body = { phrase: it.raw };
    if (args.reviewer) body.reviewer = args.reviewer;
    let del;
    try {
      del = await request("DELETE", endpoint, body, token);
    } catch (err) {
      results.push({ ...it, status: "error", message: err.message });
      continue;
    }
    if (del.status === 401 || del.status === 403) {
      authFailedSticky = true;
      results.push({ ...it, status: "auth-failed", message: `HTTP ${del.status}` });
      continue;
    }
    if (del.status === 404) {
      // Race with another reviewer: the GET above saw the phrase but it was
      // gone by the time we issued the DELETE.
      results.push({ ...it, status: "not-found", message: "server reported 404 (removed by someone else?)" });
      continue;
    }
    if (!del.ok) {
      const msg = del.payload && typeof del.payload === "object" && "error" in del.payload
        ? del.payload.error
        : `HTTP ${del.status}`;
      results.push({ ...it, status: "error", message: msg });
      continue;
    }
    const result = del.payload ?? {};
    if (typeof result.total === "number") lastTotal = result.total;
    results.push({ ...it, status: "removed", message: null });
  }

  // Summary
  console.log("");
  console.log(color("bold", "Removal results:"));
  const counts = { removed: 0, "not-found": 0, "skipped-not-found": 0, "auth-failed": 0, error: 0 };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    let line;
    switch (r.status) {
      case "removed":
        line = color("green", `  ✓ removed     "${r.normalized}"`);
        break;
      case "not-found":
        line = color("yellow", `  ! not-found   "${r.normalized}" — ${r.message}`);
        break;
      case "skipped-not-found":
        line = color("yellow", `  ! not-found   "${r.normalized}" — ${r.message}`);
        break;
      case "auth-failed":
        line = color("red", `  ✗ auth-failed "${r.normalized}" — ${r.message}`);
        break;
      case "error":
      default:
        line = color("red", `  ✗ error       "${r.normalized}" — ${r.message}`);
        break;
    }
    console.log(line);
  }
  console.log("");
  if (lastTotal !== null) {
    console.log(color("dim", `Active list size after removals: ${lastTotal}`));
  }
  if (counts["auth-failed"] > 0) {
    console.error(color("red", "One or more removals were rejected as unauthorized. Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment."));
  }

  // Exit code: 0 only when every requested removal succeeded.
  const allOk = counts.removed === requests.length;
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(color("red", `Unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
