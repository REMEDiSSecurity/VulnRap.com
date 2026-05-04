// Task #710 + #1060 — Tests for the dynamic sitemap endpoints, the
// XML builder + route table, sitemap index, and paginated report sitemaps.
// Pure helpers are exercised directly; HTTP routes are exercised via
// supertest-style `app.listen(0)` + fetch so the real Express mount
// path is covered.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

function validateSitemap(xml: string): { ok: boolean; reason?: string } {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    return { ok: false, reason: "missing XML prolog" };
  }
  if (
    !xml.includes(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    )
  ) {
    return { ok: false, reason: "missing canonical urlset xmlns" };
  }
  const tagRe = /<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/)?>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const raw = m[0];
    const name = m[1];
    if (raw.startsWith("<?") || raw.startsWith("<!")) continue;
    if (raw.endsWith("/>")) continue;
    if (raw.startsWith("</")) {
      const top = stack.pop();
      if (top !== name) {
        return { ok: false, reason: `mismatched close tag </${name}>` };
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length !== 0) {
    return { ok: false, reason: `unclosed tags: ${stack.join(",")}` };
  }
  const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  for (const block of urlBlocks) {
    for (const child of ["loc", "lastmod", "changefreq", "priority"]) {
      if (!new RegExp(`<${child}>[^<]+</${child}>`).test(block)) {
        return { ok: false, reason: `<url> missing <${child}>` };
      }
    }
  }
  return { ok: true };
}

function validateSitemapIndex(xml: string): { ok: boolean; reason?: string } {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    return { ok: false, reason: "missing XML prolog" };
  }
  if (
    !xml.includes(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    )
  ) {
    return { ok: false, reason: "missing canonical sitemapindex xmlns" };
  }
  const sitemapBlocks = xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) ?? [];
  for (const block of sitemapBlocks) {
    if (!/<loc>[^<]+<\/loc>/.test(block)) {
      return { ok: false, reason: "<sitemap> missing <loc>" };
    }
    if (!/<lastmod>[^<]+<\/lastmod>/.test(block)) {
      return { ok: false, reason: "<sitemap> missing <lastmod>" };
    }
  }
  return { ok: true };
}

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

import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import {
  buildSitemapXml,
  buildSitemapIndexXml,
  buildReportSitemapXml,
  paginateReports,
  reportPageCount,
  PUBLIC_ROUTES,
  REVIEWER_ONLY_ROUTES,
  REPORT_SITEMAP_PAGE_SIZE,
  type ReportRow,
} from "./sitemap";
import { ROUTE_TO_FILES } from "../lib/git-mtime";
import type { AddressInfo } from "node:net";

const SITEMAP_TEST_MARKER = "__sitemap_test__";

function extractFrontendRoutes(): string[] {
  const appTsx = readFileSync(
    path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "vulnrap",
      "src",
      "App.tsx",
    ),
    "utf8",
  );
  const re = /<Route\s+path="([^"]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(appTsx)) !== null) out.push(m[1]);
  return out;
}

const FRONTEND_ROUTES = extractFrontendRoutes();
const STATIC_FRONTEND_ROUTES = FRONTEND_ROUTES.filter(
  (p) => !p.includes(":") && p !== "*",
);

describe("PUBLIC_ROUTES vs App.tsx parity", () => {
  it("includes every static frontend route except reviewer-only ones", () => {
    const sitemapPaths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    const reviewerSet = new Set<string>(REVIEWER_ONLY_ROUTES);
    const missing = STATIC_FRONTEND_ROUTES.filter(
      (p) => !reviewerSet.has(p) && !sitemapPaths.has(p),
    );
    expect(
      missing,
      `Frontend routes missing from PUBLIC_ROUTES: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not include any path that isn't actually a frontend route", () => {
    const frontendSet = new Set(STATIC_FRONTEND_ROUTES);
    const stale = PUBLIC_ROUTES.map((r) => r.path).filter(
      (p) => !frontendSet.has(p),
    );
    expect(
      stale,
      `PUBLIC_ROUTES paths not present in App.tsx: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("confirms reviewer-only routes are still declared in App.tsx (so the exclusion list isn't stale)", () => {
    const frontendSet = new Set(STATIC_FRONTEND_ROUTES);
    for (const reviewerPath of REVIEWER_ONLY_ROUTES) {
      expect(
        frontendSet.has(reviewerPath),
        `Reviewer-only path ${reviewerPath} no longer declared in App.tsx; remove from REVIEWER_ONLY_ROUTES`,
      ).toBe(true);
    }
  });
});

describe("PUBLIC_ROUTES", () => {
  it("excludes every reviewer-only route", () => {
    const paths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    for (const reviewerPath of REVIEWER_ONLY_ROUTES) {
      expect(paths.has(reviewerPath)).toBe(false);
    }
  });

  it("excludes parameterised dynamic routes", () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.path).not.toMatch(/:/);
    }
  });

  it("uses absolute paths starting with '/'", () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.path.startsWith("/")).toBe(true);
    }
  });

  it("has unique paths (no duplicate <url> entries)", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("uses priorities in the [0.0, 1.0] range", () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.priority).toBeGreaterThanOrEqual(0);
      expect(route.priority).toBeLessThanOrEqual(1);
    }
  });
});

