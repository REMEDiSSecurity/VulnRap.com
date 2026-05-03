// Task #639 — Internal/reviewer-only endpoints.
//
// Currently hosts only the shadow-drift listing that backs the
// reviewer-only "Shadow drift" tab on `/feedback-analytics`. New
// reviewer-only internal surfaces should be added here so the gate
// (requireCalibrationAuthStrict) is applied uniformly.
import { Router, type IRouter } from "express";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
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
      const lookbackDaysRaw = Number(req.query.lookbackDays ?? DEFAULT_LOOKBACK_DAYS);
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
      res
        .status(500)
        .json({ error: "Failed to compute shadow drift report." });
    }
  },
);

export default router;
