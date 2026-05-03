// Task #664 — tests for the embeddable score badge SVG endpoint.
//
// Covers:
//  - SVG validity + content-type for known reports
//  - Tier color tinting on the right half of the badge
//  - Unknown / malformed / hidden ids → "unknown" badge (still 200 OK)
//  - ETag round-trip → 304 on `If-None-Match`
//  - Cache-Control header is set so embedders can't hammer the API
//
// Mocks `@workspace/db` with a per-test FIFO of report rows the way the
// cohort + stats route tests do. Pure-string SVG construction means we
// can assert on the rendered text without an SVG parser.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseReportCode, renderBadge } from "./embed";

interface FakeRow {
  id: number;
  slopScore: number;
  slopTier: string;
  showInFeed: boolean;
  createdAt: Date;
}

const reportQueue: Array<FakeRow | null> = [];

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            const next = reportQueue.length > 0 ? reportQueue.shift() : null;
            return Promise.resolve(next ? [next] : []);
          },
        }),
      }),
    },
    reportsTable: schema.reportsTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const embedRouter = (await import("./embed")).default;
  const app = express();
  app.use(embedRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  reportQueue.length = 0;
});

interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function request(urlPath: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseReportCode", () => {
  it("accepts the canonical VR-XXXX hex format (case-insensitive)", () => {
    expect(parseReportCode("VR-002A")).toBe(0x2a);
    expect(parseReportCode("VR-002a")).toBe(0x2a);
    expect(parseReportCode("vr-002a")).toBe(null); // prefix is uppercase only
    expect(parseReportCode("VR-0001")).toBe(1);
    expect(parseReportCode("VR-FFFF")).toBe(0xffff);
  });

  it("rejects empty / malformed / non-hex / zero ids", () => {
    expect(parseReportCode("")).toBe(null);
    expect(parseReportCode("VR-")).toBe(null);
    expect(parseReportCode("VR-XYZQ")).toBe(null);
    expect(parseReportCode("VR-0000")).toBe(null); // ids start at 1
    expect(parseReportCode("VR-123456789")).toBe(null); // 9 hex chars > max 8
    expect(parseReportCode("foo")).toBe(null);
  });
});

describe("renderBadge", () => {
  it("produces a well-formed SVG with both label and message visible", () => {
    const svg = renderBadge({
      label: "vulnrap",
      message: "62 · slop",
      color: "#ef4444",
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("vulnrap");
    expect(svg).toContain("62 · slop");
    expect(svg).toContain("#ef4444");
  });

  it("escapes XML-significant characters in the message", () => {
    const svg = renderBadge({
      label: "vulnrap",
      message: '<script>"&\'',
      color: "#000",
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&apos;");
  });
});

describe("GET /embed/badge.svg", () => {
  it("returns a 200 SVG with the score, tier, and tier color for a known public report", async () => {
    reportQueue.push({
      id: 0x2a,
      slopScore: 62,
      slopTier: "Likely Slop",
      showInFeed: true,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    const r = await request("/embed/badge.svg?id=VR-002A");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(r.body).toContain("<svg");
    expect(r.body).toContain("</svg>");
    expect(r.body).toContain("vulnrap");
    expect(r.body).toContain("62 · likely slop");
    // Likely Slop tier color (orange).
    expect(r.body).toContain("#f59e0b");
  });

  it("renders an 'unknown' badge (still 200) for an unknown id", async () => {
    // No row queued → db returns []
    const r = await request("/embed/badge.svg?id=VR-0001");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(r.body).toContain("unknown");
    // Unknown badge uses the gray neutral color.
    expect(r.body).toContain("#6b7280");
  });

  it("renders an 'unknown' badge for a malformed id (no DB call needed)", async () => {
    const r = await request("/embed/badge.svg?id=not-a-code");
    expect(r.status).toBe(200);
    expect(r.body).toContain("unknown");
    // Queue should still be empty — malformed ids short-circuit before DB.
    expect(reportQueue.length).toBe(0);
  });

  it("renders an 'unknown' badge for a hidden report (showInFeed=false) so private scores don't leak", async () => {
    reportQueue.push({
      id: 1,
      slopScore: 99,
      slopTier: "Slop",
      showInFeed: false,
      createdAt: new Date(),
    });
    const r = await request("/embed/badge.svg?id=VR-0001");
    expect(r.status).toBe(200);
    expect(r.body).toContain("unknown");
    expect(r.body).not.toContain("99");
    expect(r.body).not.toContain("slop ");
  });

  it("sets a Cache-Control + ETag header so embedders can revalidate cheaply", async () => {
    reportQueue.push({
      id: 0x2a,
      slopScore: 30,
      slopTier: "Likely Human",
      showInFeed: true,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    });
    const r = await request("/embed/badge.svg?id=VR-002A");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toMatch(/max-age=\d+/);
    expect(r.headers["etag"]).toBeDefined();
    expect(String(r.headers["etag"])).toMatch(/^W\/"badge-/);
  });

  it("returns 304 Not Modified when the client sends a matching If-None-Match", async () => {
    const row = {
      id: 0x2a,
      slopScore: 30,
      slopTier: "Likely Human",
      showInFeed: true,
      createdAt: new Date("2026-05-01T00:00:00Z"),
    };
    reportQueue.push(row);
    const first = await request("/embed/badge.svg?id=VR-002A");
    const etag = String(first.headers["etag"]);
    expect(etag).toBeTruthy();

    reportQueue.push(row);
    const second = await request("/embed/badge.svg?id=VR-002A", {
      "If-None-Match": etag,
    });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
  });
});
