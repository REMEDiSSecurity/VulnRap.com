// AVRI Engine 2 — family-aware substance scoring.
// Uses the rubric for the classified family to award gold-signal points and
// apply absence penalties. Penalties are applied AFTER normalization to a
// 0..100 base score and capped at -25 total (Sprint 11 Part 4 math fix).
//
// The previous Engine 2 (engines/engines.ts → runEngine2) is left intact as
// the fallback for FLAT classifications and as a contributor to the AVRI
// composite when AVRI doesn't override it.

import type { ExtractedSignals } from "../extractors";
import type { EngineResult, TriggeredIndicator, Verdict } from "../engines";
import { runEngine2 as runEngine2Legacy } from "../engines";
import type { FamilyRubric } from "./families";

const ABSENCE_PENALTY_CAP = 25;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Strip fenced code blocks and unified-diff hunks before applying contradiction
 * checks: a memory-corruption diff legitimately contains the *fixed* alert(1)
 * string in test fixtures, but the contradiction phrase rule should only fire
 * on prose. */
function stripCodeAndDiffs(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/(?:^|\n)(?:diff --git[^\n]*\n)?(?:---[^\n]+\n)?(?:\+\+\+[^\n]+\n)?(?:@@[^\n]*@@\n)?(?:[ +\-][^\n]*\n)+/g, " ");
  return out;
}

export interface AvriEngine2Detail {
  family: string;
  baseScore: number;
  goldHits: Array<{ id: string; description: string; points: number }>;
  absencePenaltiesApplied: Array<{ id: string; description: string; points: number }>;
  contradictionsFound: string[];
  totalAbsencePenalty: number;
  contradictionPenalty: number;
  rawAvriScore: number;
  legacyScore: number;
  blendedScore: number;
}

export interface AvriEngine2Result {
  engine: EngineResult;
  detail: AvriEngine2Detail;
  goldHitCount: number;
}

/**
 * Run AVRI Engine 2 for the given family. The legacy Engine 2 still runs
 * underneath (it provides the strong-evidence count, claim:evidence ratio,
 * etc.) and the AVRI score is blended 60% AVRI / 40% legacy when a family
 * was identified — this preserves the strong-evidence path that the v3.6.0
 * triage matrix already relies on.
 */
