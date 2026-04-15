import { useState } from "react";
import {
  useGetFeedbackAnalytics, getGetFeedbackAnalyticsQueryKey,
  useGetCalibrationReport, getGetCalibrationReportQueryKey,
  useGetScoringConfig, getGetScoringConfigQueryKey,
  applyCalibration,
  type FeedbackAnalyticsDailyTrendItem,
  type FeedbackAnalyticsScoreCorrelationItem,
  type FeedbackAnalyticsOutliersItem,
  type FeedbackAnalyticsRecentFeedbackItem,
  type CalibrationSuggestion,
  type BucketAnalysis,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Star, ThumbsUp, ThumbsDown, TrendingUp, AlertTriangle,
  BarChart3, Users, ArrowRight, Clock, Hash, Settings, Shield, Zap,
  CheckCircle2, XCircle, Info, Play,
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatCard({ title, value, subtitle, icon, color }: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Card className="glass-card rounded-xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground uppercase font-bold tracking-wider">{title}</span>
          <div className={cn("p-2 rounded-lg", color)}>{icon}</div>
        </div>
        <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
        {subtitle && <div className="text-xs text-muted-foreground mt-1">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}

function RatingBar({ rating, count, maxCount }: { rating: number; count: number; maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  const labels = ["", "Way off", "Needs work", "Decent", "Solid", "Nailed it"];
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1 w-16 shrink-0">
        {[1, 2, 3, 4, 5].map(s => (
          <Star key={s} className={cn("w-3 h-3", s <= rating ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/20")} />
        ))}
      </div>
      <div className="flex-1 h-5 bg-muted/30 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground w-8 text-right tabular-nums">{count}</span>
      <span className="text-xs text-muted-foreground/60 w-20 hidden sm:block">{labels[rating]}</span>
    </div>
  );
}

function CorrelationScatter({ data }: {
  data: Array<{ scoreBucket: string; avgRating: number; helpfulPct: number; count: number }>;
}) {
  if (data.length === 0) return <p className="text-xs text-muted-foreground/50 py-4 text-center">No linked feedback yet</p>;

  const W = 300;
  const H = 200;
  const PAD = { top: 12, right: 12, bottom: 28, left: 34 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;

  const bucketOrder = ["0-20", "21-40", "41-60", "61-80", "81-100"];
  const bucketColors: Record<string, string> = {
    "0-20": "#22c55e",
    "21-40": "#34d399",
    "41-60": "#eab308",
    "61-80": "#f97316",
    "81-100": "#ef4444",
  };

  const maxCount = Math.max(...data.map(d => d.count), 1);

  const points = data.map(d => {
    const bIdx = bucketOrder.indexOf(d.scoreBucket);
    const x = PAD.left + ((bIdx >= 0 ? bIdx : 0) / (bucketOrder.length - 1)) * pw;
    const y = PAD.top + ph - ((d.avgRating - 1) / 4) * ph;
    const r = 4 + (d.count / maxCount) * 10;
    const color = bucketColors[d.scoreBucket] || "#06b6d4";
    return { ...d, x, y, r, color };
  });

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: "220px" }}>
        {[1, 2, 3, 4, 5].map(rating => {
          const y = PAD.top + ph - ((rating - 1) / 4) * ph;
          return (
            <g key={rating}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={0.5} />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="monospace">{rating}★</text>
            </g>
          );
        })}

        {bucketOrder.map((label, i) => {
          const x = PAD.left + (i / (bucketOrder.length - 1)) * pw;
          return (
            <text key={label} x={x} y={H - 4} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={7} fontFamily="monospace">{label}</text>
          );
        })}

        <text x={W / 2} y={H + 2} textAnchor="middle" fill="rgba(255,255,255,0.2)" fontSize={7}>Slop Score Range</text>

        {points.map((p, i) => (
          <g key={i} className="group">
            <circle cx={p.x} cy={p.y} r={p.r + 6} fill="transparent" className="cursor-default" />
            <circle
              cx={p.x}
              cy={p.y}
              r={p.r}
              fill={p.color}
              fillOpacity={0.25}
              stroke={p.color}
              strokeWidth={1.5}
              className="transition-all duration-200"
            />
            <circle cx={p.x} cy={p.y} r={2} fill={p.color} />

            <g className="opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <rect x={p.x - 40} y={p.y - 42} width={80} height={36} rx={4} fill="rgba(0,0,0,0.85)" stroke={p.color} strokeWidth={0.5} />
              <text x={p.x} y={p.y - 28} textAnchor="middle" fill={p.color} fontSize={8} fontWeight={700} fontFamily="monospace">{p.avgRating.toFixed(1)}★ · {p.helpfulPct}%</text>
              <text x={p.x} y={p.y - 16} textAnchor="middle" fill="rgba(255,255,255,0.5)" fontSize={7}>{p.count} entries · {p.scoreBucket}</text>
            </g>
          </g>
        ))}
      </svg>
      <div className="grid grid-cols-5 gap-1 text-center">
        {data.map(d => {
          const color = bucketColors[d.scoreBucket] || "#06b6d4";
          const ratingColor = d.avgRating >= 4 ? "text-green-400" : d.avgRating >= 3 ? "text-yellow-400" : "text-red-400";
          return (
            <div key={d.scoreBucket} className="space-y-0.5 py-1.5 px-1 rounded-md" style={{ borderLeft: `2px solid ${color}` }}>
              <div className="text-[10px] font-mono font-bold" style={{ color }}>{d.scoreBucket}</div>
              <div className={cn("text-[10px] font-bold tabular-nums", ratingColor)}>{d.avgRating.toFixed(1)}★</div>
              <div className="text-[9px] text-muted-foreground/50">{d.helpfulPct}% helpful</div>
              <div className="text-[9px] text-muted-foreground/30">{d.count} entries</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OutlierCard({ outlier }: {
  outlier: {
    feedbackId: number;
    reportId?: number | null;
    rating: number;
    helpful: boolean;
    comment?: string | null;
    slopScore: number;
    slopTier: string;
    qualityScore: number;
  };
}) {
  const mismatch = (outlier.rating <= 2 && outlier.slopScore >= 60)
    ? "User rated low, engine scored high"
    : (outlier.rating >= 4 && outlier.slopScore <= 20)
      ? "User rated high, engine scored low"
      : "Marked not helpful";

  return (
    <div className="p-4 rounded-lg glass-card border border-border/50 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
          <span className="text-xs font-medium text-orange-400">{mismatch}</span>
        </div>
        {outlier.reportId && (
          <Link to={`/results/${outlier.reportId}`} className="text-xs text-primary hover:underline flex items-center gap-1">
            Report #{outlier.reportId} <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="flex items-center gap-1">
          <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
          {outlier.rating}/5
        </span>
        <span className={cn("flex items-center gap-1", outlier.helpful ? "text-green-400" : "text-red-400")}>
          {outlier.helpful ? <ThumbsUp className="w-3 h-3" /> : <ThumbsDown className="w-3 h-3" />}
          {outlier.helpful ? "Helpful" : "Not helpful"}
        </span>
        <Badge variant="outline" className="text-[10px]">Slop: {outlier.slopScore}%</Badge>
        <Badge variant="outline" className="text-[10px]">{outlier.slopTier}</Badge>
      </div>
      {outlier.comment && (
        <p className="text-xs text-muted-foreground italic leading-relaxed border-l-2 border-primary/30 pl-3 mt-2">
          "{outlier.comment}"
        </p>
      )}
    </div>
  );
}

function RecentRow({ item }: {
  item: {
    feedbackId: number;
    reportId?: number | null;
    rating: number;
    helpful: boolean;
    comment?: string | null;
    createdAt: string;
    slopScore?: number | null;
    slopTier?: string | null;
  };
}) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/20 last:border-0">
      <div className="flex items-center gap-0.5 w-16 shrink-0">
        {[1, 2, 3, 4, 5].map(s => (
          <Star key={s} className={cn("w-2.5 h-2.5", s <= item.rating ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/20")} />
        ))}
      </div>
      <div className={cn("w-5 shrink-0", item.helpful ? "text-green-400" : "text-red-400")}>
        {item.helpful ? <ThumbsUp className="w-3.5 h-3.5" /> : <ThumbsDown className="w-3.5 h-3.5" />}
      </div>
      <div className="flex-1 min-w-0">
        {item.comment ? (
          <p className="text-xs text-muted-foreground truncate">{item.comment}</p>
        ) : (
          <p className="text-xs text-muted-foreground/40 italic">No comment</p>
        )}
      </div>
      {item.slopScore != null && (
        <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">{item.slopScore}%</Badge>
      )}
      {item.reportId && (
        <Link to={`/results/${item.reportId}`} className="text-xs text-primary hover:underline shrink-0">
          #{item.reportId}
        </Link>
      )}
      <span className="text-[10px] text-muted-foreground/50 shrink-0 w-16 text-right">
        {new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
      </span>
    </div>
  );
}

function BucketRow({ bucket }: { bucket: BucketAnalysis }) {
  const signalConfig = {
    "accurate": { color: "text-green-400", bg: "bg-green-400/10", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    "over-scoring": { color: "text-red-400", bg: "bg-red-400/10", icon: <XCircle className="w-3.5 h-3.5" /> },
    "under-scoring": { color: "text-orange-400", bg: "bg-orange-400/10", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
    "insufficient-data": { color: "text-muted-foreground/50", bg: "bg-muted/10", icon: <Info className="w-3.5 h-3.5" /> },
  };
  const cfg = signalConfig[bucket.signal];
  const signalLabel = bucket.signal.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="flex items-center gap-3 py-3 border-b border-border/20 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{bucket.bucket}</div>
        <div className="text-[10px] text-muted-foreground">
          {bucket.feedbackCount} feedback · {bucket.meetsThreshold ? "threshold met" : `needs ${10 - bucket.feedbackCount} more`}
        </div>
      </div>
      <div className="text-right w-16">
        <div className="text-sm font-bold tabular-nums">{bucket.avgRating > 0 ? bucket.avgRating.toFixed(1) : "—"}</div>
        <div className="text-[10px] text-muted-foreground">rating</div>
      </div>
      <div className="text-right w-16">
        <div className="text-sm font-bold tabular-nums">{bucket.feedbackCount > 0 ? `${bucket.helpfulPct}%` : "—"}</div>
        <div className="text-[10px] text-muted-foreground">helpful</div>
      </div>
      <Badge variant="outline" className={cn("text-[10px] gap-1", cfg.color, cfg.bg)}>
        {cfg.icon} {signalLabel}
      </Badge>
    </div>
  );
}

function SuggestionCard({ suggestion, onApply, applying }: {
  suggestion: CalibrationSuggestion;
  onApply: (s: CalibrationSuggestion) => void;
  applying: boolean;
}) {
  const confColor = suggestion.confidence === "high" ? "text-green-400" : suggestion.confidence === "medium" ? "text-yellow-400" : "text-muted-foreground";

  return (
    <div className="p-4 rounded-lg glass-card border border-border/50 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary shrink-0" />
          <code className="text-xs font-mono text-primary">{suggestion.parameter}</code>
        </div>
        <Badge variant="outline" className={cn("text-[10px]", confColor)}>
          {suggestion.confidence} confidence
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="tabular-nums text-muted-foreground">{suggestion.currentValue}</span>
        <ArrowRight className="w-3 h-3 text-muted-foreground" />
        <span className="tabular-nums font-bold text-foreground">{suggestion.suggestedValue}</span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          based on {suggestion.basedOnCount} entries
        </span>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{suggestion.reason}</p>
      <Button
        size="sm"
        variant="outline"
        className="gap-2 text-xs"
        onClick={() => onApply(suggestion)}
        disabled={applying}
      >
        <Play className="w-3 h-3" />
        {applying ? "Applying..." : "Apply This Change"}
      </Button>
    </div>
  );
}

function CalibrationSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [applying, setApplying] = useState(false);

  const { data: calibration, isLoading: calLoading } = useGetCalibrationReport({
    query: {
      queryKey: getGetCalibrationReportQueryKey(),
      refetchInterval: 120_000,
    },
  });

  const { data: configData } = useGetScoringConfig({
    query: {
      queryKey: getGetScoringConfigQueryKey(),
    },
  });

  const handleApply = async (suggestion: CalibrationSuggestion) => {
    setApplying(true);
    try {
      const parts = suggestion.parameter.split(".");
      let changes: Record<string, unknown>;
      if (parts.length === 2) {
        changes = { [parts[0]]: { [parts[1]]: suggestion.suggestedValue } };
      } else {
        changes = { [suggestion.parameter]: suggestion.suggestedValue };
      }

      await applyCalibration({
        changes,
        description: `Auto-calibration: ${suggestion.parameter} ${suggestion.currentValue} → ${suggestion.suggestedValue}. ${suggestion.reason}`,
      });

      toast({ title: "Config updated", description: `${suggestion.parameter} changed to ${suggestion.suggestedValue}. New version applied.` });
      queryClient.invalidateQueries({ queryKey: getGetCalibrationReportQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetScoringConfigQueryKey() });
    } catch {
      toast({ title: "Error", description: "Failed to apply calibration change.", variant: "destructive" });
    } finally {
      setApplying(false);
    }
  };

  if (calLoading) {
    return <Skeleton className="h-64 rounded-xl" />;
  }

  if (!calibration) return null;

  const healthColor = calibration.overallHealth === "good"
    ? "text-green-400 bg-green-400/10"
    : calibration.overallHealth === "needs-attention"
      ? "text-yellow-400 bg-yellow-400/10"
      : "text-red-400 bg-red-400/10";
  const healthLabel = calibration.overallHealth.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="space-y-6">
      <Card className="glass-card rounded-xl border-primary/10">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" />
              Scoring Calibration
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn("text-[10px] gap-1", healthColor)}>
                <Shield className="w-3 h-3" /> {healthLabel}
              </Badge>
              {configData?.current && (
                <Badge variant="secondary" className="text-[10px]">
                  v{configData.current.version}
                </Badge>
              )}
            </div>
          </div>
          <CardDescription>
            Feedback-driven analysis of scoring accuracy per score range.
            {calibration.totalFeedbackAnalyzed > 0
              ? ` Analyzing ${calibration.totalFeedbackAnalyzed} feedback entries.`
              : " No linked feedback to analyze yet."}
            {" "}Minimum {calibration.minFeedbackThreshold} entries per bucket before suggesting changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {calibration.bucketAnalysis.map((bucket: BucketAnalysis) => (
            <BucketRow key={bucket.bucket} bucket={bucket} />
          ))}
        </CardContent>
      </Card>

      {calibration.suggestions.length > 0 && (
        <Card className="glass-card rounded-xl border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Suggested Adjustments
              <Badge variant="secondary" className="ml-auto text-[10px]">{calibration.suggestions.length}</Badge>
            </CardTitle>
            <CardDescription>
              Data-driven tuning suggestions based on feedback patterns. Each change creates a new scoring config version.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {calibration.suggestions.map((s: CalibrationSuggestion, i: number) => (
              <SuggestionCard key={i} suggestion={s} onApply={handleApply} applying={applying} />
            ))}
          </CardContent>
        </Card>
      )}

      {configData && configData.history.length > 1 && (
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              Config Version History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[...configData.history].reverse().map((cfg, i) => (
                <div key={cfg.version} className={cn(
                  "flex items-center gap-3 py-2 border-b border-border/20 last:border-0",
                  i === 0 && "text-foreground",
                  i > 0 && "text-muted-foreground"
                )}>
                  <Badge variant={i === 0 ? "default" : "outline"} className="text-[10px]">
                    v{cfg.version}
                  </Badge>
                  <span className="text-xs flex-1">{cfg.description}</span>
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">
                    {new Date(cfg.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-4 rounded-full bg-primary/10 mb-4">
        <MessageSquare className="w-10 h-10 text-primary/50" />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-2">No feedback yet</h3>
      <p className="text-sm text-muted-foreground max-w-md">
        As PSIRT teams analyze reports and leave feedback, this dashboard will surface patterns
        in accuracy, outliers where the engine disagrees with human judgment, and trends over time.
      </p>
    </div>
  );
}

export default function FeedbackAnalytics() {
  const { data, isLoading, error } = useGetFeedbackAnalytics({
    query: {
      queryKey: getGetFeedbackAnalyticsQueryKey(),
      refetchInterval: 60_000,
    },
  });

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" />
            Feedback Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Loading analysis feedback data...</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Card className="glass-card rounded-xl border-red-500/20">
          <CardContent className="p-8 text-center">
            <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
            <p className="text-sm text-red-400">Failed to load feedback analytics.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.summary.totalFeedback === 0) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" />
            Feedback Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">How the community rates our analysis accuracy</p>
        </div>
        <EmptyState />
      </div>
    );
  }

  const { summary, ratingDistribution, dailyTrend, scoreCorrelation, outliers, recentFeedback } = data;
  const maxRatingCount = Math.max(...Object.values(ratingDistribution).map(Number), 1);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <BarChart3 className="w-6 h-6 text-primary" />
          Feedback Analytics
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          How triage teams rate our analysis — {summary.totalFeedback} feedback entries so far
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Feedback"
          value={summary.totalFeedback}
          subtitle={`${summary.linkedToReport} linked to reports`}
          icon={<MessageSquare className="w-4 h-4 text-primary" />}
          color="bg-primary/10"
        />
        <StatCard
          title="Avg Rating"
          value={summary.avgRating.toFixed(1)}
          subtitle="out of 5.0"
          icon={<Star className="w-4 h-4 text-yellow-400" />}
          color="bg-yellow-400/10"
        />
        <StatCard
          title="Helpful Rate"
          value={`${summary.helpfulnessRate}%`}
          subtitle={`${summary.helpfulCount} helpful / ${summary.notHelpfulCount} not`}
          icon={<ThumbsUp className="w-4 h-4 text-green-400" />}
          color="bg-green-400/10"
        />
        <StatCard
          title="With Comments"
          value={summary.withComments}
          subtitle="actionable text feedback"
          icon={<Users className="w-4 h-4 text-blue-400" />}
          color="bg-blue-400/10"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="w-4 h-4 text-yellow-400" />
              Rating Distribution
            </CardTitle>
            <CardDescription>How users rate analysis accuracy (1-5 stars)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {[5, 4, 3, 2, 1].map(r => (
              <RatingBar
                key={r}
                rating={r}
                count={ratingDistribution[String(r)] ?? 0}
                maxCount={maxRatingCount}
              />
            ))}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Score vs. Feedback Correlation
            </CardTitle>
            <CardDescription>How user ratings correlate with slop scores — are we calibrated?</CardDescription>
          </CardHeader>
          <CardContent>
            <CorrelationScatter data={scoreCorrelation} />
          </CardContent>
        </Card>
      </div>

      <CalibrationSection />

      {dailyTrend.length > 0 && (
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              30-Day Trend
            </CardTitle>
            <CardDescription>Daily feedback volume, average rating, and helpfulness</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <div className="min-w-[600px]">
                <div className="flex items-end gap-1 h-32">
                  {dailyTrend.map((day: FeedbackAnalyticsDailyTrendItem) => {
                    const maxCount = Math.max(...dailyTrend.map((d: FeedbackAnalyticsDailyTrendItem) => d.count), 1);
                    const h = Math.max(8, (day.count / maxCount) * 100);
                    const ratingColor = day.avgRating >= 4 ? "bg-green-400/60" : day.avgRating >= 3 ? "bg-yellow-400/60" : "bg-red-400/60";
                    return (
                      <div key={day.date} className="flex-1 flex flex-col items-center gap-1 group relative">
                        <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
                          <div className="bg-popover border border-border rounded-md px-2 py-1 text-[10px] shadow-lg whitespace-nowrap">
                            <div className="font-medium">{day.date}</div>
                            <div>{day.count} feedback · {day.avgRating.toFixed(1)}★ · {day.helpfulPct}% helpful</div>
                          </div>
                        </div>
                        <div
                          className={cn("w-full rounded-t-sm transition-all", ratingColor)}
                          style={{ height: `${h}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-1 mt-1">
                  {dailyTrend.map((day: FeedbackAnalyticsDailyTrendItem, i: number) => (
                    <div key={day.date} className="flex-1 text-center">
                      {(i === 0 || i === dailyTrend.length - 1 || i % 7 === 0) && (
                        <span className="text-[9px] text-muted-foreground/40">
                          {new Date(day.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {outliers.length > 0 && (
        <Card className="glass-card rounded-xl border-orange-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              Outliers &amp; Disagreements
              <Badge variant="secondary" className="ml-auto text-[10px]">{outliers.length}</Badge>
            </CardTitle>
            <CardDescription>
              Reports where user feedback disagrees with engine scoring — the most valuable signals for tuning
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 max-h-[600px] overflow-y-auto">
            {outliers.map((o: FeedbackAnalyticsOutliersItem) => (
              <OutlierCard key={o.feedbackId} outlier={o} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="glass-card rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Hash className="w-4 h-4 text-primary" />
            Recent Feedback
            <Badge variant="secondary" className="ml-auto text-[10px]">{recentFeedback.length}</Badge>
          </CardTitle>
          <CardDescription>Latest feedback entries from triage teams</CardDescription>
        </CardHeader>
        <CardContent>
          {recentFeedback.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-4 text-center">No feedback entries yet</p>
          ) : (
            <div className="divide-y divide-border/10">
              {recentFeedback.map((item: FeedbackAnalyticsRecentFeedbackItem) => (
                <RecentRow key={item.feedbackId} item={item} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
