// Task #710 — Tests for the dynamic /sitemap.xml endpoint and the
// XML builder + route table. Pure helpers (`buildSitemapXml`) are
// exercised directly; the HTTP route is exercised via supertest-style
// `app.listen(0)` + fetch so the real Express mount path is covered.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

// Lightweight sitemap validator. We avoid pulling in `fast-xml-parser`
// just for tests — the format is simple enough to validate structurally:
//   1. Starts with the XML prolog.
//   2. Has a single `<urlset xmlns="...">` root with the canonical xmlns.
//   3. Tags balance (every opener has a matching closer in LIFO order).
//   4. Every `<url>` block has the four required children.
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

// Parity test — keeps PUBLIC_ROUTES in lock-step with the frontend
// router. Parses every `<Route path="...">` from `App.tsx` and asserts:
//   - every static (non-parameterised) public route is in PUBLIC_ROUTES
//   - every route in PUBLIC_ROUTES is actually declared in App.tsx
//   - reviewer-only routes are in App.tsx but NOT in PUBLIC_ROUTES
// This catches future drift where someone adds a new public page but
// forgets to register it for indexing.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSitemapXml,
  PUBLIC_ROUTES,
  REVIEWER_ONLY_ROUTES,
} from "./sitemap";
import { ROUTE_TO_FILES } from "../lib/git-mtime";
import type { AddressInfo } from "node:net";

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
