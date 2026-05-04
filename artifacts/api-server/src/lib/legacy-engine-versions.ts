// Task #937 — Inference helper for backfilling `reports.engine_versions`
// on legacy rows scored before Task #624 added the column.
//
// Task #624 added per-report version pinning so reproducibility audits
// and the score-evolution timeline can answer "which engine versions
// produced this score?" without re-deriving from git history. Reports
// scored before that migration shipped have engine_versions = NULL and
// therefore (a) hide the diagnostics-panel footer that reads them and
// (b) silently drop out of any future join that keys on engine version.
//
// The inference is intentionally best-effort: we don't keep enough
// telemetry on legacy rows to reconstruct the exact semver per engine,
// so we pin to the oldest version known to have produced a blob of the
// observed shape and let the diagnostics footer surface a more honest
// "engines: …v3.0.0" than no footer at all. Three tiers, in order from
// oldest to newest:
//
//   1. Pre-VulnRap composite (vulnrap_engine_results IS NULL).
//      Pin everything to "3.0.0" — the oldest known semver per the
//      Task #937 brief.
//   2. VulnRap composite present but no AVRI sub-block. The composite
//      shipped with the v3.5.0 signal pipeline (reconstructed reports'
//      backfill comment in routes/reports.ts:731 anchors this), so pin
//      to "3.5.0".
//   3. VulnRap composite with an AVRI sub-block. AVRI was introduced
//      in Sprint 12, which the v3.6.0 backfill (see
//      backfill-vulnrap.ts header) wrote, so pin to "3.6.0".
//
// Newer pins (3.10.x — current) are deliberately left to live writes
// and the rescore backfill: this helper is for legacy rows only.

import type { EngineVersions } from "./engine-versions";

export const LEGACY_BASE_VERSION = "3.0.0";
export const LEGACY_VULNRAP_VERSION = "3.5.0";
export const LEGACY_AVRI_VERSION = "3.6.0";

interface VulnrapBlobShape {
  engines?: unknown[];
  avri?: unknown;
  compositeBreakdown?: unknown;
}

function pinAll(version: string): EngineVersions {
  return {
    linguistic: version,
    substance: version,
    cwe: version,
    avri: version,
    fusion: version,
  };
}

/**
 * Infer the engine-version pin to stamp on a legacy report. Always
 * returns an EngineVersions object: rows with no recoverable signal
 * (null/empty/non-object blob) fall through to the LEGACY_BASE_VERSION
 * tier so the diagnostics-panel footer still has something to render
 * instead of staying hidden indefinitely.
 */
export function inferLegacyEngineVersions(
  vulnrapEngineResults: unknown,
): EngineVersions {
  const blob = (vulnrapEngineResults ?? null) as VulnrapBlobShape | null;
  if (!blob || typeof blob !== "object") {
    return pinAll(LEGACY_BASE_VERSION);
  }
  const hasVulnrapShape =
    Array.isArray(blob.engines) || blob.compositeBreakdown != null;
  if (!hasVulnrapShape && blob.avri == null) {
    return pinAll(LEGACY_BASE_VERSION);
  }
  if (blob.avri != null) {
    return pinAll(LEGACY_AVRI_VERSION);
  }
  return pinAll(LEGACY_VULNRAP_VERSION);
}
