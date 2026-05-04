// Single source of truth for the per-engine weights used by the diagnostic
// `EngineTogglePanel` on /check. The server's full fusion path
// (artifacts/api-server/src/lib/score-fusion.ts) takes
// `Math.max(styleDriven, substanceDriven)` from the authenticity/substance
// axes rather than a straight weighted blend of the four engine axes that
// the UI surfaces (Linguistic / Factual / Template / LLM). The toggle panel
// is an *educational* recalculator that re-fuses the four visible engine
// axes with the weights below. Update both the server's calibration and
// these weights together if either changes.

export type EngineKey = "linguistic" | "factual" | "template" | "llm";

export interface EngineBreakdown {
  linguistic?: number;
  factual?: number;
  template?: number;
  llm?: number | null;
}

// Fallback weights used only when the server response does not carry a
// `breakdown.fusionWeights` block (older reports cached before Task #959,
// or test fixtures that build a breakdown by hand). The server is the
// authoritative source — see `FUSION_WEIGHTS` in
// `artifacts/api-server/src/lib/score-fusion.ts`. Keep these in lockstep
// with the server constant so the UI degrades gracefully on stale data.
export const ENGINE_FUSION_WEIGHTS: Record<EngineKey, number> = {
  linguistic: 0.3,
  factual: 0.3,
  template: 0.15,
  llm: 0.25,
};

/**
 * Resolve per-engine weights, preferring server-provided values from
 * `breakdown.fusionWeights` and falling back to `ENGINE_FUSION_WEIGHTS`
 * for any missing key. Unknown keys in the server payload are ignored.
 */
export function resolveFusionWeights(
  serverWeights?: Record<string, number> | null,
): Record<EngineKey, number> {
  const out: Record<EngineKey, number> = { ...ENGINE_FUSION_WEIGHTS };
  if (!serverWeights) return out;
  for (const key of ENGINE_ORDER) {
    const v = serverWeights[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = v;
    }
  }
  return out;
}

export const ENGINE_ORDER: EngineKey[] = [
  "linguistic",
  "factual",
  "template",
  "llm",
];

export interface EngineContribution {
  key: EngineKey;
  available: boolean;
  enabled: boolean;
  rawScore: number;
  baseWeight: number;
  normalizedWeight: number;
  contribution: number;
}

export interface RefuseResult {
  score: number;
  contributions: EngineContribution[];
}

/**
 * Re-fuse the displayed slop score from the four engine axes, using
 * `ENGINE_FUSION_WEIGHTS` and renormalizing the active subset. When called
 * with all engines enabled this produces the *baseline* recalculated score
 * — the value that should be compared against any toggled-off variant to
 * isolate the contribution of a specific engine. (See
 * `EngineTogglePanel`'s "vs all-on baseline" delta.)
 */
export function refuseEngines(
  breakdown: EngineBreakdown,
  enabled: Record<EngineKey, boolean>,
  fusionWeights?: Record<string, number> | null,
): RefuseResult {
  const weights = resolveFusionWeights(fusionWeights);
  const states = ENGINE_ORDER.map((key) => {
    const value = breakdown[key];
    const available = value != null;
    return {
      key,
      available,
      enabled: available && enabled[key],
      rawScore: available ? Number(value) : 0,
      baseWeight: weights[key],
    };
  });
  const totalWeight = states
    .filter((s) => s.enabled)
    .reduce((sum, s) => sum + s.baseWeight, 0);
  const contributions: EngineContribution[] = states.map((s) => {
    const normalizedWeight =
      totalWeight > 0 && s.enabled ? s.baseWeight / totalWeight : 0;
    return {
      key: s.key,
      available: s.available,
      enabled: s.enabled,
      rawScore: s.rawScore,
      baseWeight: s.baseWeight,
      normalizedWeight,
      contribution: s.enabled ? normalizedWeight * s.rawScore : 0,
    };
  });
  const score =
    totalWeight > 0
      ? Math.round(contributions.reduce((sum, c) => sum + c.contribution, 0))
      : 0;
  return { score, contributions };
}

export const ALL_ENGINES_ON: Record<EngineKey, boolean> = {
  linguistic: true,
  factual: true,
  template: true,
  llm: true,
};
