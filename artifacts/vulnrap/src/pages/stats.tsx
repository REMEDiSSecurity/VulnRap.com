import { useState } from "react";
import { useGetStats, useGetRecentActivity, useGetSlopDistribution, getGetStatsQueryKey, getGetRecentActivityQueryKey, getGetSlopDistributionQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, BarChart3, Database, ShieldAlert, Users, TrendingUp, FileText, Lock, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const REFETCH_INTERVAL = 30_000;

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
              <span>Live — refreshes every 30s</span>
            </div>
          )}
        </div>
        <p className="text-muted-foreground mt-2">Aggregate metrics across the VulnRap validation network.</p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

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
                <CardDescription>Histogram of AI-generation probability</CardDescription>
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
              <div className="mt-4 pt-4 border-b border-border/30 px-2">
                <div className="flex items-end gap-2" style={{ height: "224px" }}>
                  {distribution.buckets.map((bucket, i) => {
                    const maxCount = Math.max(...distribution.buckets.map(b => b.count));
                    const heightPct = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;
                    const pct = distribution.totalReports > 0
                      ? Math.round((bucket.count / distribution.totalReports) * 100)
                      : 0;

                    return (
                      <button key={i} type="button" className="flex-1 flex flex-col items-center group relative h-full cursor-default focus:outline-none" aria-label={`${bucket.count} reports, ${pct}% of total, ${bucket.min}–${bucket.max} score range`}>
                        <div className="w-full flex-1 relative">
                          <div
                            className="absolute bottom-0 left-0 right-0 bar-gradient rounded-t-sm transition-all duration-500"
                            style={{
                              height: `${Math.max(heightPct, 3)}%`,
                              opacity: 0.5 + (heightPct / 200),
                            }}
                          />
                        </div>

                        <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity glass-card text-popover-foreground text-xs px-3 py-2 rounded-lg pointer-events-none z-10 glow-border space-y-0.5">
                          <div className="font-mono font-bold text-primary">{bucket.count} reports</div>
                          <div className="text-muted-foreground">{pct}% of total</div>
                          <div className="text-muted-foreground/60 text-[10px]">{bucket.min}–{bucket.max} score range</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-2 mt-2">
                  {distribution.buckets.map((bucket, i) => (
                    <div key={i} className="flex-1 text-[10px] text-muted-foreground font-mono text-center whitespace-nowrap truncate">
                      {bucket.label}
                    </div>
                  ))}
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
                {activity.recentReports.map((report) => (
                  <Link key={report.id} to={`/results/${report.id}`} className="block">
                    <div className="p-3 glass-card rounded-lg hover:border-primary/20 transition-all group">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-mono text-sm text-primary glow-text-sm group-hover:glow-text transition-all">#{report.id}</div>
                        <div className="text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleTimeString()}</div>
                      </div>
                      <div className="flex justify-between items-center">
                        <Badge variant="outline" className={
                          report.slopScore > 70 ? "border-destructive text-destructive" :
                          report.slopScore > 30 ? "border-yellow-500 text-yellow-500" :
                          "border-green-500 text-green-500"
                        }>
                          {report.slopTier}
                        </Badge>
                        <span className="text-xs font-mono">
                          {report.matchCount > 0 ? `${report.matchCount} matches` : 'Clean'}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
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
