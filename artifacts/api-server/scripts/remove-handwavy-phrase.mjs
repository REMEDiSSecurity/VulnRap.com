#!/usr/bin/env node
// Task #122 — CLI wrapper around the calibration hand-wavy phrase DELETE
// endpoint, mirroring the preview/add helper in
// artifacts/api-server/scripts/preview-handwavy-phrase.mjs. First GETs the
// active list to confirm the phrase exists and to render the entry that
// would be removed (category, who added it, when, rationale), then asks for
// confirmation before issuing the DELETE. Intended for reviewers retiring a
// phrase from a release checklist or shell script without hand-crafting curl.
//
// Usage:
//   node scripts/remove-handwavy-phrase.mjs --phrase "as far as i can tell" \
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
//   0  phrase removed
//   1  phrase not found, validation / network / auth error, or operator declined confirmation
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
  const args = { phrase: null, apiUrl: null, token: null, reviewer: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--phrase" || a === "-p") args.phrase = argv[++i];
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
  console.log(`Confirm-then-delete a curated hand-wavy phrase via the calibration API.

Usage:
  remove-handwavy-phrase.mjs --phrase "<text>" [--api-url http://localhost:3001]
                             [--token <reviewer-token>] [--reviewer "<name>"] [--yes]

Options:
  -p, --phrase     Phrase to remove (required)
      --api-url    Base URL of the API (default: $API_URL or http://localhost:3001)
      --token      Reviewer token for X-Calibration-Token (default: $CALIBRATION_TOKEN)
      --reviewer   Reviewer name/email recorded on the removal history entry
  -y, --yes        Skip the interactive confirmation prompt
  -h, --help       Show this help
`);
}

function normalizePhrase(raw) {
  // Mirror artifacts/api-server/src/lib/engines/avri/handwavy-phrases.ts so
  // the local "does it exist?" lookup matches what the server would do.
  return String(raw).toLowerCase().replace(/\s+/g, " ").trim();
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

function renderEntry(entry) {
  const lines = [];
  lines.push("");
  lines.push(color("bold", `Phrase to remove: "${entry.phrase}"`));
  lines.push(`  Category:  ${entry.category}`);
  if (entry.addedBy) lines.push(`  Added by:  ${entry.addedBy}`);
  if (entry.addedAt) lines.push(`  Added at:  ${entry.addedAt}`);
  if (entry.rationale) lines.push(`  Rationale: ${entry.rationale}`);
  if (!entry.addedBy && !entry.addedAt) {
    lines.push(color("dim", "  (curated default — no add-history metadata)"));
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
  const baseUrl = (args.apiUrl ?? process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/feedback/calibration/handwavy-phrases`;
  // The DELETE endpoint is gated by requireCalibrationAuth. The GET endpoint
  // is not, but we send the token on both requests anyway so a misconfigured
  // token surfaces immediately during the lookup rather than after the
  // operator has already typed "yes".
  const token = args.token ?? process.env.CALIBRATION_TOKEN ?? null;
  const normalized = normalizePhrase(args.phrase);

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
  const entry = phrases.find((p) => p && typeof p === "object" && p.phrase === normalized);
  if (!entry) {
    console.error(color("red", `Phrase "${normalized}" is not in the active list (${phrases.length} entr${phrases.length === 1 ? "y" : "ies"}). Nothing to remove.`));
    process.exit(1);
  }

  console.log(renderEntry(entry));

  let proceed = args.yes;
  if (!proceed) {
    proceed = await confirm(color("red", "Remove this phrase from the active list? [y/N] "));
  }
  if (!proceed) {
    console.log(color("yellow", "Aborted — no changes were made."));
    process.exit(1);
  }

  console.log(color("dim", "→ Removing phrase ..."));
  const body = { phrase: args.phrase };
  if (args.reviewer) body.reviewer = args.reviewer;
  const del = await request("DELETE", endpoint, body, token);
  if (del.status === 401 || del.status === 403) {
    console.error(color("red", "Remove failed: the calibration endpoint rejected the request as unauthorized. Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment."));
    process.exit(1);
  }
  if (del.status === 404) {
    // Race with another reviewer: the GET above saw the phrase but it was
    // gone by the time we issued the DELETE. Surface as a clear error per
    // the task's "404 surfaced as a clear error" requirement rather than
    // silently exiting 0.
    console.error(color("red", `Remove failed: server reported the phrase "${normalized}" was not found (HTTP 404). It may have been removed by another reviewer between the lookup and the delete.`));
    process.exit(1);
  }
  if (!del.ok) {
    const msg = del.payload && typeof del.payload === "object" && "error" in del.payload
      ? del.payload.error
      : `HTTP ${del.status}`;
    console.error(color("red", `Remove failed: ${msg}`));
    process.exit(1);
  }
  const result = del.payload ?? {};
  console.log(color("green", `✓ Removed "${result.phrase ?? normalized}". Active list size: ${result.total ?? "?"}.`));
  process.exit(0);
}

main().catch((err) => {
  console.error(color("red", `Unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
