import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { createHmac, randomBytes } from "crypto";
import { db, newsletterSubscriptionsTable } from "@workspace/db";
import { logger } from "../lib/logger";

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

// RFC 5321 caps local-part at 64 octets and the full address at 254. We
// validate against a conservative subset that matches every realistic
// signup form and refuse anything weirder so the row we persist is always
// hashable in a stable way.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

export function hashEmail(email: string): string {
  return createHmac("sha256", KEY).update(email.trim().toLowerCase()).digest("hex");
}

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many newsletter signups from this IP. Try again later." },
});

router.post("/newsletter/subscribe", subscribeLimiter, async (req, res): Promise<void> => {
  try {
    const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim() : "";
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

    // Insert with ON CONFLICT DO NOTHING so the unique index on email_hmac
    // is the source of truth — concurrent requests for the same address can
    // race past a SELECT-then-INSERT check, but the DB will only ever keep
    // one row per HMAC.
    const inserted = await db
      .insert(newsletterSubscriptionsTable)
      .values({ emailHmac })
      .onConflictDoNothing({ target: newsletterSubscriptionsTable.emailHmac })
      .returning({ id: newsletterSubscriptionsTable.id });

    const alreadySubscribed = inserted.length === 0;

    // Best-effort forward of the raw email to a configured destination.
    // Failure here must not block the signup response — we have already
    // persisted the HMAC and that is the source of truth for "subscribed".
    if (FORWARD_URL && !alreadySubscribed) {
      void (async () => {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (FORWARD_TOKEN) headers.Authorization = `Bearer ${FORWARD_TOKEN}`;
          const r = await fetch(FORWARD_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ email: normalized, source: "vulnrap-community" }),
          });
          if (!r.ok) {
            logger.warn(
              { status: r.status },
              "[newsletter] forward destination returned non-2xx",
            );
          }
        } catch (err) {
          logger.warn({ err }, "[newsletter] forward destination unreachable");
        }
      })();
    }

    res.status(201).json({
      ok: true,
      alreadySubscribed,
      message: alreadySubscribed
        ? "You're already on the list — thanks for sticking with us."
        : "You're on the list. Watch for updates when we ship.",
    });
  } catch (err) {
    req.log?.error(err, "Failed to subscribe to newsletter");
    res.status(500).json({ error: "Failed to subscribe. Please try again later." });
  }
});

export default router;
