import { db, reportsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildPublicUrl, type PublicUrlRequest } from "./public-url";
import { logger } from "./logger";

export interface OgMeta {
  ogImage: string;
  ogImageWidth: string;
  ogImageHeight: string;
  ogImageType: string;
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
  twitterImage: string;
  twitterCard: string;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tierLabel(score: number): string {
  if (score >= 70) return "Likely Slop";
  if (score >= 40) return "Questionable";
  if (score <= 20) return "Clean";
  return "Suspicious";
}

export async function buildOgMetaForReport(
  reportId: number,
  req: PublicUrlRequest | null,
): Promise<OgMeta | null> {
  try {
    const [report] = await db
      .select({
        id: reportsTable.id,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
        showInFeed: reportsTable.showInFeed,
      })
      .from(reportsTable)
      .where(eq(reportsTable.id, reportId));

    if (!report || !report.showInFeed) return null;

    const score = Math.round((report.slopScore as number) ?? 0);
    const tier = (report.slopTier as string) || tierLabel(score);
    const baseUrl = buildPublicUrl({ req });

    return {
      ogImage: `${baseUrl}/api/og/result/${reportId}.png`,
      ogImageWidth: "1200",
      ogImageHeight: "630",
      ogImageType: "image/png",
      ogTitle: `VulnRap Report VR-${reportId} — Slop Score: ${score}/100 (${tier})`,
      ogDescription: `Vulnerability report scored ${score}/100 (${tier}). Validate claims, detect AI slop, catch duplicates. Free and anonymous.`,
      ogUrl: `${baseUrl}/results/${reportId}`,
      twitterImage: `${baseUrl}/api/og/result/${reportId}.png`,
      twitterCard: "summary_large_image",
    };
  } catch (err) {
    logger.warn(
      { err, reportId },
      "og-meta-injection: failed to look up report for OG rewrite",
    );
    return null;
  }
}

const RESULTS_PATH_RE = /^\/results\/(\d+)\/?$/;

export function extractReportIdFromPath(urlPath: string): number | null {
  const m = RESULTS_PATH_RE.exec(urlPath);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function injectOgMeta(html: string, meta: OgMeta): string {
  const replacements: Array<{
    pattern: RegExp;
    replacement: string;
  }> = [
    {
      pattern: /(<meta\s+property="og:image"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogImage)}$3`,
    },
    {
      pattern:
        /(<meta\s+property="og:image:width"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogImageWidth)}$3`,
    },
    {
      pattern:
        /(<meta\s+property="og:image:height"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogImageHeight)}$3`,
    },
    {
      pattern:
        /(<meta\s+property="og:image:type"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogImageType)}$3`,
    },
    {
      pattern: /(<meta\s+property="og:title"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogTitle)}$3`,
    },
    {
      pattern:
        /(<meta\s+property="og:description"\s+content=")[^"]*?("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogDescription)}$2`,
    },
    {
      pattern: /(<meta\s+property="og:url"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogUrl)}$3`,
    },
    {
      pattern: /(<meta\s+name="twitter:image"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.twitterImage)}$3`,
    },
    {
      pattern: /(<meta\s+name="twitter:card"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.twitterCard)}$3`,
    },
    {
      pattern: /(<meta\s+name="twitter:title"\s+content=")([^"]*?)("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogTitle)}$3`,
    },
    {
      pattern:
        /(<meta\s+name="twitter:description"\s+content=")[^"]*?("\s*\/?>)/i,
      replacement: `$1${escapeHtmlAttr(meta.ogDescription)}$2`,
    },
  ];

  let result = html;
  for (const { pattern, replacement } of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
