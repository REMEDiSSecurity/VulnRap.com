// Task #615 — Cohort baseline ribbon endpoint.
//
// Returns a 10-bucket histogram of VulnRap composite scores from the last
// 7 days plus the median for that cohort. The composite score is the same
// metric shown in the big number on the results page header (and the value
// the ribbon's marker is positioned against), so the percentile label is a
// valid percentile for that displayed score. When `cwe` is supplied (and
// matches a known AVRI rubric family) the cohort is restricted to reports
// whose cached `avri_family` column matches; otherwise the full platform
// cohort is returned. Used by the results page baseline ribbon to give
// submitters instant context for an otherwise-context-free score number.
//
// The percentile math itself is exposed as a pure helper
// (`percentileRankFromBins`) so it can be exercised in unit tests without a
// live database.
import { Router, type IRouter } from "express";
import { sql, gte, and, eq, isNotNull } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import { GetCohortBaselineResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Mirrors AVRI_FAMILY_IDS in routes/reports.ts. Kept inline so a typo in one
// list does not silently allow an unknown family through here.
const COHORT_CWE_FAMILY_IDS = new Set<string>([
  "MEMORY_CORRUPTION",
  "INJECTION",
  "WEB_CLIENT",
  "AUTHN_AUTHZ",
  "CRYPTO",
  "DESERIALIZATION",
  "RACE_CONCURRENCY",
  "REQUEST_SMUGGLING",
  "FLAT",
]);

const BUCKET_COUNT = 10;
const WINDOW_DAYS = 7;

export interface CohortBin {
  min: number;
  max: number;
  count: number;
}

// Pure helper: builds the 10-equal-width-bucket histogram covering scores
// 0..100. The last bucket is inclusive of 100 (i.e. [90, 100]); every other
// bucket is half-open [min, max). Exposed for direct unit testing of the
// bin layout independent of the SQL query.
export function buildEmptyBins(): CohortBin[] {
  const bins: CohortBin[] = [];
  const width = 100 / BUCKET_COUNT;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    bins.push({
      min: Math.round(i * width),
      max: Math.round((i + 1) * width),
      count: 0,
    });
  }
  return bins;
}

// Pure helper: which bucket index does a score fall into? Scores below 0 are
// clamped into bucket 0 and scores at or above 100 fall in the final bucket.
export function bucketIndexForScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score <= 0) return 0;
  if (score >= 100) return BUCKET_COUNT - 1;
  const idx = Math.floor((score / 100) * BUCKET_COUNT);
  return Math.min(idx, BUCKET_COUNT - 1);
}

// Pure helper: percentile rank of `score` against the cohort represented by
// `bins`. Reports whose bin sits strictly below the score's bin count as
// "below"; the score's own bin contributes half its count (mid-rank
// convention) so two reports tied in the same bucket sit at the 50th
// percentile of that bucket rather than 0 or 100.
//
// Returns an integer 0..100. Returns 0 when the cohort is empty so the UI
// can show a "no baseline yet" affordance instead of a misleading number.
export function percentileRankFromBins(
  score: number,
  bins: CohortBin[],
): number {
  const total = bins.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return 0;
  const idx = bucketIndexForScore(score);
  let below = 0;
  for (let i = 0; i < idx; i++) below += bins[i].count;
  const same = bins[idx]?.count ?? 0;
  const rank = (below + same / 2) / total;
  return Math.max(0, Math.min(100, Math.round(rank * 100)));
}

// Pure helper: computes the median score from a bin histogram. We don't have
// access to the underlying scores at this point, so the median is
// approximated as the midpoint of the bucket that contains the
// (total/2)-th sample — sufficient for an at-a-glance baseline ribbon, and
// avoids a second SQL round-trip.
export function medianFromBins(bins: CohortBin[]): number | null {
  const total = bins.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return null;
  const half = total / 2;
  let cumulative = 0;
  for (const b of bins) {
    cumulative += b.count;
    if (cumulative >= half) {
      return Math.round((b.min + b.max) / 2);
    }
  }
  const last = bins[bins.length - 1];
  return Math.round((last.min + last.max) / 2);
}

// Pure helper: exact mid-rank percentile of `score` against the cohort,
// using the raw row counts from SQL (not the bucketed histogram). Mirrors
// the bucket-based helper above but operates on `below` / `equal` /
// `total` directly so a report scoring 61 vs 69 gets a different label
// instead of both rounding to the same 10-point step. Rounded to one
// decimal place — finer than the integer the bucket math returns and
// avoids leaking float noise to the UI.
export function exactPercentileFromCounts(
  below: number,
  equal: number,
  total: number,
): number {
  if (total <= 0) return 0;
  const rank = (below + equal / 2) / total;
  const pct = Math.max(0, Math.min(100, rank * 100));
  return Math.round(pct * 10) / 10;
}

