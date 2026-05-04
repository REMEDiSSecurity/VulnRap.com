process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import {
  createInMemoryDb,
  drizzleOrmOverrides,
  makeHashesTableSpec,
  makeReportsTableSpec,
  makeSimilaritiesTableSpec,
  makeStatsTableSpec,
  resetBaseState,
  seedReport as seedReportShared,
  type BaseDbState,
  type FakeRow,
} from "../routes/__test-fixtures__/in-memory-db";
import type { AddressInfo } from "node:net";

interface DbState extends BaseDbState {}

const dbState: DbState = {
  reports: [],
  hashes: [],
  similarities: [],
  stats: new Map(),
  nextReportId: 1,
};
(globalThis as unknown as { __fakeDbState: DbState }).__fakeDbState = dbState;

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return { ...actual, ...drizzleOrmOverrides };
});

vi.mock("./active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
}));

vi.mock("./llm-slop", () => ({
  isLLMAvailable: () => false,
  shouldCallLLM: () => false,
  evaluateLlmGate: () => ({
    shouldCall: false,
    reason: "skipped_unavailable",
    heuristicScore: 0,
    confidence: 1,
    compositeScore: null,
    costGuard: { low: 25, high: 60, confidence: 0.5 },
  }),
  analyzeSlopWithLLM: vi.fn(async () => null),
}));

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  const state = (globalThis as unknown as { __fakeDbState: DbState })
    .__fakeDbState;
  const { db, pool } = createInMemoryDb({
    schema,
    transactionMode: "passthrough",
    tables: [
      makeReportsTableSpec(schema, state),
      makeHashesTableSpec(schema, state),
      makeSimilaritiesTableSpec(schema, state),
      makeStatsTableSpec(schema, state),
    ],
  });
  return { ...schema, db, pool };
});

const { createSpaFallback } = await import("./spa-fallback");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const realIndexHtml = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "vulnrap", "index.html"),
  "utf-8",
);

let tmpDir: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spa-fallback-test-"));
  fs.writeFileSync(path.join(tmpDir, "index.html"), realIndexHtml);

  const app = express();
  app.use(createSpaFallback(tmpDir));

  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetBaseState(dbState);
});

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  return seedReportShared(dbState, overrides);
}

describe("SPA fallback — HTTP-level OG meta injection", () => {
  it("GET /results/:id returns HTML with rewritten og:image pointing at the dynamic PNG endpoint", async () => {
    const report = seedReport({
      slopScore: 62,
      slopTier: "Likely Slop",
      showInFeed: true,
    });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    const ogImageMatch = html.match(
      /property="og:image"\s+content="([^"]*)"/,
    );
    expect(ogImageMatch).toBeTruthy();
    expect(ogImageMatch![1]).toContain(`/api/og/result/${report.id}.png`);
    expect(ogImageMatch![1]).toMatch(/^https?:\/\//);
  });

  it("GET /results/:id returns HTML with rewritten twitter:image pointing at the dynamic PNG endpoint", async () => {
    const report = seedReport({
      slopScore: 30,
      slopTier: "Suspicious",
      showInFeed: true,
    });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    const match = html.match(/name="twitter:image"\s+content="([^"]*)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain(`/api/og/result/${report.id}.png`);
    expect(match![1]).toMatch(/^https?:\/\//);
  });

  it("og:image:type is rewritten to image/png in the HTTP response", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 50 });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).not.toContain('property="og:image:type" content="image/jpeg"');
  });

  it("og:title in the HTTP response contains the report id and score", async () => {
    const report = seedReport({
      slopScore: 45,
      slopTier: "Questionable",
      showInFeed: true,
    });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    const match = html.match(/property="og:title"\s+content="([^"]*)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain(`VR-${report.id}`);
    expect(match![1]).toContain("45");
    expect(match![1]).toContain("Questionable");
  });

  it("og:url in the HTTP response is the canonical results page", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 10 });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    const match = html.match(/property="og:url"\s+content="([^"]*)"/);
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/^https?:\/\//);
    expect(match![1]).toContain(`/results/${report.id}`);
  });

  it("twitter:card remains summary_large_image in the HTTP response", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 10 });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("og:image dimensions are 1200×630 in the HTTP response", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 50 });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
  });

  it("hidden reports (showInFeed=false) get the static fallback OG tags", async () => {
    const report = seedReport({ showInFeed: false, slopScore: 99 });
    const res = await fetch(`${baseUrl}/results/${report.id}`);
    const html = await res.text();

    expect(html).toContain("opengraph.jpg");
    expect(html).not.toContain(`/api/og/result/${report.id}.png`);
  });

  it("non-existent reports get the static fallback OG tags", async () => {
    const res = await fetch(`${baseUrl}/results/999999`);
    const html = await res.text();

    expect(html).toContain("opengraph.jpg");
    expect(html).not.toContain("/api/og/result/999999.png");
  });

  it("non-results pages get the static fallback OG tags", async () => {
    const res = await fetch(`${baseUrl}/about`);
    const html = await res.text();

    expect(html).toContain("opengraph.jpg");
    expect(html).toContain("VulnRap");
  });
});
