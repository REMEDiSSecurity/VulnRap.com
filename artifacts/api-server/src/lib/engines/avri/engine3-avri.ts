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
  //    explicit floors/ceilings drive the base score). Track "concrete" hits
  //    separately: matches against the cwe_correct_class signal mean only that
  //    the report mentions a relevant CWE id, which is essentially free for
  //    slop reports that copy a CWE label without any real evidence.
  let goldHitCount = 0;
  let concreteGoldHitCount = 0;
  for (const sig of family.goldSignals) {
    if (sig.pattern.test(fullText)) {
      goldHitCount++;
      if (sig.id !== "cwe_correct_class") concreteGoldHitCount++;
    }
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
  const selectedFamily = family.id;
  // Evidence confidence MEDIUM/HIGH gate (see prior comment for rationale).
  const evidenceConfidentEnough =
    classification.evidenceConfidence === "HIGH" || classification.evidenceConfidence === "MEDIUM";
  const isCweCited = !!classification.cweId;
  // Off-family ceiling still uses cited-vs-evidence: only a *cited* CWE that
  // disagrees with strong evidence evidence is a genuine type-swap signal.
  const offFamilyHighConf =
    isCweCited && citedFamily !== null && evidenceFamily !== null && citedFamily !== evidenceFamily && evidenceConfidentEnough;
  // SAME_FAMILY now compares the *selected* rubric family to the evidence
  // family, so reports whose CWE doesn't map to any rubric (e.g. CWE-190 for
  // an integer overflow → MEMORY_CORRUPTION via keyword fallback) still earn
  // the same-family floor when content agrees with the chosen family.
  const sameFamily = selectedFamily !== "FLAT" && evidenceFamily !== null && evidenceFamily === selectedFamily;
  let baseScore: number;
  let baseRule:
    | "SAME_FAMILY_FLOOR"
    | "SAME_FAMILY_NO_CONCRETE_EVIDENCE"
    | "OFF_FAMILY_CEILING"
    | "CITED_NO_EVIDENCE"
    | "FAMILY_DETECTED_NO_CWE"
    | "FALLBACK";
  if (offFamilyHighConf) {
    baseScore = 25;
    baseRule = "OFF_FAMILY_CEILING";
  } else if (sameFamily) {
    // Same-family floor only applies when there is at least one *concrete*
    // gold signal beyond a CWE label mention. Reports that merely repeat the
    // CWE id without any payload, sink, code reference, or stack trace get a
    // suppressed base — this is what stops T3 slop from inheriting the 78
    // floor just because they say the right keywords.
    if (concreteGoldHitCount === 0) {
      baseScore = 32;
      baseRule = "SAME_FAMILY_NO_CONCRETE_EVIDENCE";
    } else {
      baseScore = 75;
      baseRule = "SAME_FAMILY_FLOOR";
    }
  } else if (isCweCited && citedFamily !== null && evidenceFamily === null) {
    // Cited CWE maps to a family but no corroborating evidence detected:
    // trust the report cautiously (well above fallback, well below floor).
    baseScore = 60;
    baseRule = "CITED_NO_EVIDENCE";
  } else if (!isCweCited) {
    baseScore = 38;
    baseRule = "FAMILY_DETECTED_NO_CWE";
  } else {
    baseScore = 42;
    baseRule = "FALLBACK";
  }

  // Part 4 behavioural coherence bonus/penalty (small adjustments around the floor/ceiling).
  const behaviouralBonus = Math.min(6, Math.round(goldHitCount * 1.5));
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
