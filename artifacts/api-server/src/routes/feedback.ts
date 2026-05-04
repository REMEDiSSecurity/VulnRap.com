import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { userFeedbackTable, reportsTable } from "@workspace/db";
import { SubmitFeedbackBody } from "@workspace/api-zod";
import { sql, eq, desc, gte, and, isNotNull } from "drizzle-orm";
import { generateChallenge, verifyChallenge } from "../lib/challenge";

const router: IRouter = Router();

router.get("/feedback/challenge", (_req, res) => {
  try {
    const challenge = generateChallenge();
    res.json(challenge);
  } catch (err) {
    _req.log?.error(err, "Failed to generate challenge");
    res.status(500).json({ error: "Failed to generate challenge." });
  }
});

router.post("/feedback", async (req, res) => {
  try {
    const {
      challengeId,
      challengeSolution,
      reportId,
      rating,
      helpful,
      comment,
    } = req.body;

    if (
      !challengeId ||
      typeof challengeId !== "string" ||
      !challengeSolution ||
      typeof challengeSolution !== "string"
    ) {
      res.status(400).json({
        error:
          "Proof-of-work challenge is required. Fetch a challenge from GET /feedback/challenge first.",
      });
      return;
    }

    const challengeResult = verifyChallenge(challengeId, challengeSolution);
    if (!challengeResult.valid) {
      res.status(403).json({ error: challengeResult.error });
      return;
    }

    if (
      typeof rating !== "number" ||
      rating < 1 ||
      rating > 5 ||
      !Number.isInteger(rating)
    ) {
      res.status(400).json({ error: "Rating must be an integer from 1 to 5." });
      return;
    }
    if (typeof helpful !== "boolean") {
      res.status(400).json({ error: "helpful must be a boolean." });
      return;
    }

    const trimmedComment =
      typeof comment === "string"
        ? comment.trim().slice(0, 1000) || null
        : null;
    const validReportId =
      typeof reportId === "number" && Number.isInteger(reportId)
        ? reportId
        : null;

    // Task #640 — atomically insert the feedback row AND stamp the
    // deterministic holdout flag in a single transaction so a partial
    // failure can never leave a row with the default is_holdout=false
    // (which would silently bias the holdout-eval metrics). The bucket
    // expression `(abs(hashtext(id::text)) % 5) = 0` (~20%) is the same
    // one the startup-migration backfill uses, so backfill and per-insert
    // path agree on every id. We can't fold the stamping into the same
    // statement because Postgres doesn't make a CTE's INSERT visible to a
    // sibling UPDATE.
    const insertedId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(userFeedbackTable)
        .values({
          reportId: validReportId,
          rating,
          helpful,
          comment: trimmedComment,
        })
        .returning({ id: userFeedbackTable.id });
      await tx.execute(
        sql`UPDATE user_feedback SET is_holdout = ((abs(hashtext(id::text)) % 5) = 0) WHERE id = ${row.id}`,
      );
      return row.id;
    });

    res.status(201).json({
      id: insertedId,
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

    const ratingDist: Record<string, number> = {
      "1": 0,
      "2": 0,
      "3": 0,
      "4": 0,
      "5": 0,
    };
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
        and(
          eq(reportsTable.showInFeed, true),
          sql`(
            (${userFeedbackTable.rating} <= 2 AND ${reportsTable.slopScore} >= 60) OR
            (${userFeedbackTable.rating} >= 4 AND ${reportsTable.slopScore} <= 20) OR
            (${userFeedbackTable.helpful} = false)
          )`,
        ),
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
      .groupBy(
        sql`case
        when ${reportsTable.slopScore} <= 20 then 'Clean (0-20)'
        when ${reportsTable.slopScore} <= 40 then 'Likely Human (21-40)'
        when ${reportsTable.slopScore} <= 60 then 'Questionable (41-60)'
        when ${reportsTable.slopScore} <= 80 then 'Likely Slop (61-80)'
        else 'Slop (81-100)'
      end`,
      )
      .orderBy(sql`min(${reportsTable.slopScore})`);

    const recentFeedback = await db
      .select({
        feedbackId: userFeedbackTable.id,
        rating: userFeedbackTable.rating,
        helpful: userFeedbackTable.helpful,
        comment: userFeedbackTable.comment,
        createdAt: userFeedbackTable.createdAt,
        slopScore: reportsTable.slopScore,
        slopTier: reportsTable.slopTier,
      })
      .from(userFeedbackTable)
      .innerJoin(
        reportsTable,
        and(
          eq(userFeedbackTable.reportId, reportsTable.id),
          eq(reportsTable.showInFeed, true),
        ),
      )
      .orderBy(desc(userFeedbackTable.createdAt))
      .limit(25);

    res.json({
      summary: {
        totalFeedback: summary.totalFeedback,
        avgRating: summary.avgRating,
        helpfulCount: summary.helpfulCount,
        notHelpfulCount: summary.notHelpfulCount,
        helpfulnessRate:
          summary.totalFeedback > 0
            ? Math.round(
                (1000 * summary.helpfulCount) / summary.totalFeedback,
              ) / 10
            : 0,
        withComments: summary.withComments,
        linkedToReport: summary.linkedToReport,
      },
      ratingDistribution: ratingDist,
      dailyTrend,
      scoreCorrelation,
      outliers: outliers.map((o) => ({
        feedbackId: o.feedbackId,
        rating: o.rating,
        helpful: o.helpful,
        comment: o.comment,
        feedbackDate: o.feedbackDate,
        slopScore: o.slopScore,
        slopTier: o.slopTier,
        qualityScore: o.qualityScore,
      })),
      recentFeedback: recentFeedback.map((f) => ({
        feedbackId: f.feedbackId,
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

// Task #640 — Honest precision/recall computed ONLY from holdout rows
// that calibration suggestions never touch. Treat the engine as a binary
// "slop" classifier:
//   predicted slop  := slopScore >= config.tierThresholds.high
//   actually slop   := rating <= 2 OR helpful = false
// Returns side-by-side holdout vs. in-sample numbers so reviewers can spot
// when the in-sample numbers were optimistic (the whole point of locking a
// holdout). When a partition has zero rows, precision/recall are returned
// as null so the UI can render "insufficient data" instead of a misleading 0.
//
// Task #982 — The metric math is now shared with the holdout drift
// scheduler via `computeHoldoutEval` so both code paths stay in sync.
router.get("/feedback/holdout-eval", async (_req, res): Promise<void> => {
  try {
    const { computeHoldoutEval } = await import("../lib/holdout-eval");
    const result = await computeHoldoutEval();

    res.json({
      thresholds: {
        scoreThreshold: result.scoreThreshold,
        ratingThreshold: result.ratingThreshold,
        description: `Predicted slop = slopScore >= ${result.scoreThreshold}; actually slop = user rating <= ${result.ratingThreshold} OR helpful = false`,
      },
      holdout: result.holdout,
      inSample: result.inSample,
      holdoutFraction: 0.2,
    });
  } catch (err) {
    _req.log?.error(err, "Failed to compute holdout evaluation");
    res.status(500).json({ error: "Failed to compute holdout evaluation." });
  }
});

// Task #662 — Per-signal precision/recall. For each evidence signal type
// that has appeared on at least one rated report, compute how often its
// presence correlates with "actually slop" feedback (rating ≤ 2 OR
// helpful = false). The numbers are diagnostic — they are computed across
// the full feedback set, not the holdout split — so the per-signal
// explainer pages can show "when this signal fires, the report is rated
// slop X% of the time (N samples)". A signal with <5 samples is returned
// with null precision so the UI can render "insufficient data" instead
// of an unstable percentage.
router.get("/feedback/per-signal-eval", async (_req, res): Promise<void> => {
  try {
    const ratingThreshold = 2;

    const rows = await db
      .select({
        evidence: reportsTable.evidence,
        rating: userFeedbackTable.rating,
        helpful: userFeedbackTable.helpful,
      })
      .from(userFeedbackTable)
      .innerJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
      .where(isNotNull(reportsTable.slopScore));

    type Bucket = {
      fires: number;
      firesAndSlop: number;
      firesAndNotSlop: number;
    };
    const perSignal = new Map<string, Bucket>();

    for (const row of rows) {
      const actuallySlop =
        row.rating <= ratingThreshold || row.helpful === false;
      const evidence = (row.evidence ?? []) as Array<{ type?: string }>;
      const seen = new Set<string>();
      for (const e of evidence) {
        if (!e?.type || seen.has(e.type)) continue;
        seen.add(e.type);
        let bucket = perSignal.get(e.type);
        if (!bucket) {
          bucket = { fires: 0, firesAndSlop: 0, firesAndNotSlop: 0 };
          perSignal.set(e.type, bucket);
        }
        bucket.fires++;
        if (actuallySlop) bucket.firesAndSlop++;
        else bucket.firesAndNotSlop++;
      }
    }

    const signals = Array.from(perSignal.entries())
      .map(([type, b]) => ({
        type,
        samples: b.fires,
        firesAndSlop: b.firesAndSlop,
        firesAndNotSlop: b.firesAndNotSlop,
        // "Precision" here = P(actually slop | signal fired). With <5
        // samples we return null to discourage the UI from showing a
        // jittery 0% / 100% on a single feedback row.
        precision: b.fires >= 5 ? b.firesAndSlop / b.fires : null,
      }))
      .sort((a, b) => b.samples - a.samples);

    res.json({
      totalFeedbackRows: rows.length,
      signals,
    });
  } catch (err) {
    _req.log?.error(err, "Failed to compute per-signal eval");
    res.status(500).json({ error: "Failed to compute per-signal eval." });
  }
});

export default router;
