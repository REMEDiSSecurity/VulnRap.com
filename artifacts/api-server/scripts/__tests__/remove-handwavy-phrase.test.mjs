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
    state.deleteResponses = [{ status: 200, body: { ok: true, total: 1 } }];

    const res = await runScript([
      "--phrase", "As Far As I Can Tell",
      "--phrase", "never seen this",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({ phrase: "As Far As I Can Tell" });
    expect(res.stdout).toMatch(/removed.*"as far as i can tell"/);
    expect(res.stdout).toMatch(/not-found.*"never seen this"/);
  });

  it("reads phrases from --phrases-file, ignoring comments and dedup'ing", async () => {
    state.phrases = [entry("alpha"), entry("beta")];
    state.deleteResponses = [
      { status: 200, body: { ok: true, total: 1 } },
      { status: 200, body: { ok: true, total: 0 } },
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
      expect(deletes).toHaveLength(2);
      const sent = deletes.map((d) => d.body.phrase);
      expect(sent).toContain("alpha");
      expect(sent.some((p) => p.trim().toLowerCase() === "beta")).toBe(true);
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
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toEqual({ phrase: "one" });
    expect(res.stdout).toMatch(/auth-failed.*"one"/);
    expect(res.stdout).toMatch(/auth-failed.*"two".*skipped after earlier auth failure/);
    expect(res.stdout).toMatch(/auth-failed.*"three".*skipped after earlier auth failure/);
    expect(res.stderr).toMatch(/rejected as unauthorized/);
  });

  it("--yes skips the interactive prompt", async () => {
    state.phrases = [entry("hello world")];
    state.deleteResponses = [{ status: 200, body: { ok: true, total: 0 } }];

    const res = await runScript(["--phrase", "hello world", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/\[y\/N\]/);
    const deletes = state.requests.filter((r) => r.method === "DELETE");
    expect(deletes).toHaveLength(1);
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
