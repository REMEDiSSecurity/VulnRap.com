// Sprint 12 — AVRI calibration drift dashboard.
//
// Surfaces a rolling weekly view of the AVRI composite for production
// reports, bucketed by triage outcome (T1-equivalent vs T3-equivalent).
// Mirrors the avriComparison summarization pattern from
// routes/test-fixtures.ts but reads from the live reportsTable instead
// of the static fixture battery so the rubric drift can be tracked
// against actual reporter behaviour.
//
// "Ground truth" here is the triage outcome implied by the persisted
// composite label, since the matrix triage decision is a deterministic
// function of composite + verification + temporal signals and the label
// is the AVRI-on cohort tag we already store. The thresholds below
// match getCompositeLabel() in lib/engines/avri/composite.ts:
//
//   LIKELY INVALID / HIGH RISK   → AUTO_CLOSE-equivalent (T3-equivalent)
//   PROMISING     / STRONG       → PRIORITIZE-equivalent (T1-equivalent)
//   NEEDS REVIEW  / REASONABLE   → NEUTRAL (not used for the gap)
//
// Drift flags fire when:
//   - The on-mode T1−T3 gap drops below 45pt for a week with ≥ MIN_BUCKET
//     reports in each bucket (rubric is collapsing).
//   - Any family's mean (within either bucket) shifts by ≥5pt from the
//     prior eligible week (per-family weight drift).

import { db, reportsTable } from "@workspace/db";
import { sql, and, isNotNull, gte } from "drizzle-orm";
import { classifyReport, type FamilyId } from "./engines/avri";

export interface FamilyMean {
  family: string;
  count: number;
  mean: number;
}

export interface WeekBucket {
  /** ISO date (YYYY-MM-DD) for the Monday that starts the UTC week. */
  weekStart: string;
  reportCount: number;
  t1: { count: number; mean: number | null };
  t3: { count: number; mean: number | null };
  gap: number | null;
  perFamily: {
    t1: FamilyMean[];
    t3: FamilyMean[];
  };
  /** True when both buckets meet MIN_BUCKET so the gap is statistically usable. */
  gapEligible: boolean;
}

export interface DriftFlag {
  weekStart: string;
  kind: "GAP_BELOW_45" | "FAMILY_MEAN_SHIFT";
  detail: string;
}

export interface AvriDriftReport {
  generatedAt: string;
  weeksRequested: number;
  totalReportsScanned: number;
  /**
   * Cohort filter applied: only reports persisted with an AVRI block
   * (i.e. scored while VULNRAP_USE_AVRI=true) are included so AVRI-off
   * historical rows don't contaminate the rolling means.
   */
  cohort: "avri_on_only";
  /**
   * Reviewer-facing note explaining that the T1/T3 buckets are derived
   * from the persisted composite label as a triage-equivalent proxy.
   * The label bands (STRONG/PROMISING vs LIKELY INVALID/HIGH RISK) line
   * up 1:1 with the matrix triage AUTO_CLOSE / PRIORITIZE actions, so
   * the bucketing tracks triage outcomes without re-running the full
   * matrix per row.
   */
  bucketingNote: string;
  thresholds: {
    gapWarn: number;
    familyShiftWarn: number;
    minBucketSize: number;
  };
  weeks: WeekBucket[];
  flags: DriftFlag[];
  runbookPath: string;
}

const MIN_BUCKET = 3;
const GAP_WARN = 45;
const FAMILY_SHIFT_WARN = 5;

/** UTC Monday of the week that contains `d`, formatted YYYY-MM-DD. */
function isoWeekStart(d: Date): string {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = u.getUTCDay(); // 0=Sun..6=Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  u.setUTCDate(u.getUTCDate() + offset);
  return u.toISOString().slice(0, 10);
}

type Bucket = "T1" | "T3" | "NEUTRAL";

function bucketForLabel(label: string | null): Bucket {
  switch (label) {
    case "STRONG":
    case "PROMISING":
      return "T1";
    case "LIKELY INVALID":
    case "HIGH RISK":
      return "T3";
    default:
      return "NEUTRAL";
  }
}

/**
 * Resolve the report's AVRI family with three tiers, in order of preference:
 *   1. The dedicated `reports.avri_family` column (Sprint 12 cache — set at
 *      write time from the AVRI composite, populated for new rows and
 *      historical rows by `backfill-avri-family.ts`).
 *   2. The `avri.family` field inside `vulnrap_engine_results` for any row
 *      whose backfill hasn't run yet but whose composite did persist an
 *      AVRI block.
 *   3. Re-running `classifyReport` over `contentText` as a last resort so
 *      the dashboard never silently degrades for a row missing both caches.
 * The last tier should be effectively dead once the backfill has run; it
 * exists to keep this function correct even on a partially-populated table.
 */
function resolveFamily(
  cachedFamily: string | null,
  vulnrapEngineResults: unknown,
  contentText: string,
): string {
  if (cachedFamily && cachedFamily.length > 0) {
    return cachedFamily;
  }
  const blob = (vulnrapEngineResults ?? {}) as { avri?: { family?: unknown } };
  const stored = blob.avri?.family;
  if (typeof stored === "string" && stored.length > 0) {
    return stored as FamilyId;
  }
  return classifyReport(contentText, undefined).family.id;
}

function meanOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1));
}

