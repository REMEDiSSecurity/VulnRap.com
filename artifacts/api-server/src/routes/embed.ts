// Tasks #664 + #665 — Embeddable score badge SVG (5 styles).
//
// Public endpoint `GET /api/embed/badge.svg?id=<id>&style=<style>` returning
// a badge SVG showing the report's slop tier + score. Supports either a
// numeric id or the public `VR-XXXX` (hex) report code.
//
// Behaviour:
//  - Always returns 200 OK with a well-formed SVG. Unknown / hidden /
//    malformed ids render an "unknown" badge rather than a broken image.
//  - Honours `showInFeed`: hidden reports render as "unknown" so private
//    scores can't leak via the badge.
//  - Five visual styles via `style=`: default, flat, plastic, social, square.
//  - ETag based on `id|slopScore|tier|createdAtMs|style` so repeat embedders
//    get cheap 304s. `Cache-Control: max-age=300`.
import crypto from "crypto";
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import {
  renderBadgeSvg,
  type BadgeStyle,
  BADGE_STYLES,
} from "../lib/badge-svg";

const router: IRouter = Router();

const TIER_COLORS: Record<string, string> = {
  Slop: "#ef4444",
  "Likely Slop": "#f59e0b",
  Questionable: "#eab308",
  "Likely Human": "#22c55e",
  Clean: "#10b981",
};
const UNKNOWN_COLOR = "#9f9f9f";

function tierColor(tier: string | null | undefined): string {
  if (!tier) return UNKNOWN_COLOR;
  return TIER_COLORS[tier] ?? UNKNOWN_COLOR;
}

// Accept either a plain integer id or the public `VR-XXXX` hex code.
export function parseReportId(raw: string): number | null {
  const trimmed = raw.trim();
  const vr = /^VR-([0-9A-Fa-f]{1,8})$/.exec(trimmed);
  if (vr) {
    const n = parseInt(vr[1], 16);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildEtag(
  parts: ReadonlyArray<string | number | null | undefined>,
): string {
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
  const idRaw = typeof req.query.id === "string" ? req.query.id : "";
  const styleRaw =
    typeof req.query.style === "string" ? req.query.style : "default";
  const style: BadgeStyle = (BADGE_STYLES as readonly string[]).includes(
    styleRaw,
  )
    ? (styleRaw as BadgeStyle)
    : "default";

  const numericId = parseReportId(idRaw);

  if (numericId === null) {
    const svg = renderBadgeSvg({
      label: "vulnrap",
      value: "unknown",
      color: UNKNOWN_COLOR,
      style,
    });
    sendSvg(res, req, svg, buildEtag(["unknown", idRaw, style]));
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
    const svg = renderBadgeSvg({
      label: "vulnrap",
      value: "unknown",
      color: UNKNOWN_COLOR,
      style,
    });
    sendSvg(res, req, svg, buildEtag(["unknown", idRaw, style]));
    return;
  }

  const score = report.slopScore ?? 0;
  const tier = report.slopTier ?? "unscored";
  const color = tierColor(tier);
  const value = `${tier} (${score})`;
  const createdAtMs =
    report.createdAt instanceof Date ? report.createdAt.getTime() : 0;
  const etag = buildEtag([report.id, score, tier, createdAtMs, style]);
  const svg = renderBadgeSvg({ label: "vulnrap", value, color, style });
  sendSvg(res, req, svg, etag);
});

export default router;
