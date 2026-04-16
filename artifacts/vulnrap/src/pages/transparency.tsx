import { useGetTrends, useGetStats, useGetVisitorStats, getGetTrendsQueryKey, getGetStatsQueryKey, getGetVisitorStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, BarChart3, Users, FileText, ThumbsUp, Activity, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const TIER_COLORS = {
  clean: "#22c55e",
  likelyHuman: "#34d399",
  questionable: "#eab308",
  likelySlop: "#f97316",
  slop: "#ef4444",
};

function HeroStat({ label, value, icon, color, loading }: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  loading: boolean;
}) {
  return (
    <Card className="glass-card rounded-xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">{label}</span>
          <div className={cn("p-2 rounded-lg", color)}>{icon}</div>
        </div>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-3xl font-mono font-bold glow-text-sm">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card rounded-lg px-3 py-2 border border-border/30 text-xs space-y-1">
      <div className="font-mono text-muted-foreground">{label}</div>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-mono font-bold text-foreground">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Transparency() {
  const { data: trends, isLoading: trendsLoading } = useGetTrends(
    { days: 90 },
    { query: { queryKey: getGetTrendsQueryKey({ days: 90 }), refetchInterval: 120_000 } },
  );

  const { data: stats, isLoading: statsLoading } = useGetStats({
    query: { queryKey: getGetStatsQueryKey(), refetchInterval: 60_000 },
  });

  const { data: visitors, isLoading: visitorsLoading } = useGetVisitorStats({
    query: { queryKey: getGetVisitorStatsQueryKey(), refetchInterval: 60_000 },
  });

  const loading = trendsLoading || statsLoading;

  const dailyData = (trends?.dailyReports ?? []).map((d) => ({
    date: formatDate(d.date),
    reports: d.count,
    avgScore: d.avgScore,
    ...d.tiers,
  }));

  const feedbackData = (trends?.feedbackTrend ?? []).map((d) => ({
    date: formatDate(d.date),
    agreementRate: d.agreementRate,
    avgRating: d.avgRating,
    count: d.count,
  }));

  const detectionRate = stats && stats.totalReports > 0
    ? Math.round((stats.duplicatesDetected / stats.totalReports) * 100)
    : 0;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="pb-4">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
          <Eye className="w-8 h-8 text-primary" />
          Transparency Dashboard
        </h1>
        <p className="text-muted-foreground mt-2">
          VulnRap's journey in data — reports analyzed, detection rates, and scoring trends over time.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <HeroStat
          label="Reports Analyzed"
          value={stats?.totalReports?.toLocaleString() ?? "0"}
          icon={<FileText className="w-4 h-4 text-cyan-400" />}
          color="icon-glow-cyan"
          loading={statsLoading}
        />
        <HeroStat
          label="Feedback Entries"
          value={trends?.totalFeedback?.toLocaleString() ?? "0"}
          icon={<ThumbsUp className="w-4 h-4 text-green-400" />}
          color="icon-glow-green"
          loading={trendsLoading}
        />
        <HeroStat
          label="Avg Slop Score"
          value={Math.round(stats?.avgSlopScore ?? 0)}
          icon={<BarChart3 className="w-4 h-4 text-amber-400" />}
          color="icon-glow-amber"
          loading={statsLoading}
        />
        <HeroStat
          label="Detection Rate"
          value={`${detectionRate}%`}
          icon={<Activity className="w-4 h-4 text-violet-400" />}
          color="icon-glow-violet"
          loading={statsLoading}
        />
        <HeroStat
          label="This Week"
          value={stats?.reportsThisWeek?.toLocaleString() ?? "0"}
          icon={<TrendingUp className="w-4 h-4 text-blue-400" />}
          color="icon-glow-cyan"
          loading={statsLoading}
        />
        <HeroStat
          label="Unique Visitors"
          value={visitors?.totalUniqueVisitors?.toLocaleString() ?? "0"}
          icon={<Users className="w-4 h-4 text-purple-400" />}
          color="icon-glow-violet"
          loading={visitorsLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Reports Analyzed Per Day</CardTitle>
            <CardDescription>Daily volume over the last {trends?.days ?? 90} days</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-64 w-full" /> : dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={dailyData} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <defs>
                    <linearGradient id="reportsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#06b6d4" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Area type="monotone" dataKey="reports" stroke="#06b6d4" fill="url(#reportsFill)" strokeWidth={2} name="Reports" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">No report data yet</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Slop Tier Distribution Over Time</CardTitle>
            <CardDescription>How the mix of tiers evolves day by day</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-64 w-full" /> : dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={dailyData} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Area type="monotone" dataKey="clean" stackId="1" stroke={TIER_COLORS.clean} fill={TIER_COLORS.clean} fillOpacity={0.4} name="Clean" />
                  <Area type="monotone" dataKey="likelyHuman" stackId="1" stroke={TIER_COLORS.likelyHuman} fill={TIER_COLORS.likelyHuman} fillOpacity={0.4} name="Likely Human" />
                  <Area type="monotone" dataKey="questionable" stackId="1" stroke={TIER_COLORS.questionable} fill={TIER_COLORS.questionable} fillOpacity={0.4} name="Questionable" />
                  <Area type="monotone" dataKey="likelySlop" stackId="1" stroke={TIER_COLORS.likelySlop} fill={TIER_COLORS.likelySlop} fillOpacity={0.4} name="Likely Slop" />
                  <Area type="monotone" dataKey="slop" stackId="1" stroke={TIER_COLORS.slop} fill={TIER_COLORS.slop} fillOpacity={0.4} name="Slop" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">No report data yet</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Average Slop Score Trend</CardTitle>
            <CardDescription>Calibration drift or improvement over time</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-64 w-full" /> : dailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={dailyData} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <defs>
                    <linearGradient id="scoreLine" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#a78bfa" />
                      <stop offset="100%" stopColor="#06b6d4" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="avgScore" stroke="url(#scoreLine)" strokeWidth={2} dot={false} name="Avg Score" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">No score data yet</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Feedback Accuracy Trend</CardTitle>
                <CardDescription>Human agreement rate over time</CardDescription>
              </div>
              {feedbackData.length > 0 && (
                <Badge variant="outline" className="text-xs font-mono">
                  {trends?.totalFeedback ?? 0} total
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-64 w-full" /> : feedbackData.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={feedbackData} margin={{ top: 5, right: 5, bottom: 5, left: -10 }}>
                  <defs>
                    <linearGradient id="agreeFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22c55e" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#22c55e" stopOpacity={0.1} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="agreementRate" fill="url(#agreeFill)" radius={[4, 4, 0, 0]} name="Agreement %" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                No feedback data yet — as users rate reports, agreement trends will appear here.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <FileText className="w-5 h-5 text-primary mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground leading-relaxed">
              <span className="text-foreground font-medium">About this page:</span>{" "}
              All data shown here is computed from VulnRap's live database. Reports are counted from the{" "}
              <code className="text-[11px] bg-muted/50 px-1 rounded font-mono">reports</code> table,
              feedback from <code className="text-[11px] bg-muted/50 px-1 rounded font-mono">user_feedback</code>,
              and visitors are tracked with privacy-respecting hashed identifiers (no PII stored).
              Charts refresh every 2 minutes.
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
