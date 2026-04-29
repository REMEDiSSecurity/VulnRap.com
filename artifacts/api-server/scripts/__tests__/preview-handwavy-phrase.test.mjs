// Coverage for the preview-handwavy-phrase CLI. Two suites live here:
//
// 1. The original CLI behavior — dry-run preview rendering, confirmation
//    flow, auth/error paths, and rendering the server-side `dryRunOverlaps`
//    block returned with the dry-run response.
// 2. Task #129 — the *pre*-dry-run overlap warning the CLI now emits
//    BEFORE issuing the dry-run POST. The CLI hits
//    GET /api/feedback/calibration/handwavy-phrases first, runs the
//    same normalize + substring overlap detection locally, and surfaces
//    a one-line "Heads up" hint pointing at the colliding curated entry.
//    The dry-run still runs afterwards so reviewers also see the existing
//    GREEN/YELLOW corpus warnings.
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
    // Active curated list returned from the GET endpoint. Default empty
    // so legacy tests that don't care about pre-dry-run overlap detection
    // get a no-op (no "Heads up" line).
    phrases: [],
    // Scripted POST responses (consumed in order). Same field used by both
    // legacy tests and Task #129 tests so we don't fork response state.
    postResponses: [],
    requireToken: null,
    requests: [],
    // When true, the GET endpoint returns 500. Used to confirm the
    // pre-dry-run overlap check fails open and the dry-run still runs.
    failGet: false,
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
        if (state.failGet) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        if (state.requireToken && token !== state.requireToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ phrases: state.phrases }));
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

// Task #129 — pre-dry-run overlap hint coverage.
const EMPTY_DRY_RUN_BODY = {
  dryRun: true,
  added: false,
  phrase: "",
  category: "absence",
  total: 0,
  phrases: [],
  dryRunMatches: {
    total: 0,
    falsePositives: 0,
    corpusSize: 0,
    byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
    sampleMatches: [],
    warning: null,
  },
  dryRunMatchesProduction: null,
  dryRunMatchesProductionError: null,
  dryRunMatchesProductionLimit: 50,
  dryRunOverlaps: { total: 0, matches: [] },
};

function entry(phrase, category = "absence") {
  return { phrase, category };
}

describe("preview-handwavy-phrase CLI: pre-dry-run overlap hint (Task #129)", () => {
  it("warns about an exact-duplicate candidate before issuing the dry-run", async () => {
    state.phrases = [entry("as far as i can tell"), entry("more or less")];
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "as far as i can tell",
          dryRunOverlaps: {
            total: 1,
            matches: [
              { phrase: "as far as i can tell", category: "absence", relation: "equal" },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          added: false,
          phrase: "as far as i can tell",
          category: "absence",
          total: 2,
          phrases: state.phrases,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "As Far As I Can Tell",
      "--yes",
    ]);

    expect(res.code).toBe(0);
    // Pre-dry-run hint hits GET first.
    const gets = state.requests.filter((r) => r.method === "GET");
    expect(gets).toHaveLength(1);
    // Then dry-run + real add.
    const posts = state.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].body.dryRun).toBe(true);
    expect(posts[1].body.dryRun).toBeUndefined();
    // Heads up message rendered before the dry-run.
    expect(res.stdout).toMatch(/Heads up: this candidate already overlaps with 1 curated entry/);
    expect(res.stdout).toMatch(/exact duplicate of "as far as i can tell"/);
    // The "Heads up" line must appear ABOVE the dry-run "Previewing against"
    // line — that's the whole point of the early warning.
    const headsUpIdx = res.stdout.indexOf("Heads up:");
    const previewingIdx = res.stdout.indexOf("Previewing against");
    expect(headsUpIdx).toBeGreaterThanOrEqual(0);
    expect(previewingIdx).toBeGreaterThan(headsUpIdx);
  });

  it("warns when the candidate is broader than an existing curated entry", async () => {
    state.phrases = [entry("private poc")];
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "no private poc available",
          dryRunOverlaps: {
            total: 1,
            matches: [
              { phrase: "private poc", category: "absence", relation: "candidate-contains-existing" },
            ],
          },
        },
      },
      {
        status: 201,
        body: {
          added: true,
          phrase: "no private poc available",
          category: "absence",
          total: 2,
          phrases: [],
        },
      },
    ];

    const res = await runScript(["--phrase", "no private poc available", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Heads up: this candidate already overlaps/);
    expect(res.stdout).toMatch(/broader than \(would supersede\) "private poc"/);
  });

  it("warns when the candidate is already covered by a broader entry", async () => {
    state.phrases = [entry("no working proof-of-concept")];
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "working proof",
          dryRunOverlaps: {
            total: 1,
            matches: [
              { phrase: "no working proof-of-concept", category: "absence", relation: "existing-contains-candidate" },
            ],
          },
        },
      },
      {
        status: 201,
        body: {
          added: true,
          phrase: "working proof",
          category: "absence",
          total: 2,
          phrases: [],
        },
      },
    ];

    const res = await runScript(["--phrase", "working proof", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/already covered by "no working proof-of-concept"/);
  });

  it("does not emit the heads-up line when there are no overlaps", async () => {
    state.phrases = [entry("private poc")];
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "totally unrelated phrase",
        },
      },
      {
        status: 201,
        body: {
          added: true,
          phrase: "totally unrelated phrase",
          category: "absence",
          total: 2,
          phrases: [],
        },
      },
    ];

    const res = await runScript(["--phrase", "totally unrelated phrase", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toMatch(/Heads up:/);
  });

  it("falls back gracefully (no abort) when the active list GET fails", async () => {
    state.failGet = true;
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "anything",
        },
      },
      {
        status: 201,
        body: {
          added: true,
          phrase: "anything",
          category: "absence",
          total: 1,
          phrases: [],
        },
      },
    ];

    const res = await runScript(["--phrase", "anything", "--yes"]);
    expect(res.code).toBe(0);
    // The skip notice is printed, but the dry-run still runs and the
    // script exits 0.
    expect(res.stdout).toMatch(/Skipping pre-preview overlap check/);
    expect(res.stdout).toMatch(/Previewing against/);
  });

  it("forwards the calibration token on the GET as well as the POST", async () => {
    state.requireToken = "tok-abc";
    state.phrases = [entry("private poc")];
    state.postResponses = [
      {
        status: 200,
        body: {
          ...EMPTY_DRY_RUN_BODY,
          phrase: "private poc",
          dryRunOverlaps: {
            total: 1,
            matches: [
              { phrase: "private poc", category: "absence", relation: "equal" },
            ],
          },
        },
      },
      {
        status: 200,
        body: {
          added: false,
          phrase: "private poc",
          category: "absence",
          total: 1,
          phrases: state.phrases,
        },
      },
    ];

    const res = await runScript([
      "--phrase", "private poc",
      "--token", "tok-abc",
      "--yes",
    ]);
    expect(res.code).toBe(0);
    const gets = state.requests.filter((r) => r.method === "GET");
    expect(gets).toHaveLength(1);
    expect(gets[0].token).toBe("tok-abc");
    // Hint still emitted because the GET succeeded with the matching token.
    expect(res.stdout).toMatch(/Heads up:/);
  });
});
