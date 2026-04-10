import { Router, type IRouter } from "express";
import { sql, gte, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { reportsTable } from "@workspace/db";
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

  res.json(response);
});

router.get("/stats/recent", async (_req, res): Promise<void> => {
  const recentReports = await db
    .select({
      id: reportsTable.id,
      slopScore: reportsTable.slopScore,
      similarityMatches: reportsTable.similarityMatches,
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .orderBy(sql`${reportsTable.createdAt} desc`)
    .limit(20);

  const mapped = recentReports.map((r) => {
    const matches = r.similarityMatches as Array<{ reportId: number; similarity: number; matchType: string }>;
    let tier: string;
    if (r.slopScore >= 70) tier = "Pure Slop";
    else if (r.slopScore >= 50) tier = "Highly Suspicious";
    else if (r.slopScore >= 30) tier = "Questionable";
    else if (r.slopScore >= 15) tier = "Mildly Suspicious";
    else tier = "Probably Legit";

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
  const buckets = [
    { label: "Probably Legit", min: 0, max: 14 },
    { label: "Mildly Suspicious", min: 15, max: 29 },
    { label: "Questionable", min: 30, max: 49 },
    { label: "Highly Suspicious", min: 50, max: 69 },
    { label: "Pure Slop", min: 70, max: 100 },
  ];

  const results = await Promise.all(
    buckets.map(async (bucket) => {
      const [result] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(reportsTable)
        .where(
          and(
            gte(reportsTable.slopScore, bucket.min),
            sql`${reportsTable.slopScore} <= ${bucket.max}`
          )
        );
      return { ...bucket, count: result.count };
    })
  );

  const [total] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportsTable);

  const response = GetSlopDistributionResponse.parse({
    buckets: results,
    totalReports: total.count,
  });

  res.json(response);
});

export default router;
