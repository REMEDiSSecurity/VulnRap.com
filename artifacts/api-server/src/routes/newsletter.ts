import { createHash, createHmac, randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db, newsletterSubscriptionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { buildPublicUrl } from "../lib/public-url";
import { sendNewsletterEmail } from "../lib/newsletter-email";

const router: IRouter = Router();

let HMAC_KEY = process.env.VISITOR_HMAC_KEY;
if (!HMAC_KEY) {
  HMAC_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "[newsletter] VISITOR_HMAC_KEY not set — using ephemeral per-process key. " +
      "Newsletter email_hmac values will not be deduplicatable across restarts.",
  );
}
const KEY: string = HMAC_KEY;

const FORWARD_URL = process.env.NEWSLETTER_FORWARD_URL?.trim() || null;
const FORWARD_TOKEN = process.env.NEWSLETTER_FORWARD_TOKEN?.trim() || null;

// Task #733 — Optional double opt-in. When `NEWSLETTER_DOUBLE_OPT_IN`
// is truthy ("1" / "true" / "yes"), new signups are NOT marked
// confirmed until the user clicks the link in the confirm email. The
// HMAC row is still inserted immediately so the address cannot be
// silently re-signed-up while a confirmation is outstanding.
function doubleOptInEnabled(): boolean {
  const v = (process.env.NEWSLETTER_DOUBLE_OPT_IN ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// RFC 5321 caps local-part at 64 octets and the full address at 254. We
// validate against a conservative subset that matches every realistic
// signup form and refuse anything weirder so the row we persist is always
// hashable in a stable way.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

export function hashEmail(email: string): string {
  return createHmac("sha256", KEY)
    .update(email.trim().toLowerCase())
    .digest("hex");
}

// Plain SHA-256 of the per-row token. Keyless on purpose: an unsubscribe
// / confirm link must work even if VISITOR_HMAC_KEY is rotated. The
// token itself is 256 bits of entropy so a hash collision / brute-force
// search is computationally infeasible.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

function buildUnsubscribeUrl(req: Express.Request, token: string): string {
  // Express types — buildPublicUrl uses a structural Request shape.
  const base = buildPublicUrl({
    req: req as unknown as {
      protocol: string;
      get(name: "host"): string | undefined;
    },
  });
  const url = new URL(`${base}/api/newsletter/unsubscribe`);
  url.searchParams.set("token", token);
  return url.toString();
}

function buildConfirmUrl(req: Express.Request, token: string): string {
  const base = buildPublicUrl({
    req: req as unknown as {
      protocol: string;
      get(name: "host"): string | undefined;
    },
  });
  const url = new URL(`${base}/api/newsletter/confirm`);
  url.searchParams.set("token", token);
  return url.toString();
}

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many newsletter signups from this IP. Try again later.",
  },
});

// Per-IP rate limit on the confirm / unsubscribe endpoints. These are
// link-clicks from email so the limit can be generous, but we still
// don't want them used as an unauthenticated probe-by-token oracle.
const tokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests from this IP. Try again later.",
  },
});

router.post(
  "/newsletter/subscribe",
  subscribeLimiter,
  async (req, res): Promise<void> => {
    try {
      const rawEmail =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
      if (!rawEmail) {
        res.status(400).json({ error: "Email is required." });
        return;
      }
      if (rawEmail.length > MAX_EMAIL_LENGTH) {
        res.status(400).json({ error: "Email is too long." });
        return;
      }
      if (!EMAIL_RE.test(rawEmail)) {
        res.status(400).json({ error: "Email is not valid." });
        return;
      }

      const normalized = rawEmail.toLowerCase();
      const emailHmac = hashEmail(normalized);
      const requireConfirm = doubleOptInEnabled();
      const { token, tokenHash } = generateToken();

      // Insert with ON CONFLICT DO NOTHING so the unique index on email_hmac
      // is the source of truth — concurrent requests for the same address can
      // race past a SELECT-then-INSERT check, but the DB will only ever keep
      // one row per HMAC.
      const inserted = await db
        .insert(newsletterSubscriptionsTable)
        .values({
          emailHmac,
          tokenHash,
          confirmedAt: requireConfirm ? null : new Date(),
        })
        .onConflictDoNothing({ target: newsletterSubscriptionsTable.emailHmac })
        .returning({ id: newsletterSubscriptionsTable.id });

      const alreadySubscribed = inserted.length === 0;

      // Best-effort forward of the raw email to a configured destination.
      // Failure here must not block the signup response — we have already
      // persisted the HMAC and that is the source of truth for "subscribed".
      if (FORWARD_URL && !alreadySubscribed) {
        void (async () => {
          try {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (FORWARD_TOKEN)
              headers.Authorization = `Bearer ${FORWARD_TOKEN}`;
            const r = await fetch(FORWARD_URL, {
              method: "POST",
              headers,
              body: JSON.stringify({
                email: normalized,
                source: "vulnrap-community",
              }),
            });
            if (!r.ok) {
              logger.warn(
                { status: r.status },
                "[newsletter] forward destination returned non-2xx",
              );
            }
          } catch (err) {
            logger.warn(
              { err },
              "[newsletter] forward destination unreachable",
            );
          }
        })();
      }

      // Best-effort welcome / confirm email. Fire-and-forget so a slow
      // delivery webhook never blocks the API response. We only mail
      // freshly-inserted rows: a duplicate signup attempt is a no-op
      // here — the original row's token is unrecoverable (only the
      // hash is stored), so re-mailing would require minting a new
      // token and PUTting it on the row, which we deliberately skip
      // to keep "duplicate signup" silent.
      if (!alreadySubscribed) {
        const unsubscribeUrl = buildUnsubscribeUrl(req, token);
        const confirmUrl = requireConfirm
          ? buildConfirmUrl(req, token)
          : undefined;
        void sendNewsletterEmail({
          kind: requireConfirm ? "confirm" : "welcome",
          to: normalized,
          unsubscribeUrl,
          confirmUrl,
        }).catch((err) => {
          logger.warn(
            { err },
            "[newsletter] welcome / confirm email dispatch threw",
          );
        });
      }

      const message = alreadySubscribed
        ? "You're already on the list — thanks for sticking with us."
        : requireConfirm
          ? "Almost there — check your inbox for a confirmation link."
          : "You're on the list. We'll send a quick welcome email shortly.";

      res.status(201).json({
        ok: true,
        alreadySubscribed,
        pendingConfirmation: !alreadySubscribed && requireConfirm,
        message,
      });
    } catch (err) {
      req.log?.error(err, "Failed to subscribe to newsletter");
      res
        .status(500)
        .json({ error: "Failed to subscribe. Please try again later." });
    }
  },
);

