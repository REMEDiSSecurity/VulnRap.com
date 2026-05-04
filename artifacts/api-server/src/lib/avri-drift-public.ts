// Task #617 — Public, read-only summary of the rolling weekly T1-vs-T3
// composite mean spread. Wraps `generateAvriDriftReport` and produces a
// DTO that strips every reviewer-only field so it can be served on the
// public `/transparency` page.
//
// Reviewer-only fields explicitly *not* exposed:
//   - per-family means (perFamily)
//   - per-bucket counts and means (t1.count, t1.mean, t3.count, t3.mean)
//   - drift flags + their detail strings
//   - thresholds
//   - bucketingNote, cohort discriminator, runbookPath
//   - totalReportsScanned (raw cohort sample volume)
//
// Only `weekStart` + the rounded T1−T3 `spread` are exposed per week,
// alongside a current-vs-previous-week delta. Weeks that failed the
// internal MIN_BUCKET eligibility test are dropped so the public widget
// only ever shows statistically usable data points.

import { generateAvriDriftReport, type AvriDriftReport } from "./avri-drift";

export interface PublicDriftSummaryWeek {
  weekStart: string;
  spread: number | null;
}

export interface PublicDriftSummary {
  generatedAt: string;
  weeks: PublicDriftSummaryWeek[];
  currentSpread: number | null;
  previousSpread: number | null;
  delta: number | null;
  hasCurrentWeek: boolean;
}

const PUBLIC_WEEK_LIMIT = 12;

/** UTC Monday of the week that contains `d`, formatted YYYY-MM-DD. */
function utcMondayOf(d: Date): string {
  const u = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dow = u.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  u.setUTCDate(u.getUTCDate() + offset);
  return u.toISOString().slice(0, 10);
}

/**
 * Project an internal `AvriDriftReport` into the public-safe DTO.
 * Exported separately so unit tests can pin the projection without
 * touching the database compute.
 */
export function toPublicDriftSummary(
  report: AvriDriftReport,
  now: Date = new Date(),
): PublicDriftSummary {
  // Keep only weeks where the bucket was statistically eligible — the
  // public surface should never show raw, sub-MIN_BUCKET noise.
  const eligible = report.weeks
    .filter((w) => w.gapEligible && w.gap != null)
    .map((w) => ({ weekStart: w.weekStart, spread: w.gap }));

  // Sort oldest-first then keep the last PUBLIC_WEEK_LIMIT entries.
  eligible.sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  const weeks: PublicDriftSummaryWeek[] = eligible.slice(-PUBLIC_WEEK_LIMIT);

  const last = weeks.length > 0 ? weeks[weeks.length - 1] : null;
  const prev = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const currentSpread = last?.spread ?? null;
  const previousSpread = prev?.spread ?? null;
  const delta =
    currentSpread != null && previousSpread != null
      ? Number((currentSpread - previousSpread).toFixed(1))
      : null;

  const hasCurrentWeek = last != null && last.weekStart === utcMondayOf(now);

  return {
    generatedAt: report.generatedAt,
    weeks,
    currentSpread,
    previousSpread,
    delta,
    hasCurrentWeek,
  };
}

const DRIFT_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedSummary: PublicDriftSummary | null = null;
let cachedAt = 0;
let inflight: Promise<PublicDriftSummary> | null = null;

export async function getPublicDriftSummary(): Promise<PublicDriftSummary> {
  const now = Date.now();
  if (cachedSummary && now - cachedAt < DRIFT_CACHE_TTL_MS) {
    return cachedSummary;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const report = await generateAvriDriftReport({ weeks: 16 });
    const summary = toPublicDriftSummary(report);
    cachedSummary = summary;
    cachedAt = Date.now();
    return summary;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function invalidateDriftSummaryCache(): void {
  cachedSummary = null;
  cachedAt = 0;
}

export const __testing = { utcMondayOf, PUBLIC_WEEK_LIMIT, get cachedAt() { return cachedAt; } };
