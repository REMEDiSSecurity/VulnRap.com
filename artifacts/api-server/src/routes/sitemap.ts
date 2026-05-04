// Task #710 + #1059 + #1060 + #1062 — Sitemap generator.
//
// Generates a sitemap index (`/sitemap-index.xml`) that references:
//   1. `/sitemap.xml` — the curated static route table mirroring the
//      frontend router in `artifacts/vulnrap/src/App.tsx`.
//   2. `/sitemap-reports-{page}.xml` — paginated child sitemaps listing
//      every public report (where `showInFeed=true`), covering
//      `/results/:id`, `/verify/:id`, and `/signals/:id` routes.
//
// Reviewer-only routes (those gated behind the calibration token —
// `/feedback-analytics`, `/audit-log`) are intentionally excluded so
// they don't waste search engine crawl budget on pages that return 401
// to anonymous visitors.
//
// Task #1062 — Every blog post is included as an individual URL entry
// so search engines can discover and index each post directly. The
// `lastmod` for each post is derived from its curated `date` field in
// `blog-posts.json`.
//
// `lastmod` is derived per-page from the git history of the
// corresponding page component (Task #1059). Falls back to the deploy
// timestamp when git metadata is unavailable.
//
// Mounted at the app root (not under `/api`) so the canonical
// `/sitemap-index.xml` URL referenced from `robots.txt` resolves directly.
import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import { buildPublicUrlForRequest } from "../lib/public-url";
import { resolveRouteMtimes } from "../lib/git-mtime";
import { loadBlogPostsMeta, type BlogPostMeta } from "../lib/blog-posts";

export type SitemapChangefreq =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface SitemapRoute {
  path: string;
  changefreq: SitemapChangefreq;
  priority: number;
}