// Confirms a pending subscription. GET so the link works straight from
// an email client. Idempotent: re-clicking after confirmation returns
// the same 200 success body so a forwarded email doesn't surface a
// scary error.
router.get(
  "/newsletter/confirm",
  tokenLimiter,
  async (req, res): Promise<void> => {
    try {
      const raw = typeof req.query.token === "string" ? req.query.token : "";
      if (!raw || raw.length < 16 || raw.length > 128) {
        res.status(400).json({ error: "Confirmation token is missing." });
        return;
      }
      const tokenHash = hashToken(raw);
      const rows = await db
        .select({
          id: newsletterSubscriptionsTable.id,
          confirmedAt: newsletterSubscriptionsTable.confirmedAt,
        })
        .from(newsletterSubscriptionsTable)
        .where(eq(newsletterSubscriptionsTable.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "Confirmation token is not valid." });
        return;
      }
      const wasAlreadyConfirmed = row.confirmedAt !== null;
      if (!wasAlreadyConfirmed) {
        await db
          .update(newsletterSubscriptionsTable)
          .set({ confirmedAt: new Date() })
          .where(eq(newsletterSubscriptionsTable.id, row.id));
      }
      res.status(200).json({
        ok: true,
        alreadyConfirmed: wasAlreadyConfirmed,
        message: wasAlreadyConfirmed
          ? "Your subscription was already confirmed — you're all set."
          : "Subscription confirmed. Welcome aboard.",
      });
    } catch (err) {
      req.log?.error(err, "Failed to confirm newsletter subscription");
      res
        .status(500)
        .json({ error: "Failed to confirm. Please try again later." });
    }
  },
);

// Unsubscribe handler. Accepts both GET (so a one-click email link
// works without JavaScript) and POST (for richer clients). Removes
// the row entirely so no PII-equivalent (the HMAC) lingers — this
// matches the task spec ("removes the HMAC row"). Idempotent: an
// unknown token returns 200 with `removed: false` so a re-clicked
// link doesn't look like a failure.
async function handleUnsubscribe(
  req: Express.Request,
  res: Express.Response,
): Promise<void> {
  type Req = { query: Record<string, unknown>; body?: Record<string, unknown> };
  const r = req as unknown as Req;
  const raw =
    (typeof r.query.token === "string" && r.query.token) ||
    (r.body && typeof r.body.token === "string" ? (r.body.token as string) : "");
  if (!raw || raw.length < 16 || raw.length > 128) {
    (res as unknown as { status: (n: number) => { json: (b: unknown) => void } })
      .status(400)
      .json({ error: "Unsubscribe token is missing." });
    return;
  }
  const tokenHash = hashToken(raw);
  const deleted = await db
    .delete(newsletterSubscriptionsTable)
    .where(eq(newsletterSubscriptionsTable.tokenHash, tokenHash))
    .returning({ id: newsletterSubscriptionsTable.id });
  const removed = deleted.length > 0;
  (res as unknown as { status: (n: number) => { json: (b: unknown) => void } })
    .status(200)
    .json({
      ok: true,
      removed,
      message: removed
        ? "You're unsubscribed. The address has been removed from the list."
        : "That link is no longer active — the address is not on the list.",
    });
}

router.get(
  "/newsletter/unsubscribe",
  tokenLimiter,
  async (req, res): Promise<void> => {
    try {
      await handleUnsubscribe(
        req as unknown as Express.Request,
        res as unknown as Express.Response,
      );
    } catch (err) {
      req.log?.error(err, "Failed to process unsubscribe (GET)");
      res
        .status(500)
        .json({ error: "Failed to unsubscribe. Please try again later." });
    }
  },
);

router.post(
  "/newsletter/unsubscribe",
  tokenLimiter,
  async (req, res): Promise<void> => {
    try {
      await handleUnsubscribe(
        req as unknown as Express.Request,
        res as unknown as Express.Response,
      );
    } catch (err) {
      req.log?.error(err, "Failed to process unsubscribe (POST)");
      res
        .status(500)
        .json({ error: "Failed to unsubscribe. Please try again later." });
    }
  },
);

export default router;
