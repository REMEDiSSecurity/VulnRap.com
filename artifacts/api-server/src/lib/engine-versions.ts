// Task #624 — Engine version pinning per report.
//
// Single source of truth for the semver of each scoring engine that
// contributes to a stored report. Persisted to `reports.engine_versions`
// at write time so that any future re-scoring or score-evolution timeline
// can answer "which engine versions produced this score?" without
// re-deriving them from git history.
//
// Bump the relevant version when an engine's scoring behaviour changes
// in a way that materially affects output (weights, thresholds, signal
// set, override rules). Patch bumps are reserved for non-behavioural
// refactors so old reports stay comparable across patches.

export interface EngineVersions {
  linguistic: string;
  substance: string;
  cwe: string;
  avri: string;
  fusion: string;
}

export const ENGINE_VERSIONS: EngineVersions = {
  linguistic: "3.10.0",
  substance: "3.10.0",
  cwe: "3.10.0",
  avri: "3.10.0",
  fusion: "3.10.0",
};

export function getCurrentEngineVersions(): EngineVersions {
  return { ...ENGINE_VERSIONS };
}

export function getScoringEngineVersion(): string {
  const vals = Object.values(ENGINE_VERSIONS);
  const unique = [...new Set(vals)];
  if (unique.length === 1) return unique[0];
  return `${ENGINE_VERSIONS.substance}+mixed`;
}

export function formatEngineVersionsLabel(
  ev: EngineVersions | null | undefined,
): string | null {
  if (!ev) return null;
  const vals = Object.values(ev);
  const unique = [...new Set(vals)];
  if (unique.length === 1) return unique[0];
  return `${ev.substance}+mixed`;
}
