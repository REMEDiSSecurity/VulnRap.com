import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Task #113 — gate every mutation under /feedback/calibration/* behind a
// shared reviewer token so the API can be safely exposed publicly. The
// existing calibration namespace (apply, hand-wavy phrase add/remove) was
// open to any caller, which is fine for the current single-reviewer setup
// but would let any visitor pollute the FLAT haircut list the moment the
// service goes public. Read endpoints that expose reviewer-identifying
// metadata (Task #163) are gated with requireCalibrationAuthStrict.
//
// requireCalibrationAuth behavior (used for mutation endpoints):
//   - When CALIBRATION_TOKEN is unset or empty, the middleware is a no-op.
//     This preserves the current single-reviewer / local-dev workflow so
//     nobody is locked out by a silent default.
//   - When CALIBRATION_TOKEN is set, callers must present the same token
//     via either the `X-Calibration-Token` header or an
//     `Authorization: Bearer <token>` header. Comparison is timing-safe.
//   - Missing/wrong token returns 401 with a JSON error body that matches
//     the rest of the calibration surface.
//
// requireCalibrationAuthStrict behavior (used for sensitive read endpoints):
//   - Always requires a valid token — fails closed even when CALIBRATION_TOKEN
//     is unset. This prevents reviewer metadata from leaking publicly when the
//     token env var is not configured.

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

// Task #163 — strict variant: fails closed even when CALIBRATION_TOKEN is
// unset, so sensitive read endpoints that expose reviewer metadata are never
// publicly accessible regardless of deployment configuration.
export function requireCalibrationAuthStrict(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = readConfiguredToken();
  if (expected === null) {
    res.status(401).json({
      error:
        "This endpoint requires calibration auth. Set CALIBRATION_TOKEN and send it via the X-Calibration-Token header or Authorization: Bearer <token>.",
    });
    return;
  }
  const presented = extractPresentedToken(req);
  if (presented === null || !constantTimeEquals(expected, presented)) {
    res.status(401).json({
      error:
        "Calibration auth required. Send the configured token via the X-Calibration-Token header or Authorization: Bearer <token>.",
    });
    return;
  }
  next();
}

export const __CALIBRATION_AUTH_HEADER = HEADER_NAME;

// Task #117 — un-gated probe used by the dashboard to detect a token
// misconfiguration BEFORE the reviewer triggers a mutation that 401s. Returns
// a snapshot of the same three signals the auth middleware computes:
//   * `serverRequiresToken` — is `CALIBRATION_TOKEN` set on the API process?
//   * `tokenPresented`      — did the request include a token (header/bearer)?
//   * `tokenValid`          — does the presented token match the server's?
// `mutationsAllowed` is the derived "would `requireCalibrationAuth.next()` be
// called?" boolean: true when the server is open OR when the presented token
// is valid. Exposed as a separate helper (rather than inlined in the route)
// so the UI probe and the middleware can never drift on what counts as a
// valid token presentation.
export interface CalibrationAuthStatus {
  serverRequiresToken: boolean;
  tokenPresented: boolean;
  tokenValid: boolean;
  mutationsAllowed: boolean;
}

export function getCalibrationAuthStatus(req: Request): CalibrationAuthStatus {
  const expected = readConfiguredToken();
  const presentedToken = extractPresentedToken(req);
  const tokenPresented = presentedToken !== null;
  let tokenValid = false;
  if (expected !== null && presentedToken !== null) {
    tokenValid = constantTimeEquals(expected, presentedToken);
  }
  const serverRequiresToken = expected !== null;
  const mutationsAllowed = !serverRequiresToken || tokenValid;
  return { serverRequiresToken, tokenPresented, tokenValid, mutationsAllowed };
}
