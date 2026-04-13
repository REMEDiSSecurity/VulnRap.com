import { db } from "@workspace/db";
import { userFeedbackTable, reportsTable } from "@workspace/db";
import { sql, eq, gte, and, isNotNull } from "drizzle-orm";
import { getCurrentConfig, type ScoringConfig } from "./scoring-config";

const MIN_FEEDBACK_PER_BUCKET = 10;

export interface BucketAnalysis {
  bucket: string;
  scoreRange: [number, number];
  feedbackCount: number;
  avgRating: number;
  helpfulPct: number;
  meetsThreshold: boolean;
  signal: "accurate" | "over-scoring" | "under-scoring" | "insufficient-data";
  ratingDeviation: number;
}

export interface CalibrationSuggestion {
  parameter: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
  confidence: "low" | "medium" | "high";
  basedOnCount: number;
}

export interface CalibrationReport {
  currentConfig: ScoringConfig;
  totalFeedbackAnalyzed: number;
  bucketAnalysis: BucketAnalysis[];
  suggestions: CalibrationSuggestion[];
  overallHealth: "good" | "needs-attention" | "needs-tuning";
  minFeedbackThreshold: number;
}

const BUCKETS = [
  { bucket: "Clean (0-20)", range: [0, 20] as [number, number], expectedRating: 4.5 },
  { bucket: "Likely Human (21-40)", range: [21, 40] as [number, number], expectedRating: 4.0 },
  { bucket: "Questionable (41-60)", range: [41, 60] as [number, number], expectedRating: 3.0 },
  { bucket: "Likely Slop (61-80)", range: [61, 80] as [number, number], expectedRating: 3.5 },
  { bucket: "Slop (81-100)", range: [81, 100] as [number, number], expectedRating: 4.0 },
];

export async function generateCalibrationReport(): Promise<CalibrationReport> {
  const config = getCurrentConfig();

  const bucketResults = await db
    .select({
      slopScore: reportsTable.slopScore,
      rating: userFeedbackTable.rating,
      helpful: userFeedbackTable.helpful,
    })
    .from(userFeedbackTable)
    .innerJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
    .where(isNotNull(reportsTable.slopScore));

  const totalFeedbackAnalyzed = bucketResults.length;

  const bucketData = new Map<string, { ratings: number[]; helpfulCount: number; total: number }>();
  for (const b of BUCKETS) {
    bucketData.set(b.bucket, { ratings: [], helpfulCount: 0, total: 0 });
  }

  for (const row of bucketResults) {
    const score = row.slopScore ?? 0;
    for (const b of BUCKETS) {
      if (score >= b.range[0] && score <= b.range[1]) {
        const data = bucketData.get(b.bucket)!;
        data.ratings.push(row.rating);
        if (row.helpful) data.helpfulCount++;
        data.total++;
        break;
      }
    }
  }

  const bucketAnalysis: BucketAnalysis[] = BUCKETS.map((b) => {
    const data = bucketData.get(b.bucket)!;
    const meetsThreshold = data.total >= MIN_FEEDBACK_PER_BUCKET;
    const avgRating = data.total > 0
      ? Math.round((data.ratings.reduce((s, r) => s + r, 0) / data.total) * 100) / 100
      : 0;
    const helpfulPct = data.total > 0
      ? Math.round((data.helpfulCount / data.total) * 1000) / 10
      : 0;

    const ratingDeviation = avgRating - b.expectedRating;

    let signal: BucketAnalysis["signal"];
    if (!meetsThreshold) {
      signal = "insufficient-data";
    } else if (Math.abs(ratingDeviation) <= 0.5) {
      signal = "accurate";
    } else if (
      (b.bucket.includes("Clean") || b.bucket.includes("Human")) && ratingDeviation < -0.5
    ) {
      signal = "under-scoring";
    } else if (
      (b.bucket.includes("Slop")) && ratingDeviation < -0.5
    ) {
      signal = "over-scoring";
    } else if (
      (b.bucket.includes("Clean") || b.bucket.includes("Human")) && ratingDeviation > 0.5
    ) {
      signal = "accurate";
    } else {
      signal = ratingDeviation < -0.5 ? "over-scoring" : "under-scoring";
    }

    return {
      bucket: b.bucket,
      scoreRange: b.range,
      feedbackCount: data.total,
      avgRating,
      helpfulPct,
      meetsThreshold,
      signal,
      ratingDeviation: Math.round(ratingDeviation * 100) / 100,
    };
  });

  const suggestions = generateSuggestions(bucketAnalysis, config);

  const problematicBuckets = bucketAnalysis.filter(
    b => b.meetsThreshold && (b.signal === "over-scoring" || b.signal === "under-scoring")
  );
  const overallHealth: CalibrationReport["overallHealth"] =
    problematicBuckets.length === 0
      ? "good"
      : problematicBuckets.length <= 1
        ? "needs-attention"
        : "needs-tuning";

  return {
    currentConfig: config,
    totalFeedbackAnalyzed,
    bucketAnalysis,
    suggestions,
    overallHealth,
    minFeedbackThreshold: MIN_FEEDBACK_PER_BUCKET,
  };
}

