// Task #666 — Dynamic OG card for /results/:id share unfurls.
//
// Returns a 1200×630 PNG composed of: VulnRap branding, anonymized report
// id, the slop score with tier color, the top fired evidence signal, and a
// timestamp. Used by the results page's <meta property="og:image"> + the
// matching twitter:image so a shared link unfurls with the actual score
// instead of the static site card.
//
// Rendering uses @resvg/resvg-js (pure-rust SVG-to-PNG, no Cairo / canvas
// dependency). The card is a hand-rolled SVG so we can avoid bundling fonts
// — the system / fallback font stack inside resvg looks acceptable at OG
// sizes and the card is intentionally text-light (big numbers, short
// labels). On any rendering error we fall back to redirecting to the
// static site OG image so consumers always get *something* to display.
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import { Resvg } from "@resvg/resvg-js";
import { buildPublicUrl } from "../lib/public-url";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// Color picked off the same buckets the results page uses for slopScore.
// Higher slop = redder. Mirrors getQualityColor / getSlopColor over there.
function tierColor(slopScore: number): string {
  if (slopScore >= 70) return "#ef4444"; // red-500
  if (slopScore >= 40) return "#f59e0b"; // amber-500
  return "#22c55e"; // green-500
}

// Anonymize the numeric id the same shape the public surfaces use:
// "VR-12345" — short enough to render large in the card.
function reportCode(id: number): string {
  return `VR-${id}`;
}

// Strip non-printable / control chars and clamp length so a maliciously
// long evidence description can't blow up the SVG or inject XML.
function sanitizeText(s: string, max = 80): string {
  const cleaned = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + "…";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface OgCardInput {
  id: number;
  slopScore: number;
  slopTier: string;
  topSignal: string | null;
  createdAt: Date;
}

// Pure helper — exported so tests can assert on the SVG shape without
// invoking resvg or seeding a database row.
export function buildOgSvg(input: OgCardInput): string {
  const score = Math.max(0, Math.min(100, Math.round(input.slopScore)));
  const color = tierColor(score);
  const code = reportCode(input.id);
  const tier = sanitizeText(input.slopTier || "Unscored", 32);
  const signalLine = input.topSignal
    ? `Top signal: ${sanitizeText(input.topSignal, 70)}`
    : "No fired signals";
  const ts =
    input.createdAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#1f2937"/>
    </linearGradient>
  </defs>
  <rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${OG_WIDTH}" height="8" fill="${color}"/>
  <text x="64" y="110" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="36" font-weight="700" fill="#22d3ee">VulnRap</text>
  <text x="64" y="150" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="22" fill="#94a3b8">Vulnerability Report Validation</text>
  <text x="64" y="270" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="34" fill="#e2e8f0">Slop Score</text>
  <text x="64" y="430" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="220" font-weight="800" fill="${color}">${score}</text>
  <text x="64" y="490" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="44" font-weight="600" fill="${color}">${escapeXml(tier)}</text>
  <text x="64" y="540" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="22" fill="#cbd5e1">${escapeXml(signalLine)}</text>
  <text x="64" y="580" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="20" fill="#64748b">${escapeXml(code)} · ${escapeXml(ts)}</text>
  <text x="${OG_WIDTH - 64}" y="${OG_HEIGHT - 40}" text-anchor="end" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="20" fill="#64748b">vulnrap.com</text>
</svg>`;
}

// Pure helper — deterministic ETag derived from the inputs that affect
// rendering. Lets repeated unfurls hit the 304 path while staying cheap to
// recompute.
export function buildOgEtag(input: OgCardInput): string {
  const sig = [
    input.id,
    input.slopScore,
    input.slopTier,
    input.topSignal ?? "",
    input.createdAt.toISOString(),
  ].join("|");
  // Simple djb2 hash — no need for crypto here; the ETag just needs to be
  // stable + change when any of the rendered inputs change.
  let h = 5381;
  for (let i = 0; i < sig.length; i++) {
    h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
  }
  return `"og-${(h >>> 0).toString(16)}"`;
}

// Express 5 / path-to-regexp v8 no longer supports the legacy
// `:id.png` literal-suffix syntax — the `.` is treated as part of the
// parameter name. Using a RegExp route keeps the public URL shape
// (`/og/result/123.png`) while reliably extracting the numeric id.
router.get(/^\/og\/result\/(\d+)\.png$/, async (req, res): Promise<void> => {
  const idStr = (req.params as unknown as Record<string, string>)[0] ?? "";
  const idNum = Number.parseInt(idStr, 10);
  const fallbackUrl = buildPublicUrl({ req, path: "/opengraph.jpg" });

  if (!Number.isInteger(idNum) || idNum <= 0) {
    res.redirect(302, fallbackUrl);
    return;
  }

  try {
    const [report] = await db
      .select({
        id: reportsTable.id,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
        evidence: reportsTable.evidence,
        createdAt: reportsTable.createdAt,
        showInFeed: reportsTable.showInFeed,
      })
      .from(reportsTable)
      .where(eq(reportsTable.id, idNum));

    if (!report || !report.showInFeed) {
      res.redirect(302, fallbackUrl);
      return;
    }

    const evidence = Array.isArray(report.evidence) ? report.evidence : [];
    // Top fired signal = highest-weight evidence item. The list is
    // typically already sorted by weight, but we re-sort defensively so
    // legacy reports stored in insertion order still render the right one.
    type Ev = { description?: unknown; weight?: unknown };
    const sorted = (evidence as Ev[])
      .filter((e) => e && typeof e.description === "string")
      .slice()
      .sort((a, b) => {
        const aw = typeof a.weight === "number" ? a.weight : 0;
        const bw = typeof b.weight === "number" ? b.weight : 0;
        return bw - aw;
      });
    const topSignal =
      sorted.length > 0 ? (sorted[0].description as string) : null;

    const input: OgCardInput = {
      id: report.id as number,
      slopScore: (report.slopScore as number) ?? 0,
      slopTier: (report.slopTier as string) ?? "Unscored",
      topSignal,
      createdAt: (report.createdAt as Date) ?? new Date(),
    };

    const etag = buildOgEtag(input);
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const svg = buildOgSvg(input);
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: OG_WIDTH },
      background: "#0d1117",
    })
      .render()
      .asPng();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("ETag", etag);
    res.status(200).end(png);
  } catch (err) {
    logger.warn(
      { err, reportId: idNum },
      "og-card render failed; falling back to static OG image",
    );
    res.redirect(302, fallbackUrl);
  }
});

export default router;
