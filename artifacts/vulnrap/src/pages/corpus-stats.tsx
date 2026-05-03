import {
  useGetCorpusStats,
  getGetCorpusStatsQueryKey,
} from "@workspace/api-client-react";
import {
  BarChart3,
  Database,
  Layers,
  Tag,
  TrendingUp,
  Activity,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TIER_COLORS: Record<string, string> = {
  Clean: "text-green-400 border-green-500/40 bg-green-500/10",
  "Likely Human": "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  Questionable: "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  "Likely Slop": "text-orange-400 border-orange-500/40 bg-orange-500/10",
  Slop: "text-red-400 border-red-500/40 bg-red-500/10",
};

function tierClass(tier: string): string {
  return (
    TIER_COLORS[tier] || "text-muted-foreground border-border/40 bg-muted/10"
  );
}

function HBar({
  label,
  count,
  max,
  colorClass,
}: {
  label: string;
  count: number;
  max: number;
  colorClass: string;
}) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-40 shrink-0 truncate text-xs font-mono text-foreground/90"
        title={label}
      >
        {label}
      </div>
      <div className="flex-1 h-3 rounded-sm bg-muted/30 overflow-hidden">
        <div
          className={cn(
            "h-full transition-all duration-700 ease-out",
            colorClass,
          )}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <div className="w-16 text-right text-xs font-mono text-muted-foreground tabular-nums">
        {count.toLocaleString()}
      </div>
    </div>
  );
}

function VolumeChart({
  series,
}: {
  series: Array<{ date: string; count: number }>;
}) {
  if (series.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
        No volume data yet.
      </div>
    );
  }
  const max = Math.max(...series.map((s) => s.count), 1);
  const total = series.reduce((sum, s) => sum + s.count, 0);
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-[2px] h-40 px-1">
        {series.map((point) => {
          const heightPct = (point.count / max) * 100;
          return (
            <div
              key={point.date}
              className="flex-1 min-w-0 relative group flex items-end"
              style={{ height: "100%" }}
            >
              <div
                className="w-full rounded-t-sm bg-gradient-to-t from-primary/40 to-primary/80 transition-all duration-500 ease-out hover:from-primary/60 hover:to-primary"
                style={{ height: `${Math.max(heightPct, 2)}%` }}
              />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 opacity-0 group-hover:opacity-100 transition-opacity glass-card text-popover-foreground text-[10px] px-2 py-1 rounded pointer-events-none z-10 whitespace-nowrap">
                <div className="font-mono">{point.date}</div>
                <div className="font-mono text-primary">
                  {point.count} report{point.count === 1 ? "" : "s"}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/60 border-t border-border/30 pt-2">
        <span>{series[0]?.date}</span>
        <span>
          {total.toLocaleString()} reports across {series.length} day
          {series.length === 1 ? "" : "s"}
        </span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export default function CorpusStats() {
  const { data, isLoading } = useGetCorpusStats({
    query: { queryKey: getGetCorpusStatsQueryKey() },
  });

  const totalReports = data?.totalReports ?? 0;
  const tiers = data?.tierBreakdown ?? [];
  const signals = data?.topSignals ?? [];
  const families = data?.topCweFamilies ?? [];
  const volume = data?.volumeTimeSeries ?? [];

  const maxSignal = Math.max(...signals.map((s) => s.count), 1);
  const maxFamily = Math.max(...families.map((f) => f.count), 1);
  const maxTier = Math.max(...tiers.map((t) => t.count), 1);

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
          <Database className="w-8 h-8 text-primary" />
          Public Corpus Stats
        </h1>
        <p className="text-muted-foreground mt-2">
          Already-aggregated metrics across every report VulnRap has scored. No
          individual report content is exposed here — only counts, totals, and
          time series.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="glass-card rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
                Total Reports
              </span>
              <Database className="w-4 h-4 text-cyan-400" />
            </div>
            {isLoading ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              <div className="text-3xl font-mono font-bold text-cyan-400 glow-text-sm">
                {totalReports.toLocaleString()}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
                Tiers Tracked
              </span>
              <Layers className="w-4 h-4 text-violet-400" />
            </div>
            {isLoading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <div className="text-3xl font-mono font-bold text-violet-400">
                {tiers.length}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground font-bold">
                CWE Families
              </span>
              <Tag className="w-4 h-4 text-amber-400" />
            </div>
            {isLoading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <div className="text-3xl font-mono font-bold text-amber-400">
                {families.length}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Tier Breakdown
              </CardTitle>
              <CardDescription>
                Reports grouped by slop tier label.
              </CardDescription>
            </div>
            {totalReports > 0 && (
              <Badge variant="outline" className="text-xs font-mono">
                {totalReports.toLocaleString()} total
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : tiers.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No reports scored yet.
            </div>
          ) : (
            <div className="space-y-3">
              {tiers.map((t) => {
                const pct =
                  totalReports > 0
                    ? Math.round((t.count / totalReports) * 100)
                    : 0;
                return (
                  <div key={t.tier} className="flex items-center gap-3">
                    <div className="w-32 shrink-0">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] font-mono",
                          tierClass(t.tier),
                        )}
                      >
                        {t.tier}
                      </Badge>
                    </div>
                    <div className="flex-1 h-3 rounded-sm bg-muted/30 overflow-hidden">
                      <div
                        className={cn(
                          "h-full transition-all duration-700 ease-out",
                          tierClass(t.tier),
                        )}
                        style={{
                          width: `${Math.max((t.count / maxTier) * 100, 2)}%`,
                        }}
                      />
                    </div>
                    <div className="w-24 text-right text-xs font-mono text-muted-foreground tabular-nums">
                      {t.count.toLocaleString()}{" "}
                      <span className="text-muted-foreground/50">({pct}%)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              <Activity className="w-4 h-4" /> Top 10 Signals
            </CardTitle>
            <CardDescription>
              Most-fired evidence signal types across the corpus.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-5 w-full" />
                ))}
              </div>
            ) : signals.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No signals fired yet.
              </div>
            ) : (
              <div className="space-y-2.5">
                {signals.map((s) => (
                  <HBar
                    key={s.signal}
                    label={s.signal}
                    count={s.count}
                    max={maxSignal}
                    colorClass="bg-gradient-to-r from-cyan-500/60 to-cyan-400/80"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              <Tag className="w-4 h-4" /> Top 10 CWE Families
            </CardTitle>
            <CardDescription>
              AVRI rubric families the corpus has classified into.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(6)].map((_, i) => (
                  <Skeleton key={i} className="h-5 w-full" />
                ))}
              </div>
            ) : families.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No CWE families classified yet.
              </div>
            ) : (
              <div className="space-y-2.5">
                {families.map((f) => (
                  <HBar
                    key={f.family}
                    label={f.family}
                    count={f.count}
                    max={maxFamily}
                    colorClass="bg-gradient-to-r from-amber-500/60 to-amber-400/80"
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
            <TrendingUp className="w-4 h-4" /> Volume — Last 90 Days
          </CardTitle>
          <CardDescription>
            Daily report submissions over the last 90 days (oldest left, newest
            right).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <VolumeChart series={volume} />
          )}
        </CardContent>
      </Card>

      {data?.generatedAt && (
        <div className="text-[10px] text-muted-foreground/50 font-mono text-right">
          Aggregates generated {new Date(data.generatedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
