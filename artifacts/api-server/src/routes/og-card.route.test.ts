// Task #666 — integration + unit tests for the dynamic OG card endpoint.
//
// Pure helpers (`buildOgSvg`, `buildOgEtag`) are exercised directly so the
// SVG composition + ETag stability are testable without booting Express
// or rendering PNG bytes. The HTTP-level tests boot the same in-memory db
// harness as reports.score-history.test.ts so we can assert on the real
// route — PNG mimetype, dimensions (decoded from the PNG IHDR), the 304
// path, the redirect-fallback for unknown / hidden reports, and the
// Cache-Control header.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

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
} from "./__test-fixtures__/in-memory-db";
import type { AddressInfo } from "node:net";
// NOTE: og-card transitively imports `@workspace/db`. ESM evaluates all
// `import` statements before any top-level code runs, so importing it
// statically at the top would trigger the `vi.mock("@workspace/db")`
// factory below *before* the `__fakeDbState` assignment on line ~40 had a
// chance to run, leaving the factory's `state` reference `undefined` and
// every db read in the integration tests would blow up. The dynamic
// import below runs after the assignment, fixing the ordering.

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

const appModule = await import("../app");
const app = appModule.default;
const { buildOgEtag, buildOgSvg } = await import("./og-card");

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

// PNG IHDR: bytes 16..24 hold width (BE u32) then height (BE u32). Pulled
// out so the dimension assertion is readable as a single line.
function pngDimensions(buf: Buffer): { width: number; height: number } {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

describe("buildOgSvg", () => {
  it("includes the score, tier, top signal, anonymized id and timestamp", () => {
    const svg = buildOgSvg({
      id: 42,
      slopScore: 62,
      slopTier: "Likely Slop",
      topSignal: "AI Phrase Detected: 'I am unable to assist'",
      createdAt: new Date("2026-04-01T12:34:56Z"),
    });
    expect(svg).toContain(">62<");
    expect(svg).toContain("Likely Slop");
    expect(svg).toContain("Top signal: AI Phrase Detected");
    expect(svg).toContain("VR-42");
    expect(svg).toContain("2026-04-01 12:34 UTC");
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it("escapes XML-significant characters in tier and signal text", () => {
    const svg = buildOgSvg({
      id: 1,
      slopScore: 10,
      slopTier: "<script>",
      topSignal: 'a & b "quoted"',
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
  });

  it("falls back to a 'No fired signals' line when evidence is empty", () => {
    const svg = buildOgSvg({
      id: 7,
      slopScore: 5,
      slopTier: "Clean",
      topSignal: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(svg).toContain("No fired signals");
  });
});

describe("buildOgEtag", () => {
  it("is stable for identical inputs", () => {
    const input = {
      id: 3,
      slopScore: 50,
      slopTier: "Questionable",
      topSignal: "x",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(buildOgEtag(input)).toBe(buildOgEtag(input));
  });

  it("changes when any input that affects rendering changes", () => {
    const base = {
      id: 3,
      slopScore: 50,
      slopTier: "Questionable",
      topSignal: "x",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const e0 = buildOgEtag(base);
    expect(buildOgEtag({ ...base, slopScore: 51 })).not.toBe(e0);
    expect(buildOgEtag({ ...base, slopTier: "Likely Slop" })).not.toBe(e0);
    expect(buildOgEtag({ ...base, topSignal: "y" })).not.toBe(e0);
    expect(buildOgEtag({ ...base, id: 4 })).not.toBe(e0);
  });
});

describe("GET /api/og/result/:id.png", () => {
  it("renders a 1200x630 PNG with the right mimetype, ETag and cache header", async () => {
    const report = seedReport({
      slopScore: 62,
      slopTier: "Likely Slop",
      evidence: [
        {
          type: "ai_phrase",
          description: "AI phrase: 'as a language model'",
          weight: 25,
        },
        {
          type: "placeholder_url",
          description: "Placeholder URL example.com",
          weight: 5,
        },
      ],
    });
    const res = await fetch(`${baseUrl}/api/og/result/${report.id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("etag")).toMatch(/^"og-[0-9a-f]+"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG signature (89 50 4E 47 0D 0A 1A 0A) — fail loudly if resvg
    // returned a non-PNG payload.
    expect(
      buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
    const { width, height } = pngDimensions(buf);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it("returns 304 when If-None-Match matches the current ETag", async () => {
    const report = seedReport({ slopScore: 30, slopTier: "Suspicious" });
    const first = await fetch(`${baseUrl}/api/og/result/${report.id}.png`);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(`${baseUrl}/api/og/result/${report.id}.png`, {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });

  it("redirects to the static OG image when the report does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/og/result/9999.png`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/opengraph.jpg");
  });

  it("redirects to the static OG image for hidden (showInFeed=false) reports", async () => {
    const report = seedReport({ showInFeed: false });
    const res = await fetch(`${baseUrl}/api/og/result/${report.id}.png`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/opengraph.jpg");
  });

  it("returns 404 for non-numeric ids (regex route doesn't match)", async () => {
    // The route's URL regex requires \d+ before .png, so a garbage id never
    // even hits the handler — Express returns its default 404 instead. We
    // assert on that here so future routing changes that accidentally widen
    // the match (and let `abc.png` reach the handler) get caught.
    const res = await fetch(`${baseUrl}/api/og/result/abc.png`, {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });
});
