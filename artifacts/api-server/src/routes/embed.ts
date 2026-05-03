// Task #664 — Embeddable score badge SVG.
//
// Public endpoint `GET /api/embed/badge.svg?id=VR-XXXX` that returns a
// Shields.io-style SVG showing the report's slop score + tier color.
// Designed to be dropped into a HackerOne / Bugcrowd / Jira comment via
// `<img>` or Markdown without requiring the embedder to load JSON or hit
// our other endpoints.
//
// Behaviour notes:
//  - Always returns 200 OK with a well-formed SVG. An unknown / hidden /
//    malformed id renders an "unknown" badge instead of a 404 — broken
//    images on triage pages look worse than a graceful "unknown" pill.
//  - Honours `showInFeed`: hidden reports render as "unknown" so the
//    badge can't leak slop scores for private reports.
//  - ETag based on `id|slopScore|createdAtMs|tier`. Embedders that
//    re-render their pages frequently get a 304, which keeps the API
//    cheap even when a popular triage queue mounts the badge inline.
import { Router, type IRouter } from "express";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";

const router: IRouter = Router();

// Tier → hex color. Matches the palette the results page uses for the
// score number, just resolved to concrete hex codes so SVG embedders
// don't have to resolve Tailwind classes. Keep this list in sync with
// `getSlopColorCustom` in `artifacts/vulnrap/src/lib/settings.ts`.
const TIER_COLORS: Record<string, string> = {
  Slop: "#ef4444",
  "Likely Slop": "#f59e0b",
  Questionable: "#eab308",
  "Likely Human": "#22c55e",
  Clean: "#10b981",
};
const UNKNOWN_COLOR = "#6b7280";
const LABEL_COLOR = "#555";

// Parse `VR-XXXX` (hex, case-insensitive, 1..8 hex chars after the
// prefix) back into the numeric report id used by the database. Returns
// null for anything that doesn't match — the caller renders an
// "unknown" badge in that case.
export function parseReportCode(code: string): number | null {
  const m = /^VR-([0-9A-Fa-f]{1,8})$/.exec(code.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Approximate the width of a string in 11px Verdana — close enough for
// shields.io-style badges. Verdana glyphs average ~7px at 11px size; we
// add a small fudge for wide tier names. Width is doubled in SVG units
// because the path is rendered into a 2x viewBox so the text stays
// crisp on retina.
function textWidthPx(s: string): number {
  // Most shields.io badges round to ~7.0 px / char. We use 7.2 to leave
  // a hair of breathing room — clipped text reads as "broken badge".
  return Math.ceil(s.length * 7.2 + 10);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface BadgeInput {
  label: string; // left side, e.g. "vulnrap"
  message: string; // right side, e.g. "62 · slop"
  color: string; // right-side background (hex)
}

// Render a Shields.io-flat-style SVG. Pure-string — no SVG library.
// The shape: rounded-corner badge, two halves, antialiased text with a
// subtle drop-shadow for legibility on dark backgrounds.
export function renderBadge({ label, message, color }: BadgeInput): string {
  const labelW = textWidthPx(label);
  const messageW = textWidthPx(message);
  const totalW = labelW + messageW;
  const labelTextX = (labelW / 2) * 10;
  const messageTextX = (labelW + messageW / 2) * 10;
  const labelTextLen = (labelW - 10) * 10;
  const messageTextLen = (messageW - 10) * 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">
  <title>${escapeXml(label)}: ${escapeXml(message)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="${LABEL_COLOR}"/>
    <rect x="${labelW}" width="${messageW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${labelTextX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelTextLen}">${escapeXml(label)}</text>
    <text x="${labelTextX}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelTextLen}">${escapeXml(label)}</text>
    <text aria-hidden="true" x="${messageTextX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${messageTextLen}">${escapeXml(message)}</text>
    <text x="${messageTextX}" y="140" transform="scale(.1)" fill="#fff" textLength="${messageTextLen}">${escapeXml(message)}</text>
  </g>
</svg>`;
}

function tierColor(tier: string | null | undefined): string {
  if (!tier) return UNKNOWN_COLOR;
  return TIER_COLORS[tier] ?? UNKNOWN_COLOR;
}

function buildEtag(parts: ReadonlyArray<string | number | null | undefined>): string {
  const h = crypto
    .createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("|"))
    .digest("hex")
    .slice(0, 16);
  return `W/"badge-${h}"`;
}

function sendSvg(
  res: import("express").Response,
  req: import("express").Request,
  svg: string,
  etag: string,
): void {
  const ifNoneMatch = req.header("if-none-match");
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.setHeader("ETag", etag);
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).send(svg);
}

router.get("/embed/badge.svg", async (req, res): Promise<void> => {
  const idParam = typeof req.query.id === "string" ? req.query.id : "";
  const numericId = parseReportCode(idParam);

  if (numericId === null) {
    const svg = renderBadge({
      label: "vulnrap",
      message: "unknown",
      color: UNKNOWN_COLOR,
    });
    sendSvg(res, req, svg, buildEtag(["unknown", idParam]));
    return;
  }

  const [report] = await db
    .select({
      id: reportsTable.id,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      showInFeed: reportsTable.showInFeed,
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .where(eq(reportsTable.id, numericId));

  if (!report || !report.showInFeed) {
    const svg = renderBadge({
      label: "vulnrap",
      message: "unknown",
      color: UNKNOWN_COLOR,
    });
    sendSvg(res, req, svg, buildEtag(["unknown", idParam]));
    return;
  }

  const tier = report.slopTier ?? "Unknown";
  const message = `${report.slopScore} · ${tier.toLowerCase()}`;
  const color = tierColor(tier);
  const createdAtMs =
    report.createdAt instanceof Date ? report.createdAt.getTime() : 0;
  const etag = buildEtag([report.id, report.slopScore, tier, createdAtMs]);
  const svg = renderBadge({ label: "vulnrap", message, color });
  sendSvg(res, req, svg, etag);
});

export default router;
