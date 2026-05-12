import { Link } from "react-router-dom";
import { Clock, Search, ExternalLink } from "lucide-react";
import {
  useGetReportFeed,
  getGetReportFeedQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { getSlopColor, getSlopProgressColor, timeAgo } from "./utils";

export function RecentReportsFeed() {
  const { data, isLoading } = useGetReportFeed(
    { limit: 6 },
    {
      query: {
        queryKey: getGetReportFeedQueryKey({ limit: 6 }),
        staleTime: 15_000,
        refetchOnMount: "always",
        refetchOnWindowFocus: true,
      },
    },
  );
  const reports = data?.reports;
  const total = data?.total ?? 0;

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 07 · Live Activity</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        {/* Structured skeleton mirroring the actual report row layout
            (mono code chunk, badge, score progress, time-ago) so the loading
            state previews real content shape rather than flat bars. */}
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 p-3 rounded-lg glass-card animate-pulse"
              aria-hidden="true"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="h-3.5 w-20 sm:w-24 rounded bg-primary/15" />
                <div className="h-3 w-12 rounded bg-muted/30 hidden md:block" />
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="h-1.5 w-16 rounded-full bg-muted/30 hidden sm:block" />
                <div className="h-3 w-6 rounded bg-muted/40" />
                <div className="h-3 w-10 rounded bg-muted/25" />
              </div>
            </div>
          ))}
        </div>
        <span className="sr-only">Loading recent reports…</span>
      </div>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 07 · Live Activity</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        <p className="text-sm text-muted-foreground text-center py-6">
          No public reports yet. Be the first to share one with the community.
        </p>
      </div>
    );
  }

  return (
    <div
      className="glass-card rounded-xl p-4 sm:p-6 space-y-3 sm:space-y-4"
      data-scroll-fade
    >
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <span className="eyebrow-label">Section 07 · Live Activity</span>
          <h2 className="text-base sm:text-lg font-bold flex items-center gap-2">
            <Clock className="w-4 sm:w-5 h-4 sm:h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        <span className="text-[10px] sm:text-xs text-muted-foreground whitespace-nowrap mt-1">
          {total} public report{total !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="space-y-2">
        {reports.map((report) => (
          <Link
            key={report.id}
            to={`/verify/${report.id}`}
            className="flex items-center justify-between gap-2 p-2.5 sm:p-3 rounded-lg glass-card hover:border-primary/20 transition-all group"
          >
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <span className="font-mono text-xs sm:text-sm text-primary font-medium glow-text-sm truncate">
                {report.reportCode}
              </span>
              <Badge
                variant="secondary"
                className="text-[10px] hidden md:inline-flex"
              >
                {report.contentMode === "full" ? "Shared" : "Private"}
              </Badge>
              {report.agentFingerprintLabel && (
                <Badge
                  variant="outline"
                  className="text-[10px] hidden lg:inline-flex font-mono text-purple-400 border-purple-500/40 bg-purple-500/5"
                  title="Heuristic fingerprint — not attribution. Based on stylistic patterns in the report prose."
                >
                  Likely: {report.agentFingerprintLabel}
                  {report.agentFingerprintConfidence != null && (
                    <span className="ml-1 text-purple-300/70">
                      · {Math.round(report.agentFingerprintConfidence * 100)}%
                    </span>
                  )}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Progress
                  value={report.slopScore}
                  className="w-12 sm:w-16 h-1.5 hidden sm:block"
                  indicatorClassName={getSlopProgressColor(report.slopScore)}
                />
                <span
                  className={cn(
                    "font-mono text-xs font-medium w-6 text-right",
                    getSlopColor(report.slopScore),
                  )}
                >
                  {report.slopScore}
                </span>
              </div>
              {report.matchCount > 0 && (
                <Badge
                  variant="outline"
                  className="text-[10px] gap-1 hidden sm:inline-flex"
                >
                  <Search className="w-2.5 h-2.5" />
                  {report.matchCount}
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground w-10 sm:w-14 text-right">
                {timeAgo(report.createdAt)}
              </span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover:text-primary transition-colors hidden sm:block" />
            </div>
          </Link>
        ))}
      </div>
      <Link
        to="/reports"
        className="flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors group"
      >
        <span>View all{total > reports.length ? ` ${total}` : ""} reports</span>
        <ExternalLink className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

export default RecentReportsFeed;
