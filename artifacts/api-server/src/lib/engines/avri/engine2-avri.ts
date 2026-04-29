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
import {
  evaluateRawHttpRequest,
  evaluateRawHttpResponse,
  rawHttpGoldSignalIdsFor,
  rawHttpBodyPayloadGoldSignalIdsFor,
  rawHttpResponseGoldSignalIdsFor,
  stripPlaceholderBodies,
  type RawHttpEvaluation,
  type RawHttpResponseEvaluation,
} from "./raw-http";
import { getHandwavyPhrases } from "./handwavy-phrases";

const ABSENCE_PENALTY_CAP = 12;
/** Out-of-cap penalty applied to crash-/race-trace-bearing reports whose
 * trace is stripped/placeholder. Sized to push a slop report whose only
 * substance is a fake sanitizer/TSan trace below the AVRI YELLOW threshold. */
const STRIPPED_TRACE_PENALTY = 18;
/** Sprint 13B-2: out-of-cap penalty for crash traces whose structural details
 * (function offsets, frame numbering, thread ids, heap region size) are
 * internally inconsistent in ways a real sanitizer never produces. Sized like
 * STRIPPED_TRACE_PENALTY because the same revocation path fires either way. */
const STRUCTURAL_FAB_PENALTY = 18;
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

/**
 * Theme buckets for FLAT-family hand-wavy phrase markers, used by the
 * diagnostics panel to group matched entries instead of rendering one long
 * flat list. Only set on FLAT-branch absence-penalty entries; non-FLAT
 * absence penalties leave this field undefined.
 */
export type HandwavyCategory = "absence" | "hedging" | "buzzword";