describe("ROUTE_TO_FILES mapping", () => {
  it("has an entry for every PUBLIC_ROUTES path", () => {
    const mapped = new Set(Object.keys(ROUTE_TO_FILES));
    const missing = PUBLIC_ROUTES.map((r) => r.path).filter(
      (p) => !mapped.has(p),
    );
    expect(
      missing,
      `PUBLIC_ROUTES paths missing from ROUTE_TO_FILES: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not map routes that are not in PUBLIC_ROUTES", () => {
    const publicPaths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    const stale = Object.keys(ROUTE_TO_FILES).filter(
      (p) => !publicPaths.has(p),
    );
    expect(
      stale,
      `ROUTE_TO_FILES keys not present in PUBLIC_ROUTES: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("references page files that actually exist on disk", () => {
    const pagesDir = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "vulnrap",
      "src",
      "pages",
    );
    for (const [route, files] of Object.entries(ROUTE_TO_FILES)) {
      for (const file of files) {
        const full = path.join(pagesDir, file);
        expect(
          () => readFileSync(full),
          `ROUTE_TO_FILES["${route}"] references "${file}" which does not exist`,
        ).not.toThrow();
      }
    }
  });
});

describe("buildSitemapXml", () => {
  it("produces well-formed XML that validates as a sitemap urlset", () => {
    const xml = buildSitemapXml({ baseUrl: "https://vulnrap.com" });
    const validation = validateSitemap(xml);
    expect(validation.ok, validation.reason).toBe(true);
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    expect(urlBlocks.length).toBe(PUBLIC_ROUTES.length);
    for (const block of urlBlocks) {
      const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
      expect(loc?.startsWith("https://vulnrap.com/")).toBe(true);
    }
  });

  it("strips trailing slashes from the base URL so URLs aren't doubled", () => {
    const xml = buildSitemapXml({ baseUrl: "https://vulnrap.com/" });
    expect(xml).toContain("<loc>https://vulnrap.com/</loc>");
    expect(xml).not.toContain("https://vulnrap.com//");
  });

  it("never emits any reviewer-only path", () => {
    const xml = buildSitemapXml({ baseUrl: "https://vulnrap.com" });
    for (const reviewerPath of REVIEWER_ONLY_ROUTES) {
      expect(xml).not.toContain(
        `<loc>https://vulnrap.com${reviewerPath}</loc>`,
      );
    }
  });

  it("emits the supplied lastmod for every entry", () => {
    const lastmod = "2026-05-03T12:00:00.000Z";
    const xml = buildSitemapXml({
      baseUrl: "https://vulnrap.com",
      lastmod,
      routes: [{ path: "/", changefreq: "daily", priority: 1.0 }],
    });
    expect(xml).toContain(`<lastmod>${lastmod}</lastmod>`);
  });

  it("uses per-route lastmod from routeLastmods when provided", () => {
    const routeLastmods = new Map<string, string>([
      ["/", "2026-01-15T10:00:00+00:00"],
      ["/check", "2026-03-20T14:30:00+00:00"],
    ]);
    const routes = [
      { path: "/", changefreq: "daily" as const, priority: 1.0 },
      { path: "/check", changefreq: "weekly" as const, priority: 0.8 },
    ];
    const xml = buildSitemapXml({
      baseUrl: "https://vulnrap.com",
      routes,
      routeLastmods,
    });
    expect(xml).toContain("<lastmod>2026-01-15T10:00:00+00:00</lastmod>");
    expect(xml).toContain("<lastmod>2026-03-20T14:30:00+00:00</lastmod>");
  });

  it("routes with different underlying file mtimes get different lastmod values", () => {
    const routeLastmods = new Map<string, string>([
      ["/", "2026-04-01T00:00:00+00:00"],
      ["/check", "2026-02-15T00:00:00+00:00"],
      ["/terms", "2025-12-01T00:00:00+00:00"],
    ]);
    const routes = [
      { path: "/", changefreq: "daily" as const, priority: 1.0 },
      { path: "/check", changefreq: "weekly" as const, priority: 0.8 },
      { path: "/terms", changefreq: "monthly" as const, priority: 0.5 },
    ];
    const xml = buildSitemapXml({
      baseUrl: "https://vulnrap.com",
      routes,
      routeLastmods,
    });
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    const lastmods = urlBlocks.map(
      (block) => /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1],
    );
    expect(lastmods).toEqual([
      "2026-04-01T00:00:00+00:00",
      "2026-02-15T00:00:00+00:00",
      "2025-12-01T00:00:00+00:00",
    ]);
    const unique = new Set(lastmods);
    expect(unique.size).toBe(3);
  });

  it("falls back to the global lastmod when routeLastmods has no entry for a route", () => {
    const routeLastmods = new Map<string, string>([
      ["/", "2026-01-15T10:00:00+00:00"],
    ]);
    const fallback = "2026-05-01T00:00:00.000Z";
    const routes = [
      { path: "/", changefreq: "daily" as const, priority: 1.0 },
      { path: "/check", changefreq: "weekly" as const, priority: 0.8 },
    ];
    const xml = buildSitemapXml({
      baseUrl: "https://vulnrap.com",
      routes,
      routeLastmods,
      lastmod: fallback,
    });
    expect(xml).toContain("<lastmod>2026-01-15T10:00:00+00:00</lastmod>");
    expect(xml).toContain(`<lastmod>${fallback}</lastmod>`);
  });
});

describe("buildSitemapIndexXml", () => {
  it("produces well-formed sitemap index XML", () => {
    const xml = buildSitemapIndexXml(
      "https://vulnrap.com",
      3,
      "2026-05-04T00:00:00.000Z",
    );
    const validation = validateSitemapIndex(xml);
    expect(validation.ok, validation.reason).toBe(true);
  });

  it("always includes the static sitemap.xml as the first child", () => {
    const xml = buildSitemapIndexXml(
      "https://vulnrap.com",
      0,
      "2026-05-04T00:00:00.000Z",
    );
    expect(xml).toContain("<loc>https://vulnrap.com/sitemap.xml</loc>");
  });

  it("references the correct number of report child sitemaps", () => {
    const xml = buildSitemapIndexXml(
      "https://vulnrap.com",
      3,
      "2026-05-04T00:00:00.000Z",
    );
    expect(xml).toContain(
      "<loc>https://vulnrap.com/sitemap-reports-1.xml</loc>",
    );
    expect(xml).toContain(
      "<loc>https://vulnrap.com/sitemap-reports-2.xml</loc>",
    );
    expect(xml).toContain(
      "<loc>https://vulnrap.com/sitemap-reports-3.xml</loc>",
    );
    expect(xml).not.toContain("sitemap-reports-4.xml");
    const sitemapBlocks = xml.match(/<sitemap>/g) ?? [];
    expect(sitemapBlocks.length).toBe(4);
  });

  it("emits zero report child sitemaps when there are no public reports", () => {
    const xml = buildSitemapIndexXml(
      "https://vulnrap.com",
      0,
      "2026-05-04T00:00:00.000Z",
    );
    expect(xml).not.toContain("sitemap-reports-");
    const sitemapBlocks = xml.match(/<sitemap>/g) ?? [];
    expect(sitemapBlocks.length).toBe(1);
  });

  it("strips trailing slashes from the base URL", () => {
    const xml = buildSitemapIndexXml(
      "https://vulnrap.com/",
      1,
      "2026-05-04T00:00:00.000Z",
    );
    expect(xml).not.toContain("vulnrap.com//");
  });
});

describe("buildReportSitemapXml", () => {
  const reports: ReportRow[] = [
    { id: 42, createdAt: new Date("2026-03-15T10:00:00Z") },
    { id: 99, createdAt: new Date("2026-04-20T14:30:00Z") },
  ];

  it("produces well-formed XML", () => {
    const xml = buildReportSitemapXml("https://vulnrap.com", reports);
    const validation = validateSitemap(xml);
    expect(validation.ok, validation.reason).toBe(true);
  });

  it("generates three URLs per report (results, verify, signals)", () => {
    const xml = buildReportSitemapXml("https://vulnrap.com", reports);
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    expect(urlBlocks.length).toBe(6);

    expect(xml).toContain("<loc>https://vulnrap.com/results/42</loc>");
    expect(xml).toContain("<loc>https://vulnrap.com/verify/42</loc>");
    expect(xml).toContain("<loc>https://vulnrap.com/signals/42</loc>");
    expect(xml).toContain("<loc>https://vulnrap.com/results/99</loc>");
    expect(xml).toContain("<loc>https://vulnrap.com/verify/99</loc>");
    expect(xml).toContain("<loc>https://vulnrap.com/signals/99</loc>");
  });

  it("uses the report createdAt as lastmod", () => {
    const xml = buildReportSitemapXml("https://vulnrap.com", reports);
    expect(xml).toContain(
      "<lastmod>2026-03-15T10:00:00.000Z</lastmod>",
    );
    expect(xml).toContain(
      "<lastmod>2026-04-20T14:30:00.000Z</lastmod>",
    );
  });

  it("returns empty urlset for zero reports", () => {
    const xml = buildReportSitemapXml("https://vulnrap.com", []);
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    expect(urlBlocks.length).toBe(0);
  });
});

describe("paginateReports", () => {
  const reports: ReportRow[] = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    createdAt: new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
  }));

  it("returns the correct slice for page 1", () => {
    const page = paginateReports(reports, 1, 10);
    expect(page.length).toBe(10);
    expect(page[0].id).toBe(1);
    expect(page[9].id).toBe(10);
  });

  it("returns the correct slice for page 2", () => {
    const page = paginateReports(reports, 2, 10);
    expect(page.length).toBe(10);
    expect(page[0].id).toBe(11);
    expect(page[9].id).toBe(20);
  });

  it("returns a partial page for the last page", () => {
    const page = paginateReports(reports, 3, 10);
    expect(page.length).toBe(5);
    expect(page[0].id).toBe(21);
  });

  it("returns empty for a page beyond the data", () => {
    const page = paginateReports(reports, 4, 10);
    expect(page.length).toBe(0);
  });
});