function summarizePerFamily(
  rows: Array<{ family: string; composite: number }>,
): FamilyMean[] {
  const byFam = new Map<string, number[]>();
  for (const r of rows) {
    if (!byFam.has(r.family)) byFam.set(r.family, []);
    byFam.get(r.family)!.push(r.composite);
  }
  return Array.from(byFam.entries())
    .map(([family, xs]) => ({ family, count: xs.length, mean: meanOf(xs) ?? 0 }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

export async function generateAvriDriftReport(
  opts: { weeks?: number } = {},
): Promise<AvriDriftReport> {
  const weeksRequested = Math.max(1, Math.min(26, Math.floor(opts.weeks ?? 8)));
  const cutoff = new Date(Date.now() - weeksRequested * 7 * 24 * 60 * 60 * 1000);

  // Restrict the cohort to reports persisted with an AVRI block
  // (vulnrap_engine_results -> 'avri'). Pre-AVRI rows in the same window
  // would otherwise contaminate the rolling means.
  const rows = await db
    .select({
      id: reportsTable.id,
      composite: reportsTable.vulnrapCompositeScore,
      label: reportsTable.vulnrapCompositeLabel,
      contentText: reportsTable.contentText,
      vulnrapEngineResults: reportsTable.vulnrapEngineResults,
      avriFamily: reportsTable.avriFamily,
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .where(
      and(
        isNotNull(reportsTable.vulnrapCompositeScore),
        isNotNull(reportsTable.contentText),
        gte(reportsTable.createdAt, cutoff),
        sql`${reportsTable.vulnrapEngineResults} -> 'avri' IS NOT NULL`,
      ),
    )
    .orderBy(sql`${reportsTable.createdAt} ASC`);

  type Enriched = {
    weekStart: string;
    bucket: Bucket;
    family: string;
    composite: number;
  };
  const enriched: Enriched[] = [];
  for (const r of rows) {
    if (r.composite == null || r.contentText == null) continue;
    const bucket = bucketForLabel(r.label);
    const family = resolveFamily(r.avriFamily, r.vulnrapEngineResults, r.contentText);
    enriched.push({
      weekStart: isoWeekStart(new Date(r.createdAt)),
      bucket,
      family,
      composite: r.composite,
    });
  }

  const byWeek = new Map<string, Enriched[]>();
  for (const e of enriched) {
    if (!byWeek.has(e.weekStart)) byWeek.set(e.weekStart, []);
    byWeek.get(e.weekStart)!.push(e);
  }
  const weekStarts = Array.from(byWeek.keys()).sort();

  const weeks: WeekBucket[] = weekStarts.map(weekStart => {
    const items = byWeek.get(weekStart)!;
    const t1Items = items.filter(i => i.bucket === "T1");
    const t3Items = items.filter(i => i.bucket === "T3");
    const t1Mean = meanOf(t1Items.map(i => i.composite));
    const t3Mean = meanOf(t3Items.map(i => i.composite));
    const gap = t1Mean != null && t3Mean != null
      ? Number((t1Mean - t3Mean).toFixed(1))
      : null;
    const gapEligible = t1Items.length >= MIN_BUCKET && t3Items.length >= MIN_BUCKET;
    return {
      weekStart,
      reportCount: items.length,
      t1: { count: t1Items.length, mean: t1Mean },
      t3: { count: t3Items.length, mean: t3Mean },
      gap,
      perFamily: {
        t1: summarizePerFamily(t1Items),
        t3: summarizePerFamily(t3Items),
      },
      gapEligible,
    };
  });

  const flags: DriftFlag[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i]!;
    if (w.gapEligible && w.gap != null && w.gap < GAP_WARN) {
      flags.push({
        weekStart: w.weekStart,
        kind: "GAP_BELOW_45",
        detail: `T1−T3 composite gap ${w.gap} < ${GAP_WARN}pt threshold (T1 n=${w.t1.count} mean=${w.t1.mean}, T3 n=${w.t3.count} mean=${w.t3.mean}).`,
      });
    }
    if (i === 0) continue;
    const prev = weeks[i - 1]!;
    for (const bucketName of ["t1", "t3"] as const) {
      const cur = w.perFamily[bucketName];
      const old = prev.perFamily[bucketName];
      for (const fam of cur) {
        if (fam.count < MIN_BUCKET) continue;
        const oldFam = old.find(f => f.family === fam.family);
        if (!oldFam || oldFam.count < MIN_BUCKET) continue;
        const shift = Number((fam.mean - oldFam.mean).toFixed(1));
        if (Math.abs(shift) >= FAMILY_SHIFT_WARN) {
          flags.push({
            weekStart: w.weekStart,
            kind: "FAMILY_MEAN_SHIFT",
            detail: `${bucketName.toUpperCase()} family ${fam.family} mean shifted by ${shift >= 0 ? "+" : ""}${shift}pt vs ${prev.weekStart} (was ${oldFam.mean}, now ${fam.mean}).`,
          });
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    weeksRequested,
    totalReportsScanned: enriched.length,
    cohort: "avri_on_only",
    bucketingNote:
      "T1/T3 buckets are derived from the persisted vulnrap_composite_label as a triage-equivalent proxy: STRONG/PROMISING -> PRIORITIZE-equivalent (T1), LIKELY INVALID/HIGH RISK -> AUTO_CLOSE-equivalent (T3). NEEDS REVIEW/REASONABLE rows are excluded from the gap.",
    thresholds: {
      gapWarn: GAP_WARN,
      familyShiftWarn: FAMILY_SHIFT_WARN,
      minBucketSize: MIN_BUCKET,
    },
    weeks,
    flags,
    runbookPath: "docs/avri-drift-runbook.md",
  };
}

// Exported for unit testing the pure summarization without DB access.
export const __testing = {
  isoWeekStart,
  bucketForLabel,
  summarizePerFamily,
  MIN_BUCKET,
  GAP_WARN,
  FAMILY_SHIFT_WARN,
};
