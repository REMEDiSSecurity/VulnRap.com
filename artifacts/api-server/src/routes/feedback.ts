import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { userFeedbackTable, reportsTable } from "@workspace/db";
import { SubmitFeedbackBody } from "@workspace/api-zod";
import { sql, eq, desc, gte, and, isNotNull } from "drizzle-orm";

const router: IRouter = Router();

router.post("/feedback", async (req, res) => {
  try {
    const parsed = SubmitFeedbackBody.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid feedback data. Rating (1-5) and helpful (true/false) are required." });
      return;
    }

    const { reportId, rating, helpful, comment } = parsed.data;

    const trimmedComment = comment?.trim().slice(0, 1000) || null;

    const [inserted] = await db
      .insert(userFeedbackTable)
      .values({
        reportId: reportId ?? null,
        rating,
        helpful,
        comment: trimmedComment,
      })
      .returning({ id: userFeedbackTable.id });

    res.status(201).json({
      id: inserted.id,
      message: "Thank you for your feedback!",
    });
  } catch (err) {
    req.log?.error(err, "Failed to submit feedback");
    res.status(500).json({ error: "Failed to submit feedback." });
  }
});

router.get("/feedback/analytics", async (_req, res): Promise<void> => {
  try {
    const [summary] = await db
      .select({
        totalFeedback: sql<number>`count(*)::int`,
        avgRating: sql<number>`coalesce(round(avg(${userFeedbackTable.rating})::numeric, 2), 0)::float`,
        helpfulCount: sql<number>`count(*) filter (where ${userFeedbackTable.helpful} = true)::int`,
        notHelpfulCount: sql<number>`count(*) filter (where ${userFeedbackTable.helpful} = false)::int`,
        withComments: sql<number>`count(*) filter (where ${userFeedbackTable.comment} is not null and ${userFeedbackTable.comment} != '')::int`,
        linkedToReport: sql<number>`count(*) filter (where ${userFeedbackTable.reportId} is not null)::int`,
      })
      .from(userFeedbackTable);

    const ratingDistribution = await db
      .select({
        rating: userFeedbackTable.rating,
        count: sql<number>`count(*)::int`,
      })
      .from(userFeedbackTable)
      .groupBy(userFeedbackTable.rating)
      .orderBy(userFeedbackTable.rating);

    const ratingDist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const row of ratingDistribution) {
      ratingDist[String(row.rating)] = row.count;
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyTrend = await db
      .select({
        date: sql<string>`to_char(${userFeedbackTable.createdAt}::date, 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
        avgRating: sql<number>`round(avg(${userFeedbackTable.rating})::numeric, 2)::float`,
        helpfulPct: sql<number>`round(100.0 * count(*) filter (where ${userFeedbackTable.helpful} = true) / greatest(count(*), 1), 1)::float`,
      })
      .from(userFeedbackTable)
      .where(gte(userFeedbackTable.createdAt, thirtyDaysAgo))
      .groupBy(sql`${userFeedbackTable.createdAt}::date`)
      .orderBy(sql`${userFeedbackTable.createdAt}::date`);

    const outliers = await db
      .select({
        feedbackId: userFeedbackTable.id,
        reportId: userFeedbackTable.reportId,
        rating: userFeedbackTable.rating,
        helpful: userFeedbackTable.helpful,
        comment: userFeedbackTable.comment,
        feedbackDate: userFeedbackTable.createdAt,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
        qualityScore: reportsTable.qualityScore,
      })
      .from(userFeedbackTable)
      .innerJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
      .where(
        sql`(
          (${userFeedbackTable.rating} <= 2 AND ${reportsTable.slopScore} >= 60) OR
          (${userFeedbackTable.rating} >= 4 AND ${reportsTable.slopScore} <= 20) OR
          (${userFeedbackTable.helpful} = false)
        )`
      )
      .orderBy(desc(userFeedbackTable.createdAt))
      .limit(50);

    const scoreCorrelation = await db
      .select({
        scoreBucket: sql<string>`case
          when ${reportsTable.slopScore} <= 20 then 'Clean (0-20)'
          when ${reportsTable.slopScore} <= 40 then 'Likely Human (21-40)'
          when ${reportsTable.slopScore} <= 60 then 'Questionable (41-60)'
          when ${reportsTable.slopScore} <= 80 then 'Likely Slop (61-80)'
          else 'Slop (81-100)'
        end`,
        avgRating: sql<number>`round(avg(${userFeedbackTable.rating})::numeric, 2)::float`,
        helpfulPct: sql<number>`round(100.0 * count(*) filter (where ${userFeedbackTable.helpful} = true) / greatest(count(*), 1), 1)::float`,
        count: sql<number>`count(*)::int`,
      })
      .from(userFeedbackTable)
      .innerJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
      .groupBy(sql`case
        when ${reportsTable.slopScore} <= 20 then 'Clean (0-20)'
        when ${reportsTable.slopScore} <= 40 then 'Likely Human (21-40)'
        when ${reportsTable.slopScore} <= 60 then 'Questionable (41-60)'
        when ${reportsTable.slopScore} <= 80 then 'Likely Slop (61-80)'
        else 'Slop (81-100)'
      end`)
      .orderBy(sql`min(${reportsTable.slopScore})`);

    const recentFeedback = await db
      .select({
        feedbackId: userFeedbackTable.id,
        reportId: userFeedbackTable.reportId,
        rating: userFeedbackTable.rating,
        helpful: userFeedbackTable.helpful,
        comment: userFeedbackTable.comment,
        createdAt: userFeedbackTable.createdAt,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
      })
      .from(userFeedbackTable)
      .leftJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
      .orderBy(desc(userFeedbackTable.createdAt))
      .limit(25);

    res.json({
      summary: {
        totalFeedback: summary.totalFeedback,
        avgRating: summary.avgRating,
        helpfulCount: summary.helpfulCount,
        notHelpfulCount: summary.notHelpfulCount,
        helpfulnessRate: summary.totalFeedback > 0
          ? Math.round(1000 * summary.helpfulCount / summary.totalFeedback) / 10
          : 0,
        withComments: summary.withComments,
        linkedToReport: summary.linkedToReport,
      },
      ratingDistribution: ratingDist,
      dailyTrend,
      scoreCorrelation,
      outliers,
      recentFeedback: recentFeedback.map(f => ({
        feedbackId: f.feedbackId,
        reportId: f.reportId,
        rating: f.rating,
        helpful: f.helpful,
        comment: f.comment,
        createdAt: f.createdAt,
        slopScore: f.slopScore,
        slopTier: f.slopTier,
      })),
    });
  } catch (err) {
    _req.log?.error(err, "Failed to fetch feedback analytics");
    res.status(500).json({ error: "Failed to fetch feedback analytics." });
  }
});

export default router;
