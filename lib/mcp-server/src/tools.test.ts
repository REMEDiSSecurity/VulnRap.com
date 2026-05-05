// Smoke + input-validation tests for the public VulnRap MCP server.
// These tests intentionally do *not* hit the network: every test stubs
// `globalThis.fetch` so the suite stays deterministic and runnable in
// any environment (CI, sandboxes, offline laptops).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TOOLS,
  scoreReport,
  lookupReport,
  queryStats,
  queryGallery,
  getCohortBaseline,
  testYourself,
  ScoreReportInput,
  LookupReportInput,
  GetCohortBaselineInput,
  TestYourselfInput,
  percentileRankFromBins,
  getToolByName,
} from "./tools.js";

interface FetchCall {
  url: URL;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  process.env["VULNRAP_API_BASE_URL"] = "https://example.test";
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    calls.push({
      url: new URL(typeof input === "string" ? input : input.toString()),
      init,
    });
    const text =
      typeof nextResponse.body === "string"
        ? nextResponse.body
        : JSON.stringify(nextResponse.body);
    return new Response(text, {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["VULNRAP_API_BASE_URL"];
});

describe("tool registry", () => {
  it("exposes the eleven documented tools", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "score_report",
        "lookup_report",
        "query_stats",
        "query_transparency",
        "query_gallery",
        "get_drift_summary",
        "query_signal_metrics",
        "get_cohort_baseline",
        "find_similar",
        "redact",
        "test_yourself",
      ].sort(),
    );
  });

  it("every tool has a description and a zod input schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.inputSchema.safeParse).toBe("function");
    }
  });

  it("getToolByName returns the right entry", () => {
    expect(getToolByName("score_report")?.handler).toBeDefined();
    expect(getToolByName("does-not-exist")).toBeUndefined();
  });
});

describe("score_report input validation", () => {
  it("rejects calls with neither text nor reportUrl", () => {
    const r = ScoreReportInput.safeParse({});
    expect(r.success).toBe(false);
  });

  it("accepts text only", () => {
    const r = ScoreReportInput.safeParse({ text: "Found a path traversal..." });
    expect(r.success).toBe(true);
  });

  it("accepts reportUrl only and rejects bad URLs", () => {
    expect(
      ScoreReportInput.safeParse({ reportUrl: "https://gist.example/x" })
        .success,
    ).toBe(true);
    expect(ScoreReportInput.safeParse({ reportUrl: "not a url" }).success).toBe(
      false,
    );
  });
});