export interface AvriEngine2Detail {
  family: string;
  baseScore: number;
  goldHits: Array<{ id: string; description: string; points: number }>;
  absencePenaltiesApplied: Array<{ id: string; description: string; points: number; flatHandwavyCategory?: HandwavyCategory }>;
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
  const legacy = runEngine2Legacy(signals, fullText);
  // FLAT family: legacy passes through, but apply a hand-wavy haircut when
  // the report explicitly admits to having no reproducer / private PoC /
  // structural-only evidence. These markers are diagnostic of slop reports
  // that the family rubric can't otherwise crater (because no family fits).
  if (family.id === "FLAT") {
    // Collapse all whitespace so multi-line prose still matches phrase markers.
    const lowered = fullText.toLowerCase().replace(/\s+/g, " ");
    // Loaded from data/handwavy-phrases.json so reviewers can extend the list
    // through POST /feedback/calibration/handwavy-phrases without a redeploy.
    // Each marker carries a `category` (`absence` | `hedging` | `buzzword`) so
    // the diagnostics panel can group matched entries into themed buckets
    // rather than rendering one long flat list. The category travels with each
    // absence-penalty entry into the diagnostics payload via
    // `flatHandwavyCategory`.
    const handwavyMarkers = getHandwavyPhrases();
    const HANDWAVY_POINTS_PER_HIT = 6;
    const HANDWAVY_HAIRCUT_CAP = 24;
    // Record every matched phrase with id + phrase + per-hit points so the
    // diagnostics panel can show reviewers exactly which language fired.
    // The displayed per-entry value is the per-hit weight (6); the score
    // impact is the capped sum below, surfaced separately.
    const absencePenaltiesApplied: Array<{ id: string; description: string; points: number; flatHandwavyCategory?: HandwavyCategory }> = [];
    let haircutRaw = 0;
    for (const m of handwavyMarkers) {
      if (lowered.includes(m.phrase)) {
        const slug = m.phrase.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        absencePenaltiesApplied.push({
          id: `flat_handwavy:${slug}`,
          description: `Hand-wavy phrase: "${m.phrase}"`,
          points: HANDWAVY_POINTS_PER_HIT,
          flatHandwavyCategory: m.category,
        });
        haircutRaw += HANDWAVY_POINTS_PER_HIT;
      }
    }
    // The composite override math (lib/engines/avri/composite.ts ≥18 check)
    // keys off `totalAbsencePenalty`, so cap the applied total here while
    // leaving every matched-phrase entry visible in `absencePenaltiesApplied`.
    const haircut = Math.min(HANDWAVY_HAIRCUT_CAP, haircutRaw);
    const adjusted = clamp(legacy.score - haircut);
    const flatAvriBreakdown = {
      family: family.id,
      familyName: family.displayName,
      baseScore: legacy.score,
      goldHitCount: 0,
      goldTotalCount: 0,
      goldHits: [],
      goldMisses: [],
      absencePenalty: -haircut,
      absencePenalties: absencePenaltiesApplied.map((a) => ({
        id: a.id,
        description: a.description,
        points: a.points,
        flatHandwavyCategory: a.flatHandwavyCategory,
      })),
      contradictions: [],
      contradictionPenalty: 0,
      crashTrace: null,
      rawHttp: null,
      rawAvriScore: adjusted,
      legacyScore: legacy.score,
      blendedScore: adjusted,
    };
    return {
      engine: {
        ...legacy,
        score: adjusted,
        signalBreakdown: {
          ...legacy.signalBreakdown,
          avri: flatAvriBreakdown,
        },
        note: absencePenaltiesApplied.length
          ? `AVRI ${family.displayName}: ${absencePenaltiesApplied.length} hand-wavy phrase(s), -${haircut} haircut applied to legacy substance ${legacy.score} → ${adjusted}.`
          : legacy.note,
      },
      goldHitCount: 0,
      detail: {
        family: family.id,
        baseScore: legacy.score,
        goldHits: [],
        absencePenaltiesApplied,
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
    // Sprint 13B-2: structural fabrication takes the same revocation path as
    // a stripped trace — both indicate the trace itself is unreliable, so any
    // gold points the family awarded for the trace must come back.
    const traceFabricated = crashTrace.isStripped || crashTrace.hasStructuralFabrication;
    if (traceFabricated) {
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
  // 1c. Raw-HTTP-bytes validation. Several families award gold points
  // for signals that match purely structural regexes against pasted HTTP
  // request bytes — REQUEST_SMUGGLING (`raw_http_request`,
  // `te_or_cl_conflict`, `smuggled_second_request`), AUTHN_AUTHZ
  // (`authorization_header_swap` — Authorization/Cookie headers), and
  // INJECTION (`specific_endpoint_param` — request-line + parameter).
  // If those bytes are placeholder-padded, missing CRLFs, or carry a
  // TE/CL conflict whose values aren't coherent, the matched gold
  // points must be revoked so a polished slop report can't pad its way
  // past the gold threshold on fake HTTP request bytes. Runs for any
  // family whose rubric declares raw-HTTP-byte gold signals.
  let rawHttp: RawHttpEvaluation | null = null;
  const revokedRawHttpHits: Array<{ id: string; description: string; points: number }> = [];
  const rawHttpGoldIds = rawHttpGoldSignalIdsFor(family.id);
  if (rawHttpGoldIds) {
    // Strict CRLF only for REQUEST_SMUGGLING — that family explicitly
    // depends on byte-precise framing. AUTHN_AUTHZ / INJECTION reports
    // routinely lose CRLFs in markdown transcription and shouldn't be
    // flagged on that signal alone.
    rawHttp = evaluateRawHttpRequest(fullText, {
      strictCrlf: family.id === "REQUEST_SMUGGLING",
    });
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

    // Body-payload revocation: even if the request bytes don't trip the
    // header/CRLF/TE-CL checks above, a placeholder body (`q=<sql payload
    // here>`, `{ "q": "<inject>" }`) means any payload-class gold signal
    // (`concrete_payload`, `vulnerable_query_construction` for INJECTION)
    // whose match ONLY appears inside that body should be revoked. The
    // signal pattern is re-tested against text with placeholder bodies
    // stripped — if it still matches (because the prose carries the real
    // payload too), the gold point survives.
    const bodyPayloadIds = rawHttpBodyPayloadGoldSignalIdsFor(family.id);
    if (bodyPayloadIds && rawHttp.placeholderBodyRanges.length > 0) {
      const stripped = stripPlaceholderBodies(fullText, rawHttp);
      const remaining: typeof goldHits = [];
      for (const hit of goldHits) {
        if (bodyPayloadIds.has(hit.id)) {
          const sigDef = family.goldSignals.find((g) => g.id === hit.id);
          if (sigDef && !sigDef.pattern.test(stripped)) {
            revokedRawHttpHits.push(hit);
            goldTotal -= hit.points;
            continue;
          }
        }
        remaining.push(hit);
      }
      goldHits.length = 0;
      goldHits.push(...remaining);
      // If the placeholder-body revocation kicked in but the surrounding
      // header check didn't, mark the evaluation fake so the FAKE_RAW_HTTP
      // indicator and out-of-cap penalty fire too.
      if (!rawHttp.isFake && revokedRawHttpHits.length > 0) {
        let fallbackReason: string;
        if (rawHttp.placeholderBodies > 0 && rawHttp.requestsAnalyzed > 0) {
          fallbackReason = `Raw HTTP request body is a placeholder (${rawHttp.placeholderBodies}/${rawHttp.requestsAnalyzed} request block(s))`;
        } else if (rawHttp.prosePlaceholderPayloads > 0) {
          // Prose-only path: no fake bytes, just "Payload: `<inject>`"-shape
          // mentions in the prose that gesture at a payload without naming
          // one. The payload-class gold signal only matched incidental
          // tokens elsewhere, so revoke and flag the report.
          fallbackReason = `Prose payload reference is a placeholder (${rawHttp.prosePlaceholderPayloads} mention(s) like "Payload: <…>" with no concrete payload)`;
        } else {
          fallbackReason = "Raw HTTP request body is a placeholder";
        }
        rawHttp = {
          ...rawHttp,
          isFake: true,
          reason: rawHttp.reason ?? fallbackReason,
        };
      }
    }
  }

  // 1d. Sprint 13B-3 — raw-HTTP RESPONSE plausibility validation. Several
  // families award gold points for signals whose evidence depends on a
  // real-looking server response: INJECTION (`request_response_diff` —
  // baseline-vs-injected response pair) and WEB_CLIENT
  // (`reflection_or_dom_proof` — payload reflected in the response body).
  // Slop authors tack on a fabricated `HTTP/1.1 200 OK` block with a
  // narrative-tailored JSON body to "show" that response. The validator
  // counts plausibility markers (missing Date/Server, suspiciously clean
  // JSON body, no incidental headers); ≥2 markers per response block ⇒
  // fabricated.
  //
  // Revocation strategy mirrors the request-side header-fakeness path
  // (blanket revoke on `isFake`) rather than the body-payload
  // strip-and-retest path: the response-class gold signals reward
  // SHOWING the proof, and a fabricated response is the only thing
  // those signals were earned from in this report. A legit report
  // would carry a plausibility-passing response excerpt (with Date /
  // Server / incidental fields), so this branch never fires there.
  let rawHttpResponse: RawHttpResponseEvaluation | null = null;
  const responseGoldIds = rawHttpResponseGoldSignalIdsFor(family.id);
  if (responseGoldIds) {
    rawHttpResponse = evaluateRawHttpResponse(fullText);
    if (rawHttpResponse.isFake) {
      const remaining: typeof goldHits = [];
      for (const hit of goldHits) {
        if (responseGoldIds.has(hit.id)) {
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

  // 3b'. Sprint 13B-2 — structural-fabrication penalty (out-of-cap). Fires
  // when ≥2 of the structural detectors (round function offsets, frame-number
  // gaps, thread-id inconsistency, round heap region size) match. Mutually
  // exclusive with `strippedTracePenalty` (we never charge twice for the same
  // unreliable trace) — when both conditions hold we keep the stripped-trace
  // charge and surface STRUCTURAL_FABRICATION as a separate diagnostic only.
  const structuralFabPenalty =
    !strippedTracePenalty && crashTrace?.hasStructuralFabrication
      ? STRUCTURAL_FAB_PENALTY
      : 0;

  // 3c. Fake-raw-HTTP penalty (out-of-cap), same shape as the stripped
  // trace penalty so a slop smuggling report whose only substance is
  // fabricated bytes lands below the AVRI YELLOW threshold. Sprint
  // 13B-3: the same penalty also fires when the response-side validator
  // detects a fabricated `HTTP/1.1 200 OK` block — but it's applied
  // once even if both sides fired (we don't double-bill the same kind
  // of fabrication).
  const anyRawHttpFake = (rawHttp?.isFake ?? false) || (rawHttpResponse?.isFake ?? false);
  const fakeRawHttpPenalty = anyRawHttpFake ? FAKE_RAW_HTTP_PENALTY : 0;

  const rawAvriScore = clamp(
    baseScore -
      totalAbsencePenalty -
      contradictionPenalty -
      strippedTracePenalty -
      structuralFabPenalty -
      fakeRawHttpPenalty,
  );

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
    !crashTrace?.hasStructuralFabrication &&
    !rawHttp?.isFake &&
    !rawHttpResponse?.isFake
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
  if (crashTrace?.hasStructuralFabrication) {
    // Sprint 13B-2: surface the markers in their own indicator so the
    // diagnostics panel can show reviewers exactly which structural tells
    // fired (round offsets, frame gaps, missing PID anchor, hex region size).
    // The indicator fires whether or not STRIPPED_CRASH_TRACE also fired so
    // reviewers can see all the fabrication evidence at a glance.
    const ids = crashTrace.structuralMarkers.map((m) => m.id).join(", ");
    const penaltyNote = structuralFabPenalty > 0
      ? ` (-${structuralFabPenalty}`
      : ` (penalty subsumed by stripped-trace`;
    const revokedNote = !strippedTracePenalty && revokedTraceHits.length > 0
      ? `; revoked ${revokedTraceHits.length} trace gold signal(s)`
      : "";
    indicators.push({
      signal: "STRUCTURAL_FABRICATION",
      value: ids,
      strength: "HIGH",
      explanation: `${crashTrace.structuralMarkers.length} structural fabrication marker(s) — ${crashTrace.structuralMarkers.map((m) => m.description).join("; ")}${penaltyNote}${revokedNote})`,
    });
  }
  if (rawHttp?.isFake || rawHttpResponse?.isFake) {
    // Sprint 13B-3: surface a single FAKE_RAW_HTTP indicator, with the
    // explanation enumerating which side(s) fired (REQUEST and/or
    // RESPONSE — the latter is the new FAKE_RAW_HTTP_RESPONSE sub-flag).
    const sides: string[] = [];
    if (rawHttp?.isFake) sides.push("FAKE_RAW_HTTP_REQUEST");
    if (rawHttpResponse?.isFake) sides.push("FAKE_RAW_HTTP_RESPONSE");
    const reasonParts: string[] = [];
    if (rawHttp?.isFake && rawHttp.reason) {
      reasonParts.push(`request: ${rawHttp.reason}`);
    }
    if (rawHttpResponse?.isFake && rawHttpResponse.reason) {
      reasonParts.push(`response: ${rawHttpResponse.reason}`);
    }
    const value = rawHttp
      ? `${rawHttp.requestsAnalyzed}r/${rawHttp.totalHeaders - rawHttp.placeholderHeaders}g/${rawHttp.placeholderHeaders}p${rawHttpResponse?.isFake ? ` +${rawHttpResponse.responsesFlagged}/${rawHttpResponse.responsesAnalyzed} fake-resp` : ""}`
      : `${rawHttpResponse?.responsesFlagged ?? 0}/${rawHttpResponse?.responsesAnalyzed ?? 0} fake-resp`;
    indicators.push({
      signal: "FAKE_RAW_HTTP",
      value,
      strength: "HIGH",
      explanation: `[${sides.join("+")}] ${reasonParts.join("; ") || "Fabricated raw HTTP bytes"} (-${FAKE_RAW_HTTP_PENALTY}; revoked ${revokedRawHttpHits.length} ${family.id} gold signal(s))`,
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
              // Sprint 13B-2: list of structural-fabrication markers that
              // fired against this trace (each with id + description), so the
              // diagnostics panel can render a "Structural fabrication" sub
              // -section without re-running detectors.
              structuralMarkers: crashTrace.structuralMarkers.map((m) => ({
                id: m.id,
                description: m.description,
              })),
              hasStructuralFabrication: crashTrace.hasStructuralFabrication,
              structuralFabricationPenalty: -structuralFabPenalty,
            }
          : null,
        // Sprint 13B-3: top-level `rawHttp` is the merged view that the
        // diagnostics panel and printable triage report read. When the
        // response side fires (with no request-side rawHttp evaluation,
        // e.g. WEB_CLIENT/INJECTION outside the request-side gold-signal
        // map), we synthesize zeroed request fields so the existing UI
        // contract still holds. `isFake`/`reason` are the OR-merged
        // overall view; per-side details live in `response`.
        rawHttp:
          rawHttp || rawHttpResponse
            ? {
                requestsAnalyzed: rawHttp?.requestsAnalyzed ?? 0,
                totalHeaders: rawHttp?.totalHeaders ?? 0,
                placeholderHeaders: rawHttp?.placeholderHeaders ?? 0,
                crlfPresent: rawHttp?.crlfPresent ?? false,
                teClConflicts: rawHttp?.teClConflicts ?? 0,
                teClBroken: rawHttp?.teClBroken ?? 0,
                isFake: anyRawHttpFake,
                reason:
                  rawHttp?.isFake && rawHttpResponse?.isFake
                    ? `${rawHttp.reason ?? "Fabricated raw HTTP request"}; ${rawHttpResponse.reason ?? "Fabricated raw HTTP response"}`
                    : rawHttp?.isFake
                      ? rawHttp.reason
                      : rawHttpResponse?.isFake
                        ? rawHttpResponse.reason
                        : (rawHttp?.reason ?? null),
                revokedGoldHits: revokedRawHttpHits.map((r) => ({ id: r.id, points: r.points })),
                penalty: -fakeRawHttpPenalty,
                response: rawHttpResponse
                  ? {
                      responsesAnalyzed: rawHttpResponse.responsesAnalyzed,
                      responsesFlagged: rawHttpResponse.responsesFlagged,
                      totalHeaders: rawHttpResponse.totalHeaders,
                      responsesMissingDate: rawHttpResponse.responsesMissingDate,
                      responsesMissingServer: rawHttpResponse.responsesMissingServer,
                      responsesWithSuspiciousJsonBody: rawHttpResponse.responsesWithSuspiciousJsonBody,
                      responsesMissingIncidentals: rawHttpResponse.responsesMissingIncidentals,
                      isFake: rawHttpResponse.isFake,
                      reason: rawHttpResponse.reason,
                    }
                  : null,
              }
            : null,
        rawAvriScore: Math.round(rawAvriScore),
        legacyScore: legacy.score,
        blendedScore,
      },
    },
    note: `AVRI ${family.displayName}: ${goldHits.length} gold signal(s) (+${goldTotal}), -${totalAbsencePenalty} absence, -${contradictionPenalty} contradiction${strippedTracePenalty ? `, -${strippedTracePenalty} stripped-trace` : ""}${structuralFabPenalty ? `, -${structuralFabPenalty} structural-fabrication` : ""}${fakeRawHttpPenalty ? `, -${fakeRawHttpPenalty} fake-raw-http` : ""}. Blended with legacy substance: ${blendedScore}.`,
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
