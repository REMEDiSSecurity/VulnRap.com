/**
 * Result of {@link validateAllowedOriginsEnv}. Returned so callers (and
 * tests) can branch on the outcome without parsing log lines.
 *
 * - `unset`     — ALLOWED_ORIGINS was missing or whitespace-only. The CORS
 *                 middleware will fall back to allowing every cross-origin
 *                 request (open mode).
 * - `valid`     — Every comma-separated entry parsed cleanly as an http(s)
 *                 origin. `origins` contains the normalised allow-list the
 *                 CORS middleware should use.
 * - `invalid`   — ALLOWED_ORIGINS was set but at least one entry was
 *                 malformed. Malformed entries are dropped from `origins`
 *                 (so the allow-list stays restrictive instead of silently
 *                 reverting to open mode), and `invalidEntries` records
 *                 each rejected value alongside a human-readable reason
 *                 for operators to fix.
 */
export type AllowedOriginsEnvValidationResult =
  | { kind: "unset" }
  | { kind: "valid"; origins: string[] }
  | {
      kind: "invalid";
      origins: string[];
      invalidEntries: { value: string; reason: string }[];
    };

/**
 * Minimal logger shape used by {@link validateAllowedOriginsEnv}. Declared
 * structurally so tests can pass a recording stub without depending on the
 * full pino API.
 */
export interface AllowedOriginsEnvLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface EntryValidation {
  ok: boolean;
  value: string;
  reason?: string;
}

function validateOriginEntry(raw: string): EntryValidation {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, value, reason: "empty entry" };
  }
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, value, reason: "must start with http:// or https://" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    return {
      ok: false,
      value,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      value,
      reason: `unsupported protocol "${parsed.protocol}"`,
    };
  }
  // An origin per RFC 6454 is scheme://host[:port] — no path, query, or
  // fragment. The browser's `Origin` header is sent in exactly this form,
  // so any trailing path / query / fragment in the allow-list would never
  // match an actual incoming origin and is almost certainly an
  // operator-pasted URL by mistake (e.g. copying the address bar).
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return {
      ok: false,
      value,
      reason:
        "must be an origin (scheme://host[:port]) with no path, query, or fragment",
    };
  }
  // Normalise: drop a trailing slash so "https://x.com/" matches the
  // browser-sent "https://x.com".
  const normalised = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, value: normalised };
}

/**
 * Parses ALLOWED_ORIGINS into a list of normalised origin strings, dropping
 * any malformed entries. Intended for the CORS middleware — pair with
 * {@link validateAllowedOriginsEnv} at startup so operators see a single
 * log line describing the outcome.
 */
export function parseAllowedOrigins(
  raw: string | undefined = process.env.ALLOWED_ORIGINS,
): string[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map(validateOriginEntry)
    .filter((r) => r.ok)
    .map((r) => r.value);
}

/**
 * Validates `process.env.ALLOWED_ORIGINS` at startup and emits a single
 * log line describing the outcome:
 *
 * - Unset / whitespace-only → `logger.warn` (CORS will allow every
 *   cross-origin request — fine for local dev, dangerous in production).
 * - Set but at least one comma-separated entry is not a parseable
 *   http(s) origin → `logger.error` listing each malformed entry and the
 *   reason it was rejected. Malformed entries are dropped from the
 *   returned `origins` array so the allow-list stays restrictive instead
 *   of silently reverting to open mode.
 * - Set and every entry is a valid origin → no log line (silent success).
 *
 * Returns a structured result so callers and tests can branch on the
 * outcome without scraping log output.
 */
export function validateAllowedOriginsEnv(
  options: {
    logger?: AllowedOriginsEnvLogger;
    env?: NodeJS.ProcessEnv;
  } = {},
): AllowedOriginsEnvValidationResult {
  const env = options.env ?? process.env;
  const raw = env.ALLOWED_ORIGINS;
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  if (trimmed.length === 0) {
    options.logger?.warn(
      { fallback: "allow-all-cross-origin" },
      "ALLOWED_ORIGINS is not set; the API will allow every cross-origin request. Set ALLOWED_ORIGINS to a comma-separated list of http(s) origins (e.g. https://app.example.com) before deploying to production.",
    );
    return { kind: "unset" };
  }

  const results = trimmed.split(",").map(validateOriginEntry);
  const origins = results.filter((r) => r.ok).map((r) => r.value);
  const invalidEntries = results
    .filter((r) => !r.ok)
    .map((r) => ({ value: r.value, reason: r.reason ?? "invalid" }));

  if (invalidEntries.length === 0) {
    return { kind: "valid", origins };
  }

  options.logger?.error(
    { invalidEntries, validOrigins: origins },
    "ALLOWED_ORIGINS contains malformed entries; they have been dropped from the CORS allow-list. Fix or remove these entries so cross-origin requests from the intended origins are not silently rejected.",
  );

  return { kind: "invalid", origins, invalidEntries };
}

/**
 * Type matching the `origin` callback signature used by the `cors`
 * middleware. Re-declared structurally so this module does not have to
 * depend on the `cors` package directly (keeps the helper trivially
 * unit-testable).
 */
export type CorsOriginCallback = (
  err: Error | null,
  allow?: boolean,
) => void;

/**
 * Builds the `origin` callback for the CORS middleware from a
 * {@link AllowedOriginsEnvValidationResult}. Centralised so the
 * branching logic can be unit-tested without spinning up Express.
 *
 * Behaviour:
 *
 * - No `Origin` header (same-origin / curl / server-to-server) → always
 *   allowed. The `Origin` header is only sent by browsers for
 *   cross-origin requests, so blocking its absence would also block
 *   legitimate same-origin and non-browser callers.
 * - `kind === "unset"` → every cross-origin request is allowed
 *   (preserves the historical behaviour when ALLOWED_ORIGINS is not
 *   configured at all). The startup `warn` log already flagged this.
 * - `kind === "valid"` or `kind === "invalid"` → only the explicit
 *   `origins` allow-list is permitted. Notably, when every entry in
 *   ALLOWED_ORIGINS is malformed (`kind === "invalid"` with empty
 *   `origins`), every cross-origin request is denied — we do NOT
 *   silently fall back to open mode just because the operator's typo
 *   left the allow-list empty.
 */
export function buildCorsOriginCallback(
  validation: AllowedOriginsEnvValidationResult,
): (origin: string | undefined, callback: CorsOriginCallback) => void {
  const allowAll = validation.kind === "unset";
  const allowList = validation.kind === "unset" ? [] : validation.origins;
  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowAll || allowList.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  };
}

