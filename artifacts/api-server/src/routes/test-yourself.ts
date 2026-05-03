// Task #633 — Bring-your-own fixture battery.
//
// `POST /api/test-yourself/run` accepts up to 50 `{text, label}` rows where
// `label` is the user's expected verdict (`valid` for a real,
// well-substantiated report; `invalid` for slop / fabrication / noise),
// runs each row through the live engines pipeline, derives a binary
// predicted label from the composite score (composite >= 50 -> `valid`),
// and returns aggregate precision / recall / F1 + a confusion matrix
// alongside per-row results.
//
// The handler is synchronous, persists nothing, and is rate-limited to
// 10 runs / IP / day. The valid class is the positive class.
import { Router, type IRouter, type Request } from "express";
import { RunTestYourselfBody } from "@workspace/api-zod";
import { analyzeWithEnginesTraced } from "../lib/engines";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Composite score >= this threshold predicts the `valid` class. The
// composite label `NEEDS REVIEW` starts at 36 and `REASONABLE` at 51, so
// 50 is the natural binary cutoff between "engine doesn't believe it"
// and "engine believes it".
const VALID_THRESHOLD = 50;

const DAILY_LIMIT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface RateBucket {
  count: number;
  resetAt: number;
}

// In-memory IP -> bucket. A restart resets counts; that's fine for a
// public-good throttle whose only job is to prevent a single client from
// burning our CPU on bulk batches.
const rateBuckets = new Map<string, RateBucket>();

function clientIp(req: Request): string {
  // `app.set("trust proxy", 1)` is configured in app.ts, so req.ip is the
  // real client IP behind Replit's single-hop proxy.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function checkRateLimit(
  ip: string,
  now: number = Date.now(),
): { allowed: boolean; remaining: number } {
  const existing = rateBuckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }
  if (existing.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: DAILY_LIMIT - existing.count - 1 };
}

export function recordRateHit(ip: string, now: number = Date.now()): void {
  const existing = rateBuckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  existing.count += 1;
}

// Test-only escape hatch so route tests can reset shared state between
// runs without exporting the underlying Map.
export function _resetRateLimitForTests(): void {
  rateBuckets.clear();
}

export interface AggregateMetrics {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  confusionMatrix: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  };
}

export function computeAggregate(
  rows: ReadonlyArray<{
    expectedLabel: "valid" | "invalid";
    predictedLabel: "valid" | "invalid";
  }>,
): AggregateMetrics {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const r of rows) {
    if (r.expectedLabel === "valid" && r.predictedLabel === "valid") tp++;
    else if (r.expectedLabel === "invalid" && r.predictedLabel === "valid")
      fp++;
    else if (r.expectedLabel === "invalid" && r.predictedLabel === "invalid")
      tn++;
    else fn++;
  }
  const total = rows.length;
  const accuracy = total === 0 ? 0 : (tp + tn) / total;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    total,
    accuracy: round4(accuracy),
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    confusionMatrix: {
      truePositive: tp,
      falsePositive: fp,
      trueNegative: tn,
      falseNegative: fn,
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function preview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 240 ? trimmed.slice(0, 240) + "…" : trimmed;
}

router.post("/test-yourself/run", async (req, res): Promise<void> => {
  const ip = clientIp(req);

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({
      error: `Daily rate limit exceeded (${DAILY_LIMIT} runs / day per IP). Try again tomorrow.`,
    });
    return;
  }

  const parsed = RunTestYourselfBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ??
        "Request body must be { rows: [{text, label}] } with at most 50 rows and label 'valid'|'invalid'.",
    });
    return;
  }

  // Charge the rate limit only once we know the body is well-formed —
  // malformed bodies should not eat a daily slot.
  recordRateHit(ip);

  const rows = parsed.data.rows;
  const perRow = rows.map((row, index) => {
    let compositeScore = 0;
    let compositeLabel = "LIKELY INVALID";
    try {
      const { composite } = analyzeWithEnginesTraced(row.text, {});
      compositeScore = composite.overallScore;
      compositeLabel = composite.label;
    } catch (err) {
      logger.warn({ err, index }, "[test-yourself] scoring failed for row");
    }
    const predictedLabel: "valid" | "invalid" =
      compositeScore >= VALID_THRESHOLD ? "valid" : "invalid";
    return {
      index,
      textPreview: preview(row.text),
      expectedLabel: row.label,
      predictedLabel,
      compositeScore,
      compositeLabel,
      correct: predictedLabel === row.label,
    };
  });

  const aggregate = computeAggregate(perRow);

  res.status(200).json({
    aggregate,
    perRow,
    rateLimit: { limit: DAILY_LIMIT, remaining: limit.remaining },
  });
});

export default router;
