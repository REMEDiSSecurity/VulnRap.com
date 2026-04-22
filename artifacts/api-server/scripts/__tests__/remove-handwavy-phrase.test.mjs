import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "..", "remove-handwavy-phrase.mjs");

let server;
let baseUrl;
let state;

function resetState() {
  state = {
    phrases: [],
    deleteResponses: [],
    requireToken: null,
    requests: [],
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const token = req.headers["x-calibration-token"] ?? null;
      let parsedBody = null;
      if (body) {
        try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
      }
      state.requests.push({
        method: req.method,
        url: req.url,
        token,
        body: parsedBody,
      });

      if (req.url !== "/api/feedback/calibration/handwavy-phrases") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "GET") {
        if (state.requireToken && token !== state.requireToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ phrases: state.phrases }));
        return;
      }

      if (req.method === "DELETE") {
        const next = state.deleteResponses.shift();
        if (!next) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no scripted response" }));
          return;
        }
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next.body ?? {}));
        return;
      }

      res.writeHead(405).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  resetState();
});

function runScript(args, { stdin, env } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, "--api-url", baseUrl, ...args],
      {
        env: { ...process.env, NO_COLOR: "1", ...(env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function entry(phrase, extra = {}) {
  return {
    phrase,
    category: "hedge",
    addedBy: "alice@example.com",
    addedAt: "2026-01-01T00:00:00Z",
    rationale: "test entry",
    ...extra,
  };
}

describe("remove-handwavy-phrase CLI", () => {
  it("removes found phrases and reports missing ones (mixed batch)", async () => {
    state.phrases = [entry("as far as i can tell"), entry("more or less")];
    state.deleteResponses = [
      {
        status: 200,
        body: {
          ok: true,
          batch: true,
          total: 1,
          results: [
            { raw: "As Far As I Can Tell", phrase: "as far as i can tell", removed: true },
          ],
          phrases: [],
        },
      },
    ];

    const res = await runScript([
      "--phrase", "As Far As I Can Tell",
      "--phrase", "never seen this",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    // Found phrase goes to the server in a batch body; the not-found
    // phrase is never sent (filtered at lookup time).
    expect(deletes[0].body.phrases).toEqual(["As Far As I Can Tell"]);
    expect(res.stdout).toMatch(/removed.*"as far as i can tell"/);
    expect(res.stdout).toMatch(/not-found.*"never seen this"/);
  });

  it("reads phrases from --phrases-file, ignoring comments and dedup'ing", async () => {
    state.phrases = [entry("alpha"), entry("beta")];
    state.deleteResponses = [
      {
        status: 200,
        body: {
          ok: true,
          batch: true,
          total: 0,
          results: [
            { raw: "alpha", phrase: "alpha", removed: true },
            { raw: "  beta  ", phrase: "beta", removed: true },
          ],
          phrases: [],
        },
      },
    ];

    const dir = mkdtempSync(join(tmpdir(), "rmhwp-"));
    const filePath = join(dir, "phrases.txt");
    writeFileSync(
      filePath,
      [
        "# this is a comment",
        "",
        "alpha",
        "  beta  ",
        "ALPHA", // duplicate after normalization
        "# trailing comment",
        "",
      ].join("\n"),
    );

    try {
      const res = await runScript(["--phrases-file", filePath, "--yes"]);
      expect(res.code).toBe(0);
      const deletes = state.requests.filter((r) => r.method === "DELETE");
      // One batch DELETE for both unique phrases.
      expect(deletes).toHaveLength(1);
      const sent = deletes[0].body.phrases;
      expect(sent).toContain("alpha");
      expect(sent.some((p) => p.trim().toLowerCase() === "beta")).toBe(true);
      // The duplicate-after-normalization "ALPHA" was deduped client-side.
      expect(sent).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when none of the requested phrases are in the active list", async () => {
    state.phrases = [entry("something else")];
    const res = await runScript([
      "--phrase", "ghost one",
      "--phrase", "ghost two",
      "--yes",
    ]);
    expect(res.code).toBe(1);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(0);
    expect(res.stderr).toMatch(/None of the requested phrases/);
  });

  it("short-circuits remaining DELETEs after a 401 on the first removal", async () => {
    state.phrases = [entry("one"), entry("two"), entry("three")];
    state.deleteResponses = [
      { status: 401, body: { error: "bad token" } },
      // No further responses should be needed; if the script issues more
      // DELETEs the stub returns 500 and the assertions below will catch it.
    ];

    const res = await runScript([
      "--phrase", "one",
      "--phrase", "two",
      "--phrase", "three",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    // One batch DELETE for all three; 401 fails the whole batch at once.
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body.phrases).toEqual(["one", "two", "three"]);
    expect(res.stdout).toMatch(/auth-failed.*"one"/);
    expect(res.stdout).toMatch(/auth-failed.*"two"/);
    expect(res.stdout).toMatch(/auth-failed.*"three"/);
    expect(res.stderr).toMatch(/rejected as unauthorized/);
  });

  it("--yes skips the interactive prompt", async () => {
    state.phrases = [entry("hello world")];
    state.deleteResponses = [
      {
        status: 200,
        body: {
          ok: true,
          batch: true,
          total: 0,
          results: [
            { raw: "hello world", phrase: "hello world", removed: true },
          ],
          phrases: [],
        },
      },
    ];

    const res = await runScript(["--phrase", "hello world", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/\[y\/N\]/);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
  });

  // Task #145 — `--dry-run` must send a single DELETE with `dryRun: true`
  // and forward the FULL submitted phrase list (duplicates and original
  // order preserved) so the server-side preview can surface
  // duplicate-in-batch outcomes for the reviewer.
  it("--dry-run preserves duplicates and original order in the request payload", async () => {
    state.phrases = [entry("alpha"), entry("beta")];
    state.deleteResponses = [
      {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          batch: true,
          wouldRemove: 2,
          notFound: 1,
          duplicateInBatch: 1,
          total: 2,
          projectedTotal: 0,
          results: [
            { raw: "alpha", phrase: "alpha", removed: true },
            { raw: "beta", phrase: "beta", removed: true },
            { raw: "Alpha", phrase: "alpha", removed: false, reason: "duplicate-in-batch" },
            { raw: "ghost", phrase: "ghost", removed: false, reason: "not-found" },
          ],
          dryRunImpact: {
            corpus: {
              total: 0,
              byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
              validDetectionsLost: 0,
              falsePositivesDropped: 0,
              corpusSize: 12,
              sampleMatches: [],
              warning: null,
            },
            production: null,
            productionError: null,
            productionLimit: 2000,
          },
          phrases: [],
        },
      },
    ];

    const res = await runScript([
      "--phrase", "alpha",
      "--phrase", "beta",
      "--phrase", "Alpha", // duplicate after normalization
      "--phrase", "ghost", // not on active list
      "--dry-run",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    // Exactly one DELETE for the whole batch.
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body.dryRun).toBe(true);
    // The full submitted list reaches the server in the original order
    // and WITH the duplicate retained.
    expect(deletes[0].body.phrases).toEqual(["alpha", "beta", "Alpha", "ghost"]);
    // Reviewer-facing summary includes the requested count and the
    // duplicate-in-batch tally.
    expect(res.stdout).toMatch(/Requested:\s+4/);
    expect(res.stdout).toMatch(/Duplicate-in-batch:\s+1/);
    expect(res.stdout).toMatch(/Would remove:\s+2/);
    expect(res.stdout).toMatch(/Not on active list:\s+1/);
    // No mention of any mutation having taken place.
    expect(res.stdout).toMatch(/no changes were made/i);
  });

  it("declining at the prompt aborts without issuing any DELETE", async () => {
    state.phrases = [entry("hello world")];

    const res = await runScript(["--phrase", "hello world"], { stdin: "n\n" });
    expect(res.code).toBe(1);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(0);
    expect(res.stdout).toMatch(/Aborted/);
  });
});