// Parses & clamps the optional `score` query parameter. Returns null
// when absent or non-numeric so the percentile path is skipped without
// surfacing a 400 — keeps the ribbon endpoint forgiving of stale
// clients that send garbage.
export function parseScoreParam(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

router.get("/cohort/baseline", async (req, res): Promise<void> => {
  const rawCwe = req.query.cwe ? String(req.query.cwe) : null;
  // Unknown values fall through to the platform-wide cohort (mirrors the
  // avriFamily filter on the feed endpoint) so a stale client value never
  // returns 400.
  const cweFilter = rawCwe && COHORT_CWE_FAMILY_IDS.has(rawCwe) ? rawCwe : null;
  const queriedScore = parseScoreParam(req.query.score);

  // Task #933 — same baseline ribbon UI is also used to contextualise the
  // legacy AI Detection ("slop") score that still sits further down the
  // results page. `metric=slop` swaps the column the histogram is bucketed
  // against; everything else (window, cwe filter, percentile math) stays
  // identical so the server stays the single source of truth.
  const rawMetric = req.query.metric ? String(req.query.metric) : "composite";
  const metric: "composite" | "slop" =
    rawMetric === "slop" ? "slop" : "composite";
  const scoreColumn =
    metric === "slop"
      ? reportsTable.slopScore
      : reportsTable.vulnrapCompositeScore;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);

  // Bin against the chosen score column so the histogram and median match
  // the metric the results page actually shows users. For the composite
  // cohort, legacy rows that pre-date the multi-engine consensus have NULL
  // here and are excluded — those reports also have no composite to plot a
  // marker against, so leaving them out keeps the cohort honest. The slop
  // column is NOT NULL by schema, so the isNotNull guard is a no-op for
  // metric=slop but kept for parity.
  const conditions = [
    gte(reportsTable.createdAt, cutoff),
    isNotNull(scoreColumn),
  ];
  if (cweFilter) {
    if (cweFilter === "FLAT") {
      // FLAT must also match legacy rows where avri_family is NULL — same
      // semantic the feed endpoint uses, so the cohort baseline matches
      // what the user would see if they filtered the feed.
      conditions.push(
        sql`coalesce(${reportsTable.avriFamily}, 'FLAT') = 'FLAT'`,
      );
    } else {
      conditions.push(eq(reportsTable.avriFamily, cweFilter));
    }
  }

  const rows = await db
    .select({
      bucket: sql<number>`(least(${scoreColumn}, 99) / 10)::int`,
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(and(...conditions))
    .groupBy(sql`(least(${scoreColumn}, 99) / 10)::int`);

  const bins = buildEmptyBins();
  for (const row of rows) {
    const idx = Math.max(
      0,
      Math.min(BUCKET_COUNT - 1, Number(row.bucket) || 0),
    );
    bins[idx].count = Number(row.count) || 0;
  }

  const totalReports = bins.reduce((acc, b) => acc + b.count, 0);
  const median = medianFromBins(bins);

  // Exact percentile path — when the caller passed a `score`, run a single
  // count-aggregate query to get the number of cohort rows strictly below
  // and exactly equal to the queried score. Combined with the cohort total
  // we can compute a mid-rank percentile that doesn't quantise to the
  // 10-point bucket steps the histogram-derived percentile suffers from.
  // Skipped entirely when the cohort is empty (percentile is meaningless)
  // or when no score was supplied (so the regular ribbon fetch stays a
  // single round-trip).
  let percentile: number | null = null;
  if (queriedScore !== null && totalReports > 0) {
    const rankRows = await db
      .select({
        below: sql<number>`count(*) filter (where ${reportsTable.vulnrapCompositeScore} < ${queriedScore})::int`,
        equal: sql<number>`count(*) filter (where ${reportsTable.vulnrapCompositeScore} = ${queriedScore})::int`,
      })
      .from(reportsTable)
      .where(and(...conditions));
    const below = Number(rankRows[0]?.below ?? 0) || 0;
    const equal = Number(rankRows[0]?.equal ?? 0) || 0;
    percentile = exactPercentileFromCounts(below, equal, totalReports);
  }

  // Per-axis medians for the per-engine radar overlay (task #623). Pulled
  // from the cached `vulnrap_engine_results` JSONB array (which holds the
  // exact { engine, score, signalBreakdown } payload the results page
  // renders) plus the `quality_score` column. We do this in JS instead of
  // SQL because the engines list is heterogeneous JSON and the AVRI
  // sub-score is nested two levels deep — fine for a 7-day cohort which
  // typically has well under 10k rows.
  let engineMedians: {
    engine1: number | null;
    engine2: number | null;
    engine3: number | null;
    avri: number | null;
    quality: number | null;
  } | null = null;
  if (totalReports > 0 && metric === "composite") {
    const engineRows = await db
      .select({
        engineResults: reportsTable.vulnrapEngineResults,
        qualityScore: reportsTable.qualityScore,
      })
      .from(reportsTable)
      .where(and(...conditions));

    const e1: number[] = [];
    const e2: number[] = [];
    const e3: number[] = [];
    const avri: number[] = [];
    const quality: number[] = [];
    for (const row of engineRows) {
      if (typeof row.qualityScore === "number") quality.push(row.qualityScore);
      const engines = Array.isArray(row.engineResults)
        ? (row.engineResults as Array<{
            engine?: string;
            score?: number;
            signalBreakdown?: { avri?: { rawAvriScore?: number } };
          }>)
        : [];
      for (const eng of engines) {
        if (typeof eng?.score !== "number") continue;
        if (eng.engine === "AI Authorship Detector") e1.push(eng.score);
        else if (eng.engine === "Technical Substance Analyzer") {
          e2.push(eng.score);
          const raw = eng.signalBreakdown?.avri?.rawAvriScore;
          if (typeof raw === "number") avri.push(raw);
        } else if (eng.engine === "CWE Coherence Checker") e3.push(eng.score);
      }
    }
    const median50 = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const m =
        sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
      return Math.round(m);
    };
    engineMedians = {
      engine1: median50(e1),
      engine2: median50(e2),
      engine3: median50(e3),
      avri: median50(avri),
      quality: median50(quality),
    };
  }

  const response = GetCohortBaselineResponse.parse({
    cwe: cweFilter,
    windowDays: WINDOW_DAYS,
    totalReports,
    median,
    percentile,
    queriedScore,
    bins,
    engineMedians,
  });

  // 1h cache per the task scope ("Live re-renders as new reports come in
  // (1h cache is fine)"). A short stale-while-revalidate keeps the ribbon
  // snappy while the next caller refreshes the bins in the background.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(response);
});

export default router;
