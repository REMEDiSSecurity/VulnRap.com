import { useGetStats, useGetRecentActivity, useGetSlopDistribution, getGetStatsQueryKey, getGetRecentActivityQueryKey, getGetSlopDistributionQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, BarChart3, Database, ShieldAlert, Users } from "lucide-react";
import { Link } from "react-router-dom";

export default function Stats() {
  const { data: stats, isLoading: statsLoading } = useGetStats({ query: { queryKey: getGetStatsQueryKey() } });
  const { data: activity, isLoading: activityLoading } = useGetRecentActivity({ query: { queryKey: getGetRecentActivityQueryKey() } });
  const { data: distribution, isLoading: distLoading } = useGetSlopDistribution({ query: { queryKey: getGetSlopDistributionQueryKey() } });

  const formatNumber = (num: number) => new Intl.NumberFormat().format(num);

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
          <Activity className="w-8 h-8 text-primary" />
          Platform Statistics
        </h1>
        <p className="text-muted-foreground mt-2">Aggregate metrics across the VulnRap validation network.</p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass-card rounded-xl stat-accent-cyan">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm text-muted-foreground uppercase font-bold tracking-wider">Total Reports</div>
              <div className="p-2 rounded-lg icon-glow-cyan">
                <Database className="w-4 h-4 text-cyan-400" />
              </div>
            </div>
            {statsLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-3xl font-mono font-bold glow-text-sm">{formatNumber(stats?.totalReports || 0)}</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl stat-accent-red">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm text-muted-foreground uppercase font-bold tracking-wider">Duplicates</div>
              <div className="p-2 rounded-lg icon-glow-red">
                <ShieldAlert className="w-4 h-4 text-red-400" />
              </div>
            </div>
            {statsLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-3xl font-mono font-bold text-destructive">{formatNumber(stats?.duplicatesDetected || 0)}</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl stat-accent-amber">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm text-muted-foreground uppercase font-bold tracking-wider">Avg Slop</div>
              <div className="p-2 rounded-lg icon-glow-amber">
                <BarChart3 className="w-4 h-4 text-amber-400" />
              </div>
            </div>
            {statsLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-3xl font-mono font-bold">{Math.round(stats?.avgSlopScore || 0)}</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl stat-accent-violet">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm text-muted-foreground uppercase font-bold tracking-wider">Today</div>
              <div className="p-2 rounded-lg icon-glow-violet">
                <Users className="w-4 h-4 text-violet-400" />
              </div>
            </div>
            {statsLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-3xl font-mono font-bold text-violet-400">{formatNumber(stats?.reportsToday || 0)}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2 glass-card-accent rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">Slop Score Distribution</CardTitle>
            <CardDescription>Histogram of AI-generation probability</CardDescription>
          </CardHeader>
          <CardContent>
            {distLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : distribution?.buckets ? (
              <div className="flex items-end gap-2 h-64 mt-4 pt-4 border-b border-border/30 px-2">
                {distribution.buckets.map((bucket, i) => {
                  const maxCount = Math.max(...distribution.buckets.map(b => b.count));
                  const heightPct = maxCount > 0 ? (bucket.count / maxCount) * 100 : 0;
                  
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-2 group relative">
                      <div className="w-full flex justify-center items-end h-full">
                        <div 
                          className="w-full bar-gradient rounded-t-sm"
                          style={{ 
                            height: `${Math.max(heightPct, 2)}%`,
                            opacity: 0.5 + (heightPct / 200),
                          }}
                        />
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono -rotate-45 md:rotate-0 origin-top-left md:origin-center mt-2 w-full text-center whitespace-nowrap">
                        {bucket.label}
                      </div>
                      
                      <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity glass-card text-popover-foreground text-xs px-3 py-1.5 rounded-lg pointer-events-none z-10 font-mono glow-border">
                        {bucket.count} reports
                      </div>
                    </div>
                  );
                })}
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
                    <div className="p-3 glass-card rounded-lg hover:border-primary/20 transition-all">
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-mono text-sm text-primary glow-text-sm">#{report.id}</div>
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
