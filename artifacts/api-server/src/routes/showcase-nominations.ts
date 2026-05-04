import { createHmac, randomBytes } from "crypto";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, showcaseNominationsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  requireCalibrationAuthStrict,
  requireCalibrationAuth,
} from "../middlewares/require-calibration-auth";

const router: IRouter = Router();

let HMAC_KEY = process.env.VISITOR_HMAC_KEY;
if (!HMAC_KEY) {
  HMAC_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "[showcase-nominations] VISITOR_HMAC_KEY not set — using ephemeral per-process key. " +
      "Submitter rate-limit dedupe will not survive a restart.",
  );
}
const KEY: string = HMAC_KEY;

const ALLOWED_STATUSES = new Set(["pending", "approved", "rejected"]);
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 1000;
const MAX_EMAIL_LENGTH = 320;
const DAILY_LIMIT_PER_IP = 5;

function hashIp(ip: string): string {
  return createHmac("sha256", KEY)
    .update(ip.trim().toLowerCase())
    .digest("hex");
}

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many showcase nominations from this IP. Try again later.",
  },
});

router.post(
  "/public/showcase-nominations",
  submitLimiter,
  async (req, res): Promise<void> => {
    try {
      const rawReportId = req.body?.reportId;
      const rawReason =
        typeof req.body?.reason === "string" ? req.body.reason : "";
      const rawEmail =
        typeof req.body?.email === "string" ? req.body.email : "";

      if (
        typeof rawReportId !== "number" ||
        !Number.isInteger(rawReportId) ||
        rawReportId <= 0
      ) {
        res
          .status(400)
          .json({ error: "reportId must be a positive integer." });
        return;
      }

      const reason = rawReason.trim().replace(/\s+/g, " ");
      if (reason.length < MIN_REASON_LENGTH) {
        res.status(400).json({
          error: `Reason must be at least ${MIN_REASON_LENGTH} characters.`,
        });
        return;
      }
      if (reason.length > MAX_REASON_LENGTH) {
        res.status(400).json({
          error: `Reason must be at most ${MAX_REASON_LENGTH} characters.`,
        });
        return;
      }

      const email = rawEmail.trim().slice(0, MAX_EMAIL_LENGTH) || null;

      const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
      const ipHmac = hashIp(ip);

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(showcaseNominationsTable)
        .where(
          and(
            eq(showcaseNominationsTable.ipHmac, ipHmac),
            gte(showcaseNominationsTable.createdAt, since),
          ),
        );
      if (count >= DAILY_LIMIT_PER_IP) {
        res.status(429).json({
          error: `You've reached the daily limit of ${DAILY_LIMIT_PER_IP} showcase nominations. Try again tomorrow.`,
          dailyLimit: DAILY_LIMIT_PER_IP,
          retryAfterHours: 24,
        });
        return;
      }

      const dup = await db
        .select({ id: showcaseNominationsTable.id })
        .from(showcaseNominationsTable)
        .where(
          and(
            eq(showcaseNominationsTable.ipHmac, ipHmac),
            eq(showcaseNominationsTable.reportId, rawReportId),
            gte(showcaseNominationsTable.createdAt, since),
          ),
        )
        .limit(1);
      if (dup.length > 0) {
        res.status(200).json({
          ok: true,
          duplicate: true,
          message:
            "You already nominated this report recently — thanks, we'll review it.",
        });
        return;
      }

      const [inserted] = await db
        .insert(showcaseNominationsTable)
        .values({
          reportId: rawReportId,
          reason,
          email,
          status: "pending",
          ipHmac,
        })
        .returning({ id: showcaseNominationsTable.id });

      res.status(201).json({
        ok: true,
        duplicate: false,
        id: inserted.id,
        message: "Thanks! Your nomination is queued for reviewer triage.",
      });
    } catch (err) {
      req.log?.error(err, "Failed to submit showcase nomination");
      res.status(500).json({
        error: "Failed to submit showcase nomination. Please try again later.",
      });
    }
  },
);

router.get(
  "/feedback/calibration/showcase-nominations",
  requireCalibrationAuthStrict,
  async (req, res) => {
    try {
      const status =
        typeof req.query.status === "string" ? req.query.status : "pending";
      if (!ALLOWED_STATUSES.has(status)) {
        res.status(400).json({
          error: "status must be 'pending', 'approved', or 'rejected'.",
        });
        return;
      }
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
        : 100;
      const rows = await db
        .select({
          id: showcaseNominationsTable.id,
          reportId: showcaseNominationsTable.reportId,
          reason: showcaseNominationsTable.reason,
          email: showcaseNominationsTable.email,
          status: showcaseNominationsTable.status,
          createdAt: showcaseNominationsTable.createdAt,
        })
        .from(showcaseNominationsTable)
        .where(eq(showcaseNominationsTable.status, status))
        .orderBy(desc(showcaseNominationsTable.createdAt))
        .limit(limit);
      res.json({
        nominations: rows.map((r) => ({
          id: r.id,
          reportId: r.reportId,
          reason: r.reason,
          email: r.email ?? null,
          status: r.status,
          createdAt:
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : String(r.createdAt),
        })),
        total: rows.length,
        status,
      });
    } catch (err) {
      req.log?.error(err, "Failed to list showcase nominations");
      res.status(500).json({ error: "Failed to list showcase nominations." });
    }
  },
);

router.patch(
  "/feedback/calibration/showcase-nominations/:id",
  requireCalibrationAuth,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "id must be a positive integer." });
        return;
      }
      const status =
        typeof req.body?.status === "string" ? req.body.status : "";
      if (status !== "approved" && status !== "rejected") {
        res
          .status(400)
          .json({ error: "status must be 'approved' or 'rejected'." });
        return;
      }
      const [updated] = await db
        .update(showcaseNominationsTable)
        .set({ status })
        .where(eq(showcaseNominationsTable.id, id))
        .returning({
          id: showcaseNominationsTable.id,
          reportId: showcaseNominationsTable.reportId,
          status: showcaseNominationsTable.status,
        });
      if (!updated) {
        res.status(404).json({ error: "Nomination not found." });
        return;
      }
      res.json({
        ok: true,
        id: updated.id,
        reportId: updated.reportId,
        status: updated.status,
      });
    } catch (err) {
      req.log?.error(err, "Failed to update showcase nomination");
      res
        .status(500)
        .json({ error: "Failed to update showcase nomination." });
    }
  },
);

export default router;
