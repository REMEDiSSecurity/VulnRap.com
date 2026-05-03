// Task #663 — CWE reference catalog.
//
// Builds the public payload for `GET /api/public/cwe-catalog`. Combines
// the static CWE fingerprint library (`engines/cwe-fingerprints.ts`) with
// the AVRI family rubric (`engines/avri/families.ts`) so each entry is
// grouped under the same family ids the rest of the platform already
// uses (INJECTION, MEMORY_CORRUPTION, ...). Per-CWE usage stats
// (count + average composite score) are computed from the reports table
// by extracting the soft-citation `inferredCwe` out of
// `vulnrap_engine_results.engines[].signalBreakdown.{avri.,}softCitation`,
// mirroring the precedence used by `lib/inferred-cwe.ts`. Reports where
// no soft-citation fired are not counted.

import { sql } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import {
  CWE_FINGERPRINTS,
  HIGH_REJECTION_CWES,
} from "./engines/cwe-fingerprints";
import {
  FAMILIES_BY_ID,
  FLAT_FAMILY,
  familyForCweNumber,
  type FamilyId,
} from "./engines/avri/families";

export interface CweCatalogEntry {
  cweId: string;
  name: string;
  family: FamilyId;
  familyName: string;
  aliases: string[];
  expectedTerms: string[];
  mitreUrl: string;
  highQualityReport: string;
  reproductionExpectation: string;
  rejectionRate: number;
  reportCount: number;
  avgCompositeScore: number | null;
  reportsLink: string;
}

export interface CweCatalogFamily {
  family: FamilyId;
  familyName: string;
  reproductionExpectation: string;
  entries: CweCatalogEntry[];
}

export interface CweCatalogResponse {
  generatedAt: string;
  totalCwes: number;
  families: CweCatalogFamily[];
}

const FAMILY_ORDER: FamilyId[] = [
  "MEMORY_CORRUPTION",
  "INJECTION",
  "WEB_CLIENT",
  "AUTHN_AUTHZ",
  "CRYPTO",
  "DESERIALIZATION",
  "RACE_CONCURRENCY",
  "REQUEST_SMUGGLING",
  "FLAT",
];

function mitreUrl(cweId: string): string {
  const num = cweId.replace(/^CWE-/i, "");
  return `https://cwe.mitre.org/data/definitions/${num}.html`;
}

function highQualityReportText(
  cweId: string,
  fingerprint: (typeof CWE_FINGERPRINTS)[string],
  familyId: FamilyId,
): string {
  const fam = FAMILIES_BY_ID[familyId];
  const wantedTerms = fingerprint.expectedTerms.slice(0, 6).join(", ");
  const familyHint =
    fam.id !== "FLAT" && fam.goldSignals.length > 0
      ? ` ${fam.displayName} reports score highest when they include ${fam.goldSignals
          .slice(0, 3)
          .map((g) => g.description.toLowerCase())
          .join("; ")}.`
      : "";
  return `Name ${cweId} (or its aliases) and back the claim with concrete evidence — terms like ${wantedTerms} should appear naturally in the writeup.${familyHint}`;
}

interface InferredCweRow extends Record<string, unknown> {
  inferred_cwe: string;
  count: number;
  avg_score: number | null;
}

async function fetchInferredCweStats(): Promise<
  Map<string, { count: number; avgScore: number | null }>
