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
        status: 201,
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
        status: 201,
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

  it("--yes skips the interactive prompt", async () => {
    state.postResponses = [
      {
        status: 201,
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
});
