import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, "..", "preview-handwavy-phrase.mjs");

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

      if (req.url !== "/api/feedback/calibration/handwavy-phrases") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

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
      res.writeHead(next.status, {
        "Content-Type": next.contentType ?? "application/json",
      });
      if (next.raw !== undefined) {
        res.end(next.raw);
      } else {
        res.end(JSON.stringify(next.body ?? {}));
      }
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

function previewBody({
  phrase = "as far as i can tell",
  category = "absence",
  matches = {},
  overlaps = null,
} = {}) {
  return {
    phrase,
    category,
    dryRun: true,
    dryRunMatches: {
      total: 0,
      falsePositives: 0,
      corpusSize: 12,
      byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
      sampleMatches: [],
      warning: null,
      ...matches,
    },
    dryRunOverlaps: overlaps,
  };
}

describe("preview-handwavy-phrase CLI", () => {
  it("previews a fresh phrase, then confirms and persists it", async () => {
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          matches: {
            total: 2,
            falsePositives: 0,
            byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 1, t4Hallucinated: 1 },
            sampleMatches: [
              { id: "fixture-1", tier: "t3Slop" },
              { id: "fixture-2", tier: "t4Hallucinated" },
            ],
          },
        }),
      },
      {
        status: 200,
        body: {
          ok: true,
          added: true,
          phrase: "as far as i can tell",
          category: "absence",
          total: 7,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--category", "absence",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    const posts = state.requests.filter((r) => r.method === "POST");
    // Two POSTs: one dry-run preview, one real add.
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({
      phrase: "as far as i can tell",
      category: "absence",
      dryRun: true,
    });
    expect(posts[1].body).toMatchObject({
      phrase: "as far as i can tell",
      category: "absence",
    });
    expect(posts[1].body.dryRun).toBeUndefined();
    // Reviewer-facing preview surfaces the corpus impact and the success line.
    expect(res.stdout).toMatch(/Corpus impact for "as far as i can tell"/);
    expect(res.stdout).toMatch(/T3 slop/);
    expect(res.stdout).toMatch(/fixture-1/);
    expect(res.stdout).toMatch(/Added "as far as i can tell"/);
    expect(res.stdout).toMatch(/Active list size: 7/);
  });

  it("reports when the server says the phrase is already in the active list", async () => {
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          phrase: "more or less",
          matches: { total: 0, falsePositives: 0 },
        }),
      },
      {
        status: 200,
        body: {
          ok: true,
          added: false,
          phrase: "more or less",
          category: "absence",
          total: 5,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "more or less",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/already in the active list/);
    expect(res.stdout).toMatch(/total: 5/);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
  });

  it("exits 1 with a clear message when the preview POST returns 401", async () => {
    state.postResponses = [
      { status: 401, body: { error: "bad token" } },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    // Only the dry-run is sent; we never proceed to the real add.
    expect(posts).toHaveLength(1);
    expect(posts[0].body.dryRun).toBe(true);
    expect(res.stderr).toMatch(/rejected the request as unauthorized/);
  });

  it("exits 1 when the real add POST returns 401 even after the preview succeeded", async () => {
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          matches: { total: 1, falsePositives: 0, byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 1, t4Hallucinated: 0 } },
        }),
      },
      { status: 403, body: { error: "forbidden" } },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(res.stderr).toMatch(/Add failed.*unauthorized/);
  });

  it("forwards the reviewer token via X-Calibration-Token on both POSTs", async () => {
    state.requireToken = "secret-token";
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          matches: { total: 0, falsePositives: 0 },
        }),
      },
      {
        status: 200,
        body: {
          ok: true,
          added: true,
          phrase: "as far as i can tell",
          category: "absence",
          total: 4,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--token", "secret-token",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].token).toBe("secret-token");
    expect(posts[1].token).toBe("secret-token");
  });

  it("aborts without adding when the server response is missing the preview block", async () => {
    state.postResponses = [
      {
        status: 200,
        body: { ok: true, phrase: "as far as i can tell", category: "absence" },
      },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    // Only the dry-run is issued; the real add never fires because the
    // preview block was missing from the response.
    expect(posts).toHaveLength(1);
    expect(posts[0].body.dryRun).toBe(true);
    expect(res.stderr).toMatch(/Preview unavailable/);
    expect(res.stderr).toMatch(/Aborting without adding/);
  });

  it("aborts without adding when the server returns an empty body", async () => {
    state.postResponses = [
      { status: 200, raw: "" },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(res.stderr).toMatch(/Preview unavailable/);
  });

  it("aborts without adding when the server returns malformed (non-JSON) body", async () => {
    state.postResponses = [
      { status: 200, raw: "<html>not json</html>", contentType: "text/html" },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(res.stderr).toMatch(/Preview unavailable/);
  });

  it("surfaces an upstream error message when preview returns a non-2xx status", async () => {
    state.postResponses = [
      { status: 500, body: { error: "boom" } },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Preview failed: boom/);
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
  });

  it("declining at the interactive prompt aborts without persisting", async () => {
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          matches: { total: 0, falsePositives: 0 },
        }),
      },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
    ], { stdin: "n\n" });

    expect(res.code).toBe(1);
    const posts = state.requests.filter((r) => r.method === "POST");
    // Only the dry-run was sent; the real add was never issued.
    expect(posts).toHaveLength(1);
    expect(posts[0].body.dryRun).toBe(true);
    expect(res.stdout).toMatch(/Aborted/);
  });

  it("renders curated-overlap warnings from the preview response", async () => {
    state.postResponses = [
      {
        status: 200,
        body: previewBody({
          matches: { total: 0, falsePositives: 0 },
          overlaps: {
            total: 2,
            matches: [
              { phrase: "as far as i can tell", category: "absence", relation: "equal" },
              { phrase: "as far as", category: "absence", relation: "existing-contains-candidate" },
            ],
          },
        }),
      },
      {
        status: 200,
        body: {
          ok: true,
          added: true,
          phrase: "as far as i can tell",
          category: "absence",
          total: 8,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "as far as i can tell",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Overlaps with 2 existing curated entries/);
    expect(res.stdout).toMatch(/exact duplicate of "as far as i can tell"/);
    expect(res.stdout).toMatch(/already covered by "as far as"/);
  });
});