export function runEngine2Avri(
  signals: ExtractedSignals,
  fullText: string,
  family: FamilyRubric,
): AvriEngine2Result {
  const legacy = runEngine2Legacy(signals);
  // FLAT family: just return legacy as-is.
  if (family.id === "FLAT") {
    return {
      engine: legacy,
      goldHitCount: 0,
      detail: {
        family: family.id,
        baseScore: legacy.score,
        goldHits: [],
        absencePenaltiesApplied: [],
        contradictionsFound: [],
        totalAbsencePenalty: 0,
        contradictionPenalty: 0,
        rawAvriScore: legacy.score,
        legacyScore: legacy.score,
        blendedScore: legacy.score,
      },
    };
  }

  // 1. Sum gold-signal points (cap at 100 raw).
  const goldHits: Array<{ id: string; description: string; points: number }> = [];
  let goldTotal = 0;
  for (const sig of family.goldSignals) {
    if (sig.pattern.test(fullText)) {
      goldHits.push({ id: sig.id, description: sig.description, points: sig.points });
      goldTotal += sig.points;
    }
  }
  // Normalize gold score: full score (100) requires hitting the rubric's
  // "calibrated maximum" — the sum of the top N highest-weight signals,
  // chosen so a complete report reliably reaches 100 without needing every
  // optional signal. Cap = 80% of the total possible weight.
  const totalPossible = family.goldSignals.reduce((s, g) => s + g.points, 0);
  const calibratedMax = Math.max(1, Math.round(totalPossible * 0.8));
  const baseScore = clamp((goldTotal / calibratedMax) * 100);

  // 2. Apply absence penalties POST-normalization, capped at -25 total.
  const absencePenaltiesApplied: Array<{ id: string; description: string; points: number }> = [];
  let totalAbsencePenalty = 0;
  for (const ap of family.absencePenalties) {
    if (!ap.pattern.test(fullText)) {
      const remaining = ABSENCE_PENALTY_CAP - totalAbsencePenalty;
      if (remaining <= 0) break;
      const applied = Math.min(ap.points, remaining);
      absencePenaltiesApplied.push({ id: ap.id, description: ap.description, points: applied });
      totalAbsencePenalty += applied;
    }
  }

  // 3. Contradiction phrases: each match is -8 (prose only).
  const proseOnly = stripCodeAndDiffs(fullText).toLowerCase();
  const contradictionsFound: string[] = [];
  for (const phrase of family.contradictionPhrases) {
    if (proseOnly.includes(phrase.toLowerCase())) contradictionsFound.push(phrase);
  }
  const contradictionPenalty = Math.min(24, contradictionsFound.length * 8);

  const rawAvriScore = clamp(baseScore - totalAbsencePenalty - contradictionPenalty);

  // 4. Blend with legacy substance (60% AVRI / 40% legacy). The legacy
  //    score still picks up generic strong-evidence multipliers and the
  //    claim:evidence ratio, which are family-agnostic but valuable.
  const blendedScore = Math.round(rawAvriScore * 0.6 + legacy.score * 0.4);

  // Build indicators surfaced to diagnostics.
  const indicators: TriggeredIndicator[] = [];
  for (const g of goldHits) {
    indicators.push({
      signal: "GOLD_SIGNAL",
      value: g.id,
      strength: g.points >= 14 ? "HIGH" : g.points >= 8 ? "MEDIUM" : "LOW",
      explanation: `${g.description} (+${g.points})`,
    });
  }
  for (const a of absencePenaltiesApplied) {
    indicators.push({
      signal: "ABSENCE_PENALTY",
      value: a.id,
      strength: a.points >= 8 ? "HIGH" : "MEDIUM",
      explanation: `${a.description} (-${a.points})`,
    });
  }
  for (const c of contradictionsFound) {
    indicators.push({
      signal: "FAMILY_CONTRADICTION",
      value: c,
      strength: "HIGH",
      explanation: `Contains "${c}" which contradicts the ${family.displayName} family.`,
    });
  }
  // Keep a couple of legacy indicators for continuity.
  for (const li of legacy.triggeredIndicators) {
    if (li.signal === "POC_MISMATCH" || li.signal === "PLACEHOLDER_URLS" || li.signal === "CLAIM_EVIDENCE_EXTREME") {
      indicators.push(li);
    }
  }

  const verdict: Verdict =
    blendedScore >= 65 ? "GREEN" :
    blendedScore >= 40 ? "YELLOW" :
    "RED";

  // Carry the legacy signalBreakdown forward so the v3.6.0 triage matrix
  // helpers (pickEngine2Fields → strongCount via signalBreakdown.evidenceStrength)
  // keep working unchanged. We add an `avri` block alongside.
  const engine: EngineResult = {
    engine: "Technical Substance Analyzer",
    score: blendedScore,
    verdict,
    confidence: goldHits.length >= 2 ? "HIGH" : "MEDIUM",
    triggeredIndicators: indicators,
    signalBreakdown: {
      ...legacy.signalBreakdown,
      avri: {
        family: family.id,
        baseScore: Math.round(baseScore),
        goldHitCount: goldHits.length,
        goldHits: goldHits.map((g) => ({ id: g.id, points: g.points })),
        absencePenalty: -totalAbsencePenalty,
        contradictionPenalty: -contradictionPenalty,
        rawAvriScore: Math.round(rawAvriScore),
        legacyScore: legacy.score,
        blendedScore,
      },
    },
    note: `AVRI ${family.displayName}: ${goldHits.length} gold signal(s) (+${goldTotal}), -${totalAbsencePenalty} absence, -${contradictionPenalty} contradiction. Blended with legacy substance: ${blendedScore}.`,
  };

  return {
    engine,
    goldHitCount: goldHits.length,
    detail: {
      family: family.id,
      baseScore: Math.round(baseScore),
      goldHits,
      absencePenaltiesApplied,
      contradictionsFound,
      totalAbsencePenalty,
      contradictionPenalty,
      rawAvriScore: Math.round(rawAvriScore),
      legacyScore: legacy.score,
      blendedScore,
    },
  };
}
