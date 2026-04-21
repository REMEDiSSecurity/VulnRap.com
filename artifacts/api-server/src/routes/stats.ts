import { Router, type IRouter } from "express";
import { sql, gte, and, eq } from "drizzle-orm";
import { createHmac, randomBytes } from "crypto";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { reportsTable, pageViewsTable, userFeedbackTable } from "@workspace/db";
import {
  GetStatsResponse,
  GetRecentActivityResponse,
  GetSlopDistributionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stats", async (_req, res): Promise<void> => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const [totals] = await db
    .select({
      totalReports: sql<number>`count(*)::int`,
      avgSlopScore: sql<number>`coalesce(avg(${reportsTable.slopScore}), 0)::float`,
      fullCount: sql<number>`count(*) filter (where ${reportsTable.contentMode} = 'full')::int`,
      similarityOnlyCount: sql<number>`count(*) filter (where ${reportsTable.contentMode} = 'similarity_only')::int`,
    })
    .from(reportsTable);

  const [duplicateCounts] = await db
    .select({
      duplicatesDetected: sql<number>`count(*) filter (where jsonb_array_length(${reportsTable.similarityMatches}) > 0)::int`,
    })
    .from(reportsTable);

  const [todayCounts] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(gte(reportsTable.createdAt, todayStart));

  const [weekCounts] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(gte(reportsTable.createdAt, weekStart));

  const response = GetStatsResponse.parse({
    totalReports: totals.totalReports,
    duplicatesDetected: duplicateCounts.duplicatesDetected,
    avgSlopScore: Math.round(totals.avgSlopScore * 10) / 10,
    reportsByMode: {
      full: totals.fullCount,
      similarity_only: totals.similarityOnlyCount,
    },
    reportsToday: todayCounts.count,
    reportsThisWeek: weekCounts.count,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json(response);
});

router.get("/stats/recent", async (_req, res): Promise<void> => {
  const recentReports = await db
    .select({
      id: reportsTable.id,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      similarityMatches: reportsTable.similarityMatches,
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .orderBy(sql`${reportsTable.createdAt} desc`)
    .limit(20);

  const mapped = recentReports.map((r) => {
    const matches = r.similarityMatches as Array<{ reportId: number; similarity: number; matchType: string }>;
    const tier = r.slopTier;

    return {
      id: r.id,
      slopScore: r.slopScore,
      slopTier: tier,
      matchCount: matches.length,
      createdAt: r.createdAt,
    };
  });

  const response = GetRecentActivityResponse.parse({
    recentReports: mapped,
  });

  res.json(response);
});

router.get("/stats/distribution", async (_req, res): Promise<void> => {
  const bucketDefs = [
    { label: "Clean", min: 0, max: 20 },
    { label: "Likely Human", min: 21, max: 35 },
    { label: "Questionable", min: 36, max: 55 },
    { label: "Likely Slop", min: 56, max: 75 },
    { label: "Slop", min: 76, max: 100 },
  ];

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      b0: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 0 and ${reportsTable.slopScore} <= 20)::int`,
      b1: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 21 and ${reportsTable.slopScore} <= 35)::int`,
      b2: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 36 and ${reportsTable.slopScore} <= 55)::int`,
      b3: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 56 and ${reportsTable.slopScore} <= 75)::int`,
      b4: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 76 and ${reportsTable.slopScore} <= 100)::int`,
    })
    .from(reportsTable);

  const counts = [row.b0, row.b1, row.b2, row.b3, row.b4];
  const buckets = bucketDefs.map((def, i) => ({ ...def, count: counts[i] }));

  const response = GetSlopDistributionResponse.parse({
    buckets,
    totalReports: row.total,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json(response);
});

let VISITOR_HMAC_KEY = process.env.VISITOR_HMAC_KEY;
if (!VISITOR_HMAC_KEY) {
  VISITOR_HMAC_KEY = randomBytes(32).toString("hex");
  logger.warn(
    "VISITOR_HMAC_KEY environment variable is not set. Generated an ephemeral per-process key. " +
      "Visitor hashes will rotate on every server restart. Set VISITOR_HMAC_KEY for stable daily rotation.",
  );
}
const VISITOR_HMAC_KEY_FINAL: string = VISITOR_HMAC_KEY;

router.post("/stats/visit", async (req, res): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const visitorHash = createHmac("sha256", VISITOR_HMAC_KEY_FINAL)
    .update(`${today}::${ip}`)
    .digest("hex");

  await db
    .insert(pageViewsTable)
    .values({ visitorHash, viewDate: today })
    .onConflictDoNothing({ target: [pageViewsTable.visitorHash, pageViewsTable.viewDate] });

  res.json({ recorded: true });
});

router.get("/stats/visitors", async (_req, res): Promise<void> => {
  const [result] = await db
    .select({
      totalUniqueVisitors: sql<number>`count(distinct ${pageViewsTable.visitorHash})::int`,
      totalVisits: sql<number>`count(distinct ${pageViewsTable.viewDate})::int`,
    })
    .from(pageViewsTable);

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json({
    totalUniqueVisitors: result.totalUniqueVisitors,
    totalVisits: result.totalVisits,
  });
});

router.get("/stats/trends", async (req, res): Promise<void> => {
  const daysParam = parseInt(req.query?.days as string) || 90;
  const days = Math.min(Math.max(daysParam, 7), 365);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const dailyReports = await db
    .select({
      date: sql<string>`${reportsTable.createdAt}::date::text`,
      count: sql<number>`count(*)::int`,
      avgScore: sql<number>`coalesce(round(avg(${reportsTable.slopScore})::numeric, 1), 0)::float`,
      clean: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 0 and ${reportsTable.slopScore} <= 20)::int`,
      likelyHuman: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 21 and ${reportsTable.slopScore} <= 35)::int`,
      questionable: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 36 and ${reportsTable.slopScore} <= 55)::int`,
      likelySlop: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 56 and ${reportsTable.slopScore} <= 75)::int`,
      slop: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 76 and ${reportsTable.slopScore} <= 100)::int`,
    })
    .from(reportsTable)
    .where(gte(reportsTable.createdAt, cutoff))
    .groupBy(sql`${reportsTable.createdAt}::date`)
    .orderBy(sql`${reportsTable.createdAt}::date asc`);

  const dailyFeedback = await db
    .select({
      date: sql<string>`${userFeedbackTable.createdAt}::date::text`,
      count: sql<number>`count(*)::int`,
      avgRating: sql<number>`coalesce(round(avg(${userFeedbackTable.rating})::numeric, 1), 0)::float`,
      helpfulCount: sql<number>`count(*) filter (where ${userFeedbackTable.helpful} = true)::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(userFeedbackTable)
    .where(gte(userFeedbackTable.createdAt, cutoff))
    .groupBy(sql`${userFeedbackTable.createdAt}::date`)
    .orderBy(sql`${userFeedbackTable.createdAt}::date asc`);

  const feedbackTrend = dailyFeedback.map((row) => ({
    date: row.date,
    count: row.count,
    avgRating: row.avgRating,
    agreementRate: row.totalCount > 0 ? Math.round((row.helpfulCount / row.totalCount) * 100) : 0,
  }));

  const [totals] = await db
    .select({
      totalReports: sql<number>`count(*)::int`,
      totalFeedback: sql<number>`(select count(*) from user_feedback)::int`,
    })
    .from(reportsTable);

  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
  res.json({
    days,
    totalReports: totals.totalReports,
    totalFeedback: totals.totalFeedback,
    dailyReports: dailyReports.map((row) => ({
      date: row.date,
      count: row.count,
      avgScore: row.avgScore,
      tiers: {
        clean: row.clean,
        likelyHuman: row.likelyHuman,
        questionable: row.questionable,
        likelySlop: row.likelySlop,
        slop: row.slop,
      },
    })),
    feedbackTrend,
  });
});

export default router;