describe("score_report dispatch", () => {
  it("POSTs multipart form to /api/reports/check with rawText", async () => {
    nextResponse = { status: 200, body: { slopScore: 12 } };
    const out = await scoreReport({ text: "report body", skipLlm: true });
    expect(out).toEqual({ slopScore: 12 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/api/reports/check");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBeInstanceOf(FormData);
    const fd = calls[0].init!.body as FormData;
    expect(fd.get("rawText")).toBe("report body");
    expect(fd.get("skipLlm")).toBe("true");
    expect(fd.has("reportUrl")).toBe(false);
  });
});

describe("lookup_report", () => {
  it("coerces string ids via api-zod's GetReportParams", () => {
    const r = LookupReportInput.safeParse({ id: "42" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.id).toBe(42);
  });

  it("hits GET /api/reports/{id}", async () => {
    nextResponse = { status: 200, body: { id: 42 } };
    await lookupReport({ id: 42 });
    expect(calls[0].url.pathname).toBe("/api/reports/42");
    expect(calls[0].init?.method ?? "GET").toBe("GET");
  });
});

describe("query_stats", () => {
  it("calls /api/stats", async () => {
    nextResponse = { status: 200, body: { totalReports: 5 } };
    const out = await queryStats({});
    expect(calls[0].url.pathname).toBe("/api/stats");
    expect(out).toEqual({ totalReports: 5 });
  });
});

describe("query_gallery", () => {
  it("forwards limit/offset/sort/tier to /api/reports/feed", async () => {
    nextResponse = { status: 200, body: { reports: [] } };
    await queryGallery({
      limit: 5,
      offset: 10,
      sort: "score_desc",
      tier: "AUTO_CLOSE",
    });
    const u = calls[0].url;
    expect(u.pathname).toBe("/api/reports/feed");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("offset")).toBe("10");
    expect(u.searchParams.get("sort")).toBe("score_desc");
    expect(u.searchParams.get("tier")).toBe("AUTO_CLOSE");
  });
});

describe("get_cohort_baseline", () => {
  it("validates score range", () => {
    expect(GetCohortBaselineInput.safeParse({ score: -1 }).success).toBe(false);
    expect(GetCohortBaselineInput.safeParse({ score: 101 }).success).toBe(
      false,
    );
    expect(GetCohortBaselineInput.safeParse({ score: 50 }).success).toBe(true);
    expect(GetCohortBaselineInput.safeParse({}).success).toBe(true);
  });

  it("derives percentile rank from the histogram when score is supplied", async () => {
    const bins = [
      { min: 0, max: 10, count: 10 },
      { min: 10, max: 20, count: 10 },
      { min: 20, max: 30, count: 10 },
      { min: 30, max: 40, count: 10 },
      { min: 40, max: 50, count: 10 },
      { min: 50, max: 60, count: 10 },
      { min: 60, max: 70, count: 10 },
      { min: 70, max: 80, count: 10 },
      { min: 80, max: 90, count: 10 },
      { min: 90, max: 100, count: 10 },
    ];
    nextResponse = {
      status: 200,
      body: { bins, totalReports: 100, median: 50 },
    };
    const out = (await getCohortBaseline({ score: 75 })) as {
      percentileRank: number;
      queriedScore: number;
      median: number;
    };
    expect(out.queriedScore).toBe(75);
    // 70 reports below the matched bin + half of that bin (5) = 75 / 100 = 75
    expect(out.percentileRank).toBe(75);
  });

  it("returns the raw payload unchanged when no score is supplied", async () => {
    nextResponse = {
      status: 200,
      body: { bins: [], totalReports: 0, median: null },
    };
    const out = await getCohortBaseline({});
    expect(out).toEqual({ bins: [], totalReports: 0, median: null });
  });

  it("forwards cwe filter as query param", async () => {
    nextResponse = { status: 200, body: {} };
    await getCohortBaseline({ cwe: "INJECTION" });
    expect(calls[0].url.searchParams.get("cwe")).toBe("INJECTION");
  });
});

describe("percentileRankFromBins helper", () => {
  it("returns 0 for empty cohorts", () => {
    expect(percentileRankFromBins(50, [], 0)).toBe(0);
  });

  it("clamps below the first bin and above the last", () => {
    const bins = [
      { min: 30, max: 40, count: 5 },
      { min: 40, max: 50, count: 5 },
    ];
    expect(percentileRankFromBins(0, bins, 10)).toBe(0);
    expect(percentileRankFromBins(99, bins, 10)).toBe(100);
  });
});

describe("test_yourself", () => {
  it("clamps runs to 1..10", () => {
    expect(TestYourselfInput.safeParse({ runs: 0 }).success).toBe(false);
    expect(TestYourselfInput.safeParse({ runs: 11 }).success).toBe(false);
    expect(TestYourselfInput.safeParse({ runs: 5 }).success).toBe(true);
  });

  it("issues a GET to /api/test/run with withLlm/runs", async () => {
    nextResponse = { status: 200, body: { results: [] } };
    await testYourself({ withLlm: true, runs: 3 });
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(calls[0].url.pathname).toBe("/api/test/run");
    expect(calls[0].url.searchParams.get("withLlm")).toBe("1");
    expect(calls[0].url.searchParams.get("runs")).toBe("3");
  });

  it("omits withLlm/runs when not supplied", async () => {
    nextResponse = { status: 200, body: { results: [] } };
    await testYourself({});
    expect(calls[0].url.searchParams.has("withLlm")).toBe(false);
    expect(calls[0].url.searchParams.has("runs")).toBe(false);
  });
});

describe("error surface", () => {
  it("propagates non-2xx as HttpError with body text", async () => {
    nextResponse = { status: 404, body: { error: "not found" } };
    await expect(lookupReport({ id: 9999 })).rejects.toThrow(/404/);
  });
});
