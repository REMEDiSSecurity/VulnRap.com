import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { logger } from "../lib/logger";
import { reportCalibrationAuthRejection } from "./calibration-auth-brute-force-alert";

// Task #116 — throttle wrong-token attempts on the calibration mutation
// endpoints. Task #113 added a shared-token gate (require-calibration-auth.ts)
// that returns a flat 401 on every bad token — once the API is exposed
// publicly an attacker can brute-force the token at the same rate the server
// can answer requests, since the existing /api/reports submit limiter does
// not cover the calibration namespace.
//
// IMPORTANT: this limiter is only ever invoked from inside
// requireCalibrationAuth's *failure* path. A correct-token request never
// reaches it, so a legitimate reviewer who shares an IP (NAT, office Wi-Fi)
// with an attacker is never blocked by an exhausted bucket. Every request
// the limiter sees IS already a failed-auth attempt, which is why we don't
// need express-rate-limit's `skipSuccessfulRequests` machinery here.
//
// Limits are tunable via env so an operator can dial them down further if
// the public surface attracts attention:
//   CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS    — sliding window in ms
//                                              (default: 60 000 ms = 1 minute)
//   CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES — max wrong-token attempts per
//                                              IP per window (default: 10)

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FAILURES = 10;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface CalibrationAuthLimiterOptions {
  windowMs?: number;
  max?: number;
}

export function createCalibrationAuthLimiter(
  opts: CalibrationAuthLimiterOptions = {},
): RateLimitRequestHandler {
  const windowMs =
    opts.windowMs ??
    readPositiveIntEnv(
      "CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_WINDOW_MS,
    );
  const max =
    opts.max ??
    readPositiveIntEnv(
      "CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES",
      DEFAULT_MAX_FAILURES,
    );

  // Task #213 — when the bucket is exhausted, emit a structured warn-level
  // log BEFORE responding so an operator can see sustained brute-force
  // probes in the standard pino log stream. The log includes the request
  // IP (honouring `trust proxy`), the route, the method, and the bucket's
  // configured window/limit — but NEVER the presented (wrong) token value.
  // See the runbook comment in require-calibration-auth.ts for grep tips.
  const throttledMessage = {
    error:
      "Too many failed calibration auth attempts. Please wait a minute before trying again.",
  };

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: throttledMessage,
    handler: (req, res) => {
      logger.warn(
        {
          ip: req.ip ?? null,
          route: req.originalUrl,
          method: req.method,
          windowMs,
          max,
        },
        "calibration auth: wrong-token throttle triggered (429)",
      );
      reportCalibrationAuthRejection({
        status: 429,
        gate: "mutation",
        route: req.originalUrl,
        method: req.method,
        ip: req.ip ?? null,
      });
      res.status(429).json(throttledMessage);
    },
  });
}

export const __CALIBRATION_AUTH_RATE_LIMIT_DEFAULTS = {
  windowMs: DEFAULT_WINDOW_MS,
  max: DEFAULT_MAX_FAILURES,
};
