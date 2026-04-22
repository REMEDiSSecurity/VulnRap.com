import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useGetFeedbackAnalytics, getGetFeedbackAnalyticsQueryKey,
  useGetCalibrationReport, getGetCalibrationReportQueryKey,
  useGetScoringConfig, getGetScoringConfigQueryKey,
  useGetAvriDriftReport, getGetAvriDriftReportQueryKey,
  useGetHandwavyPhrases, getGetHandwavyPhrasesQueryKey,
  addHandwavyPhrase, removeHandwavyPhrase, reinstateHandwavyPhrase, editHandwavyPhrase, undoHandwavyPhrase,
  revertHandwavyPhraseEdit,
  type HandwavyPhraseDryRunMatches,
  type HandwavyHistoryEntry,
  type HandwavyEditEntry,
  applyCalibration,
  type FeedbackAnalyticsDailyTrendItem,
  type FeedbackAnalyticsScoreCorrelationItem,
  type FeedbackAnalyticsOutliersItem,
  type FeedbackAnalyticsRecentFeedbackItem,
  type CalibrationSuggestion,
  type BucketAnalysis,
  type AvriDriftReport,
  type AvriDriftWeekBucket,
  type AvriDriftFlag,
  type AvriDriftFamilyMean,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Link } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Star, ThumbsUp, ThumbsDown, TrendingUp, AlertTriangle,
  BarChart3, Users, ArrowRight, Clock, Hash, Settings, Shield, Zap,
  CheckCircle2, XCircle, Info, Play, Layers, Activity, BookOpen, ExternalLink,
  Plus, Trash2, MessageCircleQuestion, RotateCcw, Pencil, Save, X as XIcon, Undo2,
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
      <AvriDriftSection />
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

      <HandwavyPhrasesAdmin />

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

// Task #114 — small per-tier counter chip rendered inside the dry-run preview
// panel. `negative` flips the palette to red so GREEN/YELLOW (legitimate)
// matches stand out as bad-news rather than blending in with the slop totals.
function PreviewTierBadge({ label, count, negative }: { label: string; count: number; negative?: boolean }) {
  const danger = negative === true && count > 0;
  return (
    <div
      className={cn(
        "rounded border px-2 py-1 flex flex-col items-start gap-0.5",
        danger
          ? "border-red-500/40 bg-red-500/10 text-red-200"
          : count > 0
          ? "border-amber-500/30 bg-amber-500/5 text-amber-100"
          : "border-border/30 bg-background/30 text-muted-foreground",
      )}
    >
      <span className="uppercase tracking-wide text-[9px] opacity-80">{label}</span>
      <span className="font-bold tabular-nums text-sm">{count}</span>
    </div>
  );
}

// Local-storage key for remembering the reviewer name/email between sessions
// so the audit trail captures who is curating without forcing a re-entry on
// every add/remove.
const HANDWAVY_REVIEWER_KEY = "vulnrap.handwavy.reviewer";

