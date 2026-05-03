import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { eq } from "drizzle-orm";
import { db, newsletterSubscriptionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { buildPublicUrl } from "../lib/public-url";
import { sendNewsletterEmail } from "../lib/newsletter-email";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Stateless proof-of-work challenge.
//
// We deliberately do not use the in-memory challenge store from
// `lib/challenge.ts` here — that store breaks the moment the api-server
// runs on more than one pod (challenge issued by pod A, signup hits pod
// B → "challenge not found"). Instead the challenge is encoded as a
// self-describing string:
//
//   challengeId = base64url(payload) + "." + base64url(HMAC(payload))
//
// where `payload` is `${nonce}:${expiresAtMs}` and the HMAC key comes
// from NEWSLETTER_CHALLENGE_HMAC_KEY (or, if unset, a per-process
// random key — degraded but documented). Any pod that holds the same
// key can verify the token without coordination.
//
// To bound replay we keep a small in-process LRU of recently-spent
// signatures. Cross-pod replay is still possible up to (pod count)
// signups per solved PoW, which is acceptable: the dominant cost of an
// attack is computing the PoW, and the per-IP rate limit on the signup
// endpoint already caps how many signups any single client can land per
// hour regardless of how many pods see the same token.
// ---------------------------------------------------------------------------

const CHALLENGE_DIFFICULTY = 4;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = "vulnrap-newsletter-pow-";

let CHALLENGE_KEY = process.env.NEWSLETTER_CHALLENGE_HMAC_KEY;
if (!CHALLENGE_KEY) {
  CHALLENGE_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "[newsletter] NEWSLETTER_CHALLENGE_HMAC_KEY not set — using ephemeral " +
      "per-process key. Challenges minted on one process will be rejected on " +
      "any other process. Set this env var in production / multi-pod deploys.",
  );
}
const CHALLENGE_KEY_BUF: Buffer = Buffer.from(CHALLENGE_KEY, "utf8");

const SPENT_MAX = 10_000;
const spentSignatures = new Map<string, number>();
function markSpent(sig: string, expiresAt: number): void {
  if (spentSignatures.size >= SPENT_MAX) {
    // Drop the oldest half on overflow. Cheap; runs at most once per
    // SPENT_MAX inserts and keeps memory strictly bounded.
    const drop = Math.floor(SPENT_MAX / 2);
    let i = 0;
    for (const k of spentSignatures.keys()) {
      spentSignatures.delete(k);
      if (++i >= drop) break;
    }
  }
  spentSignatures.set(sig, expiresAt);
}

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function signPayload(payload: string): string {
  return b64urlEncode(
    createHmac("sha256", CHALLENGE_KEY_BUF).update(payload).digest(),
  );
}

interface IssuedChallenge {
  challengeId: string;
  nonce: string;
  difficulty: number;
  prefix: string;
  expiresAt: number;
}
function issueChallenge(): IssuedChallenge {
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const payload = `${nonce}:${expiresAt}`;
  const sig = signPayload(payload);
  const challengeId = `${b64urlEncode(payload)}.${sig}`;
  return {
    challengeId,
    nonce,
    difficulty: CHALLENGE_DIFFICULTY,
    prefix: CHALLENGE_PREFIX,
    expiresAt,
  };
}

function verifyChallengeToken(
  challengeId: string,
  solution: string,
): { valid: true } | { valid: false; status: 400 | 403; error: string } {
  const dot = challengeId.indexOf(".");
  if (dot <= 0 || dot === challengeId.length - 1) {
    return { valid: false, status: 400, error: "Malformed challenge token." };
  }
  const payloadB64 = challengeId.slice(0, dot);
  const sigB64 = challengeId.slice(dot + 1);

  let payload: string;
  try {
    payload = b64urlDecode(payloadB64).toString("utf8");
  } catch {
    return { valid: false, status: 400, error: "Malformed challenge token." };
  }

  const expectedSig = signPayload(payload);
  const a = Buffer.from(sigB64, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      valid: false,
      status: 403,
      error: "Invalid challenge signature.",
    };
  }

  const colon = payload.indexOf(":");
  if (colon <= 0) {
    return { valid: false, status: 400, error: "Malformed challenge token." };
  }
  const nonce = payload.slice(0, colon);
  const expiresAt = Number(payload.slice(colon + 1));
  if (!Number.isFinite(expiresAt)) {
    return { valid: false, status: 400, error: "Malformed challenge token." };
  }
  if (Date.now() > expiresAt) {
    return { valid: false, status: 403, error: "Challenge expired." };
  }

  // Opportunistic per-process replay guard.
  if (spentSignatures.has(sigB64)) {
    return { valid: false, status: 403, error: "Challenge already used." };
  }

  const hash = createHash("sha256")
    .update(CHALLENGE_PREFIX + nonce + solution)
    .digest("hex");
  if (!hash.startsWith("0".repeat(CHALLENGE_DIFFICULTY))) {
    return {
      valid: false,
      status: 403,
      error: "Invalid solution — hash does not meet difficulty requirement.",
    };
  }

  markSpent(sigB64, expiresAt);
  return { valid: true };
}

// Periodically expire spent-signature entries so the map doesn't keep
// rows from long-dead challenges around past their useful life.
setInterval(() => {
  const now = Date.now();
  for (const [sig, exp] of spentSignatures) {
    if (exp < now) spentSignatures.delete(sig);
  }
}, 60_000).unref?.();

const challengeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many challenge requests from this IP. Try again later.",
  },
});

router.get("/newsletter/challenge", challengeLimiter, (req, res) => {
  try {
    res.json(issueChallenge());
  } catch (err) {
    req.log?.error(err, "Failed to generate newsletter challenge");
    res.status(500).json({ error: "Failed to generate challenge." });
  }
});

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
      const challengeId =
        typeof req.body?.challengeId === "string" ? req.body.challengeId : "";
      const challengeSolution =
        typeof req.body?.challengeSolution === "string"
          ? req.body.challengeSolution
          : "";
      if (!challengeId || !challengeSolution) {
        res.status(400).json({
          error:
            "Proof-of-work challenge is required. Fetch a challenge from GET /newsletter/challenge first.",
        });
        return;
      }
      const challengeResult = verifyChallengeToken(
        challengeId,
        challengeSolution,
      );
      if (!challengeResult.valid) {
        res.status(challengeResult.status).json({
          error: challengeResult.error,
        });
        return;
      }

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
