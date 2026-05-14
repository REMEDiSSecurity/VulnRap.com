// Slack hosted-relay routes. UNDOCUMENTED — no nav link, no marketing,
// not in the sitemap. Reachable only via direct URL during alpha:
//   GET  /api/slack/install                     — install landing page
//   GET  /api/slack/install/start               — kicks off OAuth
//   GET  /api/slack/install/callback            — OAuth return + tenant create
//   POST /api/slack/notify/:token               — relay endpoint (hot path)
//   POST /api/slack/disconnect/:token           — revoke + delete
//   GET  /api/slack/tenant/:token               — JSON status
//
// Every route returns 503 `{ error: "slack_relay_disabled" }` when the
// SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_RELAY_MASTER_KEY env
// trio is incomplete. This keeps the code path shippable to main
// without exposing the relay to traffic until we've vetted it.
//
// See artifacts/api-server/docs/integrations/slack-hosted-relay-design.md
// for the full threat model and rollout phases.

import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, slackTenantsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { buildPublicUrl } from "../lib/public-url";
import {
  getSlackRelayConfig,
  isSlackRelayEnabled,
  SLACK_BOT_SCOPES,
} from "../lib/slack-relay-config";
import {
  sealBotToken,
  openBotToken,
  type SealedBotToken,
} from "../lib/slack-token-crypto";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Disabled-by-default gate. Mounted before every other route so a missing
// env trio short-circuits with a stable, machine-readable response.
// ---------------------------------------------------------------------------

