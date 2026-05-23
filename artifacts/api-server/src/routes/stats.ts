import { createHmac, randomBytes } from "crypto";
import { sql, gte, and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { reportsTable, userFeedbackTable } from "@workspace/db";
// page_views is intentionally NOT defined as a Drizzle pgTable anywhere in the
// source tree so the Replit deploy validator (which performs a live dev↔prod
// schema diff) cannot tie the table to a code-owned schema and try to ALTER
// its columns. The table is created/maintained entirely by the api-server's
// startup migration (see ../lib/startup-migrations.ts), and the two queries
// below access it via raw SQL.
import {
  GetStatsResponse,
  GetRecentActivityResponse,
  GetSlopDistributionResponse,
  GetTrendsResponse,
  GetCorpusStatsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { requireCalibrationAuthStrict } from "../middlewares/require-calibration-auth";

const router: IRouter = Router();

// Task #726 — Conditional GET helper for the dashboard endpoints. The
// freshness signal is the most-recent reports.created_at; clients that
// have already seen that snapshot get a 304 instead of a re-rendered
// (and zod-revalidated) JSON payload. Returns null when the table is
// empty, in which case the caller skips Last-Modified entirely so a
// browser cache from a populated env doesn't pin an empty response.
async function getReportsLastModified(): Promise<Date | null> {
  const [row] = await db
    .select({ lastModified: sql<string | null>`max(${reportsTable.createdAt})` })
    .from(reportsTable);
  const raw = row?.lastModified ?? null;
  return raw ? new Date(raw) : null;
}

router.get("/stats", async (req, res): Promise<void> => {
  const lastMod = await getReportsLastModified();
  if (lastMod) {
    res.setHeader("Last-Modified", lastMod.toUTCString());
  }
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  if (req.fresh) {
    res.status(304).end();
    return;
  }

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
    .where(eq(reportsTable.showInFeed, true))
    .orderBy(sql`${reportsTable.createdAt} desc`)
    .limit(20);

  const mapped = recentReports.map((r) => {
    const matches = r.similarityMatches as Array<{
      reportId: number;
      similarity: number;
      matchType: string;
    }>;
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

router.get("/stats/distribution", async (req, res): Promise<void> => {
  const lastMod = await getReportsLastModified();
  if (lastMod) {
    res.setHeader("Last-Modified", lastMod.toUTCString());
  }
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  if (req.fresh) {
    res.status(304).end();
    return;
  }

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

// page_views is materialized only in production (see lib/startup-migrations.ts
// for why). In development the table simply does not exist, which previously
// caused every /stats/visit and /stats/visitors call to bubble up a Postgres
// "undefined_table" error and return 500 — polluting the network panel and
// server logs on every homepage / /stats load. We treat that specific error
// (Postgres SQLSTATE 42P01) as "visitor analytics not provisioned in this
// environment" and degrade gracefully: visit recordings become a no-op, and
// the visitor counter reports zero (the UI already hides itself in that
// case). Any other database error still surfaces as a 500 so genuine
// breakage in production is not silently swallowed.
const PG_UNDEFINED_TABLE = "42P01";

function hasUndefinedTableCode(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

function isMissingPageViewsTable(err: unknown): boolean {
  // drizzle-orm wraps driver errors in DrizzleQueryError and exposes the
  // original pg error (with its SQLSTATE `code`) on `.cause`. Check both
  // levels so this works regardless of whether the raw pg error or the
  // drizzle wrapper is what propagates.
  if (hasUndefinedTableCode(err)) return true;
  if (
    typeof err === "object" &&
    err !== null &&
    "cause" in err &&
    hasUndefinedTableCode((err as { cause?: unknown }).cause)
  ) {
    return true;
  }
  return false;
}

router.post("/stats/visit", async (req, res): Promise<void> => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const visitorHash = createHmac("sha256", VISITOR_HMAC_KEY_FINAL)
    .update(`${today}::${ip}`)
    .digest("hex");

  try {
    await db.execute(sql`
      INSERT INTO page_views (visitor_hash, view_date)
      VALUES (${visitorHash}, ${today}::date)
      ON CONFLICT (visitor_hash, view_date) DO NOTHING
    `);
    res.json({ recorded: true });
  } catch (err) {
    if (isMissingPageViewsTable(err)) {
      res.json({ recorded: false });
      return;
    }
    throw err;
  }
});

router.get("/stats/visitors", async (_req, res): Promise<void> => {
  try {
    const result = await db.execute<{
      total_unique_visitors: number;
      total_visits: number;
    }>(sql`
      SELECT
        count(distinct visitor_hash)::int AS total_unique_visitors,
        count(distinct view_date)::int    AS total_visits
      FROM page_views
    `);
    const row = result.rows[0];

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({
      totalUniqueVisitors: row?.total_unique_visitors ?? 0,
      totalVisits: row?.total_visits ?? 0,
    });
  } catch (err) {
    if (isMissingPageViewsTable(err)) {
      res.set(
        "Cache-Control",
        "public, max-age=60, stale-while-revalidate=120",
      );
      res.json({ totalUniqueVisitors: 0, totalVisits: 0 });
      return;
    }
    throw err;
  }
});

// Task #1342 — Pen-test finding #8 (May 23 2026). /stats/trends returns
// day-by-day submission volume + per-tier breakdowns that the pen test
// used to fingerprint usage patterns, detect quiet periods to time
// scraping campaigns, and infer absolute submission counts. The public
// SPA does not consume this surface; the public dashboard reads
// /stats and /stats/distribution which remain open. Reviewer-token
// gated; admin pages already attach the token via customFetch.
router.get("/stats/trends", requireCalibrationAuthStrict, async (req, res): Promise<void> => {
  const lastMod = await getReportsLastModified();
  if (lastMod) {
    res.setHeader("Last-Modified", lastMod.toUTCString());
  }
  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
  if (req.fresh) {
    res.status(304).end();
    return;
  }

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
    agreementRate:
      row.totalCount > 0
        ? Math.round((row.helpfulCount / row.totalCount) * 100)
        : 0,
  }));

  const [totals] = await db
    .select({
      totalReports: sql<number>`count(*)::int`,
      totalFeedback: sql<number>`(select count(*) from user_feedback)::int`,
    })
    .from(reportsTable);

  const response = GetTrendsResponse.parse({
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

  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
  res.json(response);
});

router.get("/public/corpus-stats", async (_req, res): Promise<void> => {
  const generatedAt = new Date();

  const [totals] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(reportsTable);

  const tierRows = await db
    .select({
      tier: reportsTable.slopTier,
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .groupBy(reportsTable.slopTier)
    .orderBy(sql`count(*) desc`);

  const familyRows = await db
    .select({
      family: reportsTable.avriFamily,
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(sql`${reportsTable.avriFamily} is not null`)
    .groupBy(reportsTable.avriFamily)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  const signalRows = await db.execute<{ signal: string; count: number }>(sql`
    SELECT (elem->>'type') AS signal, count(*)::int AS count
    FROM reports, jsonb_array_elements(coalesce(evidence, '[]'::jsonb)) AS elem
    WHERE elem->>'type' IS NOT NULL
    GROUP BY elem->>'type'
    ORDER BY count(*) DESC
    LIMIT 10
  `);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const volumeRows = await db
    .select({
      date: sql<string>`${reportsTable.createdAt}::date::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(gte(reportsTable.createdAt, cutoff))
    .groupBy(sql`${reportsTable.createdAt}::date`)
    .orderBy(sql`${reportsTable.createdAt}::date asc`);

  const response = GetCorpusStatsResponse.parse({
    totalReports: totals.total,
    generatedAt: generatedAt.toISOString(),
    tierBreakdown: tierRows.map((r) => ({ tier: r.tier, count: r.count })),
    topSignals: signalRows.rows.map((r) => ({
      signal: r.signal,
      count: Number(r.count),
    })),
    topCweFamilies: familyRows.map((r) => ({
      family: r.family ?? "FLAT",
      count: r.count,
    })),
    volumeTimeSeries: volumeRows.map((r) => ({ date: r.date, count: r.count })),
  });

  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  res.json(response);
});

export default router;
