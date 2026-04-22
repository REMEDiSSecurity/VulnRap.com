// AVRI composite. Wraps Engines 1 (legacy AI authorship) + 2 (AVRI substance)
// + 3 (AVRI coherence) and applies the v3.6.0 override rules plus the
// Sprint 11 AVRI overrides (family-no-gold, family-contradiction, off-family,
// behavioral velocity, campaign template).

import { runEngine1, computeComposite, type CompositeResult, type EngineResult } from "../engines";
import { extractSignals } from "../extractors";
import { computePerplexity } from "../perplexity";
import { classifyReport, type ClassificationResult } from "./classify";
import { runEngine2Avri } from "./engine2-avri";
import { runEngine3Avri } from "./engine3-avri";
import type { FamilyRubric } from "./families";

export interface AvriCompositeOptions {
  claimedCwes?: string[];
  /** Pre-computed velocity penalty (≤0) from the route layer. */
  velocityPenalty?: number;
  /** Pre-computed template-fingerprint penalty (≤0) from the route layer. */
  templatePenalty?: number;
}

export interface AvriCompositeResult extends CompositeResult {
  avri: {
    family: FamilyRubric["id"];
    familyName: string;
    classification: {
      confidence: ClassificationResult["confidence"];
      reason: string;
      evidence: string[];
      technology: string | null;
    };
    goldHitCount: number;
    velocityPenalty: number;
    templatePenalty: number;
    rawCompositeBeforeBehavioralPenalties: number;
  };
}

export function runAvriComposite(
  text: string,
  opts: AvriCompositeOptions = {},
): AvriCompositeResult {
  const signals = extractSignals(text, opts.claimedCwes);
  const perplexity = computePerplexity(text, signals.codeBlocks);

  // Engine 1 — keep the existing perplexity-blended scoring identical to the
  // legacy pipeline so the AI authorship signal remains comparable.
  const e1Raw = runEngine1(signals);
  const blendedScore = Math.round(e1Raw.score * 0.6 + perplexity.combinedScore * 0.4);
  const blendedVerdict =
    blendedScore <= 25 ? "GREEN" : blendedScore <= 74 ? "YELLOW" : "RED";
  const e1: EngineResult = {
    ...e1Raw,
    score: blendedScore,
    verdict: blendedVerdict,
    signalBreakdown: {
      ...e1Raw.signalBreakdown,
      perplexity: {
        bigramEntropy: Number(perplexity.bigramEntropy.toFixed(3)),
        functionWordRate: Number(perplexity.functionWordRate.toFixed(2)),
        syntaxValidityScore: Number(perplexity.syntaxValidityScore.toFixed(2)),
        combinedScore: Number(perplexity.combinedScore.toFixed(1)),
        rawEngine1Score: e1Raw.score,
        rawEngine1Verdict: e1Raw.verdict,
      },
    },
  };

  // Engine 0 — classification.
  const classification = classifyReport(text, opts.claimedCwes);
  const family = classification.family;

  // Engine 2 / 3 AVRI.
  const e2 = runEngine2Avri(signals, text, family);
  const e3 = runEngine3Avri(signals, text, family, classification);

  // Run the existing composite (5/55/40 weighting + override rules).
  const baseComposite = computeComposite([e1, e2.engine, e3.engine]);

  // Apply Sprint 11 behavioral penalties on top, capped by clamp.
  const velocityPenalty = Math.min(0, opts.velocityPenalty ?? 0);
  const templatePenalty = Math.min(0, opts.templatePenalty ?? 0);
  const additionalPenalties = velocityPenalty + templatePenalty;
  const newOverrides = [...baseComposite.overridesApplied];
  if (velocityPenalty < 0) {
    newOverrides.push(`AVRI_VELOCITY: same-day submission velocity penalty (${velocityPenalty})`);
  }
  if (templatePenalty < 0) {
    newOverrides.push(`AVRI_TEMPLATE_CAMPAIGN: structural fingerprint reused (${templatePenalty})`);
  }

  // Family-no-gold + off-family overrides.
  if (family.id !== "FLAT" && e2.goldHitCount === 0 && e3.detail.goldHitCount === 0) {
    newOverrides.push(`AVRI_NO_GOLD_SIGNALS: zero gold signals for ${family.displayName}`);
  }
  if (family.id !== "FLAT" && e2.detail.contradictionsFound.length >= 1) {
    newOverrides.push(`AVRI_FAMILY_CONTRADICTION: report contradicts claimed family (${e2.detail.contradictionsFound[0]})`);
  }

  // FLAT slop additional composite haircut: when an unclassifiable report
  // self-admits to having no concrete evidence (≥3 hand-wavy markers fired
  // in Engine 2 → totalAbsencePenalty=18+), apply an extra -8 at the
  // composite level. The Engine 2 haircut alone only zeroes the substance
  // score; Engines 1 and 3 still contribute their legacy values, which can
  // leave a buzzword-soup composite hovering in the high teens to twenties.
  // This penalty pushes those reports below the LIKELY INVALID band where
  // they belong, without touching legitimate FLAT reports (which never
  // accumulate a haircut).
  let flatSlopPenalty = 0;
  if (family.id === "FLAT" && e2.detail.totalAbsencePenalty >= 18) {
    flatSlopPenalty = -8;
    newOverrides.push(`AVRI_FLAT_SLOP_HAIRCUT: hand-wavy unclassifiable report (${flatSlopPenalty})`);
  }

  const finalScore = Math.max(0, Math.min(100, baseComposite.overallScore + additionalPenalties + flatSlopPenalty));

  return {
    ...baseComposite,
    overallScore: finalScore,
    label: getCompositeLabel(finalScore),
    overridesApplied: newOverrides,
    compositeBreakdown: {
      ...baseComposite.compositeBreakdown,
      afterOverride: finalScore,
    },
    engineResults: [e1, e2.engine, e3.engine],
    avri: {
      family: family.id,
      familyName: family.displayName,
      classification: {
        confidence: classification.confidence,
        reason: classification.reason,
        evidence: classification.evidence,
        technology: classification.technology,
      },
      goldHitCount: e2.goldHitCount,
      velocityPenalty,
      templatePenalty,
      rawCompositeBeforeBehavioralPenalties: baseComposite.overallScore,
    },
  };
}

function getCompositeLabel(score: number): string {
  if (score <= 20) return "LIKELY INVALID";
  if (score <= 35) return "HIGH RISK";
  if (score <= 50) return "NEEDS REVIEW";
  if (score <= 65) return "REASONABLE";
  if (score <= 80) return "PROMISING";
  return "STRONG";
}
