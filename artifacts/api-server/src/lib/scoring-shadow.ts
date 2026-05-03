// Task #639 — Shadow Scoring Mode.
//
// When `SHADOW_SCORING_ENABLED=1`, we score every successfully-persisted
// production report through BOTH the live pipeline (whose result the user
// already saw) and a "shadow" pipeline (the in-flight scoring rule change
// being staged for promotion). The shadow result is appended to
// `report_shadow_scores` alongside the live score so reviewers can browse
// a "shadow drift" dashboard at `/api/internal/shadow-drift` and the
// reviewer-only tab on `/feedback-analytics` to spot regressions before
// promoting the shadow rules to live.
//
// v1 design notes
// ---------------
// - Mode is OFF by default. Toggle with `SHADOW_SCORING_ENABLED=1`.
// - `instant-check` (POST /reports/check) does NOT shadow-score. The task
//   explicitly scopes shadow mode to production reports only.
// - The shadow pipeline today is `recomputeSlopScoreWithoutLlm` re-run
//   with two optional env-gated overrides that simulate an in-flight
//   scoring rule change without forcing a separate scorer module:
//     * `SHADOW_SCORING_SCORE_DELTA` — integer (e.g. "5", "-7"), added
//       to the recomputed score before tier mapping. Lets a reviewer
//       preview "what if we tighten by +5 across the board".
//     * `SHADOW_SCORING_TIER_OVERRIDES` — JSON like
//       `{"slop":75,"likelySlop":55,"questionable":35,"likelyHuman":15}`
//       overriding the >= thresholds used to compute the shadow tier.
//   Both are optional. With neither set, shadow == live and divergence
//   surfaces nothing — exactly the right behavior for an empty rollout.
// - Promotion (shadow → live) is always manual; this module never
//   mutates `reports`. It only ever appends to `report_shadow_scores`.
// - Failures inside the shadow runner are logged and swallowed: shadow
//   scoring must never break the user-facing submit path.

import { db } from "@workspace/db";
import { reportShadowScoresTable, type EvidenceItem } from "@workspace/db";
import { logger } from "./logger";
import { recomputeSlopScoreWithoutLlm, getSlopTier } from "./score-fusion";

export interface ShadowScoreInputBreakdown {
  linguistic: number;
  factual: number;
  template: number;
  verification?: number | null;
}

export interface ShadowScoreInput {
  reportId: number;
  liveScore: number;
  liveTier: string;
  breakdown: ShadowScoreInputBreakdown;
  evidence: EvidenceItem[];
  originalText: string;
}

export function isShadowScoringEnabled(): boolean {
  return (process.env.SHADOW_SCORING_ENABLED ?? "").trim() === "1";
}

interface TierOverrides {
  slop: number;
  likelySlop: number;
  questionable: number;
  likelyHuman: number;
}

function readShadowDelta(): number {
  const raw = process.env.SHADOW_SCORING_SCORE_DELTA;
  if (typeof raw !== "string" || raw.trim().length === 0) return 0;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function readTierOverrides(): TierOverrides | null {
  const raw = process.env.SHADOW_SCORING_TIER_OVERRIDES;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof TierOverrides, unknown>>;
    const slop = Number(parsed.slop ?? 80);
    const likelySlop = Number(parsed.likelySlop ?? 60);
    const questionable = Number(parsed.questionable ?? 40);
    const likelyHuman = Number(parsed.likelyHuman ?? 20);
    if (
      [slop, likelySlop, questionable, likelyHuman].some(
        (v) => !Number.isFinite(v) || v < 0 || v > 100,
      )
    ) {
      return null;
    }
    return { slop, likelySlop, questionable, likelyHuman };
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 80) },
      "[shadow-scoring] Ignoring malformed SHADOW_SCORING_TIER_OVERRIDES",
    );
    return null;
  }
}

function applyTierOverrides(score: number, overrides: TierOverrides): string {
  if (score >= overrides.slop) return "Slop";
  if (score >= overrides.likelySlop) return "Likely Slop";
  if (score >= overrides.questionable) return "Questionable";
  if (score >= overrides.likelyHuman) return "Likely Human";
  return "Clean";
}

function readShadowVersion(): string {
  const raw = process.env.SHADOW_SCORING_VERSION;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().slice(0, 64);
  }
  // Fall back to the same code-version source the rescore-log uses so a
  // diverging row can be traced back to the deploy that produced it.
  const codeVer = process.env.CODE_VERSION ?? process.env.npm_package_version;
  if (typeof codeVer === "string" && codeVer.trim().length > 0) {
    return codeVer.trim().slice(0, 64);
  }
  return "unknown";
}

/**
 * Compute the shadow score+tier for a single report. Exported (rather
 * than inlined) so unit tests can exercise the env-driven divergence
 * knobs without round-tripping through the database.
 */
export function computeShadowScore(
  input: Pick<ShadowScoreInput, "breakdown" | "evidence" | "originalText">,
): { score: number; tier: string } {
  const recomputed = recomputeSlopScoreWithoutLlm(
    input.breakdown,
    input.evidence,
    input.originalText,
  );
  const delta = readShadowDelta();
  const adjusted = Math.min(100, Math.max(0, recomputed.slopScore + delta));
  const overrides = readTierOverrides();
  const tier = overrides
    ? applyTierOverrides(adjusted, overrides)
    : getSlopTier(adjusted);
  return { score: adjusted, tier };
}

/**
 * Shadow-score a freshly persisted production report. Fire-and-forget:
 * the caller does NOT await this on the user-facing submit path. Errors
 * are logged and swallowed so a shadow-pipeline regression can never
 * fail a real submission.
 */
export async function runShadowScore(input: ShadowScoreInput): Promise<void> {
  if (!isShadowScoringEnabled()) return;
  try {
    const shadow = computeShadowScore(input);
    const scoreDiff = shadow.score - input.liveScore;
    const tierDiverged = shadow.tier !== input.liveTier;
    await db.insert(reportShadowScoresTable).values({
      reportId: input.reportId,
      liveScore: input.liveScore,
      liveTier: input.liveTier,
      shadowScore: shadow.score,
      shadowTier: shadow.tier,
      scoreDiff,
      tierDiverged,
      shadowVersion: readShadowVersion(),
    });
  } catch (err) {
    logger.warn(
      { err, reportId: input.reportId },
      "[shadow-scoring] Shadow score persistence failed; live score unaffected",
    );
  }
}
