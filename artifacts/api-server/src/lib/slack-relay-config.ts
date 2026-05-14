// Slack hosted-relay configuration + feature-flag gating.
//
// The relay is dormant unless ALL THREE of the following env vars
// are set:
//   - SLACK_CLIENT_ID         (from the VulnRap-owned Slack app)
//   - SLACK_CLIENT_SECRET     (same)
//   - SLACK_RELAY_MASTER_KEY  (32 random bytes, base64; used by
//                              slack-token-crypto to seal bot tokens)
//
// When any are missing, all five Slack relay routes return 503 with
// `{ error: "slack_relay_disabled" }` and the codebase has zero
// behavioural impact. This lets us merge the relay code into main
// without exposing it to traffic until we've vetted the OAuth flow.
//
// Optional knobs:
//   - SLACK_RELAY_PUBLIC_URL  — overrides buildPublicUrl() for the
//                              OAuth redirect URI. Useful when the
//                              relay is reachable on a different host
//                              than the rest of the API. Falls back
//                              to the public URL helper.
//   - SLACK_RELAY_RATE_LIMIT_PER_MIN — per-tenant cap on
//                              POST /api/slack/notify/:token (default 30).

import { isSlackTokenCryptoConfigured } from "./slack-token-crypto";

export interface SlackRelayConfig {
  clientId: string;
  clientSecret: string;
  publicUrlOverride: string | null;
  notifyRateLimitPerMin: number;
}

function trimEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function isSlackRelayEnabled(): boolean {
  if (!isSlackTokenCryptoConfigured()) return false;
  if (trimEnv("SLACK_CLIENT_ID").length === 0) return false;
  if (trimEnv("SLACK_CLIENT_SECRET").length === 0) return false;
  return true;
}

export function getSlackRelayConfig(): SlackRelayConfig {
  if (!isSlackRelayEnabled()) {
    throw new Error(
      "Slack relay is disabled. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, " +
        "and SLACK_RELAY_MASTER_KEY to enable.",
    );
  }
  const overrideRaw = trimEnv("SLACK_RELAY_PUBLIC_URL");
  const rateRaw = trimEnv("SLACK_RELAY_RATE_LIMIT_PER_MIN");
  const rate = rateRaw.length > 0 ? Number(rateRaw) : 30;
  return {
    clientId: trimEnv("SLACK_CLIENT_ID"),
    clientSecret: trimEnv("SLACK_CLIENT_SECRET"),
    publicUrlOverride: overrideRaw.length > 0 ? overrideRaw : null,
    notifyRateLimitPerMin:
      Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 30,
  };
}

/**
 * Bot scopes requested at OAuth time. Deliberately minimal — see
 * slack-hosted-relay-design.md "Scope minimization". Adding scopes
 * here widens the blast radius of every persisted bot token; do not
 * add `users:read`, `channels:history`, etc. without a written
 * threat-model update.
 */
export const SLACK_BOT_SCOPES = ["chat:write", "incoming-webhook"] as const;
