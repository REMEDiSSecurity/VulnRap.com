import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { createCalibrationAuthLimiter } from "./calibration-auth-rate-limit";

// Task #113 — gate every mutation under /feedback/calibration/* behind a
// shared reviewer token so the API can be safely exposed publicly. The
// existing calibration namespace (apply, hand-wavy phrase add/remove) was
// open to any caller, which is fine for the current single-reviewer setup
// but would let any visitor pollute the FLAT haircut list the moment the
// service goes public. Read endpoints that expose reviewer-identifying
// metadata (Task #163) are gated with requireCalibrationAuthStrict.
//
// Task #116 — wrong-token attempts on the mutation gate are now throttled
// per-IP. Crucially, the limiter only sees requests that already FAILED
// the token check: a correct-token request returns next() before the
// limiter is touched, so a legitimate reviewer who happens to share an IP
// (NAT, office network) with an attacker is never blocked by the
// brute-force defense.
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
//   - Repeated 401s from the same IP within the limiter window return 429
//     instead. The 401 path is wrapped in the limiter so successful auth
//     never increments the bucket and never gets blocked by it.
//
// requireCalibrationAuthStrict behavior (used for sensitive read endpoints):
//   - Always requires a valid token — fails closed even when CALIBRATION_TOKEN
//     is unset. This prevents reviewer metadata from leaking publicly when the
//     token env var is not configured.
//   - The Task #116 throttle does NOT apply here: the task scopes the
//     brute-force defense to mutation routes only. Read 401s remain unthrottled.

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

// Lazy singleton so the production process gets a single limiter built from
// env vars on first use, while tests can inject their own (smaller-window,
// isolated) instance via __setCalibrationAuthLimiterForTests.
let limiterInstance: RateLimitRequestHandler | null = null;

function getLimiter(): RateLimitRequestHandler {
  if (limiterInstance === null) {
    limiterInstance = createCalibrationAuthLimiter();
  }
  return limiterInstance;
}

/**
 * Test seam — replace the lazy limiter with a freshly built one (or null to
 * force the next request to construct from env on demand). Each test should
 * inject a dedicated limiter so its in-memory hit store cannot leak counts
 * to neighbouring tests.
 */
export function __setCalibrationAuthLimiterForTests(
  limiter: RateLimitRequestHandler | null,
): void {
  limiterInstance = limiter;
}

const WRONG_TOKEN_MESSAGE =
  "Calibration mutations require a reviewer token. Send the configured token via the X-Calibration-Token header or Authorization: Bearer <token>.";

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
  if (presented !== null && constantTimeEquals(expected, presented)) {
    // Correct token — pass through immediately. The limiter is NEVER touched
    // on this path, so a valid reviewer is never throttled regardless of how
    // many failed attempts have come from the same IP.
    next();
    return;
  }
  // Wrong or missing token — route this single request through the per-IP
  // limiter. If the bucket is full, the limiter responds with 429 itself
  // and our callback is never invoked. Otherwise the limiter increments the
  // hit count and calls our callback, which sends the standard 401.
  const limiter = getLimiter();
  limiter(req, res, () => {
    res.status(401).json({ error: WRONG_TOKEN_MESSAGE });
  });
}

// Task #163 — strict variant: fails closed even when CALIBRATION_TOKEN is
// unset, so sensitive read endpoints that expose reviewer metadata are never
// publicly accessible regardless of deployment configuration. The Task #116
// throttle is intentionally NOT applied here; the task scopes brute-force
// defense to mutation routes.
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
