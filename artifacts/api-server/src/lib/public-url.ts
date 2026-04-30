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
