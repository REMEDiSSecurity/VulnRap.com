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

  // 1. Score gold signal coverage (used for behavioural bonus only — Part 4
  //    explicit floors/ceilings drive the base score).
  let goldHitCount = 0;
  for (const sig of family.goldSignals) {
    if (sig.pattern.test(fullText)) goldHitCount++;
  }

  // 2. Contradictions (prose lookup).
  const lowered = fullText.toLowerCase();
  const contradictions: string[] = [];
  for (const phrase of family.contradictionPhrases) {
    if (lowered.includes(phrase.toLowerCase())) contradictions.push(phrase);
  }
  const contradictionPenalty = Math.min(30, contradictions.length * 10);

  // 3. Coherence issues.
  const coherenceIssues = checkCoherence(fullText, family);
  const coherencePenalty = coherenceIssues.reduce((s, i) => s + i.penalty, 0);

  // 4. Sprint 11 spec Part 4 — explicit CWE/family outcomes.
  //    The off-family ceiling compares the *cited CWE family* to the
  //    *evidence-based family* (vuln-type / keyword fallback), independent of
  //    the rubric family the classifier ultimately selected. Otherwise the
  //    rule would never fire when a cited CWE wins classification.
  //    Rules:
  //      - cited CWE family == evidence family                              → 78 floor
  //      - cited CWE family != evidence family && evidence is HIGH confidence → 25 ceiling
  //      - no cited CWE but a family was detected (cwe-less report)          → 38
  //      - flat fallback (handled at the top of the function)                → 42
  //    Gold coverage and behavioural coherence then apply as small
  //    bonuses/penalties on top so the final score isn't perfectly flat.
  const citedFamily = classification.citedFamily;
  const evidenceFamily = classification.evidenceFamily;
  // Evidence confidence is MEDIUM when the vulnerability-type detector matched
  // (a single canonical pattern hit) and HIGH-equivalent when the keyword
  // fallback found ≥3 hits (still labelled MEDIUM by the classifier — see
  // `classifyByKeywords`). Spec Part 4 says "high detection confidence" — we
  // treat MEDIUM/HIGH as sufficient because the detector itself never returns
  // HIGH for evidence-only paths; otherwise the off-family ceiling could
  // never fire.
  const evidenceConfidentEnough =
    classification.evidenceConfidence === "HIGH" || classification.evidenceConfidence === "MEDIUM";
  const isCweCited = !!classification.cweId;
  const sameFamily = isCweCited && citedFamily !== null && evidenceFamily !== null && citedFamily === evidenceFamily;
  const offFamilyHighConf =
    isCweCited && citedFamily !== null && evidenceFamily !== null && citedFamily !== evidenceFamily && evidenceConfidentEnough;
  let baseScore: number;
  let baseRule: "SAME_FAMILY_FLOOR" | "OFF_FAMILY_CEILING" | "FAMILY_DETECTED_NO_CWE" | "FALLBACK";
  if (sameFamily) {
    baseScore = 78;
    baseRule = "SAME_FAMILY_FLOOR";
  } else if (offFamilyHighConf) {
    baseScore = 25;
    baseRule = "OFF_FAMILY_CEILING";
  } else if (!isCweCited) {
    baseScore = 38;
    baseRule = "FAMILY_DETECTED_NO_CWE";
  } else {
    baseScore = 42;
    baseRule = "FALLBACK";
  }

  // Part 4 behavioural coherence bonus/penalty (small adjustments around the floor/ceiling).
  const behaviouralBonus = Math.min(8, goldHitCount * 2);
  const adjusted = baseScore + behaviouralBonus - contradictionPenalty - coherencePenalty;
  const blendedScore = clamp(Math.round(adjusted));

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
        baseRule,
        baseScore,
        behaviouralBonus,
        goldHitCount,
        contradictionPenalty: -contradictionPenalty,
        coherencePenalty: -coherencePenalty,
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
