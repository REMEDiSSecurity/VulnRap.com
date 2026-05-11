// Task #1310 — Fail-closed production startup validation.
//
// In production we require an explicit set of environment variables to
// be configured. Missing values silently fell back to permissive
// defaults (allow-all CORS, request-origin canonical URLs, ephemeral
// per-process HMAC keys, optional metrics auth) which were fine for
// local dev but dangerous in a public deployment. This module collects
// the required vars, validates them once at startup, and throws on any
// missing / malformed value so a misconfigured production deploy
// refuses to boot instead of accepting traffic with insecure defaults.
//
// Dev (NODE_ENV !== "production") behaviour is unchanged — every value
// remains optional so `pnpm dev` keeps working without a `.env`.

import {
  validateAllowedOriginsEnv,
  type AllowedOriginsEnvLogger,
  type AllowedOriginsEnvValidationResult,
} from "./allowed-origins";
import {
  validatePublicUrlEnv,
  type PublicUrlEnvLogger,
  type PublicUrlEnvValidationResult,
} from "./public-url";

export interface ProdConfigLogger
  extends AllowedOriginsEnvLogger,
    PublicUrlEnvLogger {}

export interface ProdConfigResult {
  publicUrl: PublicUrlEnvValidationResult;
  allowedOrigins: AllowedOriginsEnvValidationResult;
}

const REQUIRED_TOKEN_VARS = [
  "CALIBRATION_TOKEN",
  "VISITOR_HMAC_KEY",
  "METRICS_TOKEN",
] as const;

export type RequiredProdSecret = (typeof REQUIRED_TOKEN_VARS)[number];

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates the deployment configuration. In production, throws a
 * descriptive error listing every missing / malformed required value so
 * the operator sees one error instead of N. In dev / test, just runs
 * the per-value validators (which log warnings but never throw) and
 * returns the structured results.
 */
export function validateProductionConfig(
  options: { env?: NodeJS.ProcessEnv; logger?: ProdConfigLogger } = {},
): ProdConfigResult {
  const env = options.env ?? process.env;
  const logger = options.logger;

  const publicUrl = validatePublicUrlEnv({ logger, env });
  const allowedOrigins = validateAllowedOriginsEnv({ logger, env });

  if (!isProduction(env)) {
    return { publicUrl, allowedOrigins };
  }

  const problems: string[] = [];

  if (publicUrl.kind === "unset") {
    problems.push(
      "PUBLIC_URL is not set. Set it to the canonical https origin of the deployment so security.txt, OG cards, sitemap, and Atom feeds emit stable URLs and so an attacker cannot poison them via a spoofed Host header.",
    );
  } else if (publicUrl.kind === "malformed") {
    problems.push(
      `PUBLIC_URL is malformed: ${publicUrl.reason}. Set it to a parseable http(s) URL (e.g. https://vulnrap.com).`,
    );
  }

  if (allowedOrigins.kind === "unset") {
    problems.push(
      "ALLOWED_ORIGINS is not set. Set it to a comma-separated list of permitted browser origins (e.g. https://vulnrap.com) — without it the API would allow every cross-origin caller.",
    );
  } else if (
    allowedOrigins.kind === "invalid" &&
    allowedOrigins.origins.length === 0
  ) {
    problems.push(
      "ALLOWED_ORIGINS is set but every entry is malformed; the resulting allow-list is empty. Fix the malformed entries or remove ALLOWED_ORIGINS so this check can flag it explicitly.",
    );
  }

  for (const name of REQUIRED_TOKEN_VARS) {
    if (!nonEmpty(env[name])) {
      problems.push(
        `${name} is not set. ${describeRequirement(name)}`,
      );
    }
  }

  if (problems.length > 0) {
    const message = [
      "Refusing to start in production: required environment variables are missing or invalid.",
      ...problems.map((p, i) => `  ${i + 1}. ${p}`),
      "Set the values above (or in your hosting provider's secret manager) and redeploy.",
    ].join("\n");
    throw new Error(message);
  }

  return { publicUrl, allowedOrigins };
}

function describeRequirement(name: RequiredProdSecret): string {
  switch (name) {
    case "CALIBRATION_TOKEN":
      return "Required so reviewer-only mutation endpoints can authenticate; without it every calibration mutation 401s.";
    case "VISITOR_HMAC_KEY":
      return "Required so visitor / phrase-suggestion / showcase-nomination per-IP HMACs are stable across processes. Without it counts drift on every restart.";
    case "METRICS_TOKEN":
      return "Required so the Prometheus scrape endpoint is gated. Without it /api/metrics is open to the public Internet and leaks per-route latency/volume telemetry.";
  }
}
