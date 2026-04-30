import type { Request } from "express";

/**
 * Canonical fallback used when neither PUBLIC_URL nor a request origin is
 * available. Kept as a module constant so tests can import it without copying
 * the literal string.
 */
export const DEFAULT_PUBLIC_URL = "https://vulnrap.com";

/**
 * The subset of an Express Request we actually depend on. Declared as a
 * structural type so callers can pass a plain stub in tests without faking
 * the entire Request shape.
 */
export type PublicUrlRequest = {
  protocol: string;
  get(name: "host"): string | undefined;
};

export interface BuildPublicUrlOptions {
  /**
   * Optional Express request. When PUBLIC_URL is unset we derive the base
   * URL from `${req.protocol}://${req.get("host")}` so self-hosted
   * deployments that did not configure PUBLIC_URL still get a working link.
   */
  req?: PublicUrlRequest | null;
  /**
   * Optional explicit override (e.g. injected by tests or a higher-level
   * caller). Takes precedence over PUBLIC_URL and the request origin. An
   * empty / whitespace-only string is treated as "not provided" so callers
   * can pass through user-controlled values without special-casing.
   */
  override?: string | null;
  /**
   * Optional path to append to the base URL. A leading slash is added if
   * missing. Pass without a leading slash to append a non-rooted suffix
   * (e.g. "docs/foo.md") — the helper will normalize it to "/docs/foo.md".
   * If you need a query string or fragment, include it in `path`.
   */
  path?: string;
}

/**
 * Returns a canonical public base URL (optionally with a path appended) using
 * a single, shared precedence:
 *
 *   1. `options.override` (when non-empty)
 *   2. `process.env.PUBLIC_URL` (when non-empty)
 *   3. The request-derived origin (when `options.req` is provided and has a host)
 *   4. `DEFAULT_PUBLIC_URL` ("https://vulnrap.com")
 *
 * Trailing slashes on the resolved base are always stripped so callers can
 * concatenate `${base}/whatever` safely without doubling up.
 */
export function buildPublicUrl(options: BuildPublicUrlOptions = {}): string {
  const { req, override, path } = options;

  const overrideTrimmed = typeof override === "string" ? override.trim() : "";
  const envTrimmed = (process.env.PUBLIC_URL ?? "").trim();

  let base: string;
  if (overrideTrimmed.length > 0) {
    base = overrideTrimmed;
  } else if (envTrimmed.length > 0) {
    base = envTrimmed;
  } else {
    const host = req?.get("host");
    base = host ? `${req!.protocol}://${host}` : DEFAULT_PUBLIC_URL;
  }

  base = base.replace(/\/+$/, "");

  if (path === undefined || path === null || path.length === 0) {
    return base;
  }

  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Convenience wrapper for routes that want the same precedence ladder using
 * an Express `Request` directly. Equivalent to
 * `buildPublicUrl({ req, path })`.
 */
export function buildPublicUrlForRequest(
  req: Request | PublicUrlRequest | null | undefined,
  path?: string,
): string {
  return buildPublicUrl({ req: req ?? null, path });
}

/**
 * Result of {@link validatePublicUrlEnv}. Returned so callers (and tests)
 * can branch on the outcome without parsing log lines.
 *
 * - `unset`     — PUBLIC_URL was missing or whitespace-only. Canonical
 *                 links will fall back to the request origin (or
 *                 {@link DEFAULT_PUBLIC_URL} when no request is available).
 * - `valid`     — PUBLIC_URL parsed cleanly as an http(s) URL.
 * - `malformed` — PUBLIC_URL was set but did not parse as a URL or used a
 *                 protocol other than http/https. Operators should fix this
 *                 before reviewers see broken links in webhooks and exports.
 */
export type PublicUrlEnvValidationResult =
  | { kind: "unset" }
  | { kind: "valid"; url: string }
  | { kind: "malformed"; value: string; reason: string };

/**
 * Minimal logger shape used by {@link validatePublicUrlEnv}. Declared
 * structurally so tests can pass a recording stub without depending on the
 * full pino API.
 */
export interface PublicUrlEnvLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Validates `process.env.PUBLIC_URL` at startup and emits a single log line
 * describing the outcome:
 *
 * - Unset / whitespace-only → `logger.warn` (fallback to request origin).
 * - Set but not parseable as a URL, or using a non-http(s) protocol →
 *   `logger.error` (operators should fix the typo before reviewers see
 *   broken links in webhooks and exported reports).
 * - Set and valid → no log line (silent success).
 *
 * Returns a structured result so callers and tests can branch on the
 * outcome without scraping log output.
 */
export function validatePublicUrlEnv(
  options: { logger?: PublicUrlEnvLogger; env?: NodeJS.ProcessEnv } = {},
): PublicUrlEnvValidationResult {
  const env = options.env ?? process.env;
  const raw = env.PUBLIC_URL;
  const trimmed = typeof raw === "string" ? raw.trim() : "";

  if (trimmed.length === 0) {
    options.logger?.warn(
      { fallback: "request-origin-or-default" },
      "PUBLIC_URL is not set; canonical links will fall back to the request origin (or https://vulnrap.com when no request is available).",
    );
    return { kind: "unset" };
  }

  // Require the explicit `http://` / `https://` prefix before letting `new
  // URL` parse the value. Without this guard, scheme-only typos like
  // `https:example.com` parse successfully (the `URL` parser treats the
  // host as a relative path) and would be returned as "valid" even though
  // they would yield broken canonical links when used verbatim.
  if (!/^https?:\/\//i.test(trimmed)) {
    const reason = "must start with http:// or https://";
    options.logger?.error(
      { publicUrl: trimmed, reason },
      "PUBLIC_URL is set but does not start with http:// or https://; canonical links will be broken until this is fixed.",
    );
    return { kind: "malformed", value: trimmed, reason };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    options.logger?.error(
      { publicUrl: trimmed, reason },
      "PUBLIC_URL is set but is not a parseable URL; canonical links will be broken until this is fixed.",
    );
    return { kind: "malformed", value: trimmed, reason };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const reason = `unsupported protocol "${parsed.protocol}"`;
    options.logger?.error(
      { publicUrl: trimmed, reason },
      "PUBLIC_URL is set but does not start with http:// or https://; canonical links will be broken until this is fixed.",
    );
    return { kind: "malformed", value: trimmed, reason };
  }

  return { kind: "valid", url: trimmed };
}