function formatAuditTimestamp(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Task #119 — Side-by-side render of one dry-run match block (curated vs.
// production). Identical visual shape so reviewers can read both signals at
// a glance; the `kind` prop only changes the leading icon and label noun.
function PreviewMatchBlock({
  kind,
  title,
  subtitle,
  matches,
  emptyHint,
}: {
  kind: "curated" | "production";
  title: string;
  subtitle: string;
  matches: HandwavyPhraseDryRunMatches;
  emptyHint: string;
}) {
  const fp = matches.falsePositives;
  const sourceNoun = kind === "curated" ? "fixture" : "report";
  return (
    <div
      className={cn(
        "rounded-md border p-2.5 space-y-1.5 text-xs",
        fp > 0
          ? "border-red-500/40 bg-red-500/10"
          : "border-emerald-500/30 bg-emerald-500/5",
      )}
      data-testid={`handwavy-preview-${kind}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-foreground">{title}</div>
        <Badge variant="outline" className="text-[9px] uppercase tracking-wide">
          {subtitle}
        </Badge>
      </div>
      {matches.warning ? (
        <div
          className="text-red-200 text-[11px]"
          data-testid={`handwavy-preview-${kind}-warning`}
        >
          {matches.warning}
        </div>
      ) : (
        <div className="text-emerald-200 text-[11px]">
          {emptyHint}
          {matches.total > 0
            ? ` — ${matches.total} slop ${sourceNoun}${matches.total === 1 ? "" : "s"} would be caught.`
            : "."}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-0.5 text-[11px]">
        <PreviewTierBadge label="GREEN (T1 legit)" count={matches.byTier.t1Legit} negative />
        <PreviewTierBadge label="YELLOW (T2 borderline)" count={matches.byTier.t2Borderline} negative />
        <PreviewTierBadge label="RED (T3 slop)" count={matches.byTier.t3Slop} />
        <PreviewTierBadge label="RED (T4 hallucinated)" count={matches.byTier.t4Hallucinated} />
      </div>
      {matches.sampleMatches.length > 0 && (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Sample matched {sourceNoun}s ({matches.sampleMatches.length})
          </summary>
          <ul className="mt-1 ml-3 list-disc space-y-0.5 font-mono">
            {matches.sampleMatches.map((s) => (
              <li key={s.id}>
                {kind === "production" ? `report #${s.id}` : s.id}{" "}
                <span className="opacity-60">[{s.tier}]</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// Shared renderer for the per-edit list. Both the single-edit
// <details> affordance (Task #132) and the full chronological history
// panel (Task #133) call this so they stay structurally aligned and
// every entry keeps the Revert button.
function renderHandwavyEditEntries({
  editsList,
  phrase,
  editing,
  busy,
  handleRevertEdit,
  showHistoryTestIds,
}: {
  editsList: HandwavyEditEntry[];
  phrase: string;
  editing: { phrase: string } | null;
  busy: string | null;
  handleRevertEdit: (phrase: string, entry: HandwavyEditEntry) => void;
  showHistoryTestIds?: boolean;
}): ReactNode[] {
  return editsList
    .map((entry, idx) => ({ entry, idx }))
    .reverse()
    .map(({ entry, idx }) => {
      const editedAtKey =
        entry.editedAt instanceof Date
          ? entry.editedAt.toISOString()
          : String(entry.editedAt);
      const revertKey = `revert:${phrase}:${editedAtKey}`;
      const editedAtLabel = formatAuditTimestamp(entry.editedAt);
      return (
        <li
          key={`${editedAtKey}-${idx}`}
          className="flex items-start gap-2 text-[10px] text-muted-foreground"
          data-testid={showHistoryTestIds ? "handwavy-edit-history-row" : "handwavy-edit-entry"}
        >
          <div className="flex-1 space-y-0.5">
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              <span>
                {showHistoryTestIds ? "By " : ""}
                <span className="text-foreground/80">
                  {entry.editedBy || "anonymous"}
                </span>
              </span>
              {editedAtLabel && <span>{showHistoryTestIds ? editedAtLabel : `• ${editedAtLabel}`}</span>}
            </div>
            {entry.category && (
              <div data-testid={showHistoryTestIds ? "handwavy-edit-history-category" : undefined}>
                {showHistoryTestIds ? "Category: " : "category "}
                <span className="text-foreground/70 capitalize">{entry.category.from}</span>
                {" → "}
                <span className={cn(showHistoryTestIds ? "text-foreground/90" : "text-foreground/70", "capitalize")}>
                  {entry.category.to}
                </span>
              </div>
            )}
            {entry.rationale && (
              <div data-testid={showHistoryTestIds ? "handwavy-edit-history-rationale" : undefined}>
                {showHistoryTestIds ? "Rationale: " : "rationale "}
                <span className="text-foreground/70 italic">
                  {entry.rationale.from && entry.rationale.from.length > 0
                    ? `“${entry.rationale.from}”`
                    : "(empty)"}
                </span>
                {" → "}
                <span className={cn(showHistoryTestIds ? "text-foreground/90" : "text-foreground/70", "italic")}>
                  {entry.rationale.to && entry.rationale.to.length > 0
                    ? `“${entry.rationale.to}”`
                    : showHistoryTestIds ? "(empty)" : "(cleared)"}
                </span>
              </div>
            )}
            {showHistoryTestIds && !entry.category && !entry.rationale && (
              <div className="italic">No tracked field changes recorded.</div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] text-amber-300 hover:text-amber-200 shrink-0"
            disabled={editing !== null || busy === revertKey || busy === `rm:${phrase}`}
            onClick={() => handleRevertEdit(phrase, entry)}
            data-testid="handwavy-revert-edit"
            aria-label={`Revert edit on ${phrase} from ${editedAtLabel ?? entry.editedAt}`}
            title="Restore the values from before this edit (recorded as a new audit entry)."
          >
            <Undo2 className="w-3 h-3 mr-1" />
            {busy === revertKey ? "Reverting…" : "Revert"}
          </Button>
        </li>
      );
    });
}

function HandwavyPhrasesAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [draftRationale, setDraftRationale] = useState("");
  const [reviewer, setReviewer] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(HANDWAVY_REVIEWER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  // Task #134 — bulk-remove state. `selected` is the set of currently-checked
  // phrases (keyed by the normalized `phrase` string the server stores), and
  // mirrors the CLI's batch removal flow: we collect a list, show ONE
  // confirmation summary, then issue one DELETE per phrase. `bulkConfirm`
  // toggles the inline confirmation panel; `bulkResults` keeps the per-phrase
  // outcome (removed / not-found / auth-failed / error) visible after the
  // batch completes so the reviewer can see exactly what happened without
  // squinting at toasts. The active list is refreshed ONCE after the batch.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState<string[] | null>(null);
  type BulkOutcome = "removed" | "not-found" | "auth-failed" | "error";
  const [bulkResults, setBulkResults] = useState<
    Array<{ phrase: string; status: BulkOutcome; message?: string }> | null
  >(null);
  // Task #114 — corpus-impact preview state. After the reviewer presses
  // "Add phrase" we first issue a dry-run POST and surface the GREEN/YELLOW
  // false-positive count. The actual add only persists after the reviewer
  // confirms the preview, so a poorly-chosen phrase can't crater AVRI for
  // legitimate reports without an explicit second click. Pending reviewer
  // and rationale (Task #112) are carried alongside so the eventual real
  // add still records the audit trail.
  const [preview, setPreview] = useState<{
    phrase: string;
    category: "absence" | "hedging" | "buzzword";
    matches: HandwavyPhraseDryRunMatches;
    reviewer?: string;
    rationale?: string;
    // Task #119 — second signal: same shape as the curated `matches`, but
    // scored against the most recent N production reports. `null` when the
    // production scan failed (DB unavailable etc.) — `productionError` will
    // explain why so the reviewer doesn't think the phrase is harmless.
    productionMatches: HandwavyPhraseDryRunMatches | null;
    productionError: string | null;
    productionLimit: number | null;
  } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Task #133 — track which phrase rows have their full edit history
  // expanded. Multiple rows can be open at once so reviewers can compare
  // how different phrases evolved side-by-side.
  const [openEditHistory, setOpenEditHistory] = useState<Set<string>>(() => new Set());
  // Task #120 — in-place edit state. Only one row can be in edit mode at a
  // time so the audit-trail save button doesn't get visually ambiguous.
  const [editing, setEditing] = useState<{
    phrase: string;
    category: "absence" | "hedging" | "buzzword";
    rationale: string;
  } | null>(null);

  const { data, isLoading } = useGetHandwavyPhrases({
    query: { queryKey: getGetHandwavyPhrasesQueryKey() },
  });

  const phrases = data?.phrases ?? [];
  const history = data?.history ?? [];
  const [draftCategory, setDraftCategory] = useState<"absence" | "hedging" | "buzzword">("absence");
  const CATEGORY_LABELS: Record<"absence" | "hedging" | "buzzword", string> = {
    absence: "Self-admitted absence of evidence",
    hedging: "Generic hedging",
    buzzword: "Buzzword-soup framing",
  };

  const persistReviewer = (value: string) => {
    setReviewer(value);
    if (typeof window === "undefined") return;
    try {
      if (value.trim()) {
        window.localStorage.setItem(HANDWAVY_REVIEWER_KEY, value.trim());
      } else {
        window.localStorage.removeItem(HANDWAVY_REVIEWER_KEY);
      }
    } catch {
      // ignore storage failures (private mode, quota)
    }
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetHandwavyPhrasesQueryKey() });
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const phrase = draft.trim();
    if (!phrase) return;
    setBusy("preview");
    try {
      // Task #114: ask the API to score the candidate against the corpus
      // BEFORE we persist anything. The server returns the identical phrase
      // (normalized) plus a per-tier match summary. Reviewer/rationale
      // (Task #112) are deferred to the confirm step so the audit trail
      // only records phrases the reviewer actually committed to.
      const dry = await addHandwavyPhrase({ phrase, category: draftCategory, dryRun: true });
      if (!dry.dryRunMatches) {
        // Fail closed: if the server's response is missing the preview block
        // we do NOT silently fall through to a real add. The whole point of
        // the two-step flow is that reviewers see corpus impact before any
        // mutation, so degraded API responses must surface as an error.
        toast({
          title: "Preview unavailable",
          description: "The server did not return a corpus impact preview. The phrase was not added — please retry.",
          variant: "destructive",
        });
        return;
      }
      setPreview({
        phrase: dry.phrase,
        category: (dry.category ?? draftCategory) as "absence" | "hedging" | "buzzword",
        matches: dry.dryRunMatches,
        reviewer: reviewer.trim() || undefined,
        rationale: draftRationale.trim() || undefined,
        productionMatches: dry.dryRunMatchesProduction ?? null,
        productionError: dry.dryRunMatchesProductionError ?? null,
        productionLimit: dry.dryRunMatchesProductionLimit ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to preview phrase.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleConfirmPreview = async () => {
    if (!preview) return;
    setBusy("confirm");
    try {
      const result = await addHandwavyPhrase({
        phrase: preview.phrase,
        category: preview.category,
        reviewer: preview.reviewer,
        rationale: preview.rationale,
      });
      if (result.added === false) {
        toast({ title: "Already in the list", description: `"${result.phrase}" was already a hand-wavy marker.` });
      } else {
        toast({ title: "Phrase added", description: `New triages will flag "${result.phrase}" (${CATEGORY_LABELS[preview.category]}) immediately.` });
      }
      setDraft("");
      setDraftRationale("");
      setPreview(null);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add phrase.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleCancelPreview = () => {
    setPreview(null);
  };

  const handleStartEdit = (phrase: string, category: "absence" | "hedging" | "buzzword", rationale: string | undefined) => {
    setEditing({ phrase, category, rationale: rationale ?? "" });
  };

  const handleCancelEdit = () => {
    setEditing(null);
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setBusy(`edit:${editing.phrase}`);
    try {
      const result = await editHandwavyPhrase({
        phrase: editing.phrase,
        category: editing.category,
        rationale: editing.rationale,
        reviewer: reviewer.trim() || undefined,
      });
      if (result.edited === false) {
        toast({ title: "No changes", description: `"${editing.phrase}" already matched the supplied values.` });
      } else {
        toast({ title: "Phrase updated", description: `"${editing.phrase}" was updated. Edit recorded in the audit trail.` });
      }
      setEditing(null);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to edit phrase.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Task #132 — one-click undo of a single edit-history entry. The server
  // restores whichever fields the entry recorded a change to back to their
  // before-values and appends a fresh inverse edit (so the audit log stays
  // append-only). A no-op revert (e.g. a later edit already put the field
  // back) returns edited=false and we surface that as a "nothing to undo"
  // toast so the reviewer doesn't think the click was lost.
  const handleRevertEdit = async (phrase: string, entry: HandwavyEditEntry) => {
    const editedAt =
      entry.editedAt instanceof Date ? entry.editedAt.toISOString() : String(entry.editedAt);
    const key = `revert:${phrase}:${editedAt}`;
    setBusy(key);
    try {
      const result = await revertHandwavyPhraseEdit({
        phrase,
        editedAt,
        reviewer: reviewer.trim() || undefined,
      });
      if (result.edited === false) {
        toast({
          title: "Nothing to undo",
          description: `"${phrase}" already matches the values from that edit — likely because a later edit reverted it.`,
        });
      } else {
        toast({
          title: "Edit reverted",
          description: `"${phrase}" is back to the values from before that edit. The revert is recorded as a new audit entry.`,
        });
      }
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to revert edit.";
      toast({ title: "Revert failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (phrase: string) => {
    setBusy(`rm:${phrase}`);
    try {
      await removeHandwavyPhrase({ phrase, reviewer: reviewer.trim() || undefined });
      toast({ title: "Phrase removed", description: `"${phrase}" will no longer trigger the FLAT haircut.` });
      // Drop the now-removed phrase from the selection so the bulk button
      // doesn't carry stale entries forward.
      setSelected((prev) => {
        if (!prev.has(phrase)) return prev;
        const next = new Set(prev);
        next.delete(phrase);
        return next;
      });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to remove phrase.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Task #134 — bulk-remove helpers. The selection set lives independently of
  // the active list so an in-flight refresh doesn't visually flicker the
  // checkboxes; we filter against the live `phrases` list at render time.
  const toggleSelected = (phrase: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phrase)) next.delete(phrase);
      else next.add(phrase);
      return next;
    });
  };
  const allPhrases = phrases.map((p) => p.phrase);
  const selectedInList = allPhrases.filter((p) => selected.has(p));
  const allSelected = allPhrases.length > 0 && selectedInList.length === allPhrases.length;
  const someSelected = selectedInList.length > 0 && !allSelected;
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allPhrases));
    }
  };

  const openBulkConfirm = () => {
    if (selectedInList.length === 0) return;
    setBulkResults(null);
    setBulkConfirm([...selectedInList]);
  };
  const cancelBulkConfirm = () => {
    setBulkConfirm(null);
  };
  const dismissBulkResults = () => {
    setBulkResults(null);
  };

  const confirmBulkRemove = async () => {
    if (!bulkConfirm || bulkConfirm.length === 0) return;
    setBusy("bulk-remove");
    const results: Array<{ phrase: string; status: BulkOutcome; message?: string }> = [];
    let authFailedSticky = false;
    const reviewerName = reviewer.trim() || undefined;
    for (const phrase of bulkConfirm) {
      if (authFailedSticky) {
        // Mirror the CLI: once auth fails for one phrase the token is bad for
        // every subsequent phrase, so don't bother issuing more requests.
        results.push({
          phrase,
          status: "auth-failed",
          message: "skipped after earlier auth failure",
        });
        continue;
      }
      try {
        await removeHandwavyPhrase({ phrase, reviewer: reviewerName });
        results.push({ phrase, status: "removed" });
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 401 || status === 403) {
          authFailedSticky = true;
          results.push({
            phrase,
            status: "auth-failed",
            message: `HTTP ${status}`,
          });
        } else if (status === 404) {
          results.push({
            phrase,
            status: "not-found",
            message: "server reported 404 (already removed?)",
          });
        } else {
          const msg = err instanceof Error ? err.message : "Unknown error";
          results.push({ phrase, status: "error", message: msg });
        }
      }
    }
    // Refresh ONCE after the whole batch — the active list and history view
    // both update from a single refetch instead of one per DELETE.
    refresh();
    // Drop successfully-removed phrases from the selection so the next batch
    // doesn't try to act on them again.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of results) {
        if (r.status === "removed") next.delete(r.phrase);
      }
      return next;
    });
    setBulkConfirm(null);
    setBulkResults(results);
    setBusy(null);

    const removed = results.filter((r) => r.status === "removed").length;
    const notFound = results.filter((r) => r.status === "not-found").length;
    const authFailed = results.filter((r) => r.status === "auth-failed").length;
    const errored = results.filter((r) => r.status === "error").length;
    const failures = notFound + authFailed + errored;
    if (failures === 0) {
      const noun = removed === 1 ? "phrase" : "phrases";
      toast({
        title: `${removed} ${noun} removed`,
        description: "The active list has been refreshed.",
      });
    } else {
      const parts: string[] = [];
      if (removed > 0) parts.push(`${removed} removed`);
      if (notFound > 0) parts.push(`${notFound} not-found`);
      if (authFailed > 0) parts.push(`${authFailed} auth-failed`);
      if (errored > 0) parts.push(`${errored} error${errored === 1 ? "" : "s"}`);
      toast({
        title: "Bulk removal finished with issues",
        description: parts.join(" · "),
        variant: removed === 0 ? "destructive" : undefined,
      });
    }
  };

  // Task #121 — one-click reinstate of a removed phrase straight from the
  // history log. The history row is identified by phrase + removedAt so two
  // distinct removes of the same phrase can be reinstated independently. The
  // server pulls the original category and rationale from that history row,
  // so the reviewer doesn't have to retype anything.
  const handleReinstate = async (entry: { phrase: string; removedAt: HandwavyHistoryEntry["removedAt"]; category?: HandwavyHistoryEntry["category"] }) => {
    const key = `reinstate:${entry.phrase}:${entry.removedAt}`;
    setBusy(key);
    try {
      const removedAt =
        entry.removedAt instanceof Date
          ? entry.removedAt.toISOString()
          : String(entry.removedAt);
      await reinstateHandwavyPhrase({
        phrase: entry.phrase,
        removedAt,
        reviewer: reviewer.trim() || undefined,
      });
      toast({
        title: "Phrase reinstated",
        description: `"${entry.phrase}" is back on the active list with its original ${CATEGORY_LABELS[entry.category as keyof typeof CATEGORY_LABELS] ?? entry.category ?? "absence"} context.`,
      });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reinstate phrase.";
      toast({ title: "Reinstate failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Task #130 — mirror of #121's reinstate. After adding a phrase by mistake
  // a reviewer can press Undo within UNDO_WINDOW_MS to remove it; the
  // resulting history row is tagged `undone: true` so the audit trail reads
  // "added then undone" rather than producing an unrelated manual-removal
  // entry. The Undo button only appears on the SINGLE most-recently-added
  // marker (and only while still inside the window) — older entries fall
  // back to the regular Trash flow.
  const UNDO_WINDOW_MS = 5 * 60 * 1000;
  // Re-render every ~15s while a fresh add exists so the Undo button
  // visibly disappears once its window elapses (rather than waiting for
  // the next click somewhere on the panel).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  // Find the most recently-added marker that's still inside the undo
  // window. Curated defaults (no `addedAt`) are skipped — they were never
  // "added" by a reviewer in the first place, so there's nothing to undo.
  const undoCandidate = useMemo(() => {
    let best: { phrase: string; addedAtIso: string; addedAtMs: number } | null = null;
    const now = Date.now();
    for (const m of phrases) {
      if (!m.addedAt) continue;
      const iso = String(m.addedAt);
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue;
      if (now - ms > UNDO_WINDOW_MS) continue;
      if (!best || ms > best.addedAtMs) {
        best = { phrase: m.phrase, addedAtIso: iso, addedAtMs: ms };
      }
    }
    return best;
    // The tick state forces this to re-evaluate periodically so the window
    // expires visually; phrases.length covers add/remove/refresh changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrases]);

  const handleUndo = async (phrase: string, addedAtIso: string) => {
    const key = `undo:${phrase}:${addedAtIso}`;
    setBusy(key);
    try {
      await undoHandwavyPhrase({
        phrase,
        addedAt: addedAtIso,
        reviewer: reviewer.trim() || undefined,
      });
      toast({
        title: "Add undone",
        description: `"${phrase}" was rolled back. The audit trail now records this as an undo, not a manual removal.`,
      });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to undo phrase.";
      toast({ title: "Undo failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Most recent removals first, capped to keep the panel tidy.
  // Task #135 — batch entries (one reviewer action that removed multiple
  // phrases at once) are flattened into one display row per inner phrase
  // for the audit panel. Each flattened row carries the parent batch's
  // removedAt + a `batchSize` label so reviewers can still see "this came
  // out of a batch of N".
  type DisplayHistoryRow = {
    phrase: string;
    category: HandwavyHistoryEntry["category"];
    addedBy?: string;
    addedAt?: HandwavyHistoryEntry["addedAt"];
    rationale?: string;
    removedBy?: string;
    removedAt: HandwavyHistoryEntry["removedAt"];
    reinstated?: boolean;
    reinstatedBy?: string;
    reinstatedAt?: HandwavyHistoryEntry["reinstatedAt"];
    batchSize?: number;
  };
  const flattenedHistory: DisplayHistoryRow[] = [];
  for (const h of history) {
    if (Array.isArray(h.phrases) && h.phrases.length > 0) {
      for (const inner of h.phrases) {
        flattenedHistory.push({
          phrase: inner.phrase,
          category: inner.category,
          addedBy: inner.addedBy,
          addedAt: inner.addedAt,
          rationale: inner.rationale,
          removedBy: h.removedBy,
          removedAt: h.removedAt,
          reinstated: inner.reinstated,
          reinstatedBy: inner.reinstatedBy,
          reinstatedAt: inner.reinstatedAt,
          batchSize: h.phrases.length,
        });
      }
    } else if (typeof h.phrase === "string" && h.phrase.length > 0) {
      flattenedHistory.push({
        phrase: h.phrase,
        category: h.category,
        addedBy: h.addedBy,
        addedAt: h.addedAt,
        rationale: h.rationale,
        removedBy: h.removedBy,
        removedAt: h.removedAt,
        reinstated: h.reinstated,
        reinstatedBy: h.reinstatedBy,
        reinstatedAt: h.reinstatedAt,
      });
    }
  }
  const sortedHistory = flattenedHistory.sort((a, b) => {
    const ta = Date.parse(String(a.removedAt ?? "")) || 0;
    const tb = Date.parse(String(b.removedAt ?? "")) || 0;
    return tb - ta;
  });
  const visibleHistory = sortedHistory.slice(0, 25);

  // Task #131 — per-phrase "thrash" counter. A cycle is a remove+reinstate
  // round-trip on the same phrase, which we read straight off the existing
  // history log (each reinstated row = one completed cycle). Surfacing the
  // count next to active phrases lets reviewers spot contentious markers
  // that flip back and forth before the next flip happens.
  const thrashByPhrase = new Map<
    string,
    Array<{
      removedAt: string;
      removedBy?: string;
      reinstatedAt?: string;
      reinstatedBy?: string;
    }>
  >();
  for (const h of history) {
    if (!h.reinstated) continue;
    const removedAt = h.removedAt ? String(h.removedAt) : "";
    const reinstatedAt = h.reinstatedAt ? String(h.reinstatedAt) : undefined;
    const list = thrashByPhrase.get(h.phrase) ?? [];
    list.push({
      removedAt,
      removedBy: h.removedBy,
      reinstatedAt,
      reinstatedBy: h.reinstatedBy,
    });
    thrashByPhrase.set(h.phrase, list);
  }
  // Sort each phrase's cycles oldest → newest so the tooltip reads
  // chronologically.
  for (const list of thrashByPhrase.values()) {
    list.sort((a, b) => {
      const ta = Date.parse(a.removedAt) || 0;
      const tb = Date.parse(b.removedAt) || 0;
      return ta - tb;
    });
  }

  return (
    <Card className="glass-card rounded-xl border-primary/10" data-testid="handwavy-admin">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageCircleQuestion className="w-4 h-4 text-primary" />
            FLAT Hand-wavy Marker Phrases
          </CardTitle>
          <Badge variant="secondary" className="text-[10px]">{phrases.length} active</Badge>
        </div>
        <CardDescription>
          Curated list of buzzword-soup framings the FLAT haircut looks for. Add a new
          phrase here and it takes effect on the very next triage — no engineer or
          redeploy needed. Phrases are matched as case-insensitive substrings against a
          whitespace-collapsed copy of the report text. Each entry records who added it,
          when, and (optionally) why, so reviewers can spot accidental over-reach later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-2 items-stretch">
          <input
            type="text"
            value={reviewer}
            onChange={(e) => persistReviewer(e.target.value)}
            placeholder="Your name or email (recorded in the audit trail)"
            maxLength={200}
            className="flex-1 h-9 px-3 rounded-md border border-border/40 bg-background/40 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
            data-testid="handwavy-reviewer"
            aria-label="Reviewer name or email"
          />
          {reviewer.trim() ? (
            <Badge variant="outline" className="text-[10px] self-center px-2 py-1">
              Audited as {reviewer.trim()}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] self-center px-2 py-1 text-muted-foreground">
              No reviewer set — entries will be marked anonymous
            </Badge>
          )}
        </div>
        <form onSubmit={handleAdd} className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. comprehensive zero-trust assessment"
              maxLength={200}
              className="flex-1 h-9 px-3 rounded-md border border-border/40 bg-background/40 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
              data-testid="handwavy-input"
              disabled={busy === "preview" || busy === "confirm" || preview !== null}
            />
            <select
              value={draftCategory}
              onChange={(e) => setDraftCategory(e.target.value as "absence" | "hedging" | "buzzword")}
              className="h-9 px-2 rounded-md border border-border/40 bg-background/40 text-xs"
              data-testid="handwavy-category"
              disabled={busy === "preview" || busy === "confirm" || preview !== null}
              aria-label="Theme category"
            >
              <option value="absence">Absence of evidence</option>
              <option value="hedging">Generic hedging</option>
              <option value="buzzword">Buzzword soup</option>
            </select>
            <Button
              type="submit"
              size="sm"
              disabled={busy === "preview" || busy === "confirm" || preview !== null || draft.trim().length < 3}
              data-testid="handwavy-add"
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              {busy === "preview" ? "Checking corpus…" : "Preview impact"}
            </Button>
          </div>
          <textarea
            value={draftRationale}
            onChange={(e) => setDraftRationale(e.target.value)}
            placeholder="Optional rationale — why is this phrase a hand-wavy marker? (recorded in the audit trail)"
            maxLength={500}
            rows={2}
            className="w-full px-3 py-2 rounded-md border border-border/40 bg-background/40 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
            data-testid="handwavy-rationale"
            disabled={busy === "preview" || busy === "confirm" || preview !== null}
          />
        </form>
        {preview && (() => {
          // Task #119 — combined false-positive count across BOTH the curated
          // benchmark cohorts and the production-archive scan. Either signal
          // turning red flips the outer card + confirm button to destructive
          // styling so a phrase that's clean against the curated set but
          // catastrophic against production still trips the warning UI.
          const curatedFp = preview.matches.falsePositives;
          const productionFp = preview.productionMatches?.falsePositives ?? 0;
          const anyFp = curatedFp + productionFp;
          return (
          <div
            className={cn(
              "rounded-md border p-3 space-y-3",
              anyFp > 0
                ? "border-red-500/40 bg-red-500/5"
                : "border-emerald-500/40 bg-emerald-500/5",
            )}
            data-testid="handwavy-preview"
          >
            <div className="flex items-start gap-2">
              {anyFp > 0 ? (
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              ) : (
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
              )}
              <div className="text-xs flex-1">
                <div className="font-semibold text-foreground">
                  Corpus impact for &ldquo;{preview.phrase}&rdquo;
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Two signals: the curated benchmark cohorts (T1–T4 fixtures) and the
                  most recent production reports bucketed by their composite label.
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <PreviewMatchBlock
                kind="curated"
                title="Curated benchmark"
                subtitle={`${preview.matches.corpusSize} fixtures`}
                matches={preview.matches}
                emptyHint="No GREEN/YELLOW curated fixtures would be flagged"
              />
              {preview.productionMatches ? (
                <PreviewMatchBlock
                  kind="production"
                  title="Production archive"
                  subtitle={
                    preview.productionLimit != null
                      ? `last ${preview.productionMatches.corpusSize} of up to ${preview.productionLimit} reports`
                      : `last ${preview.productionMatches.corpusSize} reports`
                  }
                  matches={preview.productionMatches}
                  emptyHint="No GREEN/YELLOW production reports would be flagged"
                />
              ) : (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200"
                  data-testid="handwavy-preview-production-error"
                >
                  <div className="font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Production archive scan unavailable
                  </div>
                  <div className="mt-1 text-amber-100/80">
                    {preview.productionError ??
                      "The production archive scan did not return a result. Only the curated-corpus signal is shown."}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelPreview}
                disabled={busy === "confirm"}
                data-testid="handwavy-preview-cancel"
              >
                Back out
              </Button>
              <Button
                size="sm"
                variant={anyFp > 0 ? "destructive" : "default"}
                onClick={handleConfirmPreview}
                disabled={busy === "confirm"}
                data-testid="handwavy-preview-confirm"
              >
                {busy === "confirm"
                  ? "Adding…"
                  : anyFp > 0
                  ? "Add anyway"
                  : "Confirm add"}
              </Button>
            </div>
          </div>
          );
        })()}
        {/* Task #134 — bulk-remove confirmation banner. Shows EVERY selected
            phrase so the reviewer can eyeball the batch before any DELETE
            fires, mirroring the CLI's confirm-then-delete flow. */}
        {bulkConfirm && bulkConfirm.length > 0 && (
          <div
            className="rounded-md border border-red-500/40 bg-red-500/5 p-3 space-y-2 text-xs"
            data-testid="handwavy-bulk-confirm"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              <div className="flex-1">
                <div className="font-semibold text-foreground">
                  Remove {bulkConfirm.length} phrase{bulkConfirm.length === 1 ? "" : "s"} from the active list?
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Each phrase below will be deleted in its own request. The active list refreshes once when the batch finishes.
                </div>
              </div>
            </div>
            <ul
              className="max-h-48 overflow-y-auto pl-2 border-l border-red-500/30 space-y-0.5"
              data-testid="handwavy-bulk-confirm-list"
            >
              {bulkConfirm.map((p) => (
                <li key={p} className="font-mono text-foreground/80 break-all text-[11px]">• {p}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelBulkConfirm}
                disabled={busy === "bulk-remove"}
                data-testid="handwavy-bulk-cancel"
              >
                Back out
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={confirmBulkRemove}
                disabled={busy === "bulk-remove"}
                data-testid="handwavy-bulk-confirm-go"
              >
                {busy === "bulk-remove"
                  ? "Removing…"
                  : `Remove ${bulkConfirm.length} phrase${bulkConfirm.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        )}
        {/* Task #134 — per-phrase results banner shown after a bulk batch
            finishes, mirroring the CLI's per-phrase outcome summary. */}
        {bulkResults && (
          <div
            className="rounded-md border border-border/40 bg-background/40 p-3 space-y-2 text-xs"
            data-testid="handwavy-bulk-results"
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">Bulk removal results</span>
              <Badge variant="outline" className="text-[10px]">
                {bulkResults.filter((r) => r.status === "removed").length} / {bulkResults.length} removed
              </Badge>
              <button
                type="button"
                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline"
                onClick={dismissBulkResults}
                data-testid="handwavy-bulk-dismiss"
              >
                Dismiss
              </button>
            </div>
            <ul className="space-y-0.5">
              {bulkResults.map((r) => {
                const cfg =
                  r.status === "removed"
                    ? { label: "removed", color: "text-emerald-400", icon: <CheckCircle2 className="w-3 h-3" /> }
                    : r.status === "not-found"
                      ? { label: "not-found", color: "text-yellow-400", icon: <AlertTriangle className="w-3 h-3" /> }
                      : r.status === "auth-failed"
                        ? { label: "auth-failed", color: "text-red-400", icon: <XCircle className="w-3 h-3" /> }
                        : { label: "error", color: "text-red-400", icon: <XCircle className="w-3 h-3" /> };
                return (
                  <li
                    key={`${r.phrase}-${r.status}`}
                    className="flex items-start gap-2 text-[11px]"
                    data-testid="handwavy-bulk-result-row"
                  >
                    <span className={cn("flex items-center gap-1 w-24 shrink-0", cfg.color)}>
                      {cfg.icon}
                      <span className="uppercase tracking-wide font-bold text-[9px]">{cfg.label}</span>
                    </span>
                    <span className="font-mono text-foreground/80 break-all flex-1">{r.phrase}</span>
                    {r.message && (
                      <span className="text-muted-foreground text-[10px] italic shrink-0 max-w-[40%] truncate">
                        {r.message}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {isLoading ? (
          <Skeleton className="h-32 rounded-md" />
        ) : phrases.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No phrases configured.</div>
        ) : (
          <div className="border border-border/30 rounded-md max-h-96 overflow-y-auto">
            {/* Task #134 — bulk-action toolbar. Sticky so the "Remove
                selected" button stays in view while the reviewer scrolls a
                long list. Indeterminate select-all checkbox toggles the
                whole visible list at once. */}
            <div
              className="sticky top-0 z-10 bg-background/95 backdrop-blur flex items-center gap-3 px-3 py-2 border-b border-border/30 text-xs"
              data-testid="handwavy-bulk-toolbar"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleSelectAll}
                aria-label={allSelected ? "Deselect all phrases" : "Select all phrases"}
                data-testid="handwavy-select-all"
              />
              <span className="text-muted-foreground">
                {selectedInList.length > 0
                  ? `${selectedInList.length} selected`
                  : "Select phrases to remove in bulk"}
              </span>
              <Button
                variant="destructive"
                size="sm"
                className="ml-auto h-7 px-2 text-xs gap-1"
                disabled={
                  selectedInList.length === 0 ||
                  busy === "bulk-remove" ||
                  bulkConfirm !== null
                }
                onClick={openBulkConfirm}
                data-testid="handwavy-bulk-remove"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove selected{selectedInList.length > 0 ? ` (${selectedInList.length})` : ""}
              </Button>
            </div>
            <div className="divide-y divide-border/20">
            {phrases.map((m) => {
              const addedAt = formatAuditTimestamp(m.addedAt);
              const isCurated = !m.addedBy && !m.addedAt;
              const isEditing = editing?.phrase === m.phrase;
              const editsList: HandwavyEditEntry[] = m.edits ?? [];
              const lastEdit: HandwavyEditEntry | undefined =
                editsList.length > 0 ? editsList[editsList.length - 1] : undefined;
              const lastEditAt = formatAuditTimestamp(lastEdit?.editedAt);
              const isSelected = selected.has(m.phrase);
              // Task #134 + Task #120 — bulk selection and inline edit are
              // mutually exclusive on a per-row basis: while a row is being
              // edited the reviewer shouldn't be able to retire it via the
              // bulk path, and while a bulk batch is mid-flight or pending
              // confirmation the row's edit affordance is disabled. The
              // disable rules below keep both flows visible side-by-side
              // without letting them step on each other.
              const bulkBusy = busy === "bulk-remove" || bulkConfirm !== null;
              const isUndoTarget =
                undoCandidate !== null && undoCandidate.phrase === m.phrase;
              const undoBusyKey = isUndoTarget && undoCandidate
                ? `undo:${undoCandidate.phrase}:${undoCandidate.addedAtIso}`
                : null;
              // Task #131 — count of completed remove+reinstate cycles for
              // this phrase, derived from the existing history log. Surfaced
              // as a hover-able badge so reviewers can spot contentious
              // markers at a glance.
              const cycles = thrashByPhrase.get(m.phrase) ?? [];
              return (
                <div
                  key={m.phrase}
                  className="flex flex-col gap-1 px-3 py-2 text-xs"
                  data-testid="handwavy-row"
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 cursor-pointer accent-primary shrink-0"
                      checked={isSelected}
                      onChange={() => toggleSelected(m.phrase)}
                      disabled={bulkBusy || isEditing}
                      aria-label={`Select phrase ${m.phrase} for bulk removal`}
                      data-testid="handwavy-select"
                    />
                    <span className="flex-1 font-mono text-foreground/80 break-all">{m.phrase}</span>
                    {/* Task #131 — thrash counter badge appears before the
                       category/edit affordances so reviewers see the
                       contentious-marker signal alongside the existing
                       bulk-select + inline-edit controls. */}
                    {cycles.length > 0 && (
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger
                            type="button"
                            className="cursor-help inline-flex"
                            data-testid="handwavy-thrash-badge"
                            aria-label={`Removed and reinstated ${cycles.length} time${cycles.length === 1 ? "" : "s"}`}
                          >
                            <Badge
                              variant="outline"
                              className="text-[10px] border-amber-500/40 text-amber-300"
                            >
                              <RotateCcw className="w-3 h-3 mr-1" />
                              Removed and reinstated {cycles.length}×
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            align="end"
                            collisionPadding={12}
                            className="max-w-xs glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal"
                            data-testid="handwavy-thrash-tooltip"
                          >
                            <div className="text-[11px] font-semibold mb-1">
                              {cycles.length} remove + reinstate {cycles.length === 1 ? "cycle" : "cycles"}
                            </div>
                            <ol className="space-y-1.5 text-[10px] leading-snug">
                              {cycles.map((c, i) => (
                                <li key={`${c.removedAt}-${i}`} className="space-y-0.5">
                                  <div>
                                    <span className="text-muted-foreground">#{i + 1} removed:</span>{" "}
                                    {formatAuditTimestamp(c.removedAt) ?? "unknown date"}
                                    {" by "}
                                    <span className="text-foreground/90">{c.removedBy || "anonymous"}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">reinstated:</span>{" "}
                                    {formatAuditTimestamp(c.reinstatedAt) ?? "unknown date"}
                                    {" by "}
                                    <span className="text-foreground/90">{c.reinstatedBy || "anonymous"}</span>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    {isEditing ? (
                      <select
                        value={editing!.category}
                        onChange={(e) =>
                          setEditing((prev) =>
                            prev ? { ...prev, category: e.target.value as "absence" | "hedging" | "buzzword" } : prev,
                          )
                        }
                        className="h-7 px-1.5 rounded border border-border/40 bg-background/40 text-[10px]"
                        data-testid="handwavy-edit-category"
                        aria-label={`Edit category for ${m.phrase}`}
                      >
                        <option value="absence">absence</option>
                        <option value="hedging">hedging</option>
                        <option value="buzzword">buzzword</option>
                      </select>
                    ) : (
                      <Badge variant="outline" className="text-[10px] capitalize">{m.category}</Badge>
                    )}
                    {isEditing ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-emerald-300 hover:text-emerald-200"
                          disabled={busy === `edit:${m.phrase}`}
                          onClick={handleSaveEdit}
                          data-testid="handwavy-edit-save"
                          aria-label={`Save edit for ${m.phrase}`}
                        >
                          <Save className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground"
                          disabled={busy === `edit:${m.phrase}`}
                          onClick={handleCancelEdit}
                          data-testid="handwavy-edit-cancel"
                          aria-label={`Cancel edit for ${m.phrase}`}
                        >
                          <XIcon className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        {isUndoTarget && undoCandidate && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[10px] text-amber-300 hover:text-amber-200"
                            disabled={editing !== null || busy === undoBusyKey}
                            onClick={() => handleUndo(undoCandidate.phrase, undoCandidate.addedAtIso)}
                            data-testid="handwavy-undo"
                            aria-label={`Undo adding phrase ${m.phrase}`}
                            title="Undo this brand-new add (within 5 minutes)"
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />
                            {busy === undoBusyKey ? "Undoing…" : "Undo"}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground hover:text-primary"
                          disabled={editing !== null || busy === `rm:${m.phrase}` || bulkBusy}
                          onClick={() => handleStartEdit(m.phrase, m.category, m.rationale)}
                          data-testid="handwavy-edit"
                          aria-label={`Edit phrase ${m.phrase}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground hover:text-red-400"
                          disabled={editing !== null || busy === `rm:${m.phrase}` || bulkBusy}
                          onClick={() => handleRemove(m.phrase)}
                          data-testid="handwavy-remove"
                          aria-label={`Remove phrase ${m.phrase}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                  <div
                    className="text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5"
                    data-testid="handwavy-audit"
                  >
                    {isCurated ? (
                      <span className="italic">Curated default</span>
                    ) : (
                      <>
                        <span>
                          Added by{" "}
                          <span className="text-foreground/80">{m.addedBy || "anonymous"}</span>
                        </span>
                        {addedAt && (
                          <span data-testid="handwavy-added-at">{addedAt}</span>
                        )}
                      </>
                    )}
                    {lastEdit && (
                      <span data-testid="handwavy-last-edit">
                        Last edit by{" "}
                        <span className="text-foreground/80">{lastEdit.editedBy || "anonymous"}</span>
                        {lastEditAt && <> • {lastEditAt}</>}
                      </span>
                    )}
                    {editsList.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setOpenEditHistory((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.phrase)) next.delete(m.phrase);
                            else next.add(m.phrase);
                            return next;
                          })
                        }
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground/80 underline-offset-2 hover:underline"
                        data-testid="handwavy-edit-history-toggle"
                        aria-expanded={openEditHistory.has(m.phrase)}
                        aria-controls={`handwavy-edit-history-${m.phrase}`}
                        aria-label={`${openEditHistory.has(m.phrase) ? "Hide" : "Show"} full edit history for ${m.phrase} (${editsList.length} edits)`}
                      >
                        <Clock className="w-3 h-3" />
                        {openEditHistory.has(m.phrase) ? "Hide" : "Show"} history ({editsList.length} edits)
                      </button>
                    )}
                  </div>
                  {!isEditing && editsList.length === 1 && (
                    // Task #132 — single-edit case keeps the lightweight
                    // <details> affordance so reviewers can still revert
                    // the one recorded edit. The Task #133 toggle only
                    // renders for >1 edits, so this stays the entry
                    // point for one-edit rows.
                    <details className="text-[10px]" data-testid="handwavy-edits-details">
                      <summary className="cursor-pointer text-muted-foreground/80 hover:text-foreground/80 select-none">
                        Show edit
                      </summary>
                      <ul
                        className="mt-1 space-y-1 border-l border-primary/20 pl-2"
                        data-testid="handwavy-edits-list"
                      >
                        {renderHandwavyEditEntries({
                          editsList,
                          phrase: m.phrase,
                          editing,
                          busy,
                          handleRevertEdit,
                        })}
                      </ul>
                    </details>
                  )}
                  {!isEditing && editsList.length > 1 && openEditHistory.has(m.phrase) && (
                    // Task #133 — full chronological history panel,
                    // toggled per row via openEditHistory. Each entry
                    // also carries Task #132's Revert button so the
                    // expanded view doubles as the restore surface.
                    <div
                      id={`handwavy-edit-history-${m.phrase}`}
                      className="mt-1 ml-1 border-l-2 border-primary/20 pl-2 flex flex-col gap-1.5"
                      data-testid="handwavy-edit-history-list"
                    >
                      <ul
                        className="space-y-1.5"
                        data-testid="handwavy-edits-list"
                      >
                        {renderHandwavyEditEntries({
                          editsList,
                          phrase: m.phrase,
                          editing,
                          busy,
                          handleRevertEdit,
                          showHistoryTestIds: true,
                        })}
                      </ul>
                    </div>
                  )}
                  {isEditing ? (
                    <textarea
                      value={editing!.rationale}
                      onChange={(e) =>
                        setEditing((prev) => (prev ? { ...prev, rationale: e.target.value } : prev))
                      }
                      placeholder="Rationale (leave empty to clear)"
                      maxLength={500}
                      rows={2}
                      className="w-full mt-1 px-2 py-1.5 rounded border border-border/40 bg-background/40 text-[11px] resize-y"
                      data-testid="handwavy-edit-rationale"
                      aria-label={`Edit rationale for ${m.phrase}`}
                    />
                  ) : (
                    m.rationale && (
                      <div
                        className="text-[11px] text-foreground/70 italic pl-1 border-l border-primary/30"
                        data-testid="handwavy-rationale-display"
                      >
                        “{m.rationale}”
                      </div>
                    )
                  )}
                </div>
              );
            })}
            </div>
          </div>
        )}
        {sortedHistory.length > 0 && (
          <div className="pt-2 border-t border-border/20">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground/80 flex items-center gap-1"
              data-testid="handwavy-history-toggle"
              aria-expanded={showHistory}
            >
              <Clock className="w-3 h-3" />
              {showHistory ? "Hide" : "Show"} removal &amp; undo history ({sortedHistory.length})
            </button>
            {showHistory && (
              <div
                className="mt-2 border border-border/20 rounded-md divide-y divide-border/10 max-h-64 overflow-y-auto"
                data-testid="handwavy-history-list"
              >
                {visibleHistory.map((h, idx) => {
                  const removedAtKey =
                    h.removedAt instanceof Date
                      ? h.removedAt.toISOString()
                      : String(h.removedAt);
                  const reinstateKey = `reinstate:${h.phrase}:${removedAtKey}`;
                  // The phrase is also "active" if it lives in the current
                  // markers list — for example, someone manually re-added it
                  // (without using the reinstate button) after it was
                  // removed. Hide the button so we don't show a control that
                  // would 409 server-side.
                  const isActive = phrases.some((m: { phrase: string }) => m.phrase === h.phrase);
                  // Task #130 — render undo rows with a distinct amber-tinted
                  // background and an "Undone" verb so the audit trail
                  // explicitly distinguishes them from manual removals.
                  const isUndone = h.undone === true;
                  return (
                    <div
                      key={`${h.phrase}-${removedAtKey}-${idx}`}
                      className={cn(
                        "px-3 py-2 text-[11px] text-muted-foreground space-y-0.5",
                        isUndone && "bg-amber-500/5 border-l-2 border-amber-500/40",
                      )}
                      data-testid="handwavy-history-row"
                      data-history-kind={isUndone ? "undone" : "removed"}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-foreground/70 break-all flex-1 line-through">{h.phrase}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">{h.category}</Badge>
                        {isUndone && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-amber-500/40 text-amber-300"
                            data-testid="handwavy-history-undone"
                          >
                            Undone
                          </Badge>
                        )}
                        {h.reinstated ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-500/40 text-emerald-300"
                            data-testid="handwavy-history-reinstated"
                          >
                            Reinstated
                          </Badge>
                        ) : isActive ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-muted-foreground"
                            data-testid="handwavy-history-active"
                          >
                            Already active
                          </Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-emerald-300 hover:text-emerald-200"
                            disabled={busy === reinstateKey}
                            onClick={() => handleReinstate(h)}
                            data-testid="handwavy-reinstate"
                            aria-label={`Reinstate phrase ${h.phrase}`}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />
                            {busy === reinstateKey ? "Reinstating…" : "Reinstate"}
                          </Button>
                        )}
                      </div>
                      <div>
                        {isUndone ? "Undone by " : "Removed by "}
                        <span className="text-foreground/80">
                          {(isUndone ? h.undoneBy : h.removedBy) || "anonymous"}
                        </span>
                        {" • "}
                        {formatAuditTimestamp(h.removedAt) ?? "unknown date"}
                        {h.batchSize && h.batchSize > 1 && (
                          <span
                            className="ml-2 text-foreground/60"
                            data-testid="handwavy-history-batch-label"
                          >
                            (part of a batch removal of {h.batchSize})
                          </span>
                        )}
                      </div>
                      {(h.addedBy || h.rationale) && (
                        <div className="text-foreground/60">
                          Originally added by{" "}
                          <span className="text-foreground/80">{h.addedBy || "anonymous"}</span>
                          {h.rationale && <> — “{h.rationale}”</>}
                        </div>
                      )}
                      {h.reinstated && (
                        <div
                          className="text-emerald-300/80"
                          data-testid="handwavy-history-reinstated-meta"
                        >
                          Reinstated by{" "}
                          <span className="text-foreground/80">{h.reinstatedBy || "anonymous"}</span>
                          {" • "}
                          {formatAuditTimestamp(h.reinstatedAt) ?? "unknown date"}
                        </div>
                      )}
                    </div>
                  );
                })}
                {sortedHistory.length > visibleHistory.length && (
                  <div className="px-3 py-2 text-[10px] italic text-muted-foreground/70">
                    Showing the {visibleHistory.length} most recent of {sortedHistory.length} removals.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ArchetypeFixture {
  id: string;
  tier: string;
  composite: number;
  avriOnScore: number;
  avriOffScore: number | null;
  distanceToCeiling: number;
  triage: string;
  passed: boolean;
}

interface ArchetypeRow {
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  minDistanceToCeiling: number;
  ceiling: number;
  fixtures: ArchetypeFixture[];
}

interface TestRunResponse {
  archetypes?: ArchetypeRow[];
}

interface ArchetypeHistorySnapshot {
  timestamp: string;
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  minDistanceToCeiling: number;
  ceiling: number;
  // Task #92 — true when the row is a daily roll-up of older snapshots
  // produced by the archetype-history compaction pass.
  aggregated?: boolean;
}

interface ArchetypeHistoryResponse {
  totalSnapshots: number;
  archetypes: Array<{ archetype: string; snapshots: ArchetypeHistorySnapshot[] }>;
}

function HeadroomSparkline({ snapshots, ceiling }: {
  snapshots: ArchetypeHistorySnapshot[];
  ceiling: number;
}) {
  if (snapshots.length < 2) {
    return (
      <span className="text-[10px] text-muted-foreground/50 italic">
        {snapshots.length === 1 ? "1 snapshot" : "no history"}
      </span>
    );
  }
  const W = 100;
  const H = 28;
  const PAD = 2;
  const ys = snapshots.map(s => s.minDistanceToCeiling);
  // Y-axis fixed to [0, ceiling] so multiple sparklines compare visually.
  const yMin = 0;
  const yMax = ceiling;
  const points = ys.map((y, i) => {
    const x = PAD + (i / (ys.length - 1)) * (W - 2 * PAD);
    const norm = Math.max(yMin, Math.min(yMax, y));
    const py = PAD + (1 - (norm - yMin) / (yMax - yMin)) * (H - 2 * PAD);
    return `${x.toFixed(1)},${py.toFixed(1)}`;
  });
  const last = ys[ys.length - 1]!;
  const lastX = PAD + (W - 2 * PAD);
  const lastY = PAD + (1 - (Math.max(0, Math.min(ceiling, last)) - yMin) / (yMax - yMin)) * (H - 2 * PAD);
  const stroke = last < 5 ? "#f87171" : last < 10 ? "#facc15" : "#34d399";

  // Task #92 — older snapshots are down-sampled to one daily row per
  // archetype. Render the aggregated prefix as a dashed segment so
  // reviewers can tell raw recent points from rolled-up history at a
  // glance. Both segments share the boundary point so the line is
  // continuous.
  const aggregatedCount = snapshots.filter(s => s.aggregated).length;
  const rawCount = snapshots.length - aggregatedCount;
  // Find the actual transition index by scanning the ordered snapshots
  // rather than relying on the count alone — this stays correct even if
  // upstream ordering ever interleaves aggregated/raw rows.
  const firstRawIdx = snapshots.findIndex(s => !s.aggregated);
  let aggregatedPoints: string[] = [];
  let rawPoints: string[] = [];
  if (firstRawIdx === -1) {
    aggregatedPoints = points;
  } else if (firstRawIdx === 0) {
    rawPoints = points;
  } else {
    // Share the boundary point so the two segments connect visually.
    aggregatedPoints = points.slice(0, firstRawIdx + 1);
    rawPoints = points.slice(firstRawIdx);
  }

  const parts: string[] = [];
  if (aggregatedCount > 0) {
    parts.push(`${aggregatedCount} daily aggregate${aggregatedCount === 1 ? "" : "s"}`);
  }
  if (rawCount > 0 || aggregatedCount === 0) {
    parts.push(`${rawCount} recent`);
  }
  const tooltip = `${parts.join(" + ")}: ${ys[0]!.toFixed(1)}pt → ${last.toFixed(1)}pt headroom`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-24 h-7" role="img" aria-label={tooltip}>
      <title>{tooltip}</title>
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="rgba(255,255,255,0.08)" strokeWidth={0.5} />
      {aggregatedPoints.length >= 2 && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeOpacity={0.6}
          strokeWidth={1.25}
          strokeDasharray="2 1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={aggregatedPoints.join(" ")}
        />
      )}
      {rawPoints.length >= 2 && (
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          points={rawPoints.join(" ")}
        />
      )}
      <circle cx={lastX} cy={lastY} r={1.6} fill={stroke} />
    </svg>
  );
}

/**
 * Compute the recent decline in headroom, in composite points. Positive
 * value means the latest snapshot has shrunk vs. the older comparison
 * window (worst-case, most regression-y direction).
 */
function recentHeadroomDecline(snapshots: ArchetypeHistorySnapshot[]): number {
  if (snapshots.length < 2) return 0;
  // Compare current minDistanceToCeiling to the max observed in the
  // earlier half of the window — picks up the worst regression rather
  // than just the prior snapshot.
  const cur = snapshots[snapshots.length - 1]!.minDistanceToCeiling;
  const earlier = snapshots.slice(0, Math.max(1, Math.floor(snapshots.length / 2)));
  const prevBest = Math.max(...earlier.map(s => s.minDistanceToCeiling));
  return Number((prevBest - cur).toFixed(1));
}

const ARCHETYPE_LABELS: Record<string, string> = {
  fabricated_diff: "Fabricated diff",
  paraphrased_cve: "Paraphrased CVE",
  narrated_curl: "Narrated curl",
  pseudo_asan: "Pseudo ASAN",
  prose_poc: "Prose PoC",
};

function ArchetypeRowView({
  row,
  threshold,
  history,
  declineThreshold,
}: {
  row: ArchetypeRow;
  threshold: number;
  history: ArchetypeHistorySnapshot[];
  declineThreshold: number;
}) {
  const tight = row.minDistanceToCeiling < threshold;
  const label = ARCHETYPE_LABELS[row.archetype] ?? row.archetype;
  const worst = row.fixtures.reduce<ArchetypeFixture | null>(
    (acc, f) => (acc === null || f.avriOnScore > acc.avriOnScore ? f : acc),
    null,
  );
  const distanceColor = tight
    ? "text-red-400"
    : row.minDistanceToCeiling < threshold * 2
      ? "text-yellow-400"
      : "text-green-400";

  const decline = recentHeadroomDecline(history);
  const shrinking = history.length >= 2 && decline >= declineThreshold;

  return (
    <div
      className={cn(
        "py-3 border-b border-border/20 last:border-0",
        (tight || shrinking) && "bg-red-500/5 -mx-4 px-4 rounded",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <code className="text-[10px] font-mono text-muted-foreground/60">{row.archetype}</code>
            {tight && (
              <Badge variant="outline" className="text-[10px] gap-1 text-red-400 bg-red-400/10 border-red-400/30">
                <AlertTriangle className="w-3 h-3" /> Tight headroom
              </Badge>
            )}
            {shrinking && (
              <Badge variant="outline" className="text-[10px] gap-1 text-orange-400 bg-orange-400/10 border-orange-400/30">
                <TrendingUp className="w-3 h-3 rotate-180" /> Headroom shrinking −{decline.toFixed(1)}pt
              </Badge>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {row.count} fixture{row.count === 1 ? "" : "s"}
            {worst && (
              <>
                {" · worst-case "}
                <code className="font-mono">{worst.id}</code>
                {" @ "}
                <span className="tabular-nums">{worst.avriOnScore.toFixed(1)}</span>
              </>
            )}
            {history.length > 0 && (
              <>
                {" · "}
                <span className="tabular-nums">{history.length}</span> snapshot{history.length === 1 ? "" : "s"}
              </>
            )}
          </div>
        </div>
        <div className="w-24 shrink-0">
          <HeadroomSparkline snapshots={history} ceiling={row.ceiling} />
        </div>
        <div className="text-right w-20">
          <div className="text-sm font-bold tabular-nums">{row.avriOnMean.toFixed(1)}</div>
          <div className="text-[10px] text-muted-foreground">mean (AVRI on)</div>
        </div>
        <div className="text-right w-20">
          <div className="text-sm font-bold tabular-nums">{row.avriOnMax.toFixed(1)}</div>
          <div className="text-[10px] text-muted-foreground">worst score</div>
        </div>
        <div className="text-right w-24">
          <div className={cn("text-sm font-bold tabular-nums", distanceColor)}>
            {row.minDistanceToCeiling > 0 ? "+" : ""}
            {row.minDistanceToCeiling.toFixed(1)}
          </div>
          <div className="text-[10px] text-muted-foreground">to ceiling ({row.ceiling})</div>
        </div>
      </div>
    </div>
  );
}

const ARCHETYPE_HISTORY_QUERY_KEY = ["test-run-archetype-history"] as const;

const AVRI_DRIFT_RUNBOOK_REPO_BASE =
  "https://github.com/REMEDiSSecurity/VulnRap.Com/blob/main/";

function runbookUrl(runbookPath: string): string {
  if (/^https?:\/\//i.test(runbookPath)) return runbookPath;
  const cleaned = runbookPath.replace(/^\.?\/+/, "");
  return AVRI_DRIFT_RUNBOOK_REPO_BASE + cleaned;
}

function DriftFlagBadge({ kind, gapWarn, familyShiftWarn }: {
  kind: AvriDriftFlag["kind"];
  gapWarn: number;
  familyShiftWarn: number;
}) {
  const cfg = kind === "GAP_BELOW_45"
    ? { label: `Gap < ${gapWarn}pt`, color: "text-red-400 bg-red-400/10 border-red-400/30" }
    : { label: `Family shift ≥ ${familyShiftWarn}pt`, color: "text-orange-400 bg-orange-400/10 border-orange-400/30" };
  return (
    <Badge variant="outline" className={cn("text-[10px] gap-1 font-mono", cfg.color)}>
      <AlertTriangle className="w-3 h-3" /> {cfg.label}
    </Badge>
  );
}

function GapSparkline({ weeks, gapWarn }: { weeks: AvriDriftWeekBucket[]; gapWarn: number }) {
  const eligible = weeks.filter(w => w.gapEligible && w.gap != null);
  if (eligible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground/50 py-4 text-center">
        Not enough reports per bucket yet to chart the T1−T3 gap.
      </p>
    );
  }
  const W = 480;
  const H = 120;
  const PAD = { top: 12, right: 12, bottom: 22, left: 36 };
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;
  const gaps = eligible.map(w => w.gap as number);
  const minY = Math.min(...gaps, gapWarn) - 5;
  const maxY = Math.max(...gaps, gapWarn) + 5;
  const span = Math.max(1, maxY - minY);
  const xFor = (i: number) => PAD.left + (eligible.length === 1 ? pw / 2 : (i / (eligible.length - 1)) * pw);
  const yFor = (g: number) => PAD.top + ph - ((g - minY) / span) * ph;
  const path = eligible.map((w, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(w.gap as number)}`).join(" ");
  const warnY = yFor(gapWarn);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: "140px" }}>
      <line x1={PAD.left} y1={warnY} x2={W - PAD.right} y2={warnY} stroke="#ef4444" strokeWidth={1} strokeDasharray="3,3" />
      <text x={PAD.left - 4} y={warnY + 3} textAnchor="end" fill="#ef4444" fontSize={8} fontFamily="monospace">{gapWarn}</text>
      <path d={path} fill="none" stroke="#06b6d4" strokeWidth={1.5} />
      {eligible.map((w, i) => {
        const flagged = (w.gap as number) < gapWarn;
        return (
          <g key={w.weekStart}>
            <circle cx={xFor(i)} cy={yFor(w.gap as number)} r={3} fill={flagged ? "#ef4444" : "#06b6d4"} />
            <text
              x={xFor(i)}
              y={H - 6}
              textAnchor="middle"
              fill="rgba(255,255,255,0.4)"
              fontSize={7}
              fontFamily="monospace"
            >
              {w.weekStart.slice(5)}
            </text>
          </g>
        );
      })}
      <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="monospace">
        {Math.round(maxY)}
      </text>
      <text x={PAD.left - 4} y={H - PAD.bottom + 2} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="monospace">
        {Math.round(minY)}
      </text>
    </svg>
  );
}

function FamilyMeansTable({ rows, bucket }: { rows: AvriDriftFamilyMean[]; bucket: "T1" | "T3" }) {
  if (rows.length === 0) {
    return <p className="text-[10px] text-muted-foreground/40 italic">No {bucket} reports this week</p>;
  }
  return (
    <div className="space-y-1">
      {rows.map(r => (
        <div key={`${bucket}-${r.family}`} className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground truncate">{r.family}</span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="tabular-nums text-foreground/80">{r.mean.toFixed(1)}</span>
            <span className="text-muted-foreground/40 tabular-nums">n={r.count}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmergingArchetypesSection() {
  const [threshold, setThreshold] = useState(5);
  const [declineThreshold, setDeclineThreshold] = useState(5);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, dataUpdatedAt } = useQuery<TestRunResponse>({
    queryKey: ["test-run-archetypes"],
    queryFn: async () => {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/test/run`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 300_000,
    retry: false,
  });

  // Invalidate the persisted-history query whenever a fresh /api/test/run
  // result lands so the new snapshot appears in the sparkline immediately,
  // rather than waiting for the 5-minute refetch tick.
  useEffect(() => {
    if (data) {
      queryClient.invalidateQueries({ queryKey: ARCHETYPE_HISTORY_QUERY_KEY });
    }
  }, [dataUpdatedAt, data, queryClient]);

  // Sprint 13 — pull persisted per-archetype headroom snapshots so each row
  // can render a sparkline alongside its current worst-score number.
  const { data: historyData } = useQuery<ArchetypeHistoryResponse>({
    queryKey: ARCHETYPE_HISTORY_QUERY_KEY,
    queryFn: async () => {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/test/archetype-history`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 300_000,
    retry: false,
    // Refetch right after a /test/run completes so the new snapshot lands.
    enabled: !isError,
  });

  if (isLoading) {
    return <Skeleton className="h-48 rounded-xl" />;
  }

  // /api/test/run is dev-only; in production the endpoint 404s. Hide the
  // panel rather than surface a noisy error to reviewers.
  if (isError || !data?.archetypes || data.archetypes.length === 0) {
    return null;
  }

  const rows = data.archetypes;
  const historyByArchetype = new Map<string, ArchetypeHistorySnapshot[]>();
  for (const a of historyData?.archetypes ?? []) {
    historyByArchetype.set(a.archetype, a.snapshots);
  }
  const tightCount = rows.filter(r => r.minDistanceToCeiling < threshold).length;
  const shrinkingCount = rows.filter(r => {
    const h = historyByArchetype.get(r.archetype) ?? [];
    return h.length >= 2 && recentHeadroomDecline(h) >= declineThreshold;
  }).length;
  const ceilingMax = rows.reduce((m, r) => Math.max(m, r.ceiling), 35);

  return (
    <Card className="glass-card rounded-xl border-primary/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Emerging Slop Archetypes
            <Badge variant="secondary" className="text-[10px]">{rows.length}</Badge>
            {tightCount > 0 && (
              <Badge variant="outline" className="text-[10px] gap-1 text-red-400 bg-red-400/10 border-red-400/30">
                <AlertTriangle className="w-3 h-3" /> {tightCount} tight
              </Badge>
            )}
            {shrinkingCount > 0 && (
              <Badge variant="outline" className="text-[10px] gap-1 text-orange-400 bg-orange-400/10 border-orange-400/30">
                <TrendingUp className="w-3 h-3 rotate-180" /> {shrinkingCount} shrinking
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>Alert below</span>
              <input
                type="number"
                min={0}
                max={ceilingMax}
                step={1}
                value={threshold}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v)) setThreshold(Math.max(0, Math.min(ceilingMax, v)));
                }}
                className="w-14 px-2 py-1 rounded-md bg-background border border-border text-foreground tabular-nums text-xs"
              />
              <span>pts</span>
            </label>
            <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>Trend drop ≥</span>
              <input
                type="number"
                min={1}
                max={ceilingMax}
                step={1}
                value={declineThreshold}
                onChange={e => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v)) setDeclineThreshold(Math.max(1, Math.min(ceilingMax, v)));
                }}
                className="w-14 px-2 py-1 rounded-md bg-background border border-border text-foreground tabular-nums text-xs"
              />
              <span>pts</span>
            </label>
          </div>
        </div>
        <CardDescription>
          Each row groups the dev fixture battery by reviewer-facing slop archetype.
          Distance to ceiling is the worst-case AVRI-on composite vs. the LIKELY-INVALID
          cutoff (35) — small numbers mean the next regression could escape auto-rejection.
          The sparkline plots persisted headroom over the last {historyData?.totalSnapshots ?? 0} run snapshots,
          and rows where headroom shrank by ≥ {declineThreshold}pt are flagged.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.map(r => (
          <ArchetypeRowView
            key={r.archetype}
            row={r}
            threshold={threshold}
            declineThreshold={declineThreshold}
            history={historyByArchetype.get(r.archetype) ?? []}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function AvriDriftSection() {
  const { data, isLoading, error } = useGetAvriDriftReport(undefined, {
    query: {
      queryKey: getGetAvriDriftReportQueryKey(),
      refetchInterval: 300_000,
    },
  });

  if (isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (error || !data) {
    return (
      <Card className="glass-card rounded-xl border-red-500/10">
        <CardContent className="p-6 text-center text-xs text-muted-foreground">
          Could not load the AVRI drift report.
        </CardContent>
      </Card>
    );
  }

  const report: AvriDriftReport = data;
  const flagsByWeek = new Map<string, AvriDriftFlag[]>();
  for (const f of report.flags) {
    if (!flagsByWeek.has(f.weekStart)) flagsByWeek.set(f.weekStart, []);
    flagsByWeek.get(f.weekStart)!.push(f);
  }
  const recentWeeks = [...report.weeks].slice(-6).reverse();
  const flaggedCount = report.flags.length;
  const headerColor = flaggedCount === 0
    ? "text-green-400 bg-green-400/10"
    : "text-orange-400 bg-orange-400/10";

  return (
    <Card className="glass-card rounded-xl border-primary/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            AVRI Drift Dashboard
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("text-[10px] gap-1", headerColor)}>
              <Shield className="w-3 h-3" />
              {flaggedCount === 0 ? "No drift flags" : `${flaggedCount} flag${flaggedCount === 1 ? "" : "s"}`}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {report.totalReportsScanned} reports · {report.weeksRequested}w
            </Badge>
          </div>
        </div>
        <CardDescription className="space-y-1">
          <span className="block">
            Rolling weekly view of the AVRI composite, bucketed by triage outcome
            (T1-equivalent vs T3-equivalent). Flags fire when the T1−T3 gap drops
            below {report.thresholds.gapWarn}pt or any family mean shifts by ≥{report.thresholds.familyShiftWarn}pt
            week-over-week (min {report.thresholds.minBucketSize} reports per bucket).
          </span>
          <a
            href={runbookUrl(report.runbookPath)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
          >
            <BookOpen className="w-3 h-3" />
            Open the AVRI drift runbook
            <ExternalLink className="w-3 h-3" />
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Weekly T1−T3 composite gap (warn line at {report.thresholds.gapWarn}pt)
          </div>
          <GapSparkline weeks={report.weeks} gapWarn={report.thresholds.gapWarn} />
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Drift flags
          </div>
          {report.flags.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 py-2 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              No drift flags fired in the last {report.weeksRequested} weeks.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {report.flags.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <DriftFlagBadge
                    kind={f.kind}
                    gapWarn={report.thresholds.gapWarn}
                    familyShiftWarn={report.thresholds.familyShiftWarn}
                  />
                  <span className="text-muted-foreground/80 font-mono text-[10px] shrink-0 pt-0.5">
                    {f.weekStart}
                  </span>
                  <span className="text-foreground/80 leading-relaxed">{f.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Recent weeks (T1/T3 means and per-family breakdown)
          </div>
          {recentWeeks.length === 0 ? (
            <p className="text-xs text-muted-foreground/50 py-4 text-center">
              No AVRI-scored reports in the lookback window yet.
            </p>
          ) : (
            <div className="space-y-3">
              {recentWeeks.map(week => {
                const weekFlags = flagsByWeek.get(week.weekStart) ?? [];
                return (
                  <div
                    key={week.weekStart}
                    className={cn(
                      "p-3 rounded-lg border space-y-3",
                      weekFlags.length > 0
                        ? "border-orange-400/30 bg-orange-400/[0.03]"
                        : "border-border/40 bg-muted/[0.03]",
                    )}
                  >
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-foreground">{week.weekStart}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {week.reportCount} report{week.reportCount === 1 ? "" : "s"}
                        </span>
                        {weekFlags.map((f, i) => (
                          <DriftFlagBadge
                            key={i}
                            kind={f.kind}
                            gapWarn={report.thresholds.gapWarn}
                            familyShiftWarn={report.thresholds.familyShiftWarn}
                          />
                        ))}
                      </div>
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="tabular-nums">
                          <span className="text-muted-foreground">T1 </span>
                          <span className="text-foreground font-medium">
                            {week.t1.mean != null ? week.t1.mean.toFixed(1) : "—"}
                          </span>
                          <span className="text-muted-foreground/50"> (n={week.t1.count})</span>
                        </span>
                        <span className="tabular-nums">
                          <span className="text-muted-foreground">T3 </span>
                          <span className="text-foreground font-medium">
                            {week.t3.mean != null ? week.t3.mean.toFixed(1) : "—"}
                          </span>
                          <span className="text-muted-foreground/50"> (n={week.t3.count})</span>
                        </span>
                        <span className={cn(
                          "tabular-nums font-mono px-1.5 py-0.5 rounded",
                          week.gapEligible && week.gap != null && week.gap < report.thresholds.gapWarn
                            ? "bg-red-400/10 text-red-400"
                            : "bg-primary/10 text-primary",
                        )}>
                          gap {week.gap != null ? week.gap.toFixed(1) : "—"}
                          {!week.gapEligible && (
                            <span className="text-muted-foreground/50 ml-1">·n/a</span>
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
                          T1 families
                        </div>
                        <FamilyMeansTable rows={week.perFamily.t1} bucket="T1" />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
                          T3 families
                        </div>
                        <FamilyMeansTable rows={week.perFamily.t3} bucket="T3" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/60 italic leading-relaxed border-t border-border/30 pt-3">
          {report.bucketingNote}
        </p>
      </CardContent>
    </Card>
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

      <EmergingArchetypesSection />

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
