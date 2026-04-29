import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "..", "reinstate-handwavy-phrase-batch.mjs");

let server;
let baseUrl;
let state;

function resetState() {
  state = {
    postResponses: [],
    getResponses: [],
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

      // Task #160 — CLI picker hits the new GET endpoint to populate the menu.
      if (
        req.method === "GET" &&
        req.url.startsWith("/api/feedback/calibration/handwavy-phrases/removal-batches")
      ) {
        if (state.requireToken && token !== state.requireToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const next = state.getResponses.shift();
        if (!next) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no scripted GET response" }));
          return;
        }
        res.writeHead(next.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(next.body ?? {}));
        return;
      }

      if (req.url !== "/api/feedback/calibration/handwavy-phrases/reinstate-batch") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method === "POST") {
        if (state.requireToken && token !== state.requireToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const next = state.postResponses.shift();
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

describe("reinstate-handwavy-phrase-batch CLI", () => {
  it("reinstates a whole batch in one round-trip and renders per-phrase outcomes", async () => {
    state.postResponses = [
      {
        status: 200,
        body: {
          reinstated: true,
          batch: true,
          removedAt: "2026-04-22T12:34:56.000Z",
          reinstatedCount: 2,
          skipped: 1,
          total: 17,
          results: [
            { phrase: "rb a", reinstated: true },
            { phrase: "rb b", reinstated: true },
            { phrase: "rb c", reinstated: false, reason: "already-reinstated" },
          ],
          historyEntry: { removedAt: "2026-04-22T12:34:56.000Z", reinstated: true, phrases: [] },
          phrases: [],
          history: [],
        },
      },
    ];

    const res = await runScript([
      "--removed-at", "2026-04-22T12:34:56.000Z",
      "--reviewer", "carol@team.com",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      removedAt: "2026-04-22T12:34:56.000Z",
      reviewer: "carol@team.com",
    });
    expect(res.stdout).toMatch(/Reinstated:\s+2/);
    expect(res.stdout).toMatch(/Skipped:\s+1/);
    expect(res.stdout).toMatch(/Active list size now:\s+17/);
    expect(res.stdout).toMatch(/reinstated         "rb a"/);
    expect(res.stdout).toMatch(/reinstated         "rb b"/);
    expect(res.stdout).toMatch(/already-reinstated "rb c"/);
  });

  it("succeeds (exit 0) even when every inner phrase was already reinstated/active", async () => {
    state.postResponses = [
      {
        status: 200,
        body: {
          reinstated: true,
          batch: true,
          removedAt: "2026-04-22T01:02:03.000Z",
          reinstatedCount: 0,
          skipped: 2,
          total: 12,
          results: [
            { phrase: "rb skip a", reinstated: false, reason: "already-reinstated" },
            { phrase: "rb skip b", reinstated: false, reason: "already-active" },
          ],
          historyEntry: { removedAt: "2026-04-22T01:02:03.000Z", reinstated: true, phrases: [] },
          phrases: [],
          history: [],
        },
      },
    ];

    const res = await runScript(["--removed-at", "2026-04-22T01:02:03.000Z", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Reinstated:\s+0/);
    expect(res.stdout).toMatch(/Skipped:\s+2/);
    expect(res.stdout).toMatch(/already-reinstated "rb skip a"/);
    expect(res.stdout).toMatch(/already-active     "rb skip b"/);
  });

  it("exits 1 with a clear message when --removed-at does not match any history entry (404)", async () => {
    state.postResponses = [
      { status: 404, body: { error: "No matching removal-history entry found for that removedAt.", reason: "history-not-found" } },
    ];
    const res = await runScript(["--removed-at", "2099-01-01T00:00:00.000Z", "--yes"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/No matching removal-history entry/);
    expect(res.stderr).toMatch(/no removal-history entry matched/);
  });

  it("exits 1 with a clear message when the matched entry is not a batch (409)", async () => {
    state.postResponses = [
      { status: 409, body: { error: "That history entry is not a batch removal — use /reinstate for single-phrase entries.", reason: "not-a-batch" } },
    ];
    const res = await runScript(["--removed-at", "2026-01-01T00:00:00.000Z", "--yes"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not a batch removal/);
    expect(res.stderr).toMatch(/use the per-phrase \/reinstate endpoint/);
  });

  it("exits 1 when the calibration token is rejected (401)", async () => {
    state.postResponses = [{ status: 401, body: { error: "unauthorized" } }];
    const res = await runScript(["--removed-at", "2026-01-01T00:00:00.000Z", "--yes"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/rejected as unauthorized/);
  });

  it("exits 2 when --removed-at is missing", async () => {
    const res = await runScript(["--yes"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/--removed-at/);
  });

  it("declining at the prompt aborts without issuing the POST", async () => {
    const res = await runScript(["--removed-at", "2026-04-22T12:34:56.000Z"], { stdin: "n\n" });
    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(0);
    expect(res.stdout).toMatch(/Aborted/);
  });

  // Task #160 — interactive picker so reviewers don't have to copy/paste an
  // ISO removedAt from the calibration UI.
  describe("--pick interactive batch picker", () => {
    it("lists recent batches, picks one by number, and POSTs to its removedAt", async () => {
      state.getResponses = [
        {
          status: 200,
          body: {
            limit: 10,
            totalBatches: 2,
            batches: [
              {
                removedAt: "2026-04-22T12:34:56.000Z",
                removedBy: "alice@team.com",
                phraseCount: 3,
                reinstated: false,
                samplePhrases: ["pick a", "pick b", "pick c"],
              },
              {
                removedAt: "2026-04-20T10:00:00.000Z",
                removedBy: "bob@team.com",
                phraseCount: 1,
                reinstated: true,
                samplePhrases: ["pick old"],
              },
            ],
          },
        },
      ];
      state.postResponses = [
        {
          status: 201,
          body: {
            reinstated: true,
            batch: true,
            removedAt: "2026-04-22T12:34:56.000Z",
            reinstatedCount: 3,
            skipped: 0,
            total: 9,
            results: [
              { phrase: "pick a", reinstated: true },
              { phrase: "pick b", reinstated: true },
              { phrase: "pick c", reinstated: true },
            ],
            historyEntry: { removedAt: "2026-04-22T12:34:56.000Z", reinstated: true, phrases: [] },
            phrases: [],
            history: [],
          },
        },
      ];

      // Pick batch #1 from the menu; --yes skips the secondary confirmation
      // prompt so the picker → POST flow can be exercised end-to-end with a
      // single line of stdin.
      const res = await runScript(["--pick", "--reviewer", "carol@team.com", "--yes"], {
        stdin: "1\n",
      });
      expect(res.code).toBe(0);
      const gets = state.requests.filter((r) => r.method === "GET");
      const posts = state.requests.filter((r) => r.method === "POST");
      expect(gets).toHaveLength(1);
      expect(gets[0].url).toMatch(/\/removal-batches/);
      expect(posts).toHaveLength(1);
      expect(posts[0].body).toEqual({
        removedAt: "2026-04-22T12:34:56.000Z",
        reviewer: "carol@team.com",
      });
      // Menu is rendered with the timestamps, reviewer, count, and reinstated tag.
      expect(res.stdout).toMatch(/Recent batch removals/);
      expect(res.stdout).toMatch(/2026-04-22T12:34:56\.000Z/);
      expect(res.stdout).toMatch(/alice@team\.com/);
      expect(res.stdout).toMatch(/3 phrases/);
      expect(res.stdout).toMatch(/already reinstated/);
      expect(res.stdout).toMatch(/Reinstated:\s+3/);
    });

    it("forwards --limit as a query string parameter", async () => {
      state.getResponses = [
        {
          status: 200,
          body: {
            limit: 3,
            totalBatches: 1,
            batches: [
              {
                removedAt: "2026-04-22T12:34:56.000Z",
                phraseCount: 1,
                reinstated: false,
                samplePhrases: ["only one"],
              },
            ],
          },
        },
      ];
      state.postResponses = [
        {
          status: 201,
          body: {
            reinstated: true, batch: true, removedAt: "2026-04-22T12:34:56.000Z",
            reinstatedCount: 1, skipped: 0, total: 5,
            results: [{ phrase: "only one", reinstated: true }],
            historyEntry: { removedAt: "2026-04-22T12:34:56.000Z", reinstated: true, phrases: [] },
            phrases: [], history: [],
          },
        },
      ];
      const res = await runScript(["--pick", "--limit", "3", "--yes"], { stdin: "1\n" });
      expect(res.code).toBe(0);
      const gets = state.requests.filter((r) => r.method === "GET");
      expect(gets).toHaveLength(1);
      expect(gets[0].url).toBe("/api/feedback/calibration/handwavy-phrases/removal-batches?limit=3");
    });

    it("aborts cleanly when the picker prompt is answered with q (no POST issued)", async () => {
      state.getResponses = [
        {
          status: 200,
          body: {
            limit: 10,
            totalBatches: 1,
            batches: [
              {
                removedAt: "2026-04-22T12:34:56.000Z",
                phraseCount: 2,
                reinstated: false,
                samplePhrases: ["x", "y"],
              },
            ],
          },
        },
      ];
      const res = await runScript(["--pick"], { stdin: "q\n" });
      expect(res.code).toBe(1);
      expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(res.stdout).toMatch(/Aborted/);
    });

    it("exits 1 with a clear message when the picker returns no batches", async () => {
      state.getResponses = [
        { status: 200, body: { limit: 10, totalBatches: 0, batches: [] } },
      ];
      const res = await runScript(["--pick"]);
      expect(res.code).toBe(1);
      expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(res.stdout).toMatch(/No batch removals found/);
    });

    it("exits 1 with a clear error when the picker selection is out of range", async () => {
      state.getResponses = [
        {
          status: 200,
          body: {
            limit: 10,
            totalBatches: 1,
            batches: [
              {
                removedAt: "2026-04-22T12:34:56.000Z",
                phraseCount: 1,
                reinstated: false,
                samplePhrases: ["only"],
              },
            ],
          },
        },
      ];
      const res = await runScript(["--pick"], { stdin: "5\n" });
      expect(res.code).toBe(1);
      expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(res.stderr).toMatch(/Invalid selection/);
    });

    it("non-TTY invocation without --removed-at AND without --pick still errors out (no surprise prompt)", async () => {
      // The test harness pipes stdin (so isTTY is false). Without --pick or
      // --removed-at the script must exit 2 with the existing message and
      // must NOT issue any HTTP request — auto-engagement of the picker is
      // gated on TTY so cron jobs/scripts don't silently start prompting.
      const res = await runScript([]);
      expect(res.code).toBe(2);
      expect(state.requests).toHaveLength(0);
      expect(res.stderr).toMatch(/--removed-at/);
    });

    it("explicit --pick is still allowed in non-TTY contexts (scripted usage)", async () => {
      // Locks the documented contract: auto-engagement is TTY-only, but
      // when an operator explicitly opts in with --pick (e.g. piping a
      // selection from a wrapper script: `echo 1 | ... --pick --yes`) the
      // picker must run regardless of TTY status.
      state.getResponses = [
        {
          status: 200,
          body: {
            limit: 10,
            totalBatches: 1,
            batches: [
              {
                removedAt: "2026-04-22T12:34:56.000Z",
                phraseCount: 2,
                reinstated: false,
                samplePhrases: ["scripted a", "scripted b"],
              },
            ],
          },
        },
      ];
      state.postResponses = [
        {
          status: 201,
          body: {
            reinstated: true, batch: true, removedAt: "2026-04-22T12:34:56.000Z",
            reinstatedCount: 2, skipped: 0, total: 4,
            results: [
              { phrase: "scripted a", reinstated: true },
              { phrase: "scripted b", reinstated: true },
            ],
            historyEntry: { removedAt: "2026-04-22T12:34:56.000Z", reinstated: true, phrases: [] },
            phrases: [], history: [],
          },
        },
      ];
      const res = await runScript(["--pick", "--yes"], { stdin: "1\n" });
      expect(res.code).toBe(0);
      const posts = state.requests.filter((r) => r.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0].body.removedAt).toBe("2026-04-22T12:34:56.000Z");
    });

    it("rejects non-positive --limit with exit code 2 before hitting the network", async () => {
      const res = await runScript(["--pick", "--limit", "0"], { stdin: "1\ny\n" });
      expect(res.code).toBe(2);
      expect(state.requests).toHaveLength(0);
      expect(res.stderr).toMatch(/--limit must be a positive integer/);
    });

    it("propagates a 401 from the picker GET as an unauthorized message", async () => {
      state.getResponses = [{ status: 401, body: { error: "unauthorized" } }];
      const res = await runScript(["--pick"], { stdin: "1\ny\n" });
      expect(res.code).toBe(1);
      expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      expect(res.stderr).toMatch(/rejected as unauthorized/);
    });
  });

  it("--yes skips the interactive prompt", async () => {
    state.postResponses = [
      {
        status: 200,
        body: {
          reinstated: true, batch: true, removedAt: "2026-04-22T12:34:56.000Z",
          reinstatedCount: 1, skipped: 0, total: 5,
          results: [{ phrase: "rb only", reinstated: true }],
          historyEntry: { removedAt: "2026-04-22T12:34:56.000Z", reinstated: true, phrases: [] },
          phrases: [], history: [],
        },
      },
    ];
    const res = await runScript(["--removed-at", "2026-04-22T12:34:56.000Z", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/\[y\/N\]/);
  });

  // Task #159 — --dry-run sends `dryRun: true`, never prompts, prints the
  // preview header, and exits 0 on a successful preview without mutating
  // anything server-side.
  it("--dry-run sends dryRun:true, skips the prompt, and prints a preview", async () => {
    state.postResponses = [
      {
        status: 200,
        body: {
          dryRun: true,
          batch: true,
          removedAt: "2026-04-22T12:34:56.000Z",
          reinstatedCount: 2,
          skipped: 1,
          total: 9,
          results: [
            { phrase: "rb dry a", reinstated: true },
            { phrase: "rb dry b", reinstated: true },
            { phrase: "rb dry c", reinstated: false, reason: "already-reinstated" },
          ],
          historyEntry: {
            removedAt: "2026-04-22T12:34:56.000Z",
            reinstated: false,
            phrases: [],
          },
          phrases: [],
          history: [],
        },
      },
    ];

    const res = await runScript([
      "--removed-at", "2026-04-22T12:34:56.000Z",
      "--dry-run",
    ]);
    expect(res.code).toBe(0);

    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      removedAt: "2026-04-22T12:34:56.000Z",
      dryRun: true,
    });

    // No interactive confirm prompt was rendered.
    expect(res.stdout).not.toMatch(/\[y\/N\]/);
    // Preview-mode wording (not the mutating "Reinstated:" / "Active list size now:" text).
    expect(res.stdout).toMatch(/Batch reinstate preview/);
    expect(res.stdout).toMatch(/Would reinstate:\s+2/);
    expect(res.stdout).toMatch(/Would skip:\s+1/);
    expect(res.stdout).toMatch(/Projected active total:\s+9/);
    expect(res.stdout).toMatch(/\(dry-run — no changes were made\)/);
    // Per-phrase rendering uses the dry-run verb.
    expect(res.stdout).toMatch(/would reinstate.*"rb dry a"/);
    expect(res.stdout).toMatch(/already-reinstated.*"rb dry c"/);
  });
});
