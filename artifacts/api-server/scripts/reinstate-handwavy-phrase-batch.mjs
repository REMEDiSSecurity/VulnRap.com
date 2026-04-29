#!/usr/bin/env node
// Task #157 — CLI wrapper around the calibration hand-wavy phrase
// /reinstate-batch endpoint, mirroring the bulk-remove helper in
// artifacts/api-server/scripts/remove-handwavy-phrase.mjs. Reviewers stuck in
// a terminal can undo a whole Task #135 batch removal in one round-trip
// instead of calling the per-phrase /reinstate endpoint N times. Prints a
// per-phrase outcome summary (reinstated / already-reinstated /
// already-active) and exits 0 only when the server processed the batch
// without a transport / auth / lookup failure.
//
// Usage:
//   node scripts/reinstate-handwavy-phrase-batch.mjs --removed-at 2026-04-22T12:34:56.000Z \
//     [--api-url http://localhost:3001] \
//     [--token <reviewer-token>] \
//     [--reviewer "alice@example.com"] \
//     [--yes]   # skip the interactive confirmation prompt
//
//   # Task #160 — interactive picker (no --removed-at needed): list the most
//   # recent batch removals and let the reviewer pick one by number. Picker
//   # mode is opt-in via --pick, OR auto-engaged when --removed-at is omitted
//   # AND stdin is a TTY (a non-TTY invocation without --removed-at still
//   # errors out so scripts don't accidentally hang on a hidden prompt).
//   node scripts/reinstate-handwavy-phrase-batch.mjs --pick [--limit 10]
//
// Environment fallbacks:
//   API_URL              base URL of the running API server (default http://localhost:3001)
//   CALIBRATION_TOKEN    reviewer token sent as `X-Calibration-Token` on the
//                        request — required whenever the API server has its
//                        own CALIBRATION_TOKEN env var set (see
//                        artifacts/api-server/src/middlewares/require-calibration-auth.ts).
//
// Exit codes:
//   0  the server processed the batch (HTTP 201). Per-phrase skips
//      (already-reinstated / already-active) are NOT failures — they are
//      reported in the summary and counted toward `skipped`.
//   1  transport / auth / lookup failure (network, 401/403, 404 history
//      not-found, 409 not-a-batch, or operator declined the prompt).
//   2  bad arguments.

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
  const args = {
    removedAt: null,
    apiUrl: null,
    token: null,
    reviewer: null,
    yes: false,
    pick: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--removed-at" || a === "--removedAt") args.removedAt = argv[++i];
    else if (a === "--api-url") args.apiUrl = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--reviewer") args.reviewer = argv[++i];
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--pick") args.pick = true;
    else if (a === "--limit") args.limit = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Reinstate every not-yet-reinstated phrase from a single batch
removal entry via the calibration API. Mirrors the bulk-remove CLI so
reviewers can undo a Task #135 cleanup in one terminal round-trip.

Usage:
  reinstate-handwavy-phrase-batch.mjs --removed-at <iso-timestamp>
                                      [--api-url http://localhost:3001]
                                      [--token <reviewer-token>]
                                      [--reviewer "<name>"] [--yes]
  reinstate-handwavy-phrase-batch.mjs --pick [--limit N] [--reviewer "<name>"]

Options:
      --removed-at     ISO 8601 timestamp of the batch removal entry to
                       reinstate (matches the parent entry's \`removedAt\`
                       field in the removal-history log). Required unless
                       --pick is set or stdin is a TTY (interactive picker).
      --pick           Fetch the most recent batch removals from the server
                       and prompt for a numbered selection (Task #160).
                       Auto-engaged when --removed-at is omitted and stdin
                       is a TTY; non-TTY invocations still require
                       --removed-at so scripts never silently hang on a
                       hidden prompt.
      --limit          When picking, max number of batch entries to list
                       (default 10, server caps at 50).
      --api-url        Base URL of the API (default: $API_URL or http://localhost:3001)
      --token          Reviewer token for X-Calibration-Token (default: $CALIBRATION_TOKEN)
      --reviewer       Reviewer name/email recorded as \`addedBy\`/\`reinstatedBy\`
                       on every reinstated phrase. Optional.
  -y, --yes            Skip the interactive confirmation prompt
  -h, --help           Show this help

Examples:
  # Reinstate the batch removed at 2026-04-22T12:34:56.000Z
  reinstate-handwavy-phrase-batch.mjs --removed-at 2026-04-22T12:34:56.000Z

  # Same, but skip the prompt and attribute the reinstate to carol@team.com
  reinstate-handwavy-phrase-batch.mjs --removed-at 2026-04-22T12:34:56.000Z \\
    --reviewer carol@team.com --yes

  # Interactive picker — list recent batches, choose one by number
  reinstate-handwavy-phrase-batch.mjs --pick --reviewer carol@team.com
`);
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

async function confirm(question) {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

async function promptForChoice(question) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Task #160 — Render a numbered menu of recent batch removals and return the
// selected entry's `removedAt`. Returns null if the reviewer typed `q` /
// blank to abort. Throws on transport / auth failure (caught by main).
async function pickRemovedAtInteractively(baseUrl, token, limit) {
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : "";
  const listUrl = `${baseUrl}/api/feedback/calibration/handwavy-phrases/removal-batches${qs}`;
  console.log(color("dim", `→ GET ${listUrl} ...`));
  const resp = await request("GET", listUrl, undefined, token);
  if (resp.status === 401 || resp.status === 403) {
    const err = new Error(`Picker rejected as unauthorized (HTTP ${resp.status}). Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment.`);
    err.code = "auth";
    throw err;
  }
  if (!resp.ok) {
    const msg = resp.payload && typeof resp.payload === "object" && "error" in resp.payload
      ? resp.payload.error
      : `HTTP ${resp.status}`;
    throw new Error(`Picker failed: ${msg}`);
  }
  const batches = Array.isArray(resp.payload?.batches) ? resp.payload.batches : [];
  if (batches.length === 0) {
    console.log(color("yellow", "No batch removals found in the history log — nothing to reinstate."));
    return null;
  }
  console.log("");
  console.log(color("bold", `Recent batch removals (newest first, showing ${batches.length}):`));
  batches.forEach((b, i) => {
    const idx = String(i + 1).padStart(2, " ");
    const ts = b.removedAt ?? "(unknown)";
    const reviewer = b.removedBy ? ` by ${b.removedBy}` : "";
    const count = typeof b.phraseCount === "number" ? `${b.phraseCount} phrase${b.phraseCount === 1 ? "" : "s"}` : "? phrases";
    const flag = b.reinstated === true ? color("yellow", " [already reinstated]") : "";
    const sample = Array.isArray(b.samplePhrases) && b.samplePhrases.length > 0
      ? `\n      ${color("dim", "→ " + b.samplePhrases.map((p) => JSON.stringify(p)).join(", ") + (b.phraseCount > b.samplePhrases.length ? ", ..." : ""))}`
      : "";
    console.log(`  ${color("cyan", idx)}) ${ts}${reviewer} — ${count}${flag}${sample}`);
  });
  console.log("");
  const ans = await promptForChoice(color("yellow", `Pick a batch [1-${batches.length}] or q to abort: `));
  if (!ans || ans.toLowerCase() === "q" || ans.toLowerCase() === "quit") {
    return null;
  }
  const choice = Number.parseInt(ans, 10);
  if (!Number.isFinite(choice) || choice < 1 || choice > batches.length) {
    throw new Error(`Invalid selection "${ans}" — expected a number between 1 and ${batches.length}.`);
  }
  const picked = batches[choice - 1];
  if (typeof picked.removedAt !== "string" || picked.removedAt.length === 0) {
    throw new Error("Selected batch is missing a removedAt timestamp.");
  }
  if (picked.reinstated === true) {
    console.log(color("yellow", `Note: this batch has already been fully reinstated. Proceeding will be a no-op (every inner phrase will be skipped).`));
  }
  return picked.removedAt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  const baseUrl = (args.apiUrl ?? process.env.API_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/feedback/calibration/handwavy-phrases/reinstate-batch`;
  const token = args.token ?? process.env.CALIBRATION_TOKEN ?? null;

  // Task #160 — Decide whether to engage the interactive picker. Picker is
  // opt-in via --pick OR auto-engaged when --removed-at is missing AND
  // stdin is a TTY. Non-TTY invocations without --removed-at still get the
  // existing exit-2 error so scripts don't silently hang on a hidden prompt.
  const removedAtFlag = typeof args.removedAt === "string" ? args.removedAt.trim() : "";
  const hasRemovedAt = removedAtFlag.length > 0;
  const stdinIsTty = Boolean(process.stdin.isTTY);
  const shouldPick = args.pick === true || (!hasRemovedAt && stdinIsTty);

  let removedAt;
  if (shouldPick) {
    let pickLimit = null;
    if (args.limit !== null && args.limit !== undefined) {
      const parsed = Number.parseInt(args.limit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error("Error: --limit must be a positive integer.");
        process.exit(2);
      }
      pickLimit = parsed;
    }
    let picked;
    try {
      picked = await pickRemovedAtInteractively(baseUrl, token, pickLimit);
    } catch (err) {
      console.error(color("red", err.message));
      process.exit(1);
    }
    if (picked === null) {
      console.log(color("yellow", "Aborted — no changes were made."));
      process.exit(1);
    }
    removedAt = picked;
  } else {
    if (!hasRemovedAt) {
      console.error("Error: --removed-at <iso-timestamp> is required.");
      printHelp();
      process.exit(2);
    }
    removedAt = removedAtFlag;
  }

  let proceed = args.yes;
  if (!proceed) {
    proceed = await confirm(color("yellow", `Reinstate every not-yet-reinstated phrase from the batch removed at ${removedAt}? [y/N] `));
  }
  if (!proceed) {
    console.log(color("yellow", "Aborted — no changes were made."));
    process.exit(1);
  }

  const body = { removedAt };
  if (args.reviewer) body.reviewer = args.reviewer;

  console.log(color("dim", `→ POST ${endpoint} (removedAt=${removedAt}) ...`));
  let resp;
  try {
    resp = await request("POST", endpoint, body, token);
  } catch (err) {
    console.error(color("red", `Reinstate failed: ${err.message}`));
    process.exit(1);
  }

  if (resp.status === 401 || resp.status === 403) {
    console.error(color("red", `Reinstate rejected as unauthorized (HTTP ${resp.status}). Pass --token <reviewer-token> or set CALIBRATION_TOKEN in the environment.`));
    process.exit(1);
  }
  if (resp.status === 404) {
    const msg = resp.payload && typeof resp.payload === "object" && "error" in resp.payload
      ? resp.payload.error
      : `HTTP ${resp.status}`;
    console.error(color("red", `Reinstate failed: ${msg}`));
    console.error(color("dim", "  (no removal-history entry matched that --removed-at value)"));
    process.exit(1);
  }
  if (resp.status === 409) {
    const msg = resp.payload && typeof resp.payload === "object" && "error" in resp.payload
      ? resp.payload.error
      : `HTTP ${resp.status}`;
    console.error(color("red", `Reinstate failed: ${msg}`));
    console.error(color("dim", "  (the matched history entry is a single-phrase removal — use the per-phrase /reinstate endpoint instead)"));
    process.exit(1);
  }
  if (!resp.ok || !resp.payload || resp.payload.batch !== true) {
    const msg = resp.payload && typeof resp.payload === "object" && "error" in resp.payload
      ? resp.payload.error
      : `HTTP ${resp.status}`;
    console.error(color("red", `Reinstate failed: ${msg}`));
    process.exit(1);
  }

  const p = resp.payload;
  const results = Array.isArray(p.results) ? p.results : [];
  const reinstatedCount = typeof p.reinstatedCount === "number" ? p.reinstatedCount : 0;
  const skipped = typeof p.skipped === "number" ? p.skipped : 0;

  console.log("");
  console.log(color("bold", `Batch reinstate processed (removedAt=${p.removedAt ?? removedAt}):`));
  console.log(`  Inner phrases:        ${results.length}`);
  console.log(`  Reinstated:           ${color("green", reinstatedCount)}`);
  console.log(`  Skipped:              ${color("yellow", skipped)}`);
  if (typeof p.total === "number") {
    console.log(`  Active list size now: ${p.total}`);
  }
  if (p.historyEntry && typeof p.historyEntry === "object" && p.historyEntry.reinstated === true) {
    console.log(color("dim", "  (aggregate history entry is now flagged reinstated:true)"));
  } else if (p.historyEntry && typeof p.historyEntry === "object") {
    console.log(color("dim", "  (aggregate history entry not yet fully reinstated — some inner phrases remain active or are still removed)"));
  }

  if (results.length > 0) {
    console.log("");
    console.log(color("bold", "Per-phrase outcome:"));
    for (const r of results) {
      if (r && r.reinstated === true) {
        console.log(color("green", `  ✓ reinstated         "${r.phrase}"`));
      } else if (r && r.reason === "already-reinstated") {
        console.log(color("yellow", `  ! already-reinstated "${r.phrase}" — left untouched`));
      } else if (r && r.reason === "already-active") {
        console.log(color("yellow", `  ! already-active     "${r.phrase}" — left untouched`));
      } else if (r && r.reason) {
        console.log(color("yellow", `  ! skipped            "${r.phrase}" — ${r.reason}`));
      } else {
        console.log(color("yellow", `  ! skipped            "${r?.phrase ?? "(unknown)"}"`));
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(color("red", `Unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