function generateSuggestions(
  analysis: BucketAnalysis[],
  config: ScoringConfig
): CalibrationSuggestion[] {
  const suggestions: CalibrationSuggestion[] = [];

  const cleanBucket = analysis.find(b => b.bucket.includes("Clean"));
  if (cleanBucket && cleanBucket.meetsThreshold && cleanBucket.signal === "under-scoring") {
    const newLow = Math.max(5, config.tierThresholds.low - 5);
    suggestions.push({
      parameter: "tierThresholds.low",
      currentValue: config.tierThresholds.low,
      suggestedValue: newLow,
      reason: `Reports scored as "Clean" (0-${config.tierThresholds.low}) are getting low ratings (avg ${cleanBucket.avgRating}). Lowering the clean threshold would be more conservative.`,
      confidence: cleanBucket.feedbackCount >= 30 ? "high" : "medium",
      basedOnCount: cleanBucket.feedbackCount,
    });
  }

  const slopBucket = analysis.find(b => b.bucket === "Slop (81-100)");
  if (slopBucket && slopBucket.meetsThreshold && slopBucket.signal === "over-scoring") {
    const newHigh = Math.min(95, config.tierThresholds.high + 5);
    suggestions.push({
      parameter: "tierThresholds.high",
      currentValue: config.tierThresholds.high,
      suggestedValue: newHigh,
      reason: `Reports scored as "Slop" (${config.tierThresholds.high}+) are getting low ratings (avg ${slopBucket.avgRating}), suggesting false positives. Raising the threshold would reduce over-classification.`,
      confidence: slopBucket.feedbackCount >= 30 ? "high" : "medium",
      basedOnCount: slopBucket.feedbackCount,
    });
  }

  const questionableBucket = analysis.find(b => b.bucket.includes("Questionable"));
  if (questionableBucket && questionableBucket.meetsThreshold) {
    if (questionableBucket.helpfulPct < 50 && questionableBucket.avgRating < 2.5) {
      suggestions.push({
        parameter: "prior",
        currentValue: config.prior,
        suggestedValue: Math.max(5, config.prior - 3),
        reason: `The "Questionable" range has low helpfulness (${questionableBucket.helpfulPct}%) and ratings (${questionableBucket.avgRating}). Lowering the prior would shift baseline scores down, potentially improving accuracy in this middle range.`,
        confidence: questionableBucket.feedbackCount >= 30 ? "high" : "medium",
        basedOnCount: questionableBucket.feedbackCount,
      });
    }
  }

  const likelyHumanBucket = analysis.find(b => b.bucket.includes("Likely Human"));
  if (likelyHumanBucket && likelyHumanBucket.meetsThreshold && likelyHumanBucket.signal === "under-scoring") {
    suggestions.push({
      parameter: "axisThresholds.linguistic",
      currentValue: config.axisThresholds.linguistic,
      suggestedValue: Math.min(25, config.axisThresholds.linguistic + 5),
      reason: `Reports in the "Likely Human" range are rated poorly (avg ${likelyHumanBucket.avgRating}), suggesting the linguistic axis fires too aggressively. Raising its activation threshold would reduce false positives.`,
      confidence: likelyHumanBucket.feedbackCount >= 30 ? "high" : "medium",
      basedOnCount: likelyHumanBucket.feedbackCount,
    });
  }

  return suggestions;
}