describe("reportPageCount", () => {
  it("returns 0 for 0 reports", () => {
    expect(reportPageCount(0, 10_000)).toBe(0);
  });

  it("returns 1 for reports within one page", () => {
    expect(reportPageCount(5_000, 10_000)).toBe(1);
    expect(reportPageCount(10_000, 10_000)).toBe(1);
  });

  it("returns correct pages for reports exceeding one page", () => {
    expect(reportPageCount(10_001, 10_000)).toBe(2);
    expect(reportPageCount(30_000, 10_000)).toBe(3);
    expect(reportPageCount(30_001, 10_000)).toBe(4);
  });

  it("uses the default page size when not specified", () => {
    expect(reportPageCount(1)).toBe(1);
    expect(reportPageCount(REPORT_SITEMAP_PAGE_SIZE)).toBe(1);
    expect(reportPageCount(REPORT_SITEMAP_PAGE_SIZE + 1)).toBe(2);
  });
});

describe("GET /sitemap.xml", () => {
  it("returns valid XML with the expected content-type and cache header", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=600",
    );
    const body = await res.text();
    const validation = validateSitemap(body);
    expect(validation.ok, validation.reason).toBe(true);
    expect(body).toContain("<urlset");
    expect(body).toContain("</urlset>");
  });

  it("includes every public route from the route table", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`);
    const body = await res.text();
    for (const route of PUBLIC_ROUTES) {
      expect(body).toContain(`${route.path}</loc>`);
    }
  });

  it("does not include reviewer-only routes", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`);
    const body = await res.text();
    for (const reviewerPath of REVIEWER_ONLY_ROUTES) {
      expect(body).not.toContain(`${reviewerPath}</loc>`);
    }
  });

  it("derives <loc> from PUBLIC_URL when set", async () => {
    const previous = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://example.test";
    try {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const body = await res.text();
      expect(body).toContain("<loc>https://example.test/</loc>");
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previous;
    }
  });
});

