// Single source of truth for deriving the soft-citation "inferred CWE"
// label from a vulnrap_engine_results JSONB blob. Mirrors the per-engine
// extraction the triage report panel (`results.tsx`) already does:
//   prefer signalBreakdown.avri.softCitation.inferredCwe (CWE Coherence
//   Checker running under AVRI), then fall back to
//   signalBreakdown.softCitation.inferredCwe (legacy Engine 3 path on
//   reports analysed before AVRI was rolled out).
// Sourcing it server-side lets the reports feed surface the same badge
// reviewers see in the per-report breakdown without a round trip.

export interface InferredCweInfo {
  /** e.g. "CWE-79" — `null` when no soft citation fired for the report. */
  inferredCwe: string | null;
  /** Friendly soft-citation name (e.g. "XSS"); useful for tooltips. */
  inferredCweName: string | null;
}

interface SoftCitationLike {
  name?: string | null;
  inferredCwe?: string | null;
}

interface EngineLike {
  signalBreakdown?: {
    softCitation?: SoftCitationLike | null;
    avri?: { softCitation?: SoftCitationLike | null } | null;
  } | null;
}

interface EngineResultsBlob {
  engines?: EngineLike[];
}

function pickSoft(
  signalBreakdown: EngineLike["signalBreakdown"],
): SoftCitationLike | null {
  if (!signalBreakdown) return null;
  // Prefer the AVRI-emitted block (newer pipeline) over the legacy
  // top-level one — same precedence the triage panel uses, so the badge
  // on the row matches the badge on the detail page for any given row.
  return (
    signalBreakdown.avri?.softCitation ?? signalBreakdown.softCitation ?? null
  );
}

export function deriveInferredCwe(
  vulnrapEngineResults: unknown,
): InferredCweInfo {
  const engines =
    ((vulnrapEngineResults ?? {}) as EngineResultsBlob).engines ?? [];
  for (const eng of engines) {
    const soft = pickSoft(eng?.signalBreakdown);
    if (
      soft &&
      typeof soft.inferredCwe === "string" &&
      soft.inferredCwe.length > 0
    ) {
      return {
        inferredCwe: soft.inferredCwe,
        inferredCweName:
          typeof soft.name === "string" && soft.name.length > 0
            ? soft.name
            : null,
      };
    }
  }
  return { inferredCwe: null, inferredCweName: null };
}
