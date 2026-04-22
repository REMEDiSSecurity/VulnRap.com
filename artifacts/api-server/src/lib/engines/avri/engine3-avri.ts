// AVRI Engine 3 — family-aware coherence.
// Replaces the per-CWE fingerprint scoring with: (a) does the report's content
// match the family's gold signals, (b) does it avoid contradictions for the
// family, (c) do the semantic-coherence checks pass. The legacy Engine 3 score
// is still surfaced as `legacyScore` in signalBreakdown for diagnostics.

import type { ExtractedSignals } from "../extractors";
import type { EngineResult, TriggeredIndicator, Verdict } from "../engines";
import { runEngine3 as runEngine3Legacy } from "../engines";
import type { FamilyRubric } from "./families";
import type { ClassificationResult } from "./classify";
import { checkCoherence, type CoherenceIssue } from "./coherence";

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface AvriEngine3Detail {
  family: string;
  classificationConfidence: ClassificationResult["confidence"];
  goldHitCount: number;
  contradictions: string[];
  coherenceIssues: CoherenceIssue[];
  baseScore: number;
  legacyScore: number;
  blendedScore: number;
}

export interface AvriEngine3Result {
  engine: EngineResult;
  detail: AvriEngine3Detail;
}

export function runEngine3Avri(
  signals: ExtractedSignals,
  fullText: string,
  family: FamilyRubric,
  classification: ClassificationResult,
): AvriEngine3Result {
  const legacy = runEngine3Legacy(signals, fullText);
  if (family.id === "FLAT") {
    return {
      engine: legacy,
      detail: {
        family: family.id,
        classificationConfidence: classification.confidence,
        goldHitCount: 0,
        contradictions: [],
        coherenceIssues: [],
        baseScore: legacy.score,
        legacyScore: legacy.score,
        blendedScore: legacy.score,
      },
    };
  }

  // 1. Score gold signal coverage as a percentage of the rubric's calibrated max.
  let goldTotal = 0;
  let goldHitCount = 0;
  for (const sig of family.goldSignals) {
    if (sig.pattern.test(fullText)) { goldTotal += sig.points; goldHitCount++; }
  }
  const totalPossible = family.goldSignals.reduce((s, g) => s + g.points, 0);
  const calibratedMax = Math.max(1, Math.round(totalPossible * 0.7));
  const goldCoverage = clamp((goldTotal / calibratedMax) * 100);

  // 2. Contradictions (prose lookup is fine here — Engine 3 is allowed to be
  //    a little stricter than Engine 2 because contradictions in coherence
  //    *should* hurt the family score).
  const lowered = fullText.toLowerCase();
  const contradictions: string[] = [];
  for (const phrase of family.contradictionPhrases) {
    if (lowered.includes(phrase.toLowerCase())) contradictions.push(phrase);
  }
  const contradictionPenalty = Math.min(30, contradictions.length * 10);

  // 3. Coherence issues.
  const coherenceIssues = checkCoherence(fullText, family);
  const coherencePenalty = coherenceIssues.reduce((s, i) => s + i.penalty, 0);

  // 4. Classification confidence floor: HIGH starts at 60, MEDIUM at 50, LOW at 40.
  const floor =
    classification.confidence === "HIGH" ? 60 :
    classification.confidence === "MEDIUM" ? 50 :
    40;

  let baseScore = clamp(Math.max(floor, goldCoverage) - contradictionPenalty - coherencePenalty);

  // 5. Blend with legacy CWE-fingerprint Engine 3 (70% AVRI / 30% legacy).
  const blendedScore = Math.round(baseScore * 0.7 + legacy.score * 0.3);

  const indicators: TriggeredIndicator[] = [];
  indicators.push({
    signal: "FAMILY_CLASSIFIED",
    value: family.id,
    strength: classification.confidence === "HIGH" ? "HIGH" : classification.confidence === "MEDIUM" ? "MEDIUM" : "LOW",
    explanation: classification.reason,
  });
  if (goldHitCount === 0 && family.goldSignals.length > 0) {
    indicators.push({
      signal: "FAMILY_NO_GOLD_SIGNALS",
      value: 0,
      threshold: 1,
      strength: "HIGH",
      explanation: `No ${family.displayName} gold signals matched — likely off-family or generic.`,
    });
  }
  for (const c of contradictions) {
    indicators.push({
      signal: "FAMILY_CONTRADICTION",
      value: c,
      strength: "HIGH",
      explanation: `Contains "${c}" which contradicts the ${family.displayName} family.`,
    });
  }
  for (const ci of coherenceIssues) {
    indicators.push({
      signal: ci.id,
      value: ci.id,
      strength: ci.penalty >= 6 ? "MEDIUM" : "LOW",
      explanation: ci.description,
    });
  }

  const verdict: Verdict =
    blendedScore >= 65 ? "GREEN" :
    blendedScore >= 40 ? "YELLOW" :
    "RED";

  const engine: EngineResult = {
    engine: "CWE Coherence Checker",
    score: blendedScore,
    verdict,
    confidence: classification.confidence === "HIGH" ? "HIGH" : "MEDIUM",
    triggeredIndicators: indicators,
    signalBreakdown: {
      ...legacy.signalBreakdown,
      avri: {
        family: family.id,
        classificationConfidence: classification.confidence,
        goldCoverage: Math.round(goldCoverage),
        goldHitCount,
        contradictionPenalty: -contradictionPenalty,
        coherencePenalty: -coherencePenalty,
        baseScore: Math.round(baseScore),
        legacyScore: legacy.score,
        blendedScore,
        coherenceIssues: coherenceIssues.map((i) => ({ id: i.id, penalty: -i.penalty })),
      },
    },
    note: `AVRI ${family.displayName} (${classification.confidence}): ${goldHitCount}/${family.goldSignals.length} gold, ${contradictions.length} contradictions, ${coherenceIssues.length} coherence issue(s). Blended: ${blendedScore}.`,
  };

  return {
    engine,
    detail: {
      family: family.id,
      classificationConfidence: classification.confidence,
      goldHitCount,
      contradictions,
      coherenceIssues,
      baseScore: Math.round(baseScore),
      legacyScore: legacy.score,
      blendedScore,
    },
  };
}
