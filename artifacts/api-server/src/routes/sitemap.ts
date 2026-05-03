// Task #710 — Sitemap generator.
//
// Generates `sitemap.xml` from a curated route table mirroring the
// frontend router in `artifacts/vulnrap/src/App.tsx`. Reviewer-only
// routes (those gated behind the calibration token — `/feedback-analytics`,
// `/audit-log`) are intentionally excluded so they don't waste search
// engine crawl budget on pages that return 401 to anonymous visitors.
//
// `lastmod` uses the deploy timestamp (process boot time) per the task's
// out-of-scope note; per-page git mtimes are explicitly out of scope.
//
// Mounted at the app root (not under `/api`) so the canonical
// `/sitemap.xml` URL referenced from `robots.txt` resolves directly.
import { Router, type IRouter } from "express";
import { buildPublicUrlForRequest } from "../lib/public-url";

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
// listing every report id would balloon the sitemap and the per-report
// pages are reachable via `/reports`.
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
  { path: "/corpus-stats", changefreq: "daily", priority: 0.7 },
  { path: "/cwe", changefreq: "monthly", priority: 0.7 },
  { path: "/docs/good-report", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/cwe-coherence", changefreq: "monthly", priority: 0.7 },
  { path: "/engines/substance", changefreq: "monthly", priority: 0.7 },
  { path: "/gallery", changefreq: "weekly", priority: 0.7 },
  { path: "/how-it-works", changefreq: "monthly", priority: 0.7 },
  { path: "/playground", changefreq: "weekly", priority: 0.7 },
  { path: "/presets", changefreq: "monthly", priority: 0.7 },
  { path: "/pricing", changefreq: "monthly", priority: 0.7 },
  { path: "/quickstart", changefreq: "monthly", priority: 0.7 },
  { path: "/redaction-examples", changefreq: "monthly", priority: 0.7 },
  { path: "/roadmap", changefreq: "weekly", priority: 0.7 },
  { path: "/signals", changefreq: "weekly", priority: 0.7 },
  { path: "/stats", changefreq: "daily", priority: 0.7 },
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
  "/feedback-analytics",
  "/audit-log",
];

// Captured at module load (process boot). The deploy timestamp is a
// reasonable `lastmod` proxy until per-page git mtime sourcing lands.
const DEPLOY_LASTMOD = new Date().toISOString();

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
}

export function buildSitemapXml(options: BuildSitemapOptions): string {
  const base = options.baseUrl.replace(/\/+$/, "");
  const routes = options.routes ?? PUBLIC_ROUTES;
  const lastmod = options.lastmod ?? DEPLOY_LASTMOD;

  const urls = routes
    .map((route) => {
      const loc = escapeXml(`${base}${route.path}`);
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

const router: IRouter = Router();

router.get("/sitemap.xml", (req, res) => {
  const baseUrl = buildPublicUrlForRequest(req);
  const xml = buildSitemapXml({ baseUrl });
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.type("application/xml").send(xml);
});

export default router;
