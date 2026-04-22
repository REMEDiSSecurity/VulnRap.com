// Daily-rotating, anonymous visitor hash. Used by the AVRI velocity tracker
// (and may be used elsewhere later). Mirrors the construction in stats.ts but
// adds the user-agent so submission velocity from the same IP behind a
// shared NAT doesn't all collapse to one bucket.
//
// The hash key (VISITOR_HMAC_KEY) is shared with stats.ts; if unset, an
// ephemeral per-process key is generated which means hashes rotate on every
// server restart — fine for AVRI velocity (in-memory anyway) and stats.ts
// already warns about it on its own.

import { createHmac, randomBytes } from "crypto";
import { logger } from "./logger";

let VISITOR_HMAC_KEY = process.env.VISITOR_HMAC_KEY;
if (!VISITOR_HMAC_KEY) {
  VISITOR_HMAC_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "[visitor] VISITOR_HMAC_KEY not set — using ephemeral per-process key (rotates on restart).",
  );
}
const KEY: string = VISITOR_HMAC_KEY;

export interface VisitorAttribution {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Compute a daily-rotating, anonymous visitor hash. Returns null when no
 * usable identifier is available. The result includes the UTC day so it
 * automatically rotates at midnight UTC.
 */
export function visitorHash(attr: VisitorAttribution | null | undefined): string | null {
  if (!attr) return null;
  const ip = (attr.ip ?? "").trim();
  const ua = (attr.userAgent ?? "").trim();
  if (!ip && !ua) return null;
  const utcDay = new Date().toISOString().slice(0, 10);
  return createHmac("sha256", KEY).update(`${utcDay}::${ip}::${ua}`).digest("hex");
}
