import { Router, type IRouter } from "express";
import { sql, gte } from "drizzle-orm";
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
    { label: "Probably Legit", min: 0, max: 14 },
    { label: "Mildly Suspicious", min: 15, max: 29 },
    { label: "Questionable", min: 30, max: 49 },
    { label: "Highly Suspicious", min: 50, max: 69 },
    { label: "Pure Slop", min: 70, max: 100 },
  ];

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      b0: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 0 and ${reportsTable.slopScore} <= 14)::int`,
      b1: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 15 and ${reportsTable.slopScore} <= 29)::int`,
      b2: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 30 and ${reportsTable.slopScore} <= 49)::int`,
      b3: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 50 and ${reportsTable.slopScore} <= 69)::int`,
      b4: sql<number>`count(*) filter (where ${reportsTable.slopScore} >= 70 and ${reportsTable.slopScore} <= 100)::int`,
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

export default router;
