import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetReportFeed, getGetReportFeedQueryKey } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";
import { Activity, ArrowUpDown, ChevronDown, Database, ExternalLink, Filter, Search, TrendingUp } from "lucide-react";

const PAGE_SIZE = 20;

function getSlopColor(score: number) {
  const s = getSettings();
  return getSlopColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function getSlopProgressColor(score: number) {
  const s = getSettings();
  return getSlopProgressColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "score_desc", label: "Highest score" },
  { value: "score_asc", label: "Lowest score" },
] as const;

const TIER_ORDER = [
  "Clean",
  "Likely Human",
  "Questionable",
  "Likely Slop",
  "Slop",
];

function getTierBadgeColor(tier: string) {
  switch (tier) {
    case "Clean":
    case "Likely Human":
      return "border-green-500/50 text-green-400 bg-green-500/10";
    case "Questionable":
      return "border-amber-500/50 text-amber-400 bg-amber-500/10";
    case "Likely Slop":
      return "border-orange-500/50 text-orange-400 bg-orange-500/10";
    case "Slop":
      return "border-red-500/50 text-red-400 bg-red-500/10";
    default:
      return "border-muted-foreground/50 text-muted-foreground";
  }
}

function getTierBarColor(tier: string) {
  switch (tier) {
    case "Clean":
    case "Likely Human":
      return "bg-green-500";
    case "Questionable":
      return "bg-amber-500";
    case "Likely Slop":
      return "bg-orange-500";
    case "Slop":
      return "bg-red-500";
    default:
      return "bg-muted-foreground";
  }
}