> {
  // Unwrap the per-engine signalBreakdown blocks from vulnrap_engine_results.
  // Prefer the AVRI-emitted softCitation (newer pipeline) then fall back to
  // the legacy top-level softCitation — same precedence as
  // lib/inferred-cwe.ts. We pick exactly one inferred CWE per report (the
  // first non-null one seen in any engine) so a report that fires the
  // citation in two engines is not double-counted.
  const result = await db.execute<InferredCweRow>(sql`
    WITH per_report AS (
      SELECT DISTINCT ON (r.id)
        r.id,
        r.vulnrap_composite_score,
        COALESCE(
          elem->'signalBreakdown'->'avri'->'softCitation'->>'inferredCwe',
          elem->'signalBreakdown'->'softCitation'->>'inferredCwe'
        ) AS inferred_cwe
      FROM reports r,
           jsonb_array_elements(
             COALESCE(r.vulnrap_engine_results->'engines', '[]'::jsonb)
           ) AS elem
      WHERE COALESCE(
              elem->'signalBreakdown'->'avri'->'softCitation'->>'inferredCwe',
              elem->'signalBreakdown'->'softCitation'->>'inferredCwe'
            ) IS NOT NULL
      ORDER BY r.id
    )
    SELECT
      inferred_cwe,
      COUNT(*)::int AS count,
      AVG(vulnrap_composite_score)::float AS avg_score
    FROM per_report
    GROUP BY inferred_cwe
  `);

  const map = new Map<string, { count: number; avgScore: number | null }>();
  for (const r of result.rows) {
    if (!r.inferred_cwe) continue;
    map.set(r.inferred_cwe, {
      count: Number(r.count) || 0,
      avgScore:
        r.avg_score === null || r.avg_score === undefined
          ? null
          : Number(r.avg_score),
    });
  }
  return map;
}

export async function buildCweCatalog(): Promise<CweCatalogResponse> {
  let stats: Map<string, { count: number; avgScore: number | null }>;
  try {
    stats = await fetchInferredCweStats();
  } catch {
    // Surface an empty stats map on DB failure rather than 500ing the
    // whole catalog — the static fingerprint metadata is the primary
    // payload, the per-CWE counts are an enrichment.
    stats = new Map();
  }

  const grouped = new Map<FamilyId, CweCatalogEntry[]>();

  for (const [cweId, fingerprint] of Object.entries(CWE_FINGERPRINTS)) {
    const num = cweId.replace(/^CWE-/i, "");
    const familyId = familyForCweNumber(num) ?? FLAT_FAMILY.id;
    const fam = FAMILIES_BY_ID[familyId];
    const stat = stats.get(cweId);
    const rejectionRate =
      HIGH_REJECTION_CWES[cweId] ?? fingerprint.rejectionRate;

    const entry: CweCatalogEntry = {
      cweId,
      name: fingerprint.name,
      family: familyId,
      familyName: fam.displayName,
      aliases: fingerprint.knownAliases,
      expectedTerms: fingerprint.expectedTerms,
      mitreUrl: mitreUrl(cweId),
      highQualityReport: highQualityReportText(cweId, fingerprint, familyId),
      reproductionExpectation: fam.reproductionExpectation,
      rejectionRate,
      reportCount: stat?.count ?? 0,
      avgCompositeScore:
        stat?.avgScore !== undefined ? (stat?.avgScore ?? null) : null,
      reportsLink:
        familyId === "FLAT" ? "/reports" : `/reports?avriFamily=${familyId}`,
    };

    const existing = grouped.get(familyId) ?? [];
    existing.push(entry);
    grouped.set(familyId, existing);
  }

  const families: CweCatalogFamily[] = FAMILY_ORDER.filter((f) =>
    grouped.has(f),
  ).map((familyId) => {
    const fam = FAMILIES_BY_ID[familyId];
    const entries = (grouped.get(familyId) ?? []).sort((a, b) => {
      // Most-used first within a family, then by CWE id ascending.
      if (b.reportCount !== a.reportCount) return b.reportCount - a.reportCount;
      return a.cweId.localeCompare(b.cweId, undefined, { numeric: true });
    });
    return {
      family: familyId,
      familyName: fam.displayName,
      reproductionExpectation: fam.reproductionExpectation,
      entries,
    };
  });

  // Catch any CWE whose family wasn't in FAMILY_ORDER (defensive).
  for (const [familyId, entries] of grouped.entries()) {
    if (!FAMILY_ORDER.includes(familyId)) {
      families.push({
        family: familyId,
        familyName: FAMILIES_BY_ID[familyId]?.displayName ?? String(familyId),
        reproductionExpectation:
          FAMILIES_BY_ID[familyId]?.reproductionExpectation ?? "",
        entries,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalCwes: Object.keys(CWE_FINGERPRINTS).length,
    families,
  };
}
