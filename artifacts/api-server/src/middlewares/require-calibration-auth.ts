import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Task #113 — gate every mutation under /feedback/calibration/* behind a
// shared reviewer token so the API can be safely exposed publicly. The
// existing calibration namespace (apply, hand-wavy phrase add/remove) was
// open to any caller, which is fine for the current single-reviewer setup
// but would let any visitor pollute the FLAT haircut list the moment the
// service goes public. Read endpoints stay open — only writes are gated.
//
// Behavior:
//   - When CALIBRATION_TOKEN is unset or empty, the middleware is a no-op.
//     This preserves the current single-reviewer / local-dev workflow so
//     nobody is locked out by a silent default.
//   - When CALIBRATION_TOKEN is set, callers must present the same token
//     via either the `X-Calibration-Token` header or an
//     `Authorization: Bearer <token>` header. Comparison is timing-safe.
//   - Missing/wrong token returns 401 with a JSON error body that matches
//     the rest of the calibration surface.

const HEADER_NAME = "x-calibration-token";

function readConfiguredToken(): string | null {
  const raw = process.env.CALIBRATION_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractPresentedToken(req: Request): string | null {
  const headerVal = req.header(HEADER_NAME);
  if (typeof headerVal === "string" && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  const auth = req.header("authorization");
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) {
      const tok = match[1].trim();
      if (tok.length > 0) return tok;
    }
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still run a comparison against `aBuf` to keep the timing roughly
    // consistent with the matching-length path.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function requireCalibrationAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = readConfiguredToken();
  if (expected === null) {
    next();
    return;
  }
  const presented = extractPresentedToken(req);
  if (presented === null || !constantTimeEquals(expected, presented)) {
    res.status(401).json({
      error:
        "Calibration mutations require a reviewer token. Send the configured token via the X-Calibration-Token header or Authorization: Bearer <token>.",
    });
    return;
  }
  next();
}

export const __CALIBRATION_AUTH_HEADER = HEADER_NAME;
