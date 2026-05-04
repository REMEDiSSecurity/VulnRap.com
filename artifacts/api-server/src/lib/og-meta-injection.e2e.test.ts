process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
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

vi.mock("../lib/active-verification", () => ({
  performActiveVerification: vi.fn(async () => null),
}));

vi.mock("../lib/llm-slop", () => ({
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

const { buildOgMetaForReport } = await import("./og-meta-injection");
const { injectOgMeta } = await import("./og-meta-injection");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "vulnrap",
  "index.html",
);
const indexHtml = fs.readFileSync(indexHtmlPath, "utf-8");

const appModule = await import("../app");
const app = appModule.default;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetBaseState(dbState);
});

function seedReport(overrides: Partial<FakeRow> = {}): FakeRow {
  return seedReportShared(dbState, overrides);
}

const fakeReq = { protocol: "https", get: () => "vulnrap.com" };

describe("OG meta tag server-side injection — end-to-end validation", () => {
  it("buildOgMetaForReport returns absolute og:image URL for a visible report", async () => {
    const report = seedReport({
      slopScore: 62,
      slopTier: "Likely Slop",
      showInFeed: true,
    });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    expect(meta).toBeTruthy();
    expect(meta!.ogImage).toBe(
      `https://vulnrap.com/api/og/result/${report.id}.png`,
    );
    expect(meta!.twitterImage).toBe(
      `https://vulnrap.com/api/og/result/${report.id}.png`,
    );
    expect(meta!.ogUrl).toBe(`https://vulnrap.com/results/${report.id}`);
  });

  it("buildOgMetaForReport returns null for hidden reports", async () => {
    const report = seedReport({ showInFeed: false, slopScore: 99 });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    expect(meta).toBeNull();
  });

  it("buildOgMetaForReport returns null for non-existent reports", async () => {
    const meta = await buildOgMetaForReport(999999, fakeReq);
    expect(meta).toBeNull();
  });

  it("injecting into the real index.html produces valid og:image with absolute URL", async () => {
    const report = seedReport({
      slopScore: 62,
      slopTier: "Likely Slop",
      showInFeed: true,
    });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    expect(meta).toBeTruthy();

    const rewritten = injectOgMeta(indexHtml, meta!);

    const ogImageMatch = rewritten.match(
      /property="og:image"\s+content="([^"]*)"/,
    );
    expect(ogImageMatch).toBeTruthy();
    expect(ogImageMatch![1]).toBe(
      `https://vulnrap.com/api/og/result/${report.id}.png`,
    );
    expect(ogImageMatch![1]).toMatch(/^https:\/\//);
  });

  it("injecting into the real index.html produces valid twitter:image with absolute URL", async () => {
    const report = seedReport({
      slopScore: 30,
      slopTier: "Suspicious",
      showInFeed: true,
    });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    const match = rewritten.match(
      /name="twitter:image"\s+content="([^"]*)"/,
    );
    expect(match).toBeTruthy();
    expect(match![1]).toBe(
      `https://vulnrap.com/api/og/result/${report.id}.png`,
    );
    expect(match![1]).toMatch(/^https:\/\//);
  });

  it("og:image:type is rewritten from image/jpeg to image/png", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 50 });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    expect(rewritten).toContain(
      'property="og:image:type" content="image/png"',
    );
    expect(rewritten).not.toContain(
      'property="og:image:type" content="image/jpeg"',
    );
  });

  it("og:title is report-specific with id and score", async () => {
    const report = seedReport({
      slopScore: 45,
      slopTier: "Questionable",
      showInFeed: true,
    });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    const match = rewritten.match(
      /property="og:title"\s+content="([^"]*)"/,
    );
    expect(match).toBeTruthy();
    expect(match![1]).toContain(`VR-${report.id}`);
    expect(match![1]).toContain("45");
    expect(match![1]).toContain("Questionable");
  });

  it("og:url is the canonical results page URL", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 10 });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    const match = rewritten.match(
      /property="og:url"\s+content="([^"]*)"/,
    );
    expect(match).toBeTruthy();
    expect(match![1]).toBe(`https://vulnrap.com/results/${report.id}`);
  });

  it("twitter:card remains summary_large_image", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 10 });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    expect(rewritten).toContain(
      'name="twitter:card" content="summary_large_image"',
    );
  });

  it("the dynamic og:image URL resolves to a valid PNG via the OG card endpoint", async () => {
    const report = seedReport({
      slopScore: 62,
      slopTier: "Likely Slop",
      showInFeed: true,
      evidence: [
        {
          type: "ai_phrase",
          description: "AI phrase: 'as a language model'",
          weight: 25,
        },
      ],
    });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    expect(meta).toBeTruthy();

    const imgRes = await fetch(
      `${baseUrl}/api/og/result/${report.id}.png`,
    );
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get("content-type")).toBe("image/png");

    const buf = Buffer.from(await imgRes.arrayBuffer());
    expect(
      buf
        .subarray(0, 8)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ),
    ).toBe(true);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it("og:image dimensions match the OG card endpoint output (1200×630)", async () => {
    const report = seedReport({ showInFeed: true, slopScore: 50 });
    const meta = await buildOgMetaForReport(report.id, fakeReq);
    const rewritten = injectOgMeta(indexHtml, meta!);

    const widthMatch = rewritten.match(
      /property="og:image:width"\s+content="(\d+)"/,
    );
    const heightMatch = rewritten.match(
      /property="og:image:height"\s+content="(\d+)"/,
    );
    expect(widthMatch?.[1]).toBe("1200");
    expect(heightMatch?.[1]).toBe("630");
  });
});
