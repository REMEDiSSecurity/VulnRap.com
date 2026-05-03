// Task #634 — User-suggested phrase form. Anonymous end users can propose
// new handwavy / ai-self-disclosure phrases via the public transparency
// page; submissions land in `phrase_suggestions` with status="pending"
// and are surfaced to reviewers in the feedback-analytics dashboard.
// Nothing is auto-applied: reviewers approve via the existing add
// endpoints and then mark the suggestion approved/rejected here.
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { createHmac, randomBytes } from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, phraseSuggestionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { requireCalibrationAuthStrict, requireCalibrationAuth } from "../middlewares/require-calibration-auth";

const router: IRouter = Router();

let HMAC_KEY = process.env.VISITOR_HMAC_KEY;
if (!HMAC_KEY) {
  HMAC_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "[phrase-suggestions] VISITOR_HMAC_KEY not set — using ephemeral per-process key. " +
      "Submitter rate-limit dedupe will not survive a restart.",
  );
}
const KEY: string = HMAC_KEY;

const ALLOWED_CATEGORIES = new Set(["handwavy", "ai-self-disclosure"]);
const ALLOWED_STATUSES = new Set(["pending", "approved", "rejected"]);
const MAX_TEXT_LENGTH = 240;
const MIN_TEXT_LENGTH = 3;
const MAX_CONTEXT_LENGTH = 1000;
const DAILY_LIMIT_PER_IP = 5;

export function hashIp(ip: string): string {
  return createHmac("sha256", KEY).update(ip.trim().toLowerCase()).digest("hex");
}

// Per-IP burst protection in addition to the DB-level daily count check.
// Keeps a wide-open POST endpoint from getting hammered into oblivion.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many phrase suggestions from this IP. Try again later." },
});

router.post("/public/phrase-suggestions", submitLimiter, async (req, res): Promise<void> => {
  try {
    const rawText = typeof req.body?.text === "string" ? req.body.text : "";
    const rawCategory = typeof req.body?.category === "string" ? req.body.category : "";
    const rawContext = typeof req.body?.context === "string" ? req.body.context : "";

    const text = rawText.trim().replace(/\s+/g, " ");
    if (text.length < MIN_TEXT_LENGTH) {
      res.status(400).json({ error: `Phrase must be at least ${MIN_TEXT_LENGTH} characters.` });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: `Phrase must be at most ${MAX_TEXT_LENGTH} characters.` });
      return;
    }
    if (!ALLOWED_CATEGORIES.has(rawCategory)) {
      res.status(400).json({ error: "category must be 'handwavy' or 'ai-self-disclosure'." });
      return;
    }
    const context = rawContext.trim().slice(0, MAX_CONTEXT_LENGTH) || null;

    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    const ipHmac = hashIp(ip);

    // Daily-per-IP cap. Friendly cooldown banner is rendered client-side
    // when this kicks in.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(phraseSuggestionsTable)
      .where(and(eq(phraseSuggestionsTable.ipHmac, ipHmac), gte(phraseSuggestionsTable.createdAt, since)));
    if (count >= DAILY_LIMIT_PER_IP) {
      res.status(429).json({
        error: `You've reached the daily limit of ${DAILY_LIMIT_PER_IP} phrase suggestions. Try again tomorrow.`,
        dailyLimit: DAILY_LIMIT_PER_IP,
        retryAfterHours: 24,
      });
      return;
    }

    // Soft dedupe: if the same IP already proposed this exact normalized
    // text in the last 24h, treat the second submission as a no-op so the
    // queue isn't littered with retries.
    const lowered = text.toLowerCase();
    const dup = await db
      .select({ id: phraseSuggestionsTable.id })
      .from(phraseSuggestionsTable)
      .where(
        and(
          eq(phraseSuggestionsTable.ipHmac, ipHmac),
          gte(phraseSuggestionsTable.createdAt, since),
          sql`lower(${phraseSuggestionsTable.text}) = ${lowered}`,
        ),
      )
      .limit(1);
    if (dup.length > 0) {
      res.status(200).json({
        ok: true,
        duplicate: true,
        message: "You already suggested this phrase recently — thanks, we'll review it.",
      });
      return;
    }

    const [inserted] = await db
      .insert(phraseSuggestionsTable)
      .values({
        text,
        category: rawCategory,
        context,
        status: "pending",
        ipHmac,
      })
      .returning({ id: phraseSuggestionsTable.id });

    res.status(201).json({
      ok: true,
      duplicate: false,
      id: inserted.id,
      message: "Thanks! Your suggestion is queued for reviewer triage.",
    });
  } catch (err) {
    req.log?.error(err, "Failed to submit phrase suggestion");
    res.status(500).json({ error: "Failed to submit phrase suggestion. Please try again later." });
  }
});

// Reviewer-only: list pending (or any-status) suggestions for the queue.
router.get(
  "/feedback/calibration/phrase-suggestions",
  requireCalibrationAuthStrict,
  async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "pending";
      if (!ALLOWED_STATUSES.has(status)) {
        res.status(400).json({ error: "status must be 'pending', 'approved', or 'rejected'." });
        return;
      }
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100;
      const rows = await db
        .select({
          id: phraseSuggestionsTable.id,
          text: phraseSuggestionsTable.text,
          category: phraseSuggestionsTable.category,
          context: phraseSuggestionsTable.context,
          status: phraseSuggestionsTable.status,
          createdAt: phraseSuggestionsTable.createdAt,
        })
        .from(phraseSuggestionsTable)
        .where(eq(phraseSuggestionsTable.status, status))
        .orderBy(desc(phraseSuggestionsTable.createdAt))
        .limit(limit);
      res.json({
        suggestions: rows.map((r) => ({
          id: r.id,
          text: r.text,
          category: r.category,
          context: r.context ?? null,
          status: r.status,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        })),
        total: rows.length,
        status,
      });
    } catch (err) {
      req.log?.error(err, "Failed to list phrase suggestions");
      res.status(500).json({ error: "Failed to list phrase suggestions." });
    }
  },
);

// Reviewer-only: mark a suggestion approved or rejected. The actual
// addition to the active phrase list happens via the existing
// /feedback/calibration/handwavy-phrases (or ai-self-disclosure) add
// endpoints — this is just the bookkeeping flip.
router.patch(
  "/feedback/calibration/phrase-suggestions/:id",
  requireCalibrationAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "id must be a positive integer." });
        return;
      }
      const status = typeof req.body?.status === "string" ? req.body.status : "";
      if (status !== "approved" && status !== "rejected") {
        res.status(400).json({ error: "status must be 'approved' or 'rejected'." });
        return;
      }
      const [updated] = await db
        .update(phraseSuggestionsTable)
        .set({ status })
        .where(eq(phraseSuggestionsTable.id, id))
        .returning({
          id: phraseSuggestionsTable.id,
          text: phraseSuggestionsTable.text,
          category: phraseSuggestionsTable.category,
          status: phraseSuggestionsTable.status,
        });
      if (!updated) {
        res.status(404).json({ error: "Suggestion not found." });
        return;
      }
      res.json({ ok: true, id: updated.id, status: updated.status });
    } catch (err) {
      req.log?.error(err, "Failed to update phrase suggestion");
      res.status(500).json({ error: "Failed to update phrase suggestion." });
    }
  },
);

export default router;
