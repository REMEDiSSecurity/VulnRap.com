// Task #615 — Cohort baseline ribbon.
//
// A horizontal ribbon that sits between the composite score header and the
// engine breakdown on /results/:id. It contextualises an otherwise-bare
// score number ("62") by showing where the score sits in the last 7 days of
// platform activity:
//
//   - a 10-bucket sparkline of the last-7d composite-score histogram (pure CSS,
//     no chart lib so the bundle stays small and the ribbon stays tiny);
//   - a marker bar overlayed on the bucket the report falls in;
//   - a percentile label ("Higher than 78% of reports scored this week");
//   - an apples-to-apples second line with the median for this report's CWE
//     family when the report carries one (`avriFamily`).
//
// The ribbon degrades gracefully:
//   - while loading it renders a subtle skeleton band so the page doesn't
//     reflow when the data arrives;
//   - when the cohort has zero reports it shows a "no baseline yet" hint
//     instead of a misleading 0%;
//   - when the fetch errors it renders nothing (the rest of the results
//     page is unaffected).

import { useMemo } from "react";
import {
  useGetCohortBaseline,
  getGetCohortBaselineQueryKey,
  type CohortBaseline,
} from "@workspace/api-client-react";
import { BarChart3 } from "lucide-react";

export interface CohortBaselineRibbonProps {
  score: number;
  cwe?: string | null;
  // Task #933 — which per-report axis the marker score is from. Defaults to
  // "composite" so existing call sites keep their behaviour unchanged. When
  // "slop" is passed, the ribbon fetches the slop-score cohort baseline so
  // the legacy AI Detection Score card on /results/:id can show the same
  // "62 out of 100, where does that sit?" context the composite ribbon
  // does. The CWE family overlay and engine-medians block are
  // composite-only and are hidden in slop mode.
  metric?: "composite" | "slop";
  // Compact mode trims the ribbon down for use as a sub-card indicator
  // (smaller header label, no per-CWE family line) so it can sit inside an
  // existing card without dominating it.
  compact?: boolean;
}

// Pure helper exported for the unit test: mid-rank percentile of `score`
// against the cohort `bins`. Mirrors the server-side helper in
// `routes/cohort.ts` so the UI can render a percentile label without a
// second round-trip and so the test suite can pin the math.
export function percentileFromBins(
  score: number,
  bins: CohortBaseline["bins"],
): number {
  const total = bins.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return 0;
  let idx = 0;
  if (score >= 100) idx = bins.length - 1;
  else if (score <= 0) idx = 0;
  else idx = Math.min(bins.length - 1, Math.floor((score / 100) * bins.length));
  let below = 0;
  for (let i = 0; i < idx; i++) below += bins[i].count;
  const same = bins[idx]?.count ?? 0;
  const rank = (below + same / 2) / total;
  return Math.max(0, Math.min(100, Math.round(rank * 100)));
}

function sparklineHeights(bins: CohortBaseline["bins"]): number[] {
  const max = bins.reduce((acc, b) => Math.max(acc, b.count), 0);
  if (max === 0) return bins.map(() => 0);
  // Boost the floor so a 1-count bucket is still visible against a 50-count
  // peak — a pure linear scale makes the smallest non-zero buckets vanish.
  return bins.map((b) =>
    b.count === 0 ? 0 : Math.max(8, Math.round((b.count / max) * 100)),
  );
}

function markerLeftPercent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