export default function Reports() {
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<string>("newest");
  const [tierFilter, setTierFilter] = useState<string>("All");
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showTierMenu, setShowTierMenu] = useState(false);

  const feedParams = {
    limit: PAGE_SIZE,
    offset,
    sort: sort as "newest" | "oldest" | "score_asc" | "score_desc",
    ...(tierFilter !== "All" ? { tier: tierFilter } : {}),
  };

  const { data: feedData, isLoading: feedLoading, isError: feedError } = useGetReportFeed(feedParams, {
    query: {
      queryKey: getGetReportFeedQueryKey(feedParams),
      staleTime: 30_000,
    },
  });

  const reports = feedData?.reports ?? [];
  const total = feedData?.total ?? 0;
  const hasMore = feedData?.hasMore ?? false;
  const summary = feedData?.summary;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const tierCounts = summary?.tierCounts ?? {};
  const tierEntries = Object.entries(tierCounts).sort((a, b) => b[1] - a[1]);
  const availableTiers = ["All", ...TIER_ORDER.filter((t) => t in tierCounts)];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="pb-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
            <Database className="w-7 h-7 text-primary" />
            Reports Explorer
          </h1>
        </div>
        <p className="text-muted-foreground mt-2 text-sm">Browse all public vulnerability report validations.</p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-card rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <Database className="w-4 h-4 text-cyan-400" />
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">Public Reports</span>
          </div>
          {feedLoading ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="text-2xl font-mono font-bold glow-text-sm">{summary?.totalPublic ?? 0}</div>
          )}
        </div>

        <div className="glass-card rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">Avg Slop Score</span>
          </div>
          {feedLoading ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="text-2xl font-mono font-bold text-amber-400">{Math.round(summary?.avgScore ?? 0)}</div>
          )}
        </div>

        <div className="glass-card rounded-xl p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-4 h-4 text-violet-400" />
            <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">Tier Breakdown</span>
          </div>
          {feedLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : tierEntries.length > 0 ? (
            <div className="flex items-end gap-1 h-8">
              {tierEntries.map(([tier, count]) => {
                const maxCount = Math.max(...tierEntries.map(([, c]) => c), 1);
                const pct = (count / maxCount) * 100;
                return (
                  <div
                    key={tier}
                    className={cn("flex-1 rounded-t-sm transition-all opacity-70", getTierBarColor(tier))}
                    style={{ height: `${Math.max(pct, 8)}%` }}
                    title={`${tier}: ${count}`}
                  />
                );
              })}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No data</div>
          )}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowTierMenu(!showTierMenu); setShowSortMenu(false); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-card text-sm font-medium hover:border-primary/30 transition-all"
            >
              <Filter className="w-3.5 h-3.5 text-muted-foreground" />
              <span>{tierFilter === "All" ? "All tiers" : tierFilter}</span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
            {showTierMenu && (
              <div className="absolute top-full mt-1 left-0 z-50 glass-card rounded-lg border border-border/50 shadow-xl py-1 min-w-[160px]">
                {availableTiers.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => { setTierFilter(tier); setOffset(0); setShowTierMenu(false); }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm hover:bg-primary/10 transition-colors",
                      tierFilter === tier && "text-primary font-medium"
                    )}
                  >
                    {tier === "All" ? "All tiers" : `${tier} (${tierCounts[tier] ?? 0})`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => { setShowSortMenu(!showSortMenu); setShowTierMenu(false); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass-card text-sm font-medium hover:border-primary/30 transition-all"
            >
              <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
              <span>{SORT_OPTIONS.find((s) => s.value === sort)?.label}</span>
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            </button>
            {showSortMenu && (
              <div className="absolute top-full mt-1 left-0 z-50 glass-card rounded-lg border border-border/50 shadow-xl py-1 min-w-[160px]">
                {SORT_OPTIONS.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => { setSort(s.value); setOffset(0); setShowSortMenu(false); }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm hover:bg-primary/10 transition-colors",
                      sort === s.value && "text-primary font-medium"
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <span className="text-xs text-muted-foreground">
          {total > 0 ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : "No reports found"}
        </span>
      </div>

      <div className="space-y-2">
        {feedLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/10 animate-pulse" />
          ))
        ) : feedError ? (
          <div className="glass-card rounded-xl p-8 text-center">
            <p className="text-destructive font-medium">Failed to load reports. Please try again later.</p>
          </div>
        ) : reports.length === 0 ? (
          <div className="glass-card rounded-xl p-8 text-center">
            <p className="text-muted-foreground">No reports match the current filters.</p>
          </div>
        ) : (
          reports.map((report) => (
            <Link
              key={report.id}
              to={`/verify/${report.id}`}
              className="flex items-center justify-between gap-3 p-3 sm:p-4 rounded-lg glass-card hover:border-primary/20 transition-all group"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-sm text-primary font-medium glow-text-sm">{report.reportCode}</span>
                <Badge variant="outline" className={cn("text-[10px] hidden sm:inline-flex", getTierBadgeColor(report.slopTier))}>
                  {report.slopTier}
                </Badge>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <Progress value={report.slopScore} className="w-16 h-1.5 hidden sm:block" indicatorClassName={getSlopProgressColor(report.slopScore)} />
                  <span className={cn("font-mono text-sm font-medium w-7 text-right", getSlopColor(report.slopScore))}>{report.slopScore}</span>
                </div>
                {report.matchCount > 0 && (
                  <Badge variant="outline" className="text-[10px] gap-1 hidden md:inline-flex">
                    <Search className="w-2.5 h-2.5" />{report.matchCount}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground w-16 text-right hidden sm:block">{timeAgo(report.createdAt)}</span>
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover:text-primary transition-colors" />
              </div>
            </Link>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="glass-card"
          >
            Previous
          </Button>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(totalPages, 7) }).map((_, i) => {
              let page: number;
              if (totalPages <= 7) {
                page = i + 1;
              } else if (currentPage <= 4) {
                page = i + 1;
              } else if (currentPage >= totalPages - 3) {
                page = totalPages - 6 + i;
              } else {
                page = currentPage - 3 + i;
              }
              return (
                <button
                  key={page}
                  type="button"
                  onClick={() => setOffset((page - 1) * PAGE_SIZE)}
                  className={cn(
                    "w-8 h-8 rounded-md text-xs font-mono font-medium transition-all",
                    currentPage === page
                      ? "bg-primary text-primary-foreground glow-text-sm"
                      : "glass-card hover:border-primary/30 text-muted-foreground hover:text-primary"
                  )}
                >
                  {page}
                </button>
              );
            })}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="glass-card"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