router.use("/slack", (req, res, next): void => {
  if (!isSlackRelayEnabled()) {
    res.status(503).json({
      error: "slack_relay_disabled",
      message:
        "The hosted Slack relay is not configured on this deployment. " +
        "See docs/integrations/slack-hosted-relay-design.md.",
    });
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Cookie helpers — minimal inline parser/setter so we avoid pulling
// cookie-parser into the global middleware stack just for these routes.
// ---------------------------------------------------------------------------

function parseCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  opts: { maxAgeSec: number },
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/api/slack",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res: Response, name: string): void {
  setCookie(res, name, "", { maxAgeSec: 0 });
}

// ---------------------------------------------------------------------------
// In-memory per-tenant rate limiter. Restart resets the bucket — fine
// for v0 because alpha runs on one instance and the inner Slack 429
// handling provides backstop pressure even after a restart.
// ---------------------------------------------------------------------------

const tenantBuckets = new Map<string, { count: number; resetAt: number }>();
const BUCKET_WINDOW_MS = 60 * 1000;

function takeRateLimitToken(tenantId: string, capacity: number): boolean {
  const now = Date.now();
  const bucket = tenantBuckets.get(tenantId);
  if (!bucket || bucket.resetAt <= now) {
    tenantBuckets.set(tenantId, { count: 1, resetAt: now + BUCKET_WINDOW_MS });
    return true;
  }
  if (bucket.count >= capacity) return false;
  bucket.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Notify-token helpers. The raw token is shown to the installer once
// and never persisted. We store sha256(token) and last 4 chars (UX).
// ---------------------------------------------------------------------------

function hashNotifyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintNotifyToken(): { raw: string; hash: string; last4: string } {
  // 32 bytes → 43 base64url chars. Unguessable, URL-safe.
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashNotifyToken(raw), last4: raw.slice(-4) };
}

// ---------------------------------------------------------------------------
// HTML render helpers — self-contained pages so the install flow does
// not touch the SPA. Keep these tiny; the relay is for a handful of
// alpha testers, not a marketing surface.
// ---------------------------------------------------------------------------

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} — VulnRap</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 640px; margin: 6vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  p { color: #444; }
  @media (prefers-color-scheme: dark) { p { color: #bbb; } }
  code, pre { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 4px; font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
  @media (prefers-color-scheme: dark) { code, pre { background: #222; } }
  pre { padding: 0.75rem 1rem; overflow-x: auto; }
  .btn { display: inline-block; background: #4a154b; color: #fff; padding: 0.55rem 1rem; border-radius: 6px; text-decoration: none; font-weight: 600; }
  .btn:hover { background: #611f64; }
  .ok { color: #15803d; font-weight: 600; }
  .err { color: #b91c1c; font-weight: 600; }
  .muted { color: #666; font-size: 0.9rem; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5rem 0; }
</style>
</head><body>${body}</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// GET /api/slack/install — landing page with the "Add to Slack" button.
// ---------------------------------------------------------------------------

router.get("/slack/install", (_req, res): void => {
  res
    .status(200)
    .type("html")
    .send(
      htmlPage(
        "Add to Slack",
        `<h1>VulnRap → Slack (alpha)</h1>
         <p>Click below to install the relay into your Slack workspace. You'll
         be asked to pick a channel; we'll post triage cards there whenever
         you call your private notify URL.</p>
         <p><a class="btn" href="/api/slack/install/start">Add to Slack</a></p>
         <hr>
         <p class="muted">This page is intentionally undocumented during the
         alpha. Bot scopes requested: <code>${SLACK_BOT_SCOPES.join(
           "</code>, <code>",
         )}</code>. Bot tokens are encrypted at rest with AES-256-GCM. We
         never store report bodies — every notify call is scored synchronously
         and forwarded.</p>`,
      ),
    );
});

// ---------------------------------------------------------------------------
// GET /api/slack/install/start — issue state cookie, 302 to Slack.
// ---------------------------------------------------------------------------

router.get("/slack/install/start", (req, res): void => {
  const cfg = getSlackRelayConfig();
  const state = randomBytes(24).toString("base64url");
  setCookie(res, "vr_slack_oauth_state", state, { maxAgeSec: 600 });

  const redirectUri =
    cfg.publicUrlOverride !== null
      ? `${cfg.publicUrlOverride}/api/slack/install/callback`
      : buildPublicUrl({ req, path: "/api/slack/install/callback" });

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("user_scope", "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

// ---------------------------------------------------------------------------
// GET /api/slack/install/callback — exchange code, persist tenant.
// Returns a self-contained HTML page that displays the notify URL ONCE.
// ---------------------------------------------------------------------------

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { channel_id: string; channel: string };
}

router.get("/slack/install/callback", async (req, res): Promise<void> => {
  const cfg = getSlackRelayConfig();

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookieState = parseCookie(req, "vr_slack_oauth_state") ?? "";
  clearCookie(res, "vr_slack_oauth_state");

  if (!code || !state || !cookieState) {
    res
      .status(400)
      .type("html")
      .send(
        htmlPage(
          "Install failed",
          `<h1 class="err">Install failed</h1>
           <p>Missing OAuth code or state. Try again from
           <a href="/api/slack/install">/api/slack/install</a>.</p>`,
        ),
      );
    return;
  }
  // Constant-time state compare.
  const a = Buffer.from(state);
  const b = Buffer.from(cookieState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logger.warn(
      { route: "slack-relay" },
      "slack relay install: state mismatch",
    );
    res
      .status(400)
      .type("html")
      .send(
        htmlPage(
          "Install failed",
          `<h1 class="err">Install failed</h1>
           <p>OAuth state mismatch. This usually means the install link
           was opened in a different browser session than the one that
           started it. Restart from
           <a href="/api/slack/install">/api/slack/install</a>.</p>`,
        ),
      );
    return;
  }

  const redirectUri =
    cfg.publicUrlOverride !== null
      ? `${cfg.publicUrlOverride}/api/slack/install/callback`
      : buildPublicUrl({ req, path: "/api/slack/install/callback" });

  let oauth: SlackOAuthResponse;
  try {
    const slackRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    oauth = (await slackRes.json()) as SlackOAuthResponse;
  } catch (err) {
    logger.error(
      { route: "slack-relay", err: String(err) },
      "slack relay install: network error during oauth.v2.access",
    );
    res
      .status(502)
      .type("html")
      .send(
        htmlPage(
          "Install failed",
          `<h1 class="err">Install failed</h1>
           <p>Couldn't reach Slack. Try again in a minute.</p>`,
        ),
      );
    return;
  }

  if (
    !oauth.ok ||
    !oauth.access_token ||
    !oauth.bot_user_id ||
    !oauth.team ||
    !oauth.incoming_webhook
  ) {
    logger.warn(
      { route: "slack-relay", error: oauth.error ?? "unknown" },
      "slack relay install: oauth.v2.access returned not-ok",
    );
    res
      .status(400)
      .type("html")
      .send(
        htmlPage(
          "Install failed",
          `<h1 class="err">Install failed</h1>
           <p>Slack returned: <code>${escapeHtml(oauth.error ?? "unknown_error")}</code>.
           Restart from <a href="/api/slack/install">/api/slack/install</a>.</p>`,
        ),
      );
    return;
  }

  const sealed = sealBotToken(oauth.access_token);
  const notify = mintNotifyToken();

  await db.insert(slackTenantsTable).values({
    teamId: oauth.team.id,
    teamName: oauth.team.name,
    channelId: oauth.incoming_webhook.channel_id,
    channelName: oauth.incoming_webhook.channel,
    botUserId: oauth.bot_user_id,
    botTokenCiphertext: sealed.ciphertext,
    botTokenNonce: sealed.nonce,
    botTokenTag: sealed.tag,
    keyVersion: sealed.keyVersion,
    notifyTokenHash: notify.hash,
    notifyTokenLast4: notify.last4,
    status: "active",
  });

  logger.info(
    {
      route: "slack-relay",
      teamId: oauth.team.id,
      channelId: oauth.incoming_webhook.channel_id,
    },
    "slack relay install: tenant provisioned",
  );

  const notifyUrl = buildPublicUrl({
    req,
    path: `/api/slack/notify/${notify.raw}`,
  });

  res
    .status(200)
    .type("html")
    .send(
      htmlPage(
        "Installed",
        `<h1 class="ok">Installed ✓</h1>
         <p>Workspace: <strong>${escapeHtml(oauth.team.name)}</strong>
         &nbsp;·&nbsp; Channel: <strong>#${escapeHtml(
           oauth.incoming_webhook.channel,
         )}</strong></p>
         <p>Your private notify URL — <strong>copy this now, we cannot show it again</strong>:</p>
         <pre>${escapeHtml(notifyUrl)}</pre>
         <p>Test it from the shell:</p>
         <pre>curl -fsS -X POST ${escapeHtml(notifyUrl)} \\
  -F "rawText=$(cat report.md)"</pre>
         <hr>
         <p class="muted">To disconnect: POST to
         <code>/api/slack/disconnect/&lt;your-token&gt;</code>. To check
         status: GET <code>/api/slack/tenant/&lt;your-token&gt;</code>.</p>`,
      ),
    );
});

// ---------------------------------------------------------------------------
// POST /api/slack/notify/:token — the hot path.
// ---------------------------------------------------------------------------

interface CheckScoreResult {
  vulnrap?: {
    compositeScore?: number;
    compositeLabel?: string;
    engines?: Array<{ engine: string; score: number; verdict?: string }>;
  };
  recommendation?: { action?: string; reason?: string };
  similarityMatches?: unknown[];
  slopTier?: string;
}

const ACTION_EMOJI: Record<string, string> = {
  PRIORITIZE: ":rotating_light:",
  MANUAL_REVIEW: ":eyes:",
  STANDARD_TRIAGE: ":inbox_tray:",
  CHALLENGE_REPORTER: ":question:",
  AUTO_CLOSE: ":wastebasket:",
};

function buildBlocks(scored: CheckScoreResult): unknown[] {
  const composite = scored.vulnrap?.compositeScore ?? "?";
  const label = scored.vulnrap?.compositeLabel ?? scored.slopTier ?? "?";
  const action = scored.recommendation?.action ?? "STANDARD_TRIAGE";
  const reason = scored.recommendation?.reason ?? "";
  const emoji = ACTION_EMOJI[action] ?? ":mag:";
  const dupes = (scored.similarityMatches ?? []).length;
  const engineLines =
    (scored.vulnrap?.engines ?? [])
      .map((e) => `• *${e.engine}* — ${e.score}/100 (${e.verdict ?? "?"})`)
      .join("\n") || "_no engine breakdown_";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji}  VulnRap analysis` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Composite*\n${composite}/100 — ${label}` },
        { type: "mrkdwn", text: `*Recommended*\n\`${action}\`` },
        { type: "mrkdwn", text: `*Similar reports*\n${dupes}` },
        { type: "mrkdwn", text: `*Reason*\n${reason || "_n/a_"}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: engineLines } },
  ];
}

const AUTO_DISABLE_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "token_revoked",
  "account_inactive",
  "invalid_auth",
]);

router.post("/slack/notify/:token", async (req, res): Promise<void> => {
  const cfg = getSlackRelayConfig();
  const token = req.params.token ?? "";
  if (!token) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const tenant = (
    await db
      .select()
      .from(slackTenantsTable)
      .where(eq(slackTenantsTable.notifyTokenHash, hashNotifyToken(token)))
      .limit(1)
  )[0];

  if (!tenant) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (tenant.status !== "active") {
    res.status(410).json({
      error: "tenant_disabled",
      reason: tenant.disabledReason,
    });
    return;
  }
  if (
    tenant.rateLimitedUntil &&
    new Date(tenant.rateLimitedUntil).getTime() > Date.now()
  ) {
    const retryAfter = Math.max(
      1,
      Math.ceil(
        (new Date(tenant.rateLimitedUntil).getTime() - Date.now()) / 1000,
      ),
    );
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "tenant_rate_limited", retryAfter });
    return;
  }
  if (!takeRateLimitToken(tenant.id, cfg.notifyRateLimitPerMin)) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "tenant_rate_limited", retryAfter: 60 });
    return;
  }

  const rawText =
    typeof req.body?.rawText === "string" ? req.body.rawText : "";
  if (rawText.trim().length === 0) {
    res.status(400).json({
      error: "missing_raw_text",
      message: "POST a `rawText` field with the report body.",
    });
    return;
  }

  // Score by calling /api/reports/check on this same process. Going
  // through HTTP keeps us using the existing rate-limit bucket and
  // request validation for free; on a single-instance deployment the
  // round-trip is sub-millisecond.
  let scored: CheckScoreResult;
  const selfBase =
    cfg.publicUrlOverride !== null
      ? cfg.publicUrlOverride
      : buildPublicUrl({ req, path: "" });
  try {
    const checkRes = await fetch(`${selfBase}/api/reports/check`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ rawText }).toString(),
    });
    if (!checkRes.ok) {
      logger.warn(
        { route: "slack-relay", status: checkRes.status, tenantId: tenant.id },
        "slack relay notify: scoring upstream non-2xx",
      );
      res.status(502).json({ error: "scoring_failed" });
      return;
    }
    scored = (await checkRes.json()) as CheckScoreResult;
  } catch (err) {
    logger.error(
      { route: "slack-relay", err: String(err), tenantId: tenant.id },
      "slack relay notify: scoring fetch threw",
    );
    res.status(502).json({ error: "scoring_failed" });
    return;
  }

  // Decrypt bot token for a single Slack call. Never log it.
  let botToken: string;
  try {
    const sealed: SealedBotToken = {
      ciphertext: tenant.botTokenCiphertext,
      nonce: tenant.botTokenNonce,
      tag: tenant.botTokenTag,
      keyVersion: tenant.keyVersion,
    };
    botToken = openBotToken(sealed);
  } catch (err) {
    logger.error(
      { route: "slack-relay", tenantId: tenant.id, err: String(err) },
      "slack relay notify: decrypt_failed",
    );
    res.status(500).json({ error: "decrypt_failed" });
    return;
  }

  const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: tenant.channelId,
      blocks: buildBlocks(scored),
    }),
  });
  // Best-effort wipe of the local plaintext reference.
  botToken = "";

  if (slackRes.status === 429) {
    const retryAfterSec =
      Number(slackRes.headers.get("Retry-After") ?? "30") || 30;
    await db
      .update(slackTenantsTable)
      .set({
        rateLimitedUntil: new Date(Date.now() + retryAfterSec * 1000),
      })
      .where(eq(slackTenantsTable.id, tenant.id));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "slack_rate_limited", retryAfter: retryAfterSec });
    return;
  }

  const slackBody = (await slackRes.json()) as {
    ok: boolean;
    error?: string;
    ts?: string;
  };

  if (!slackBody.ok) {
    const error = slackBody.error ?? "unknown";
    if (AUTO_DISABLE_ERRORS.has(error)) {
      await db
        .update(slackTenantsTable)
        .set({
          status: "disabled",
          disabledReason: error,
          disabledAt: new Date(),
        })
        .where(eq(slackTenantsTable.id, tenant.id));
      logger.warn(
        { route: "slack-relay", tenantId: tenant.id, error },
        "slack relay notify: auto-disabled",
      );
      res.status(410).json({ error: "tenant_disabled", reason: error });
      return;
    }
    logger.warn(
      { route: "slack-relay", tenantId: tenant.id, error },
      "slack relay notify: slack returned not-ok",
    );
    res.status(502).json({ error: "slack_error", reason: error });
    return;
  }

  await db
    .update(slackTenantsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(slackTenantsTable.id, tenant.id));

  res.status(200).json({ ok: true, slackTs: slackBody.ts });
});

// ---------------------------------------------------------------------------
// POST /api/slack/disconnect/:token — revoke + delete row.
// ---------------------------------------------------------------------------

router.post("/slack/disconnect/:token", async (req, res): Promise<void> => {
  const token = req.params.token ?? "";
  const tenant = (
    await db
      .select()
      .from(slackTenantsTable)
      .where(eq(slackTenantsTable.notifyTokenHash, hashNotifyToken(token)))
      .limit(1)
  )[0];
  if (!tenant) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Best-effort Slack-side revoke. Failure here doesn't block the
  // local delete — the tenant wants out, give them out.
  try {
    const sealed: SealedBotToken = {
      ciphertext: tenant.botTokenCiphertext,
      nonce: tenant.botTokenNonce,
      tag: tenant.botTokenTag,
      keyVersion: tenant.keyVersion,
    };
    let botToken: string | null = null;
    try {
      botToken = openBotToken(sealed);
    } catch {
      // Decrypt failed (key rotated out?) — skip the revoke, still
      // delete the row.
    }
    if (botToken) {
      await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}` },
      }).catch(() => {});
      botToken = "";
    }
  } catch {
    // Swallow — local delete is the source of truth.
  }
  await db
    .delete(slackTenantsTable)
    .where(eq(slackTenantsTable.id, tenant.id));
  logger.info(
    { route: "slack-relay", tenantId: tenant.id },
    "slack relay disconnect: tenant deleted",
  );
  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/slack/tenant/:token — JSON status.
// ---------------------------------------------------------------------------

router.get("/slack/tenant/:token", async (req, res): Promise<void> => {
  const token = req.params.token ?? "";
  const tenant = (
    await db
      .select({
        id: slackTenantsTable.id,
        teamName: slackTenantsTable.teamName,
        channelName: slackTenantsTable.channelName,
        status: slackTenantsTable.status,
        disabledReason: slackTenantsTable.disabledReason,
        rateLimitedUntil: slackTenantsTable.rateLimitedUntil,
        createdAt: slackTenantsTable.createdAt,
        lastUsedAt: slackTenantsTable.lastUsedAt,
        notifyTokenLast4: slackTenantsTable.notifyTokenLast4,
      })
      .from(slackTenantsTable)
      .where(eq(slackTenantsTable.notifyTokenHash, hashNotifyToken(token)))
      .limit(1)
  )[0];
  if (!tenant) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.status(200).json(tenant);
});

export default router;