describe("GET /sitemap-index.xml", () => {
  it("returns valid sitemap index XML with correct headers", async () => {
    const res = await fetch(`${baseUrl}/sitemap-index.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=600",
    );
    const body = await res.text();
    const validation = validateSitemapIndex(body);
    expect(validation.ok, validation.reason).toBe(true);
  });

  it("always references sitemap.xml as a child", async () => {
    const res = await fetch(`${baseUrl}/sitemap-index.xml`);
    const body = await res.text();
    expect(body).toContain("sitemap.xml</loc>");
  });
});

describe("GET /sitemap-reports-:page.xml", () => {
  it("returns 404 for page 0", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports-0.xml`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for negative page", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports--1.xml`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for non-numeric page", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports-abc.xml`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a page beyond the total page count", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports-99999.xml`);
    expect(res.status).toBe(404);
  });
});

describe("report sitemap DB integration", () => {
  const testContentHash = `sitemap_test_${Date.now()}`;
  let visibleId: number;
  let hiddenId: number;

  beforeAll(async () => {
    const base = {
      deleteToken: "test",
      simhash: "0",
      minhashSignature: [],
      lshBuckets: [],
      contentText: SITEMAP_TEST_MARKER,
      redactedText: SITEMAP_TEST_MARKER,
      contentMode: "full",
      slopScore: 50,
      slopTier: "Questionable",
      qualityScore: 50,
      confidence: 0.5,
      breakdown: { linguistic: 0, factual: 0, template: 0, llm: null, quality: 50 },
      evidence: [],
      humanIndicators: [],
      authenticityScore: 50,
      validityScore: 50,
      quadrant: "WEAK_HUMAN",
      archetype: "REQUEST_DETAILS",
      similarityMatches: [],
      sectionHashes: {},
      sectionMatches: [],
      redactionSummary: { totalRedactions: 0, categories: {} },
      feedback: [],
      fileSize: 100,
    };

    const [visible] = await db
      .insert(reportsTable)
      .values({
        ...base,
        contentHash: `${testContentHash}_visible`,
        showInFeed: true,
      })
      .returning({ id: reportsTable.id });
    visibleId = visible.id;

    const [hidden] = await db
      .insert(reportsTable)
      .values({
        ...base,
        contentHash: `${testContentHash}_hidden`,
        showInFeed: false,
      })
      .returning({ id: reportsTable.id });
    hiddenId = hidden.id;
  });

  afterAll(async () => {
    await db
      .delete(reportsTable)
      .where(
        inArray(reportsTable.contentHash, [
          `${testContentHash}_visible`,
          `${testContentHash}_hidden`,
        ]),
      );
  });

  it("excludes hidden reports (showInFeed=false) from report sitemap", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports-1.xml`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`/results/${visibleId}</loc>`);
    expect(body).toContain(`/verify/${visibleId}</loc>`);
    expect(body).toContain(`/signals/${visibleId}</loc>`);
    expect(body).not.toContain(`/results/${hiddenId}</loc>`);
    expect(body).not.toContain(`/verify/${hiddenId}</loc>`);
    expect(body).not.toContain(`/signals/${hiddenId}</loc>`);
  });

  it("returns valid sitemap XML with correct headers for page 1", async () => {
    const res = await fetch(`${baseUrl}/sitemap-reports-1.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=600",
    );
    const body = await res.text();
    const validation = validateSitemap(body);
    expect(validation.ok, validation.reason).toBe(true);
  });

  it("sitemap index references report child sitemaps when public reports exist", async () => {
    const res = await fetch(`${baseUrl}/sitemap-index.xml`);
    const body = await res.text();
    expect(body).toContain("sitemap-reports-1.xml</loc>");
  });
});

describe("robots.txt sitemap directive", () => {
  it("points at sitemap-index.xml instead of sitemap.xml", () => {
    const robotsTxt = readFileSync(
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "vulnrap",
        "public",
        "robots.txt",
      ),
      "utf8",
    );
    expect(robotsTxt).toContain("Sitemap: https://vulnrap.com/sitemap-index.xml");
    expect(robotsTxt).not.toContain("Sitemap: https://vulnrap.com/sitemap.xml");
  });
});