// Public route table. Keep alphabetised within priority bands and in sync
// with `artifacts/vulnrap/src/App.tsx`. Reviewer-only routes
// (`/feedback-analytics`, `/audit-log`) and parameterised routes
// (`/results/:id`, `/verify/:id`, `/signals/:id`) are intentionally
// excluded — the former because they require auth, the latter because
// they are now covered by the paginated report child sitemaps.
export const PUBLIC_ROUTES: ReadonlyArray<SitemapRoute> = [
  { path: "/", changefreq: "daily", priority: 1.0 },
  { path: "/blog", changefreq: "weekly", priority: 0.9 },
  { path: "/check", changefreq: "weekly", priority: 0.8 },
  { path: "/developers", changefreq: "monthly", priority: 0.8 },
  { path: "/reports", changefreq: "daily", priority: 0.8 },
  { path: "/whitepaper", changefreq: "monthly", priority: 0.8 },
  { path: "/architecture", changefreq: "monthly", priority: 0.7 },
  { path: "/batch", changefreq: "weekly", priority: 0.7 },
  { path: "/changelog", changefreq: "weekly", priority: 0.7 },
  { path: "/compare", changefreq: "weekly", priority: 0.7 },
  { path: "/compare-detectors", changefreq: "weekly", priority: 0.7 },
  { path: "/connect", changefreq: "monthly", priority: 0.7 },
  { path: "/corpus-stats", changefreq: "daily", priority: 0.7 },
  { path: "/cwe", changefreq: "monthly", priority: 0.7 },
  { path: "/docs/good-report", changefreq: "monthly", priority: 0.7 },
  { path: "/engines", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/ai-authorship", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/avri", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/cwe-coherence", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/substance", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/technical-substance", changefreq: "monthly", priority: 0.7 },
  { path: "/gallery", changefreq: "weekly", priority: 0.7 },
  { path: "/glossary", changefreq: "monthly", priority: 0.7 },
  { path: "/how-it-works", changefreq: "monthly", priority: 0.7 },
  { path: "/incidents", changefreq: "weekly", priority: 0.7 },
  { path: "/playground", changefreq: "weekly", priority: 0.7 },
  { path: "/presets", changefreq: "monthly", priority: 0.7 },
  { path: "/press", changefreq: "monthly", priority: 0.7 },
  { path: "/pricing", changefreq: "monthly", priority: 0.7 },
  { path: "/quickstart", changefreq: "monthly", priority: 0.7 },
  { path: "/redaction-examples", changefreq: "monthly", priority: 0.7 },
  { path: "/roadmap", changefreq: "weekly", priority: 0.7 },
  { path: "/showcase", changefreq: "weekly", priority: 0.7 },
  { path: "/signals", changefreq: "weekly", priority: 0.7 },
  { path: "/stats", changefreq: "daily", priority: 0.7 },
  { path: "/test-yourself", changefreq: "weekly", priority: 0.7 },
  { path: "/transparency", changefreq: "weekly", priority: 0.7 },
  { path: "/use-cases", changefreq: "monthly", priority: 0.7 },
  { path: "/accessibility", changefreq: "monthly", priority: 0.6 },
  { path: "/badges", changefreq: "monthly", priority: 0.6 },
  { path: "/community", changefreq: "weekly", priority: 0.6 },
  { path: "/history", changefreq: "weekly", priority: 0.6 },
  { path: "/security", changefreq: "monthly", priority: 0.6 },
  { path: "/status", changefreq: "daily", priority: 0.6 },
  { path: "/privacy", changefreq: "monthly", priority: 0.5 },
  { path: "/terms", changefreq: "monthly", priority: 0.5 },
];

// Reviewer-only routes — kept here so the test suite can assert they
// are *never* present in the generated sitemap. Mirrors the auth-gated
// pages in `App.tsx`.
export const REVIEWER_ONLY_ROUTES: ReadonlyArray<string> = [
  "/admin/incidents",
  "/feedback-analytics",
  "/audit-log",
];

export const REPORT_SITEMAP_PAGE_SIZE = 10_000;

const BLOG_POSTS = loadBlogPostsMeta();

const DEPLOY_LASTMOD = new Date().toISOString();

let routeMtimes: Map<string, string> | null = null;
const routeMtimesReady: Promise<void> = resolveRouteMtimes(DEPLOY_LASTMOD)
  .then((m) => {
    routeMtimes = m;
  })
  .catch(() => {
    routeMtimes = null;
  });

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface BuildSitemapOptions {
  baseUrl: string;
  routes?: ReadonlyArray<SitemapRoute>;
  lastmod?: string;
  routeLastmods?: Map<string, string>;
  blogPosts?: ReadonlyArray<BlogPostMeta>;
}

function toIsoDate(date: string): string {
  const parsed = new Date(date.length === 10 ? `${date}T00:00:00Z` : date);
  return parsed.toISOString();
}

export function buildSitemapXml(options: BuildSitemapOptions): string {
  const base = options.baseUrl.replace(/\/+$/, "");
  const routes = options.routes ?? PUBLIC_ROUTES;
  const fallbackLastmod = options.lastmod ?? DEPLOY_LASTMOD;
  const perRoute = options.routeLastmods;
  const blogPosts = options.blogPosts ?? BLOG_POSTS;

  const routeUrls = routes
    .map((route) => {
      const loc = escapeXml(`${base}${route.path}`);
      const lastmod = perRoute?.get(route.path) ?? fallbackLastmod;
      return [
        "  <url>",
        `    <loc>${loc}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority.toFixed(1)}</priority>`,
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  const blogUrls = blogPosts
    .map((post) => {
      const loc = escapeXml(`${base}/blog#${post.id}`);
      const lastmod = toIsoDate(post.date);
      return [
        "  <url>",
        `    <loc>${loc}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>monthly</changefreq>`,
        `    <priority>0.8</priority>`,
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  const allUrls = blogUrls ? `${routeUrls}\n${blogUrls}` : routeUrls;

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls}
</urlset>
`;
}

export interface ReportRow {
  id: number;
  createdAt: Date;
}

export async function fetchPublicReportIds(): Promise<ReportRow[]> {
  const rows = await db
    .select({ id: reportsTable.id, createdAt: reportsTable.createdAt })
    .from(reportsTable)
    .where(eq(reportsTable.showInFeed, true))
    .orderBy(asc(reportsTable.id));
  return rows;
}

export function buildReportSitemapXml(
  baseUrl: string,
  reports: ReportRow[],
): string {
  const base = baseUrl.replace(/\/+$/, "");

  const urls = reports
    .map((r) => {
      const lastmod = r.createdAt.toISOString();
      const resultsLoc = escapeXml(`${base}/results/${r.id}`);
      const verifyLoc = escapeXml(`${base}/verify/${r.id}`);
      const signalsLoc = escapeXml(`${base}/signals/${r.id}`);
      return [
        "  <url>",
        `    <loc>${resultsLoc}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>monthly</changefreq>`,
        `    <priority>0.5</priority>`,
        "  </url>",
        "  <url>",
        `    <loc>${verifyLoc}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>monthly</changefreq>`,
        `    <priority>0.4</priority>`,
        "  </url>",
        "  <url>",
        `    <loc>${signalsLoc}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>monthly</changefreq>`,
        `    <priority>0.4</priority>`,
        "  </url>",
      ].join("\n");
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function buildSitemapIndexXml(
  baseUrl: string,
  reportPageCount: number,
  lastmod: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");

  const sitemaps: string[] = [];

  sitemaps.push(
    [
      "  <sitemap>",
      `    <loc>${escapeXml(`${base}/sitemap.xml`)}</loc>`,
      `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
      "  </sitemap>",
    ].join("\n"),
  );

  for (let i = 1; i <= reportPageCount; i++) {
    sitemaps.push(
      [
        "  <sitemap>",
        `    <loc>${escapeXml(`${base}/sitemap-reports-${i}.xml`)}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        "  </sitemap>",
      ].join("\n"),
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.join("\n")}
</sitemapindex>
`;
}

export function paginateReports(
  reports: ReportRow[],
  page: number,
  pageSize: number = REPORT_SITEMAP_PAGE_SIZE,
): ReportRow[] {
  const start = (page - 1) * pageSize;
  return reports.slice(start, start + pageSize);
}

export function reportPageCount(
  totalReports: number,
  pageSize: number = REPORT_SITEMAP_PAGE_SIZE,
): number {
  if (totalReports === 0) return 0;
  return Math.ceil(totalReports / pageSize);
}

const SITEMAP_CACHE_HEADER =
  "public, max-age=3600, stale-while-revalidate=600";

const router: IRouter = Router();

router.get("/sitemap.xml", async (_req, res) => {
  await routeMtimesReady;
  const baseUrl = buildPublicUrlForRequest(_req);
  const xml = buildSitemapXml({
    baseUrl,
    routeLastmods: routeMtimes ?? undefined,
  });
  res.set("Cache-Control", SITEMAP_CACHE_HEADER);
  res.type("application/xml").send(xml);
});

router.get("/sitemap-index.xml", async (_req, res) => {
  try {
    await routeMtimesReady;
    const baseUrl = buildPublicUrlForRequest(_req);
    const reports = await fetchPublicReportIds();
    const pages = reportPageCount(reports.length);
    const xml = buildSitemapIndexXml(baseUrl, pages, DEPLOY_LASTMOD);
    res.set("Cache-Control", SITEMAP_CACHE_HEADER);
    res.type("application/xml").send(xml);
  } catch {
    res.status(500).type("text/plain").send("Internal Server Error");
  }
});

router.get("/sitemap-reports-:page.xml", async (_req, res) => {
  try {
    const page = parseInt(_req.params.page, 10);
    if (isNaN(page) || page < 1) {
      res.status(404).type("text/plain").send("Not Found");
      return;
    }

    const baseUrl = buildPublicUrlForRequest(_req);
    const reports = await fetchPublicReportIds();
    const pages = reportPageCount(reports.length);

    if (page > pages) {
      res.status(404).type("text/plain").send("Not Found");
      return;
    }

    const slice = paginateReports(reports, page);
    const xml = buildReportSitemapXml(baseUrl, slice);
    res.set("Cache-Control", SITEMAP_CACHE_HEADER);
    res.type("application/xml").send(xml);
  } catch {
    res.status(500).type("text/plain").send("Internal Server Error");
  }
});

export default router;
