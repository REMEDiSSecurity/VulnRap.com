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
import { evaluateCrashTrace, crashTraceGoldSignalIdsFor, type CrashTraceEvaluation } from "./crash-trace";
import { evaluateRawHttpRequest, rawHttpGoldSignalIdsFor, type RawHttpEvaluation } from "./raw-http";

const ABSENCE_PENALTY_CAP = 12;
/** Out-of-cap penalty applied to crash-/race-trace-bearing reports whose
 * trace is stripped/placeholder. Sized to push a slop report whose only
 * substance is a fake sanitizer/TSan trace below the AVRI YELLOW threshold. */
const STRIPPED_TRACE_PENALTY = 18;
/** Out-of-cap penalty applied to REQUEST_SMUGGLING reports whose pasted
 * raw HTTP bytes are fabricated (placeholder header values, no CRLFs, or
 * incoherent TE/CL conflict). Sized like STRIPPED_TRACE_PENALTY so a slop
 * smuggling report whose only substance is fake bytes lands below YELLOW. */
const FAKE_RAW_HTTP_PENALTY = 18;

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
  // FLAT family: legacy passes through, but apply a hand-wavy haircut when
  // the report explicitly admits to having no reproducer / private PoC /
  // structural-only evidence. These markers are diagnostic of slop reports
  // that the family rubric can't otherwise crater (because no family fits).
  if (family.id === "FLAT") {
    // Collapse all whitespace so multi-line prose still matches phrase markers.
    const lowered = fullText.toLowerCase().replace(/\s+/g, " ");
    const handwavyMarkers = [
      // Self-admitted absence of evidence
      "do not have a runnable reproducer",
      "do not have a reproducer",
      "private fuzzing harness",
      "private poc",
      "structural rather than",
      "structural vulnerability follows from the design",
      "i have not enumerated",
      "have not been able to confirm",
      "no working proof-of-concept",
      "no runnable proof",
      "follows from the design as observed",
      "deployment is no different in this respect",
      // Generic "may/appears/likely" hedging that signals zero observation
      "may not be encrypted",
      "may be present in environment variables",
      "do not appear to be",
      "does not appear to be",
      "appears to be susceptible",
      "consider a holistic remediation",
      "leadership-level discussion",
      // Buzzword-soup framings with zero specifics
      "comprehensive zero-trust assessment",
      "modern threat landscape",
      "advanced persistent threats",
      "defense-in-depth posture",
      "weak security culture",
    ];
    let haircut = 0;
    for (const m of handwavyMarkers) {
      if (lowered.includes(m)) haircut += 6;
    }
    haircut = Math.min(24, haircut);
    const adjusted = clamp(legacy.score - haircut);
    return {
      engine: { ...legacy, score: adjusted },
      goldHitCount: 0,
      detail: {
        family: family.id,
        baseScore: legacy.score,
        goldHits: [],
        absencePenaltiesApplied: haircut
          ? [{ id: "flat_handwavy_haircut", description: "FLAT report with hand-wavy evidence markers", points: haircut }]
          : [],
        contradictionsFound: [],
        totalAbsencePenalty: haircut,
        contradictionPenalty: 0,
        rawAvriScore: adjusted,
        legacyScore: legacy.score,
        blendedScore: adjusted,
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

  // 1b. Crash/race-trace validation. Sanitizer/Valgrind/TSan headers and
  // `#N 0x...` frame regexes are easy to fake; if the trace itself has no
  // resolvable symbols/source lines (e.g. "<symbol stripped>" frames or
  // "+0xZZZZ" placeholder offsets), revoke the trace-derived gold points
  // so a polished slop report can't pad its way past the gold threshold
  // on a fake crash/race dump. Runs for any family whose rubric declares
  // tool-emitted-trace gold signals (currently MEMORY_CORRUPTION and
  // RACE_CONCURRENCY).
  let crashTrace: CrashTraceEvaluation | null = null;
  const revokedTraceHits: Array<{ id: string; description: string; points: number }> = [];
  const traceGoldIds = crashTraceGoldSignalIdsFor(family.id);
  if (traceGoldIds) {
    crashTrace = evaluateCrashTrace(fullText);
    if (crashTrace.isStripped) {
      const remaining: typeof goldHits = [];
      for (const hit of goldHits) {
        if (traceGoldIds.has(hit.id)) {
          revokedTraceHits.push(hit);
          goldTotal -= hit.points;
        } else {
          remaining.push(hit);
        }
      }
      goldHits.length = 0;
      goldHits.push(...remaining);
    }
  }
  // 1c. Raw-HTTP-bytes validation. REQUEST_SMUGGLING gold signals
  // (`raw_http_request`, `te_or_cl_conflict`, `smuggled_second_request`)
  // all match purely structural regexes against the pasted bytes; if
  // those bytes are placeholder-padded, missing CRLFs, or carry a TE/CL
  // conflict whose values aren't actually coherent, the matched gold
  // points must be revoked so a polished slop report can't pad its way
  // past the gold threshold on fake HTTP request bytes. Runs for any
  // family whose rubric declares raw-HTTP-byte gold signals (currently
  // REQUEST_SMUGGLING only).
  let rawHttp: RawHttpEvaluation | null = null;
  const revokedRawHttpHits: Array<{ id: string; description: string; points: number }> = [];
  const rawHttpGoldIds = rawHttpGoldSignalIdsFor(family.id);
  if (rawHttpGoldIds) {
    rawHttp = evaluateRawHttpRequest(fullText);
    if (rawHttp.isFake) {
      const remaining: typeof goldHits = [];
      for (const hit of goldHits) {
        if (rawHttpGoldIds.has(hit.id)) {
          revokedRawHttpHits.push(hit);
          goldTotal -= hit.points;
        } else {
          remaining.push(hit);
        }
      }
      goldHits.length = 0;
      goldHits.push(...remaining);
    }
  }

  // Normalize gold score: full score (100) requires hitting the rubric's
  // "calibrated maximum" — the sum of the top N highest-weight signals,
  // chosen so a complete report reliably reaches 100 without needing every
  // optional signal. Cap = 80% of the total possible weight.
  const totalPossible = family.goldSignals.reduce((s, g) => s + g.points, 0);
  const calibratedMax = Math.max(1, Math.round(totalPossible * 0.55));
  // Cap raw baseScore at 90: even a maximally-evidenced report shouldn't
  // saturate the AVRI rubric to 100 — there is always *some* uncertainty
  // (no live reproduction, single reviewer, etc.). This pulls down very
  // high-evidence reports a few points so they don't overshoot reference
  // bands while still preserving cohort separation.
  const baseScore = Math.min(84, (goldTotal / calibratedMax) * 100);

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

  // 3b. Stripped-trace penalty (out-of-cap). Applied directly to baseScore
  // so it composes with absence/contradiction without sharing the absence
  // cap budget. Only fires when the validator detected a placeholder trace.
  const strippedTracePenalty = crashTrace?.isStripped ? STRIPPED_TRACE_PENALTY : 0;

  // 3c. Fake-raw-HTTP penalty (out-of-cap), same shape as the stripped
  // trace penalty so a slop smuggling report whose only substance is
  // fabricated bytes lands below the AVRI YELLOW threshold.
  const fakeRawHttpPenalty = rawHttp?.isFake ? FAKE_RAW_HTTP_PENALTY : 0;

  const rawAvriScore = clamp(baseScore - totalAbsencePenalty - contradictionPenalty - strippedTracePenalty - fakeRawHttpPenalty);

  // 4. Blend with legacy substance. Default 50/50, but when the AVRI rubric
  //    crater-scores a report that the legacy substance engine considers
  //    well-evidenced (and no contradictions fired), lean heavily on legacy.
  //    This protects legitimate reports whose evidence shape doesn't fit the
  //    family's narrow gold-signal rubric (e.g. shell-script TOCTOU,
  //    CORS-credentials misconfig) without rescuing slop, which has weak
  //    legacy substance scores too.
  // Slip-through guard: contradictions in *any* part of the text (including
  // code blocks/diffs) disqualify the legacy-anchor path. Otherwise reports
  // that demonstrate INJECTION evidence while citing CWE-79 (or similar
  // type-swap slop) get rescued by their high legacy substance score.
  const contradictionsAnywhere = family.contradictionPhrases.some((p) =>
    fullText.toLowerCase().includes(p.toLowerCase()),
  );
  let avriWeight = 0.5;
  if (
    rawAvriScore < 25 &&
    legacy.score >= 55 &&
    !contradictionsAnywhere &&
    goldHits.length >= 1 &&
    !crashTrace?.isStripped &&
    !rawHttp?.isFake
  ) {
    avriWeight = 0.25;
  }
  const blendedScore = Math.round(rawAvriScore * avriWeight + legacy.score * (1 - avriWeight));

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
  if (crashTrace?.isStripped) {
    indicators.push({
      signal: "STRIPPED_CRASH_TRACE",
      value: `${crashTrace.framesAnalyzed}f/${crashTrace.goodFrames}g/${crashTrace.placeholderFrames}p`,
      strength: "HIGH",
      explanation: `${crashTrace.reason ?? "Stripped crash trace"} (-${STRIPPED_TRACE_PENALTY}; revoked ${revokedTraceHits.length} trace gold signal(s))`,
    });
  }
  if (rawHttp?.isFake) {
    indicators.push({
      signal: "FAKE_RAW_HTTP",
      value: `${rawHttp.requestsAnalyzed}r/${rawHttp.totalHeaders - rawHttp.placeholderHeaders}g/${rawHttp.placeholderHeaders}p`,
      strength: "HIGH",
      explanation: `${rawHttp.reason ?? "Fabricated raw HTTP request"} (-${FAKE_RAW_HTTP_PENALTY}; revoked ${revokedRawHttpHits.length} smuggling gold signal(s))`,
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

  // Build the gold-signal "miss" list so the diagnostics panel can show
  // reviewers which expected signals were absent for this family.
  const goldMisses = family.goldSignals
    .filter((g) => !goldHits.some((h) => h.id === g.id))
    .map((g) => ({ id: g.id, description: g.description, points: g.points }));

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
        familyName: family.displayName,
        baseScore: Math.round(baseScore),
        goldHitCount: goldHits.length,
        goldTotalCount: family.goldSignals.length,
        goldHits: goldHits.map((g) => ({ id: g.id, description: g.description, points: g.points })),
        goldMisses,
        absencePenalty: -totalAbsencePenalty,
        absencePenalties: absencePenaltiesApplied.map((a) => ({ id: a.id, description: a.description, points: a.points })),
        contradictions: contradictionsFound,
        contradictionPenalty: -contradictionPenalty,
        crashTrace: crashTrace
          ? {
              framesAnalyzed: crashTrace.framesAnalyzed,
              goodFrames: crashTrace.goodFrames,
              placeholderFrames: crashTrace.placeholderFrames,
              isStripped: crashTrace.isStripped,
              reason: crashTrace.reason,
              revokedGoldHits: revokedTraceHits.map((r) => ({ id: r.id, points: r.points })),
              penalty: -strippedTracePenalty,
            }
          : null,
        rawHttp: rawHttp
          ? {
              requestsAnalyzed: rawHttp.requestsAnalyzed,
              totalHeaders: rawHttp.totalHeaders,
              placeholderHeaders: rawHttp.placeholderHeaders,
              crlfPresent: rawHttp.crlfPresent,
              teClConflicts: rawHttp.teClConflicts,
              teClBroken: rawHttp.teClBroken,
              isFake: rawHttp.isFake,
              reason: rawHttp.reason,
              revokedGoldHits: revokedRawHttpHits.map((r) => ({ id: r.id, points: r.points })),
              penalty: -fakeRawHttpPenalty,
            }
          : null,
        rawAvriScore: Math.round(rawAvriScore),
        legacyScore: legacy.score,
        blendedScore,
      },
    },
    note: `AVRI ${family.displayName}: ${goldHits.length} gold signal(s) (+${goldTotal}), -${totalAbsencePenalty} absence, -${contradictionPenalty} contradiction${strippedTracePenalty ? `, -${strippedTracePenalty} stripped-trace` : ""}${fakeRawHttpPenalty ? `, -${fakeRawHttpPenalty} fake-raw-http` : ""}. Blended with legacy substance: ${blendedScore}.`,
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
