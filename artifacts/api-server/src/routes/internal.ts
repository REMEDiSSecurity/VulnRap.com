// Task #639 — Internal/reviewer-only endpoints.
//
// Currently hosts only the shadow-drift listing that backs the
// reviewer-only "Shadow drift" tab on `/feedback-analytics`. New
// reviewer-only internal surfaces should be added here so the gate
// (requireCalibrationAuthStrict) is applied uniformly.
//
// Task #1113 — Added /internal/newsletter-delivery to surface welcome
// email delivery failures (welcomeSentAt NULL + overdue) so silent
// webhook misconfigurations are visible without reading logs.
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  newsletterSubscriptionsTable,
  reportShadowScoresTable,
  reportsTable,
} from "@workspace/db";
import { requireCalibrationAuthStrict } from "../middlewares/require-calibration-auth";
import { isShadowScoringEnabled } from "../lib/scoring-shadow";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Default lookback for the listing — keeps the page snappy and matches
// the rolling window reviewers use elsewhere on /feedback-analytics.
const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Divergence thresholds from the task description: a row is considered
// divergent when the tier flipped (`tier_diverged = true`) OR the score
// delta is at least 10 points in either direction.
const SCORE_DELTA_THRESHOLD = 10;

router.get(
  "/internal/shadow-drift",
  requireCalibrationAuthStrict,
  async (req, res) => {
    try {
      const lookbackDaysRaw = Number(
        req.query.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      );
      const lookbackDays =
        Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
          ? Math.min(90, Math.trunc(lookbackDaysRaw))
          : DEFAULT_LOOKBACK_DAYS;

      const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(MAX_LIMIT, Math.trunc(limitRaw))
          : DEFAULT_LIMIT;

      const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

      const divergenceCondition = or(
        eq(reportShadowScoresTable.tierDiverged, true),
        sql`abs(${reportShadowScoresTable.scoreDiff}) >= ${SCORE_DELTA_THRESHOLD}`,
      );

      const rows = await db
        .select({
          id: reportShadowScoresTable.id,
          reportId: reportShadowScoresTable.reportId,
          liveScore: reportShadowScoresTable.liveScore,
          liveTier: reportShadowScoresTable.liveTier,
          shadowScore: reportShadowScoresTable.shadowScore,
          shadowTier: reportShadowScoresTable.shadowTier,
          scoreDiff: reportShadowScoresTable.scoreDiff,
          tierDiverged: reportShadowScoresTable.tierDiverged,
          shadowVersion: reportShadowScoresTable.shadowVersion,
          scoredAt: reportShadowScoresTable.scoredAt,
          reportCreatedAt: reportsTable.createdAt,
          fileName: reportsTable.fileName,
        })
        .from(reportShadowScoresTable)
        .leftJoin(
          reportsTable,
          eq(reportShadowScoresTable.reportId, reportsTable.id),
        )
        .where(
          and(
            gte(reportShadowScoresTable.scoredAt, cutoff),
            divergenceCondition,
          ),
        )
        .orderBy(desc(reportShadowScoresTable.scoredAt))
        .limit(limit);

      const [totals] = await db
        .select({
          total: sql<number>`count(*)::int`,
          divergent: sql<number>`count(*) filter (where ${reportShadowScoresTable.tierDiverged} = true OR abs(${reportShadowScoresTable.scoreDiff}) >= ${SCORE_DELTA_THRESHOLD})::int`,
          tierFlips: sql<number>`count(*) filter (where ${reportShadowScoresTable.tierDiverged} = true)::int`,
          scoreFlips: sql<number>`count(*) filter (where abs(${reportShadowScoresTable.scoreDiff}) >= ${SCORE_DELTA_THRESHOLD})::int`,
          legitToSlop: sql<number>`count(*) filter (where ${reportShadowScoresTable.tierDiverged} = true AND ${reportShadowScoresTable.shadowScore} > ${reportShadowScoresTable.liveScore})::int`,
          slopToLegit: sql<number>`count(*) filter (where ${reportShadowScoresTable.tierDiverged} = true AND ${reportShadowScoresTable.shadowScore} < ${reportShadowScoresTable.liveScore})::int`,
        })
        .from(reportShadowScoresTable)
        .where(gte(reportShadowScoresTable.scoredAt, cutoff));

      res.json({
        enabled: isShadowScoringEnabled(),
        generatedAt: new Date().toISOString(),
        lookbackDays,
        scoreDeltaThreshold: SCORE_DELTA_THRESHOLD,
        totals: {
          total: totals?.total ?? 0,
          divergent: totals?.divergent ?? 0,
          tierFlips: totals?.tierFlips ?? 0,
          scoreFlips: totals?.scoreFlips ?? 0,
          legitToSlop: totals?.legitToSlop ?? 0,
          slopToLegit: totals?.slopToLegit ?? 0,
        },
        rows: rows.map((r) => ({
          id: r.id,
          reportId: r.reportId,
          liveScore: r.liveScore,
          liveTier: r.liveTier,
          shadowScore: r.shadowScore,
          shadowTier: r.shadowTier,
          scoreDiff: r.scoreDiff,
          tierDiverged: r.tierDiverged,
          shadowVersion: r.shadowVersion,
          scoredAt:
            r.scoredAt instanceof Date
              ? r.scoredAt.toISOString()
              : new Date(r.scoredAt as unknown as string).toISOString(),
          fileName: r.fileName ?? null,
        })),
      });
    } catch (err) {
      logger.error({ err }, "[internal] /internal/shadow-drift failed");
      res.status(500).json({ error: "Failed to compute shadow drift report." });
    }
  },
);

