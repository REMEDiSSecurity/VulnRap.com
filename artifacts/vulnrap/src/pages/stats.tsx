import { useState } from "react";
import { useGetStats, useGetRecentActivity, useGetSlopDistribution, getGetStatsQueryKey, getGetRecentActivityQueryKey, getGetSlopDistributionQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, BarChart3, Database, ShieldAlert, Users, RefreshCw, TrendingUp, TrendingDown, Minus, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const REFETCH_INTERVAL = 30_000;

const TIER_COLORS: Record<string, { bar: string; text: string; border: string }> = {
  "Clean": {
    bar: "bg-gradient-to-t from-green-500/60 to-green-400/80",
    text: "text-green-400",
    border: "border-green-500/30",
  },
  "Likely Human": {
    bar: "bg-gradient-to-t from-emerald-500/60 to-emerald-400/80",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
  },
  "Questionable": {
    bar: "bg-gradient-to-t from-yellow-500/60 to-yellow-400/80",
    text: "text-yellow-400",
    border: "border-yellow-500/30",
  },
  "Likely Slop": {
    bar: "bg-gradient-to-t from-orange-500/60 to-orange-400/80",
    text: "text-orange-400",
    border: "border-orange-500/30",
  },
  "Slop": {
    bar: "bg-gradient-to-t from-red-500/60 to-red-400/80",
    text: "text-red-400",
    border: "border-red-500/30",
  },
};

function getTierColor(label: string) {
  return TIER_COLORS[label] || TIER_COLORS["Questionable"];
}

function StatCard({
  title,
  value,
  loading,
  icon,
  accentClass,
  glowClass,
  valueClass,
  detail,
  detailLabel,
  secondDetail,
  secondDetailLabel,
  onClick,
}: {
  title: string;
  value: string;
  loading: boolean;
  icon: React.ReactNode;
  accentClass: string;
  glowClass: string;
  valueClass?: string;
  detail?: string;
  detailLabel?: string;
  secondDetail?: string;
  secondDetailLabel?: string;
  onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Card
      className={cn(
        "glass-card rounded-xl transition-all duration-300",
        accentClass,
        hovered && "scale-[1.03] glow-border",
        onClick && "cursor-pointer"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-muted-foreground uppercase font-bold tracking-wider">{title}</div>
          <div className={cn("p-2 rounded-lg transition-transform duration-300", glowClass, hovered && "scale-110")}>
            {icon}
          </div>
        </div>
        {loading ? <Skeleton className="h-8 w-24" /> : (
          <div className={cn("text-3xl font-mono font-bold transition-all duration-300", valueClass, hovered && "glow-text")}>{value}</div>
        )}
        <div className={cn(
          "overflow-hidden transition-all duration-300 ease-in-out",
          hovered ? "max-h-24 opacity-100 mt-3" : "max-h-0 opacity-0 mt-0"
        )}>
          {detail && (
            <div className="flex justify-between items-center text-xs text-muted-foreground pt-2 border-t border-border/30">
              <span>{detailLabel}</span>
              <span className="font-mono font-medium text-foreground">{detail}</span>
            </div>
          )}
          {secondDetail && (
            <div className="flex justify-between items-center text-xs text-muted-foreground mt-1.5">
              <span>{secondDetailLabel}</span>
              <span className="font-mono font-medium text-foreground">{secondDetail}</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function HeadlineNarrative({
  totalReports,
  reportsToday,
  reportsThisWeek,
  avgSlop,
  dupRate,
  distribution,
}: {
  totalReports: number;
  reportsToday: number;
  reportsThisWeek: number;
  avgSlop: number;
  dupRate: number;
  distribution?: { buckets: Array<{ label: string; count: number }> };
}) {
  const slopCount = distribution?.buckets
    .filter(b => b.label === "Likely Slop" || b.label === "Slop")
    .reduce((sum, b) => sum + b.count, 0) ?? 0;
  const cleanCount = distribution?.buckets
    .filter(b => b.label === "Clean" || b.label === "Likely Human")
    .reduce((sum, b) => sum + b.count, 0) ?? 0;
  const slopPct = totalReports > 0 ? Math.round((slopCount / totalReports) * 100) : 0;
  const cleanPct = totalReports > 0 ? Math.round((cleanCount / totalReports) * 100) : 0;

  if (totalReports === 0) return null;

  return (
    <div className="glass-card rounded-xl p-5 border-l-2 border-l-primary/40">
      <div className="flex items-start gap-3">
        <FileText className="w-5 h-5 text-primary mt-0.5 shrink-0" />
        <div className="text-sm text-muted-foreground leading-relaxed">
          <span className="text-foreground font-medium">{totalReports.toLocaleString()} reports</span> analyzed
          {reportsThisWeek > 0 && (
            <> &mdash; <span className="text-foreground font-medium">{reportsThisWeek}</span> this week</>
          )}
          {reportsToday > 0 && (
            <>, <span className="text-foreground font-medium">{reportsToday}</span> today</>
          )}.
          {avgSlop > 0 && (
            <> Average slop score sits at <span className={cn("font-mono font-medium", avgSlop > 55 ? "text-orange-400" : avgSlop > 35 ? "text-yellow-400" : "text-green-400")}>{Math.round(avgSlop)}</span>.</>
          )}
          {slopPct > 0 && (
            <> <span className="text-red-400 font-medium">{slopPct}%</span> flagged as likely slop or worse.</>
          )}
          {cleanPct > 0 && (
            <> <span className="text-green-400 font-medium">{cleanPct}%</span> rated clean or likely human.</>
          )}
          {dupRate > 0 && (
            <> Duplicate detection rate: <span className="text-foreground font-mono">{dupRate}%</span>.</>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Stats() {
  const { data: stats, isLoading: statsLoading, dataUpdatedAt } = useGetStats({
    query: {
      queryKey: getGetStatsQueryKey(),
      refetchInterval: REFETCH_INTERVAL,
    },
  });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({
    query: {
      queryKey: getGetRecentActivityQueryKey(),
      refetchInterval: REFETCH_INTERVAL,
    },
  });
  const { data: distribution, isLoading: distLoading } = useGetSlopDistribution({
    query: {
      queryKey: getGetSlopDistributionQueryKey(),
      refetchInterval: REFETCH_INTERVAL,
    },
  });

  const formatNumber = (num: number) => new Intl.NumberFormat().format(num);

  const dupRate = stats && stats.totalReports > 0
    ? Math.round((stats.duplicatesDetected / stats.totalReports) * 100)
    : 0;

  const getSlopTier = (score: number) => {
    if (score <= 20) return "Clean";
    if (score <= 35) return "Likely Human";
    if (score <= 55) return "Questionable";
    if (score <= 75) return "Likely Slop";
    return "Slop";
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="pb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
            <Activity className="w-8 h-8 text-primary" />
            Platform Statistics
          </h1>
          {dataUpdatedAt > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/50">
              <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: "3s" }} />
              <span>Live &mdash; refreshes every 30s</span>
            </div>
          )}
        </div>
        <p className="text-muted-foreground mt-2">Aggregate metrics across the VulnRap validation network.</p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

      {!statsLoading && stats && (
        <HeadlineNarrative
          totalReports={stats.totalReports}
          reportsToday={stats.reportsToday}
          reportsThisWeek={stats.reportsThisWeek}
          avgSlop={stats.avgSlopScore}
          dupRate={dupRate}
          distribution={distribution ?? undefined}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Reports"
          value={formatNumber(stats?.totalReports || 0)}
          loading={statsLoading}
          icon={<Database className="w-4 h-4 text-cyan-400" />}
          accentClass="stat-accent-cyan"
          glowClass="icon-glow-cyan"
          valueClass="glow-text-sm"
          detail={formatNumber(stats?.reportsByMode?.full || 0)}
          detailLabel="Full mode"
          secondDetail={formatNumber(stats?.reportsByMode?.similarity_only || 0)}
          secondDetailLabel="Similarity only"
        />

        <StatCard
          title="Duplicates"
          value={formatNumber(stats?.duplicatesDetected || 0)}
          loading={statsLoading}
          icon={<ShieldAlert className="w-4 h-4 text-red-400" />}
          accentClass="stat-accent-red"
          glowClass="icon-glow-red"
          valueClass="text-destructive"
          detail={`${dupRate}%`}
          detailLabel="Duplicate rate"
          secondDetail={formatNumber((stats?.totalReports || 0) - (stats?.duplicatesDetected || 0))}
          secondDetailLabel="Unique reports"
        />

        <StatCard
          title="Avg Slop"
          value={String(Math.round(stats?.avgSlopScore || 0))}
          loading={statsLoading}
          icon={<BarChart3 className="w-4 h-4 text-amber-400" />}
          accentClass="stat-accent-amber"
          glowClass="icon-glow-amber"
          detail={getSlopTier(stats?.avgSlopScore || 0)}
          detailLabel="Average tier"
          secondDetail={stats?.avgSlopScore ? `${stats.avgSlopScore.toFixed(1)} / 100` : "0 / 100"}
          secondDetailLabel="Precise score"
        />

        <StatCard
          title="Today"
          value={formatNumber(stats?.reportsToday || 0)}
          loading={statsLoading}
          icon={<Users className="w-4 h-4 text-violet-400" />}
          accentClass="stat-accent-violet"
          glowClass="icon-glow-violet"
          valueClass="text-violet-400"
          detail={formatNumber(stats?.reportsThisWeek || 0)}
          detailLabel="This week"
          secondDetail={stats && stats.reportsThisWeek && stats.reportsThisWeek > 0
            ? `${Math.round((stats.reportsToday / stats.reportsThisWeek) * 100)}% of week`
            : "—"}
          secondDetailLabel="Daily share"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2 glass-card-accent rounded-xl">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">Slop Score Distribution</CardTitle>
                <CardDescription>Reports by tier &mdash; color-coded by classification</CardDescription>
              </div>
              {distribution?.totalReports != null && (
                <Badge variant="outline" className="text-xs font-mono">
                  {distribution.totalReports} total
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {distLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : distribution?.buckets ? (
              <div className="space-y-4">
                <div className="flex items-end gap-2 px-2" style={{ height: "224px" }}>
                  {distribution.buckets.map((bucket, i) => {
                    const maxCount = Math.max(...distribution.buckets.map(b => b.count));
                    const heightPct = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;
                    const pct = distribution.totalReports > 0
                      ? Math.round((bucket.count / distribution.totalReports) * 100)
                      : 0;
                    const tierColor = getTierColor(bucket.label);

                    return (
                      <button key={i} type="button" className="flex-1 flex flex-col items-center group relative h-full cursor-default focus:outline-none" aria-label={`${bucket.count} reports, ${pct}% of total, ${bucket.label}`}>
                        <div className="w-full flex-1 relative">
                          <div
                            className={cn(
                              "absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-700 ease-out",
                              tierColor.bar,
                            )}
                            style={{
                              height: `${Math.max(heightPct, 3)}%`,
                              opacity: 0.5 + (heightPct / 200),
                              animationDelay: `${i * 100}ms`,
                            }}
                          />
                          {bucket.count > 0 && (
                            <div
                              className={cn("absolute left-1/2 -translate-x-1/2 font-mono text-[10px] font-bold transition-opacity", tierColor.text)}
                              style={{ bottom: `${Math.max(heightPct, 3) + 2}%` }}
                            >
                              {bucket.count}
                            </div>
                          )}
                        </div>

                        <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity glass-card text-popover-foreground text-xs px-3 py-2 rounded-lg pointer-events-none z-10 glow-border space-y-0.5">
                          <div className={cn("font-mono font-bold", tierColor.text)}>{bucket.count} reports</div>
                          <div className="text-muted-foreground">{pct}% of total</div>
                          <div className="text-muted-foreground/60 text-[10px]">{bucket.label} ({bucket.min}&ndash;{bucket.max})</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex gap-2 px-2">
                  {distribution.buckets.map((bucket, i) => {
                    const tierColor = getTierColor(bucket.label);
                    return (
                      <div key={i} className="flex-1 text-center">
                        <div className={cn("text-[10px] font-bold truncate", tierColor.text)}>{bucket.label}</div>
                        <div className="text-[9px] text-muted-foreground/50 font-mono">{bucket.min}&ndash;{bucket.max}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-3 pt-2 border-t border-border/20 px-2">
                  {distribution.buckets.map((bucket, i) => {
                    const pct = distribution.totalReports > 0
                      ? Math.round((bucket.count / distribution.totalReports) * 100)
                      : 0;
                    const tierColor = getTierColor(bucket.label);
                    return (
                      <div key={i} className="flex-1">
                        <div className={cn("h-1.5 rounded-full", tierColor.bar)} style={{ width: `${Math.max(pct, 2)}%`, opacity: 0.7 }} />
                        <div className="text-[9px] text-muted-foreground/40 mt-1 font-mono">{pct}%</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="h-64 flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl flex flex-col">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">Recent Scans</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {activityLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : activity?.recentReports && activity.recentReports.length > 0 ? (
              <div className="space-y-3">
                {activity.recentReports.map((report) => {
                  const tierColor = getTierColor(report.slopTier);
                  return (
                    <Link key={report.id} to={`/results/${report.id}`} className="block">
                      <div className={cn("p-3 glass-card rounded-lg hover:border-primary/20 transition-all group border-l-2", tierColor.border)}>
                        <div className="flex justify-between items-start mb-2">
                          <div className="font-mono text-sm text-primary glow-text-sm group-hover:glow-text transition-all">#{report.id}</div>
                          <div className="text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleTimeString()}</div>
                        </div>
                        <div className="flex justify-between items-center">
                          <Badge variant="outline" className={cn("text-[10px]", tierColor.text, tierColor.border)}>
                            {report.slopTier}
                          </Badge>
                          <div className="flex items-center gap-2">
                            <span className={cn("text-xs font-mono font-bold", tierColor.text)}>{report.slopScore}</span>
                            <span className="text-xs font-mono text-muted-foreground/50">
                              {report.matchCount > 0 ? `${report.matchCount} match${report.matchCount > 1 ? "es" : ""}` : ""}
                            </span>
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground text-sm">No recent activity</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
