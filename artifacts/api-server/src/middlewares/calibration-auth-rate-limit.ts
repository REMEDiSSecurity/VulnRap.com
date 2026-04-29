import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

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
  const windowMs = opts.windowMs ?? readPositiveIntEnv(
    "CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS",
    DEFAULT_WINDOW_MS,
  );
  const max = opts.max ?? readPositiveIntEnv(
    "CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES",
    DEFAULT_MAX_FAILURES,
  );

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error:
        "Too many failed calibration auth attempts. Please wait a minute before trying again.",
    },
  });
}

export const __CALIBRATION_AUTH_RATE_LIMIT_DEFAULTS = {
  windowMs: DEFAULT_WINDOW_MS,
  max: DEFAULT_MAX_FAILURES,
};
