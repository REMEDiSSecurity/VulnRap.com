import { Router, type IRouter } from "express";
import { sql, gte, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { reportsTable, pageViewsTable } from "@workspace/db";
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

router.post("/stats/pageview", async (req, res): Promise<void> => {
  const { path } = req.body;
  if (!path || typeof path !== "string") {
    res.status(400).json({ error: "path is required" });
    return;
  }

  const cleanPath = path.slice(0, 255).replace(/[^a-zA-Z0-9/\-_]/g, "");
  if (!cleanPath) {
    res.status(400).json({ error: "invalid path" });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);

  await db
    .insert(pageViewsTable)
    .values({ path: cleanPath, viewDate: today, count: 1 })
    .onConflictDoUpdate({
      target: [pageViewsTable.path, pageViewsTable.viewDate],
      set: { count: sql`${pageViewsTable.count} + 1` },
    });

  res.json({ ok: true });
});

router.get("/stats/pageviews", async (_req, res): Promise<void> => {
  const [totals] = await db
    .select({
      totalViews: sql<number>`coalesce(sum(${pageViewsTable.count}), 0)::int`,
    })
    .from(pageViewsTable);

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekDate = weekAgo.toISOString().slice(0, 10);

  const [todayViews] = await db
    .select({
      count: sql<number>`coalesce(sum(${pageViewsTable.count}), 0)::int`,
    })
    .from(pageViewsTable)
    .where(eq(pageViewsTable.viewDate, today));

  const [weekViews] = await db
    .select({
      count: sql<number>`coalesce(sum(${pageViewsTable.count}), 0)::int`,
    })
    .from(pageViewsTable)
    .where(gte(pageViewsTable.viewDate, weekDate));

  const byPage = await db
    .select({
      path: pageViewsTable.path,
      views: sql<number>`sum(${pageViewsTable.count})::int`,
    })
    .from(pageViewsTable)
    .groupBy(pageViewsTable.path)
    .orderBy(sql`sum(${pageViewsTable.count}) desc`)
    .limit(20);

  const [apiHits] = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(reportsTable);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [apiHitsToday] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(gte(reportsTable.createdAt, todayStart));

  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.json({
    totalPageViews: totals.totalViews,
    pageViewsToday: todayViews.count,
    pageViewsThisWeek: weekViews.count,
    topPages: byPage,
    apiReportsProcessed: apiHits.total,
    apiReportsToday: apiHitsToday.count,
  });
});

export default router;