// Task #1113 — Newsletter welcome email delivery health.
//
// Subscribers are bucketed into three states:
//   * sent      — welcomeSentAt IS NOT NULL (delivery confirmed).
//   * pending   — welcomeSentAt IS NULL AND createdAt >= NOW()-5min
//                 (the fire-and-forget dispatch may still be in flight).
//   * overdue   — welcomeSentAt IS NULL AND createdAt < NOW()-5min
//                 (5-minute grace period has elapsed; delivery failed or
//                 the webhook was never configured).
//
// The endpoint also returns up to 20 most-recent rows with a recorded
// error so reviewers can diagnose webhook misconfiguration without
// tailing logs.
//
// Retry path: subscribers re-submitting their email via POST
// /api/newsletter/subscribe will automatically trigger a re-send when
// welcomeSentAt is still NULL. No plaintext email addresses are stored
// so a server-side batch resend is not possible without operator
// intervention (fix the webhook, then re-collect addresses).

const DELIVERY_PENDING_GRACE_MS = 5 * 60 * 1000; // 5 minutes

router.get(
  "/internal/newsletter-delivery",
  requireCalibrationAuthStrict,
  async (_req, res) => {
    try {
      const overdueThreshold = new Date(
        Date.now() - DELIVERY_PENDING_GRACE_MS,
      );

      const [counts] = await db
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) filter (where ${newsletterSubscriptionsTable.welcomeSentAt} is not null)::int`,
          overdue: sql<number>`count(*) filter (where ${newsletterSubscriptionsTable.welcomeSentAt} is null and ${newsletterSubscriptionsTable.createdAt} < ${overdueThreshold})::int`,
          pending: sql<number>`count(*) filter (where ${newsletterSubscriptionsTable.welcomeSentAt} is null and ${newsletterSubscriptionsTable.createdAt} >= ${overdueThreshold})::int`,
        })
        .from(newsletterSubscriptionsTable);

      // Most-recent rows with a recorded delivery error, for operator
      // diagnostics. We surface the createdAt and the error only — no
      // HMAC or any other subscriber field that could be correlated.
      const recentErrors = await db
        .select({
          id: newsletterSubscriptionsTable.id,
          createdAt: newsletterSubscriptionsTable.createdAt,
          welcomeLastError: newsletterSubscriptionsTable.welcomeLastError,
        })
        .from(newsletterSubscriptionsTable)
        .where(isNotNull(newsletterSubscriptionsTable.welcomeLastError))
        .orderBy(desc(newsletterSubscriptionsTable.createdAt))
        .limit(20);

      res.json({
        generatedAt: new Date().toISOString(),
        pendingGraceMs: DELIVERY_PENDING_GRACE_MS,
        counts: {
          total: counts?.total ?? 0,
          sent: counts?.sent ?? 0,
          overdue: counts?.overdue ?? 0,
          pending: counts?.pending ?? 0,
        },
        // Non-zero `overdue` is the actionable signal: it means the
        // webhook is misconfigured or returning errors for at least one
        // subscriber. Check recentErrors for the specific message.
        healthy: (counts?.overdue ?? 0) === 0,
        recentErrors: recentErrors.map((r) => ({
          id: r.id,
          createdAt:
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : new Date(r.createdAt as unknown as string).toISOString(),
          error: r.welcomeLastError ?? null,
        })),
        retryNote:
          "Subscribers can trigger a re-send by re-submitting the subscribe form. " +
          "The server will re-mint a fresh token and retry delivery when welcomeSentAt is still NULL.",
      });
    } catch (err) {
      logger.error(
        { err },
        "[internal] /internal/newsletter-delivery failed",
      );
      res
        .status(500)
        .json({ error: "Failed to compute newsletter delivery report." });
    }
  },
);

export default router;
