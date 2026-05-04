// Task #982 — Shared holdout evaluation logic used by both the
// GET /feedback/holdout-eval route and the holdout drift scheduler.
// Centralised here so changes to the classifier definition or metric
// math are applied in exactly one place.

import { db } from "@workspace/db";
import { userFeedbackTable, reportsTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import { getCurrentConfig } from "./scoring-config";

export interface HoldoutPartition {
  totalFeedback: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
}

export function emptyPartition(): HoldoutPartition {
  return {
    totalFeedback: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    precision: null,
    recall: null,
    f1: null,
    accuracy: null,
  };
}

export function finalizePartition(p: HoldoutPartition): HoldoutPartition {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const precDen = p.tp + p.fp;
  const recDen = p.tp + p.fn;
  const total = p.totalFeedback;
  const precision = precDen > 0 ? round(p.tp / precDen) : null;
  const recall = recDen > 0 ? round(p.tp / recDen) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? round((2 * precision * recall) / (precision + recall))
      : null;
  const accuracy = total > 0 ? round((p.tp + p.tn) / total) : null;
  return { ...p, precision, recall, f1, accuracy };
}

export interface HoldoutEvalResult {
  scoreThreshold: number;
  ratingThreshold: number;
  holdout: HoldoutPartition;
  inSample: HoldoutPartition;
}

export async function computeHoldoutEval(): Promise<HoldoutEvalResult> {
  const config = getCurrentConfig();
  const scoreThreshold = config.tierThresholds.high;
  const ratingThreshold = 2;

  const rows = await db
    .select({
      slopScore: reportsTable.slopScore,
      rating: userFeedbackTable.rating,
      helpful: userFeedbackTable.helpful,
      isHoldout: userFeedbackTable.isHoldout,
    })
    .from(userFeedbackTable)
    .innerJoin(reportsTable, eq(userFeedbackTable.reportId, reportsTable.id))
    .where(isNotNull(reportsTable.slopScore));

  const holdout = emptyPartition();
  const inSample = emptyPartition();

  for (const row of rows) {
    const score = row.slopScore ?? 0;
    const predictedSlop = score >= scoreThreshold;
    const actuallySlop = row.rating <= ratingThreshold || row.helpful === false;
    const target = row.isHoldout ? holdout : inSample;
    target.totalFeedback++;
    if (predictedSlop && actuallySlop) target.tp++;
    else if (predictedSlop && !actuallySlop) target.fp++;
    else if (!predictedSlop && actuallySlop) target.fn++;
    else target.tn++;
  }

  return {
    scoreThreshold,
    ratingThreshold,
    holdout: finalizePartition(holdout),
    inSample: finalizePartition(inSample),
  };
}