export function CohortBaselineRibbon({
  score,
  cwe,
  metric = "composite",
  compact = false,
}: CohortBaselineRibbonProps) {
  const platformParams =
    metric === "slop" ? { metric: "slop" as const } : undefined;
  const platformQuery = useGetCohortBaseline(platformParams, {
    query: {
      queryKey: getGetCohortBaselineQueryKey(platformParams),
      // 1h server cache + 5min client gc keeps this from being a per-render
      // flicker while still letting a session-long visitor pick up the
      // hourly refresh.
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
  });
  // The per-CWE family overlay is composite-only — the legacy slop score
  // doesn't have a meaningful per-family interpretation, so we skip the
  // second fetch entirely in slop mode.
  const familyParams =
    cwe && metric === "composite" ? { cwe } : undefined;
  const familyQuery = useGetCohortBaseline(familyParams, {
    query: {
      queryKey: getGetCohortBaselineQueryKey(familyParams),
      enabled: Boolean(familyParams),
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
  });

  const platform = platformQuery.data;
  const family = familyQuery.data;

  const heights = useMemo(
    () => (platform ? sparklineHeights(platform.bins) : []),
    [platform],
  );
  const percentile = useMemo(
    () => (platform ? percentileFromBins(score, platform.bins) : 0),
    [platform, score],
  );

  if (platformQuery.isLoading) {
    return (
      <div
        data-testid="cohort-baseline-ribbon-loading"
        className="rounded-xl border border-border/30 bg-muted/10 px-4 py-3 animate-pulse"
      >
        <div className="h-3 w-48 bg-muted/30 rounded mb-2" />
        <div className="h-6 w-full bg-muted/20 rounded" />
      </div>
    );
  }

  // Errors and absent platform data render nothing — the rest of the
  // results page is intentionally unaffected by an unhealthy cohort fetch.
  if (!platform || platformQuery.isError) return null;

  const platformEmpty = platform.totalReports === 0;
  const metricLabel = metric === "slop" ? "AI Detection" : "Cohort";
  const headerLabel =
    metric === "slop" ? "AI-likelihood baseline" : "Cohort baseline";
  const percentileLabel = platformEmpty
    ? `No ${metricLabel.toLowerCase()} baseline yet — be the first scored this week.`
    : metric === "slop"
      ? `Higher than ${percentile}% of AI-likelihood scores this week`
      : `Higher than ${percentile}% of reports scored this week`;
  const medianLine =
    !platformEmpty && platform.median != null
      ? `7d median ${platform.median}`
      : null;

  return (
    <div
      data-testid={
        metric === "slop"
          ? "cohort-baseline-ribbon-slop"
          : "cohort-baseline-ribbon"
      }
      className={
        compact
          ? "rounded-lg border border-cyan-500/15 bg-muted/5 px-3 py-2"
          : "rounded-xl border border-cyan-500/15 bg-muted/5 px-4 py-3"
      }
    >
      <div
        className={
          compact ? "flex items-center gap-2 mb-1.5" : "flex items-center gap-2 mb-2"
        }
      >
        <BarChart3 className="w-3.5 h-3.5 text-primary" />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {headerLabel}
        </span>
        <span
          className="text-[10px] text-muted-foreground/70 font-mono"
          data-testid={
            metric === "slop"
              ? "cohort-baseline-ribbon-slop-window"
              : "cohort-baseline-ribbon-window"
          }
        >
          last {platform.windowDays}d · n={platform.totalReports}
          {medianLine ? ` · ${medianLine}` : ""}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div
          className={`relative flex-1 ${compact ? "h-6" : "h-8"} flex items-end gap-[2px]`}
          data-testid={
            metric === "slop"
              ? "cohort-baseline-ribbon-slop-sparkline"
              : "cohort-baseline-ribbon-sparkline"
          }
          aria-label={`${metricLabel} score distribution sparkline (last 7 days)`}
        >
          {platform.bins.map((bin, i) => (
            <div
              key={`${bin.min}-${bin.max}`}
              className="flex-1 bg-cyan-400/40 rounded-sm"
              style={{
                height: `${heights[i] ?? 0}%`,
                minHeight: heights[i] ? 1 : 0,
              }}
              data-testid={`cohort-baseline-ribbon-bar-${i}`}
              data-count={bin.count}
              title={`${bin.min}-${bin.max}: ${bin.count} report${bin.count === 1 ? "" : "s"}`}
            />
          ))}
          {!platformEmpty && (
            <div
              data-testid="cohort-baseline-ribbon-marker"
              className="absolute top-0 bottom-0 w-0.5 bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]"
              style={{ left: `${markerLeftPercent(score)}%` }}
              aria-label={`This report's score: ${score}`}
            />
          )}
        </div>
        <div
          className="text-right min-w-[120px]"
          data-testid="cohort-baseline-ribbon-percentile-label"
        >
          <div className="text-[11px] text-muted-foreground leading-tight">
            {percentileLabel}
          </div>
        </div>
      </div>

      {metric === "composite" && !compact && cwe && family && (
        <div
          className="mt-2 pt-2 border-t border-border/20 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap"
          data-testid="cohort-baseline-ribbon-family"
        >
          <span className="uppercase tracking-wide text-muted-foreground/70">
            CWE family
          </span>
          <span className="font-mono text-cyan-400">{cwe}</span>
          <span className="text-muted-foreground/60">·</span>
          {family.totalReports === 0 || family.median == null ? (
            <span>
              no {cwe} reports in the last {family.windowDays}d
            </span>
          ) : (
            <span>
              median{" "}
              <span className="font-mono text-foreground">{family.median}</span>
              <span className="text-muted-foreground/60">
                {" "}
                · n={family.totalReports}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default CohortBaselineRibbon;
