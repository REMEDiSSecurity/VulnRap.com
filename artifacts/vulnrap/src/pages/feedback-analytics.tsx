import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useGetFeedbackAnalytics, getGetFeedbackAnalyticsQueryKey,
  useGetCalibrationReport, getGetCalibrationReportQueryKey,
  useGetScoringConfig, getGetScoringConfigQueryKey,
  useGetAvriDriftReport, getGetAvriDriftReportQueryKey,
  useGetAvriDriftNotifications, getGetAvriDriftNotificationsQueryKey,
  rearmAvriDriftNotifications,
  ApiError,
  type AvriDriftNotificationRecord,
  useGetCalibrationAuthStatus, getGetCalibrationAuthStatusQueryKey,
  useGetHandwavyPhrases, getGetHandwavyPhrasesQueryKey,
  useListHandwavyPhraseRemovalBatches, getListHandwavyPhraseRemovalBatchesQueryKey,
  addHandwavyPhrase, removeHandwavyPhrase, reinstateHandwavyPhrase, reinstateHandwavyPhrasesBatch,
  editHandwavyPhrase, undoHandwavyPhrase,
  revertHandwavyPhraseEdit,
  type HandwavyPhraseDryRunMatches,
  type HandwavyPhraseDryRunOverlaps,
  type HandwavyPhraseDryRunOverlapsMatchesItem,
  type HandwavyPhraseDryRunOverlapsMatchesItemRelation,
  type HandwavyPhraseBatchRemoveDryRunResponse,
  type HandwavyPhraseBatchRemoveDryRunImpact,
  type HandwavyPhraseBatchRemoveResultEntry,
  type HandwavyPhraseRemovalBatchSummary,
  type HandwavyPhraseReinstateBatchDryRunResponse,
  type HandwavyPhraseReinstateBatchEntryResult,
  type HandwavyPhraseSingleRemoveDryRunResponse,
  type HandwavyHistoryEntry,
  type HandwavyEditEntry,
  type HandwavyCategory,
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
  getCalibrationToken,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link, useSearchParams } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare, Star, ThumbsUp, ThumbsDown, TrendingUp, AlertTriangle,
  BarChart3, Users, ArrowRight, Clock, Hash, Settings, Shield, Zap,
  CheckCircle2, XCircle, Info, Play, Layers, Activity, BookOpen, ExternalLink,
  Plus, Trash2, MessageCircleQuestion, RotateCcw, Pencil, Save, X as XIcon, Undo2,
  KeyRound, ArrowLeftRight,
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

// Task #117 — small status indicator + (when relevant) banner explaining
// whether the dashboard is going to be able to perform calibration mutations.
// Without this, the only signal a reviewer gets when the API server has
// `CALIBRATION_TOKEN` set but the UI build does not is a generic 401 toast
// per attempted add/remove — which doesn't tell them WHY their phrase didn't
// stick. We probe the un-gated `/feedback/calibration/auth-status` endpoint
// (which reports whether the server requires a token AND whether the token
// the UI sent — if any — would be accepted) and render a token chip in the
// Scoring Calibration card header. When mutations would be rejected we also
// show a prominent warning above the calibration UI so the reviewer doesn't
// burn a bunch of clicks finding out the hard way.
type CalibrationAuthStateKind =
  | "loading"
  | "open"        // server doesn't require a token; UI is fine either way
  | "valid"       // server requires a token and the UI is sending the right one
  | "missing"     // server requires a token and the UI isn't sending one at all
  | "invalid"     // server requires a token and the UI is sending the wrong one
  | "probe-failed"; // the auth-status probe itself failed (network/server error)

interface CalibrationAuthState {
  kind: CalibrationAuthStateKind;
  // Convenience flag: false when reviewers should be warned that mutations
  // will 401. `loading` and `probe-failed` are treated as "allowed" because
  // we don't want to block the UI on a transient probe failure — the worst
  // case (mutations actually fail) still shows the existing 401 toast.
  mutationsAllowed: boolean;
}

function useCalibrationAuthState(): CalibrationAuthState {
  // Refetch periodically so a reviewer who configures the server token while
  // the dashboard is open sees the indicator flip without a hard reload.
  const { data, isLoading, isError } = useGetCalibrationAuthStatus({
    query: {
      queryKey: getGetCalibrationAuthStatusQueryKey(),
      refetchInterval: 60_000,
      retry: 1,
    },
  });
  if (isLoading) return { kind: "loading", mutationsAllowed: true };
  if (isError || !data) return { kind: "probe-failed", mutationsAllowed: true };
  if (!data.serverRequiresToken) return { kind: "open", mutationsAllowed: true };
  if (data.tokenValid) return { kind: "valid", mutationsAllowed: true };
  if (data.tokenPresented) return { kind: "invalid", mutationsAllowed: false };
  return { kind: "missing", mutationsAllowed: false };
}

function CalibrationAuthBadge({ state }: { state: CalibrationAuthState }) {
  let className: string;
  let label: string;
  let title: string;
  switch (state.kind) {
    case "loading":
      className = "text-muted-foreground bg-muted/20";
      label = "Reviewer token: checking…";
      title = "Probing the calibration auth endpoint to see whether a reviewer token is required.";
      break;
    case "open":
      className = "text-muted-foreground bg-muted/20";
      label = "Reviewer token: not required";
      title = "The API server has no CALIBRATION_TOKEN configured, so calibration mutations are open to any caller.";
      break;
    case "valid":
      className = "text-green-400 bg-green-400/10";
      label = "Reviewer token: configured";
      title = "The API server requires a reviewer token and the dashboard build supplies the correct one. Mutations will be accepted.";
      break;
    case "missing":
      className = "text-red-400 bg-red-400/10";
      label = "Reviewer token: missing";
      title = "The API server requires a reviewer token but this UI build is not sending one (VITE_CALIBRATION_TOKEN unset). Calibration mutations will be rejected with 401.";
      break;
    case "invalid":
      className = "text-red-400 bg-red-400/10";
      label = "Reviewer token: invalid";
      title = "The API server requires a reviewer token and this UI build is sending one, but the server rejected it. Calibration mutations will be rejected with 401.";
      break;
    case "probe-failed":
      className = "text-yellow-400 bg-yellow-400/10";
      label = "Reviewer token: probe failed";
      title = "Could not reach the auth-status endpoint to check whether a reviewer token is required. Mutations will still attempt — watch for 401 toasts.";
      break;
  }
  return (
    <Badge variant="outline" className={cn("text-[10px] gap-1", className)} title={title}>
      <KeyRound className="w-3 h-3" /> {label}
    </Badge>
  );
}

function CalibrationAuthBanner({ state }: { state: CalibrationAuthState }) {
  if (state.kind !== "missing" && state.kind !== "invalid") return null;
  const detail =
    state.kind === "missing"
      ? "This UI build is not sending a reviewer token (VITE_CALIBRATION_TOKEN was unset at build time), but the API server requires one. Adding, editing, or removing phrases — and applying calibration changes — will be rejected with HTTP 401."
      : "The reviewer token baked into this UI build was rejected by the API server (the build's VITE_CALIBRATION_TOKEN does not match the server's CALIBRATION_TOKEN). Calibration mutations will be rejected with HTTP 401.";
  return (
    <Card className="glass-card rounded-xl border-red-500/40 bg-red-500/5">
      <CardContent className="p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="text-sm font-semibold text-red-300">
            Calibration mutations will be rejected
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{detail}</p>
          <p className="text-xs text-muted-foreground/70 leading-relaxed">
            Read-only views (analytics, reports, version history) still work. To enable
            mutations, rebuild the UI with <code className="font-mono text-[11px]">VITE_CALIBRATION_TOKEN</code> set
            to the same value as the server's <code className="font-mono text-[11px]">CALIBRATION_TOKEN</code>.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function CalibrationSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [applying, setApplying] = useState(false);
  const authState = useCalibrationAuthState();

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
      <CalibrationAuthBanner state={authState} />
      <AvriDriftSection />
      <Card className="glass-card rounded-xl border-primary/10">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" />
              Scoring Calibration
            </CardTitle>
            <div className="flex items-center gap-2">
              <CalibrationAuthBadge state={authState} />
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

// Task #129 — pre-preview overlap detection. Mirror EXACTLY the
// normalization (`normalizePhrase` in handwavy-phrases.ts) and substring
// rules used by `detectCuratedOverlaps` in calibration.ts so the inline
// hint shown under the add-phrase input matches what the eventual server
// dry-run would surface, just rendered earlier (before the reviewer pays
// the round-trip + corpus scan + production DB hit).
type HandwavyOverlapRelation =
  | "equal"
  | "candidate-contains-existing"
  | "existing-contains-candidate";

interface HandwavyOverlapMatch {
  phrase: string;
  category: "absence" | "hedging" | "buzzword";
  relation: HandwavyOverlapRelation;
}

function normalizeHandwavyPhrase(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function isHandwavyCategory(value: unknown): value is HandwavyOverlapMatch["category"] {
  return value === "absence" || value === "hedging" || value === "buzzword";
}

function detectHandwavyCuratedOverlaps(
  rawCandidate: string,
  curated: ReadonlyArray<{ phrase: string; category: string }>,
): HandwavyOverlapMatch[] {
  const normalized = normalizeHandwavyPhrase(rawCandidate);
  if (normalized.length < 3) return [];
  const matches: HandwavyOverlapMatch[] = [];
  for (const m of curated) {
    const existing = typeof m?.phrase === "string" ? m.phrase : "";
    if (!existing) continue;
    let relation: HandwavyOverlapRelation | null = null;
    if (existing === normalized) {
      relation = "equal";
    } else if (existing.includes(normalized)) {
      relation = "existing-contains-candidate";
    } else if (normalized.includes(existing)) {
      relation = "candidate-contains-existing";
    }
    if (relation) {
      // Guard at runtime against malformed payloads — the API client type
      // says `category` is one of three strings but we'd rather degrade
      // gracefully (default to "absence") than render a missing label.
      const category = isHandwavyCategory(m.category) ? m.category : "absence";
      matches.push({ phrase: existing, category, relation });
    }
  }
  return matches;
}

function describeHandwavyOverlapRelation(rel: HandwavyOverlapRelation): string {
  switch (rel) {
    case "equal":
      return "exact duplicate of";
    case "candidate-contains-existing":
      return "broader than (would supersede)";
    case "existing-contains-candidate":
      return "already covered by";
  }
}

// Local-storage key for remembering the reviewer name/email between sessions
// so the audit trail captures who is curating without forcing a re-entry on
// every add/remove.
const HANDWAVY_REVIEWER_KEY = "vulnrap.handwavy.reviewer";
// Task #150 — persist the "Most contentious first" toggle so reviewers who
// triage thrashed phrases as part of their routine don't have to flip it on
// every visit. Stored as the literal string "1" when ON; missing/anything
// else defaults to OFF, preserving the original first-time experience.
const HANDWAVY_SORT_THRASH_KEY = "vulnrap.handwavy.sortByThrash";
// Task #125 — persist the reviewer-chosen production-scan window between
// sessions. Stored as a stringified integer; missing/invalid falls back to
// the server-side default (2000) so existing reviewers see no behavior change.
const HANDWAVY_PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.handwavy.productionScanLimit";
const HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT = 2000;
const HANDWAVY_PRODUCTION_SCAN_LIMIT_MIN = 100;
const HANDWAVY_PRODUCTION_SCAN_LIMIT_MAX = 10000;

// Task #140 — render the remaining undo window for the inline countdown on
// the Undo button (e.g. "4m 12s", "45s"). Math.ceil keeps the displayed
// value monotonically counting down without prematurely showing "0s" while
// fractional time still remains, so the button only ever flips to hidden
// at the true 0-mark.
function formatUndoRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${totalSec}s`;
}

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

// Task #124 — Format the production scan's createdAt window into a compact
// "scanned N reports from <oldest> to <newest>" line. We collapse to a single
// "on <date>" when both endpoints fall on the same calendar day so the UI
// doesn't render a confusing same-day range. Returns null when the scan
// produced no usable timestamps (curated block, empty production scan, or
// rows without createdAt) so the caller can omit the line entirely.
function formatProductionScanRange(
  oldestIso: string | null | undefined,
  newestIso: string | null | undefined,
): string | null {
  if (!oldestIso || !newestIso) return null;
  const oldest = new Date(oldestIso);
  const newest = new Date(newestIso);
  if (Number.isNaN(oldest.getTime()) || Number.isNaN(newest.getTime())) return null;
  const fmt: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  const oldestStr = oldest.toLocaleDateString(undefined, fmt);
  const newestStr = newest.toLocaleDateString(undefined, fmt);
  if (oldestStr === newestStr) return `on ${oldestStr}`;
  return `from ${oldestStr} to ${newestStr}`;
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
  // Task #124 — only the production block carries a createdAt window; the
  // curated block has no wall-clock timestamps so this returns null there.
  const scanRange = formatProductionScanRange(matches.oldestCreatedAt, matches.newestCreatedAt);
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
      {scanRange && (
        <div
          className="text-[10px] text-muted-foreground"
          data-testid={`handwavy-preview-${kind}-range`}
        >
          Scanned {matches.corpusSize} {sourceNoun}
          {matches.corpusSize === 1 ? "" : "s"} {scanRange}
        </div>
      )}
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

// Task #128 — describe a curated-overlap relation in human-readable English
// for the preview callout. Mirrors `describeOverlapRelation` in the CLI
// script (preview-handwavy-phrase.mjs) so the web UI and the CLI surface
// the same wording for the same `relation` value.
function describeOverlapRelation(rel: HandwavyPhraseDryRunOverlapsMatchesItemRelation): string {
  switch (rel) {
    case "equal":
      return "exact duplicate of";
    case "candidate-contains-existing":
      return "broader than (would supersede)";
    case "existing-contains-candidate":
      return "already covered by";
    default:
      return "overlaps with";
  }
}

// Task #128 — render the curated-phrase overlap callout inside the add
// preview panel. Mirrors the CLI's `renderOverlaps` block (the same
// equal / broader / narrower phrasing) and uses the GREEN/YELLOW
// false-positive callout's visual language so reviewers can spot the
// signal at a glance. Returns null when there are no overlaps so the
// panel stays compact for the common case.
function PreviewOverlapsBlock({ overlaps, candidate }: {
  overlaps: HandwavyPhraseDryRunOverlaps | null;
  candidate: string;
}) {
  if (!overlaps || overlaps.matches.length === 0) return null;
  const noun = overlaps.total === 1 ? "entry" : "entries";
  return (
    <div
      className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 space-y-1.5 text-xs text-red-100"
      data-testid="handwavy-preview-overlaps"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-300" />
        <div className="flex-1">
          <div className="font-semibold text-red-100">
            Overlaps with {overlaps.total} existing curated {noun} — adding may be redundant
          </div>
          <div className="text-[10px] text-red-200/80 mt-0.5">
            &ldquo;{candidate}&rdquo; matches phrases already on the active list. Reinstating
            or editing the existing entry is usually preferable to a near-duplicate add.
          </div>
        </div>
      </div>
      <ul className="ml-1 space-y-1">
        {overlaps.matches.map((o: HandwavyPhraseDryRunOverlapsMatchesItem) => (
          <li
            key={`${o.relation}::${o.phrase}`}
            className="flex items-start gap-1.5"
            data-testid="handwavy-preview-overlap-row"
          >
            <span className="text-red-300/80 select-none">•</span>
            <span className="flex-1">
              <span className="text-red-200 font-medium">{describeOverlapRelation(o.relation)}</span>{" "}
              <span className="text-foreground/90">&ldquo;{o.phrase}&rdquo;</span>{" "}
              <span className="text-[10px] text-red-200/70 uppercase tracking-wide">
                [{o.category}]
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Task #154 — render block for one bulk-removal corpus impact (curated
// benchmark fixtures or recent production reports). Mirrors the visual
// shape of `PreviewMatchBlock` (the add-time corpus impact preview) so
// reviewers see the same affordance for both add and remove flows. The
// `kind` prop only swaps the leading icon and the noun used for the
// sample-match list ("fixture" vs "report").
function BulkRemovalImpactBlock({
  kind,
  title,
  subtitle,
  impact,
  emptyHint,
}: {
  kind: "curated" | "production";
  title: string;
  subtitle: string;
  impact: HandwavyPhraseBatchRemoveDryRunImpact;
  emptyHint: string;
}) {
  const lost = impact.validDetectionsLost;
  const dropped = impact.falsePositivesDropped;
  const sourceNoun = kind === "curated" ? "fixture" : "report";
  return (
    <div
      className={cn(
        "rounded-md border p-2.5 space-y-1.5 text-xs",
        lost > 0
          ? "border-red-500/40 bg-red-500/10"
          : dropped > 0
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5",
      )}
      data-testid={`handwavy-bulk-preview-${kind}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-foreground">{title}</div>
        <Badge variant="outline" className="text-[9px] uppercase tracking-wide">
          {subtitle}
        </Badge>
      </div>
      {impact.warning ? (
        <div
          className="text-red-200 text-[11px]"
          data-testid={`handwavy-bulk-preview-${kind}-warning`}
        >
          {impact.warning}
        </div>
      ) : impact.total > 0 ? (
        <div className="text-amber-200 text-[11px]">
          {impact.total} false-positive {sourceNoun}{impact.total === 1 ? "" : "s"} would no longer be flagged — informational only, no real detections lost here.
        </div>
      ) : (
        <div className="text-emerald-200 text-[11px]">
          {emptyHint}.
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5 pt-0.5 text-[11px]">
        <PreviewTierBadge label="GREEN (T1 legit) dropped" count={impact.byTier.t1Legit} />
        <PreviewTierBadge label="YELLOW (T2 borderline) dropped" count={impact.byTier.t2Borderline} />
        <PreviewTierBadge label="RED (T3 slop) lost" count={impact.byTier.t3Slop} negative />
        <PreviewTierBadge
          label="RED (T4 hallucinated) lost"
          count={impact.byTier.t4Hallucinated}
          negative
        />
      </div>
      {impact.sampleMatches.length > 0 && (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Sample {sourceNoun}s that would lose their flag ({impact.sampleMatches.length})
          </summary>
          <ul className="mt-1 ml-3 list-disc space-y-0.5 font-mono">
            {impact.sampleMatches.map((s) => (
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

// Task #147 — word-level diff for rationale edits in the audit log so reviewers
// can see at a glance which words actually changed instead of mentally diffing
// two quoted strings. Tokenizing on whitespace+word runs keeps punctuation and
// spacing aligned with how reviewers read the text.
function tokenizeForDiff(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

type RationaleDiffOp = { type: "eq" | "add" | "del"; text: string };

function diffTokens(a: string[], b: string[]): RationaleDiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: RationaleDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  const merged: RationaleDiffOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}

function RationaleDiff({
  from,
  to,
  wrapperTestId = "handwavy-edit-rationale",
}: {
  from: string;
  to: string;
  wrapperTestId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const ops = useMemo(
    () => diffTokens(tokenizeForDiff(from), tokenizeForDiff(to)),
    [from, to],
  );
  // Long rationales get clamped to two lines until the reviewer asks for the
  // rest — keeps the audit log scannable without hiding any data.
  const longish = from.length > 140 || to.length > 140;
  const isEmptyFrom = from.length === 0;
  const isEmptyTo = to.length === 0;
  return (
    <div className="space-y-0.5" data-testid={wrapperTestId}>
      <div className="text-muted-foreground/60 uppercase tracking-wider text-[9px] font-semibold">
        rationale
      </div>
      <div
        className={cn(
          "rounded border border-border/30 bg-muted/20 px-1.5 py-1 leading-snug whitespace-pre-wrap break-words",
          !expanded && longish && "line-clamp-2",
        )}
        data-testid="handwavy-edit-rationale-diff"
      >
        {isEmptyFrom && !isEmptyTo && (
          <span className="italic text-muted-foreground/60 mr-1">(was empty)</span>
        )}
        {ops.map((op, idx) => {
          if (op.type === "eq") {
            return (
              <span key={idx} className="text-foreground/70">
                {op.text}
              </span>
            );
          }
          if (op.type === "add") {
            return (
              <span
                key={idx}
                className="bg-emerald-500/15 text-emerald-300 rounded-sm"
                data-testid="rationale-diff-add"
              >
                {op.text}
              </span>
            );
          }
          return (
            <span
              key={idx}
              className="bg-rose-500/15 text-rose-300 line-through rounded-sm"
              data-testid="rationale-diff-del"
            >
              {op.text}
            </span>
          );
        })}
        {!isEmptyFrom && isEmptyTo && (
          <span className="italic text-muted-foreground/60 ml-1">(cleared)</span>
        )}
      </div>
      {longish && (
        <button
          type="button"
          className="text-[9px] text-muted-foreground/70 hover:text-foreground/80 underline underline-offset-2"
          onClick={() => setExpanded((v) => !v)}
          data-testid="handwavy-edit-rationale-toggle"
        >
          {expanded ? "Show less" : "Show full text"}
        </button>
      )}
    </div>
  );
}

// Task #148 — pure helper that decides whether reverting a given edit entry
// would be a no-op against the current marker state. The Revert button is
// disabled when this returns true so reviewers don't get a "nothing to undo"
// toast from a click whose outcome was knowable up front. An entry that
// recorded no tracked field changes is treated as a no-op as well.
//
// Exported only so the focused unit test in feedback-analytics.test.tsx can
// exercise every branch without standing up the full HandwavyPhrasesAdmin
// query/auth stack. The runtime UI continues to call it in-module.
export function revertWouldBeNoop(
  entry: HandwavyEditEntry,
  currentCategory: HandwavyCategory,
  currentRationale: string | undefined,
): boolean {
  if (!entry.category && !entry.rationale) return true;
  if (entry.category && currentCategory !== entry.category.from) return false;
  if (entry.rationale) {
    const cur = currentRationale ?? "";
    const target = entry.rationale.from ?? "";
    if (cur !== target) return false;
  }
  return true;
}

// Shared renderer for the per-edit list. Both the single-edit
// <details> affordance (Task #132) and the full chronological history
// panel (Task #133) call this so they stay structurally aligned and
// every entry keeps the Revert button.
//
// Task #147 — category and rationale render as visually distinct blocks
// (pill swap for category, word-level inline diff for rationale) so
// reviewers can tell at a glance which fields changed.
function renderHandwavyEditEntries({
  editsList,
  phrase,
  currentCategory,
  currentRationale,
  editing,
  busy,
  onRevertClick,
  showHistoryTestIds,
}: {
  editsList: HandwavyEditEntry[];
  phrase: string;
  // Task #148 — current live values for the marker. Used to compute whether
  // each entry's Revert would be a no-op (so the button can be disabled with
  // an explanatory tooltip rather than firing and bouncing back as a toast).
  currentCategory: HandwavyCategory;
  currentRationale: string | undefined;
  editing: { phrase: string } | null;
  busy: string | null;
  // Task #146 — the click handler now opens a confirmation dialog rather
  // than calling the API directly, so the helper just forwards the entry
  // and lets the caller decide what to do with it.
  onRevertClick: (entry: HandwavyEditEntry) => void;
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
      // Task #148 — disable Revert when the entry's "from" values already
      // match the live marker state (a later edit already put things back,
      // or the entry recorded no tracked field changes). Reviewers see an
      // explanatory tooltip instead of a "nothing to undo" toast they only
      // discover after firing.
      const isNoop = revertWouldBeNoop(entry, currentCategory, currentRationale);
      return (
        <li
          key={`${editedAtKey}-${idx}`}
          className="flex items-start gap-2 text-[10px] text-muted-foreground"
          data-testid={showHistoryTestIds ? "handwavy-edit-history-row" : "handwavy-edit-entry"}
        >
          <div className="flex-1 space-y-1">
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
              <div
                className="flex items-center gap-1 flex-wrap"
                data-testid={
                  showHistoryTestIds ? "handwavy-edit-history-category" : "handwavy-edit-category"
                }
              >
                <span className="text-muted-foreground/60 uppercase tracking-wider text-[9px] font-semibold mr-1">
                  category
                </span>
                <span className="px-1.5 py-0.5 rounded bg-muted/40 text-foreground/70 capitalize">
                  {entry.category.from}
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground/60" />
                <span className="px-1.5 py-0.5 rounded bg-primary/15 text-primary capitalize">
                  {entry.category.to}
                </span>
              </div>
            )}
            {entry.rationale && (
              <RationaleDiff
                from={entry.rationale.from ?? ""}
                to={entry.rationale.to ?? ""}
                wrapperTestId={
                  showHistoryTestIds ? "handwavy-edit-history-rationale" : "handwavy-edit-rationale"
                }
              />
            )}
            {showHistoryTestIds && !entry.category && !entry.rationale && (
              <div className="italic">No tracked field changes recorded.</div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[10px] text-amber-300 hover:text-amber-200 shrink-0 disabled:text-muted-foreground/60"
            disabled={editing !== null || busy === revertKey || busy === `rm:${phrase}` || isNoop}
            onClick={() => onRevertClick(entry)}
            data-testid="handwavy-revert-edit"
            data-noop={isNoop ? "true" : "false"}
            aria-label={
              isNoop
                ? `Revert unavailable for ${phrase}: the marker already matches this edit's prior state.`
                : `Revert edit on ${phrase} from ${editedAtLabel ?? entry.editedAt}`
            }
            title={
              isNoop
                ? "Already at this state — nothing to revert."
                : "Restore the values from before this edit (recorded as a new audit entry)."
            }
          >
            <Undo2 className="w-3 h-3 mr-1" />
            {busy === revertKey
              ? "Reverting…"
              : isNoop
                ? "At this state"
                : "Revert"}
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
  // Task #125 — reviewer-chosen production-scan window for the dry-run
  // preview. Stored as a string so the input can be temporarily empty /
  // mid-edit; we coerce + clamp to an integer in the Min..Max range when
  // sending it to the server. Heavy-user installs can dial this up for a
  // sharper false-positive signal; small installs can dial it down to
  // focus on recent reporter behavior. Defaults to 2000, matching the
  // server-side default so existing reviewers see no behavior change.
  const [productionScanLimitInput, setProductionScanLimitInput] = useState<string>(() => {
    if (typeof window === "undefined") return String(HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT);
    try {
      const stored = window.localStorage.getItem(HANDWAVY_PRODUCTION_SCAN_LIMIT_KEY);
      if (stored == null) return String(HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT);
      const parsed = Number.parseInt(stored, 10);
      if (
        !Number.isFinite(parsed) ||
        parsed < HANDWAVY_PRODUCTION_SCAN_LIMIT_MIN ||
        parsed > HANDWAVY_PRODUCTION_SCAN_LIMIT_MAX
      ) {
        return String(HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT);
      }
      return String(parsed);
    } catch {
      return String(HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT);
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  // Task #146 — confirmation prompt for the per-edit Revert button. We hold
  // the (phrase, entry) pair the reviewer clicked so the dialog can summarize
  // exactly which fields will change and to what values before we actually
  // call the server. `null` = closed.
  const [revertConfirm, setRevertConfirm] = useState<
    { phrase: string; entry: HandwavyEditEntry } | null
  >(null);
  // Task #153 — same shape of confirmation prompt for the per-row Reinstate
  // button on the removal-history list. Reinstating restores a phrase to
  // active use, so we hold the row the reviewer clicked and summarize the
  // phrase, category, and original rationale before calling the server.
  // `null` = closed.
  const [reinstateConfirm, setReinstateConfirm] = useState<
    DisplayHistoryRow | null
  >(null);
  // Task #177 — dry-run preview for the per-batch "Reinstate all" flow. The
  // server's /reinstate-batch endpoint accepts `dryRun: true` (Task #159) and
  // returns the same per-phrase outcome shape as the mutating call without
  // touching the active list or the audit log. This state holds the preview
  // response for the batch the reviewer is currently inspecting; `null` =
  // no preview open. Confirming from the panel runs the real (non-dry-run)
  // call and clears this state.
  const [reinstatePreview, setReinstatePreview] = useState<{
    removedAtIso: string;
    data: HandwavyPhraseReinstateBatchDryRunResponse;
  } | null>(null);
  // Task #180 — the per-row Reinstate button got a confirm dialog in Task #153
  // but the "Reinstate all N" button on a batch removal entry was still firing
  // immediately on click. A misclick on the batch button re-enables every
  // phrase from a batch removal at once, which is a much bigger blast radius
  // than a single per-row reinstate, so we guard it with the same dialog
  // pattern. The state holds the full set of inputs the action handler needs
  // (removedAt + batchSize) plus the list of phrase strings that would
  // actually become active again so the dialog can list them. `null` = closed.
  // This dialog is the direct-click gate; the Task #177 dry-run Preview
  // button next to it is its own (richer) confirm flow and doesn't need
  // this dialog on top of it.
  const [reinstateBatchConfirm, setReinstateBatchConfirm] = useState<
    {
      removedAtIso: string;
      removedBy?: string;
      batchSize: number;
      phrasesToReinstate: string[];
    } | null
  >(null);
  // Task #134 + Task #154 — bulk-remove state. `selected` is the set of
  // currently-checked phrases (keyed by the normalized `phrase` string
  // the server stores). Bulk removal goes through the side-by-side
  // preview panel (`bulkPreview` below): the reviewer ticks rows, opens
  // the preview, and only the preview's confirm button can fire the
  // actual DELETEs (one per phrase, one batched refresh after).
  // `bulkResults` keeps the per-phrase outcome (removed / not-found /
  // auth-failed / error) visible after the batch completes so the
  // reviewer can see exactly what happened without squinting at toasts.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Task #139 — when a single-phrase remove targets a phrase that's already
  // been thrash'd (>=2 completed remove+reinstate cycles), we pause the DELETE
  // behind a confirm panel so the reviewer sees the prior cycles before
  // triggering what's likely to become cycle #N+1. Phrases with 0 or 1 cycles
  // continue to fire the DELETE immediately, exactly as before.
  type RemoveConfirmCycle = {
    removedAt: string;
    removedBy?: string;
    reinstatedAt?: string;
    reinstatedBy?: string;
  };
  const [removeConfirm, setRemoveConfirm] = useState<{
    phrase: string;
    cycles: RemoveConfirmCycle[];
  } | null>(null);
  // Task #142 — `reinstated` is the success outcome for the per-batch
  // "Undo this batch" action that lives on the results banner. It uses the
  // same banner shape as the removal outcomes so the reviewer sees the
  // post-undo per-phrase summary in the exact same place the removal
  // summary just was. `removedAt` is captured per row so the undo handler
  // can call the existing single-phrase reinstate endpoint with the
  // history-row identifier the server already records.
  type BulkOutcome =
    | "removed"
    | "not-found"
    | "auth-failed"
    | "error"
    | "reinstated";
  type BulkResultRow = {
    phrase: string;
    status: BulkOutcome;
    message?: string;
    removedAt?: string;
  };
  type BulkResultsState = {
    kind: "remove" | "undo";
    rows: BulkResultRow[];
  };
  const [bulkResults, setBulkResults] = useState<BulkResultsState | null>(null);
  // Task #154 — bulk-removal preview state. Mirrors the CLI `--dry-run` flow:
  // before the destructive DELETE fires we ask the server for a per-phrase
  // outcome breakdown plus the corpus + production impact, so the reviewer
  // can see "of these N, X are not on the active list, Y are duplicates,
  // the remaining Z would un-flag W legitimate hand-wavy reports between
  // them" and decide whether to proceed. `acknowledged` is set once the
  // reviewer ticks the explicit confirmation checkbox; the actual delete
  // button stays disabled until that flips when valid detections would be
  // lost (in either the curated corpus or the production sample).
  const [bulkPreview, setBulkPreview] = useState<{
    requestedPhrases: string[];
    data: HandwavyPhraseBatchRemoveDryRunResponse;
    acknowledged: boolean;
  } | null>(null);
  // Task #173 — single-phrase removal-impact preview state. The per-row
  // Trash button now first issues `DELETE {phrase, dryRun: true}` (Task
  // #155). When `validDetectionsLost === 0` we fire the live DELETE in
  // the same click, preserving the one-click affordance for safe
  // removals. When valid hand-wavy detections WOULD be lost, we hold the
  // dry-run response here and surface the same corpus + production
  // impact renderer (`BulkRemovalImpactBlock`) used by the batch
  // confirmation step, gating the destructive removal behind an explicit
  // acknowledgment checkbox.
  const [removePreview, setRemovePreview] = useState<{
    phrase: string;
    data: HandwavyPhraseSingleRemoveDryRunResponse;
    acknowledged: boolean;
  } | null>(null);
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
    // Task #128 — overlap signal mirroring the CLI's `dryRunOverlaps` block.
    // When non-null with `total > 0` the preview panel renders a colored
    // callout showing each existing curated phrase the candidate is
    // equal/broader/narrower than, so reviewers can spot near-duplicates
    // before clicking "Add" the same way the CLI does.
    overlaps: HandwavyPhraseDryRunOverlaps | null;
  } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Task #133 — track which phrase rows have their full edit history
  // expanded. Multiple rows can be open at once so reviewers can compare
  // how different phrases evolved side-by-side.
  const [openEditHistory, setOpenEditHistory] = useState<Set<string>>(() => new Set());
  // Task #138 — optional sort that floats the most-thrashed phrases to the
  // top of the active list. Default is OFF so the curated insertion order is
  // preserved (reviewers who haven't opted in still see the familiar list);
  // when ON we sort by descending remove+reinstate cycle count, with the
  // original index as a stable tie-breaker so phrases with the same count
  // don't shuffle around between renders.
  const [sortByThrash, setSortByThrash] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(HANDWAVY_SORT_THRASH_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Task #150 — mirror the toggle into localStorage on every change so the
  // preference survives reloads. We write "1" for ON and remove the key for
  // OFF (rather than writing "0") so first-time users and anyone who clears
  // browser storage cleanly fall back to the documented default of OFF.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sortByThrash) {
        window.localStorage.setItem(HANDWAVY_SORT_THRASH_KEY, "1");
      } else {
        window.localStorage.removeItem(HANDWAVY_SORT_THRASH_KEY);
      }
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }, [sortByThrash]);
  // Task #125 — derive the validated production-scan limit from the input
  // string. Empty / mid-edit / out-of-range values fall back to the default
  // so the actual API call is always well-formed; the UI surfaces a hint
  // separately so reviewers know when their typed value was clamped.
  const productionScanLimitParsed = (() => {
    const trimmed = productionScanLimitInput.trim();
    if (trimmed === "") return null;
    const v = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(v)) return null;
    return v;
  })();
  const productionScanLimitValid =
    productionScanLimitParsed !== null &&
    productionScanLimitParsed >= HANDWAVY_PRODUCTION_SCAN_LIMIT_MIN &&
    productionScanLimitParsed <= HANDWAVY_PRODUCTION_SCAN_LIMIT_MAX;
  const effectiveProductionScanLimit = productionScanLimitValid
    ? (productionScanLimitParsed as number)
    : HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT;
  // Mirror only the validated value into localStorage, never a mid-edit
  // string. Default value is removed from storage (rather than written
  // explicitly) so first-time users and anyone who clears browser storage
  // cleanly fall back to the documented default.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!productionScanLimitValid) return;
    try {
      if (effectiveProductionScanLimit === HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT) {
        window.localStorage.removeItem(HANDWAVY_PRODUCTION_SCAN_LIMIT_KEY);
      } else {
        window.localStorage.setItem(
          HANDWAVY_PRODUCTION_SCAN_LIMIT_KEY,
          String(effectiveProductionScanLimit),
        );
      }
    } catch {
      // ignore storage failures (private mode, quota)
    }
  }, [productionScanLimitValid, effectiveProductionScanLimit]);
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

  // Task #175 — fetch the slim "recent batch removals" summary for the
  // dedicated picker panel below. Sourced from the Task #160 endpoint that
  // also feeds the reinstate-batch CLI picker. Newest batches first.
  const removalBatchesQuery = useListHandwavyPhraseRemovalBatches(undefined, {
    query: { queryKey: getListHandwavyPhraseRemovalBatchesQueryKey() },
  });
  const removalBatches: HandwavyPhraseRemovalBatchSummary[] =
    removalBatchesQuery.data?.batches ?? [];

  const phrases = data?.phrases ?? [];
  const history = data?.history ?? [];
  const [draftCategory, setDraftCategory] = useState<"absence" | "hedging" | "buzzword">("absence");
  // Task #129 — pre-preview overlap hint. Recompute every render against the
  // current draft + active phrase list so the reviewer sees the warning the
  // moment they finish typing the candidate, before the dry-run round-trip.
  // Using the same normalize + substring rules as the server's
  // `detectCuratedOverlaps` keeps the hint identical to what the eventual
  // preview would surface (no false alarms / no missed warnings).
  const draftOverlaps = useMemo(
    () => detectHandwavyCuratedOverlaps(draft, phrases),
    [draft, phrases],
  );
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
    // Task #175 — also refresh the dedicated removal-batches picker so the
    // "already reinstated" badge / disabled state flips in lock-step with
    // the active phrase list after any add/remove/reinstate round-trip.
    queryClient.invalidateQueries({
      queryKey: getListHandwavyPhraseRemovalBatchesQueryKey(),
    });
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
      // Task #125: pass the reviewer-chosen production-scan window so heavy
      // installs can widen / small installs can tighten the second signal.
      // Omit the field entirely when the reviewer left the default in place
      // so the request body stays identical to the legacy shape.
      const dry = await addHandwavyPhrase({
        phrase,
        category: draftCategory,
        dryRun: true,
        ...(effectiveProductionScanLimit !== HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT
          ? { productionScanLimit: effectiveProductionScanLimit }
          : {}),
      });
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
        // Task #128 — capture the curated-phrase overlap block returned by the
        // server (Task #123) so the preview panel can render the same
        // equal / broader / narrower callout the CLI does. The field is
        // optional in the response, so default to null when missing.
        overlaps: dry.dryRunOverlaps ?? null,
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

  // Task #173 — single-phrase removal-impact preview. Issues a
  // `DELETE {phrase, dryRun: true}` (Task #155) and either fires the live
  // DELETE immediately (zero-impact phrases keep the one-click affordance)
  // or surfaces the same corpus + production impact renderer used by the
  // batch flow, gated behind an explicit acknowledgment checkbox when
  // valid hand-wavy detections would be un-flagged.
  const requestRemoveWithImpactPreview = async (phrase: string) => {
    setBusy(`rm-preview:${phrase}`);
    try {
      const resp = await removeHandwavyPhrase({ phrase, dryRun: true });
      // Defensive: the DELETE response is a union and the server might
      // theoretically respond with the live shape if it ignored dryRun.
      // Fail closed by surfacing an error rather than a silent live
      // removal.
      if (
        !("dryRun" in resp) ||
        resp.dryRun !== true ||
        !("dryRunImpact" in resp) ||
        // Single-phrase preview must carry `batch: false`; the batch
        // shape is structurally similar but reviewers asked for the
        // single-phrase preview to be the only one rendered here.
        ("batch" in resp && resp.batch !== false)
      ) {
        toast({
          title: "Preview unavailable",
          description:
            "The server did not return a removal preview. The phrase was not removed — please retry.",
          variant: "destructive",
        });
        return;
      }
      const single = resp as HandwavyPhraseSingleRemoveDryRunResponse;
      const corpusLost = single.dryRunImpact.corpus.validDetectionsLost;
      const productionLost = single.dryRunImpact.production?.validDetectionsLost ?? 0;
      const totalValidLost = corpusLost + productionLost;
      // Zero-impact removals stay one-click: no extra confirmation
      // friction for phrases that aren't doing real work in either
      // corpus right now.
      if (totalValidLost === 0) {
        await handleRemove(phrase);
        return;
      }
      setRemovePreview({ phrase, data: single, acknowledged: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to preview removal.";
      toast({ title: "Preview failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Task #139 — gate the per-row trash button so phrases with >=2 completed
  // remove+reinstate cycles route through a confirm panel before the DELETE
  // fires. Lower-thrash phrases skip the thrash gate but still go through
  // the Task #173 dry-run impact preview, which short-circuits to the live
  // DELETE when no valid detections would be lost so a clean trash click
  // stays one click.
  const requestRemove = (phrase: string, cycles: RemoveConfirmCycle[]) => {
    if (cycles.length >= 2) {
      setRemoveConfirm({ phrase, cycles });
      return;
    }
    void requestRemoveWithImpactPreview(phrase);
  };
  const cancelRemoveConfirm = () => {
    setRemoveConfirm(null);
  };
  const confirmRemoveAnyway = async () => {
    if (!removeConfirm) return;
    const { phrase } = removeConfirm;
    setRemoveConfirm(null);
    // After the high-thrash gate, still route through the Task #173
    // impact preview so the reviewer also sees the corpus / production
    // un-flag warning if there is one (zero-impact still fires the DELETE
    // in one click).
    await requestRemoveWithImpactPreview(phrase);
  };

  // Task #173 — preview-panel handlers.
  const cancelRemovePreview = () => {
    setRemovePreview(null);
  };
  const setRemovePreviewAcknowledged = (ack: boolean) => {
    setRemovePreview((prev) => (prev ? { ...prev, acknowledged: ack } : prev));
  };
  const confirmRemoveFromPreview = async () => {
    if (!removePreview) return;
    const { phrase } = removePreview;
    setRemovePreview(null);
    await handleRemove(phrase);
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

  const dismissBulkResults = () => {
    setBulkResults(null);
  };

  // Task #142 — one-click "Undo this batch" on the bulk-removal results
  // banner. Mirrors the per-row Reinstate button in the history log but
  // operates on every successfully-removed phrase from the just-completed
  // batch in a single click. Each phrase is reinstated using its captured
  // history-row identifier (phrase + removedAt) so we hit the existing
  // single-phrase reinstate endpoint exactly the way the per-row button
  // does. We refresh ONCE at the end and replace the banner contents with
  // the per-phrase reinstate outcomes in the same shape as the removals
  // (one "REINSTATED" / "NOT-FOUND" / "AUTH-FAILED" / "ERROR" row per
  // phrase) so reviewers see exactly what happened without squinting at
  // toasts.
  const handleUndoBulkBatch = async () => {
    if (!bulkResults || bulkResults.kind !== "remove") return;
    const removedRows = bulkResults.rows.filter((r) => r.status === "removed");
    if (removedRows.length === 0) return;
    setBusy("bulk-undo");
    const reviewerName = reviewer.trim() || undefined;
    const results: BulkResultRow[] = [];
    let authFailedSticky = false;
    for (const row of removedRows) {
      if (authFailedSticky) {
        results.push({
          phrase: row.phrase,
          status: "auth-failed",
          message: "skipped after earlier auth failure",
        });
        continue;
      }
      if (!row.removedAt) {
        // Defensive: a row that somehow missed its `removedAt` (shouldn't
        // happen — every successful DELETE returns a `historyEntry` with
        // one) can't be reinstated through the per-history-row endpoint.
        // Surface this rather than silently skipping so the reviewer
        // knows to fall back to the manual per-row Reinstate.
        results.push({
          phrase: row.phrase,
          status: "error",
          message: "missing history identifier; reinstate manually from the history log",
        });
        continue;
      }
      try {
        await reinstateHandwavyPhrase({
          phrase: row.phrase,
          removedAt: row.removedAt,
          reviewer: reviewerName,
        });
        results.push({ phrase: row.phrase, status: "reinstated" });
      } catch (err) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 401 || status === 403) {
          authFailedSticky = true;
          results.push({
            phrase: row.phrase,
            status: "auth-failed",
            message: `HTTP ${status}`,
          });
        } else if (status === 404) {
          results.push({
            phrase: row.phrase,
            status: "not-found",
            message: "server reported 404 (already reinstated?)",
          });
        } else {
          const msg = err instanceof Error ? err.message : "Unknown error";
          results.push({ phrase: row.phrase, status: "error", message: msg });
        }
      }
    }
    refresh();
    setBulkResults({ kind: "undo", rows: results });
    setBusy(null);

    const reinstated = results.filter((r) => r.status === "reinstated").length;
    const notFound = results.filter((r) => r.status === "not-found").length;
    const authFailed = results.filter((r) => r.status === "auth-failed").length;
    const errored = results.filter((r) => r.status === "error").length;
    const failures = notFound + authFailed + errored;
    if (failures === 0) {
      const noun = reinstated === 1 ? "phrase" : "phrases";
      toast({
        title: `${reinstated} ${noun} reinstated`,
        description: "The active list has been refreshed.",
      });
    } else {
      const parts: string[] = [];
      if (reinstated > 0) parts.push(`${reinstated} reinstated`);
      if (notFound > 0) parts.push(`${notFound} not-found`);
      if (authFailed > 0) parts.push(`${authFailed} auth-failed`);
      if (errored > 0) parts.push(`${errored} error${errored === 1 ? "" : "s"}`);
      toast({
        title: "Batch undo finished with issues",
        description: parts.join(" · "),
        variant: reinstated === 0 ? "destructive" : undefined,
      });
    }
  };

  // Task #154 — fetch the dry-run preview for the current selection. The
  // server returns the same `wouldRemove` / `notFound` / `duplicateInBatch`
  // breakdown the CLI's `--dry-run` flag surfaces, plus the corpus and
  // production impact summary. We hold both the response and the exact
  // phrase list we sent so the eventual real DELETE acts on what the
  // preview was scored against (selection changes after preview will
  // require re-previewing — see the "stale preview" guard on the confirm
  // button below). Per Task #154 this is the SOLE entry point for bulk
  // removal: there is no longer a "Remove selected" path that bypasses the
  // preview, so reviewers always see the dryRun impact before any DELETE.
  const handlePreviewBulkRemove = async () => {
    if (selectedInList.length === 0) return;
    const phrasesToPreview = [...selectedInList];
    setBulkResults(null);
    setBusy("bulk-preview");
    try {
      const resp = await removeHandwavyPhrase({
        phrases: phrasesToPreview,
        dryRun: true,
      });
      // Defensive: the union response could be a non-dry-run shape if the
      // server somehow ignored dryRun. Fail closed rather than silently
      // mutating the active list.
      if (
        !("dryRun" in resp) ||
        resp.dryRun !== true ||
        !("dryRunImpact" in resp)
      ) {
        toast({
          title: "Preview unavailable",
          description:
            "The server did not return a removal preview. No phrases were removed — please retry.",
          variant: "destructive",
        });
        return;
      }
      setBulkPreview({
        requestedPhrases: phrasesToPreview,
        data: resp,
        acknowledged: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to preview removal.";
      toast({ title: "Preview failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const cancelBulkPreview = () => {
    setBulkPreview(null);
  };

  const setBulkPreviewAcknowledged = (ack: boolean) => {
    setBulkPreview((prev) => (prev ? { ...prev, acknowledged: ack } : prev));
  };

  // Task #178 — drop a single phrase from the pending bulk-remove batch
  // straight from the preview panel. Before this, a reviewer who spotted a
  // high-thrash row had to back out, untick the row in the active list,
  // then re-open the preview — three clicks of friction that nudged people
  // toward just hitting "Remove" anyway. Now they can dismiss the
  // contentious row inline and fire the rest in a single confirm click.
  //
  // We also untick the dropped phrase in the underlying `selected` set so
  // the active-list checkbox state matches the reviewer's intent (and so
  // the "selection has changed since this preview was generated" stale
  // warning doesn't fire from the drop itself). Dropping the last phrase
  // closes the panel — same end state as Back out.
  const dropPhraseFromBulkPreview = (phrase: string) => {
    setSelected((prev) => {
      if (!prev.has(phrase)) return prev;
      const next = new Set(prev);
      next.delete(phrase);
      return next;
    });
    setBulkPreview((prev) => {
      if (!prev) return prev;
      const remaining = prev.requestedPhrases.filter((p) => p !== phrase);
      if (remaining.length === 0) return null;
      if (remaining.length === prev.requestedPhrases.length) return prev;
      return { ...prev, requestedPhrases: remaining };
    });
  };

  // Task #154 — confirm the destructive removal straight from the preview
  // panel. Uses the EXACT phrase list the preview was scored against so
  // the reviewer is committing to what they were just shown, not whatever
  // the live selection happens to be at click time.
  const confirmBulkRemoveFromPreview = async () => {
    if (!bulkPreview) return;
    const phrasesToRemove = bulkPreview.requestedPhrases;
    if (phrasesToRemove.length === 0) {
      setBulkPreview(null);
      return;
    }
    setBulkPreview(null);
    await confirmBulkRemove(phrasesToRemove);
  };

  // The destructive bulk-remove path. Always called with the explicit
  // phrase list the reviewer just acknowledged in the preview panel
  // (Task #154 made the preview mandatory; nothing else may invoke this
  // helper).
  const confirmBulkRemove = async (phrasesToRemove: string[]) => {
    if (!phrasesToRemove || phrasesToRemove.length === 0) return;
    setBusy("bulk-remove");
    const results: BulkResultRow[] = [];
    let authFailedSticky = false;
    const reviewerName = reviewer.trim() || undefined;
    for (const phrase of phrasesToRemove) {
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
        // Task #142 — capture the server-assigned `removedAt` from the
        // single-phrase DELETE response so the per-batch "Undo this batch"
        // action on the results banner can reinstate using the same
        // history-row identifier the existing per-row Reinstate uses.
        const resp = await removeHandwavyPhrase({ phrase, reviewer: reviewerName });
        const removedAtRaw =
          ("historyEntry" in resp && resp.historyEntry?.removedAt) || undefined;
        const removedAt = removedAtRaw
          ? removedAtRaw instanceof Date
            ? removedAtRaw.toISOString()
            : String(removedAtRaw)
          : undefined;
        results.push({ phrase, status: "removed", removedAt });
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
    setBulkResults({ kind: "remove", rows: results });
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

  // Task #144 — single-round-trip "Reinstate all" for a batch removal entry.
  // The reviewer hits one button on the batch header row and the server
  // reinstates every inner phrase that hasn't already been reinstated (and
  // isn't currently active). Per-phrase reinstate buttons still work for
  // partial undos.
  const handleReinstateBatch = async (removedAtIso: string, batchSize: number) => {
    const key = `reinstate-batch:${removedAtIso}`;
    setBusy(key);
    try {
      const resp = await reinstateHandwavyPhrasesBatch({
        removedAt: removedAtIso,
        reviewer: reviewer.trim() || undefined,
      });
      const reinstatedCount =
        typeof resp.reinstatedCount === "number" ? resp.reinstatedCount : 0;
      const skipped = typeof resp.skipped === "number" ? resp.skipped : 0;
      const noun = reinstatedCount === 1 ? "phrase" : "phrases";
      const skipNote = skipped > 0 ? ` (${skipped} already active or already reinstated)` : "";
      toast({
        title: reinstatedCount > 0 ? "Batch reinstated" : "Nothing to reinstate",
        description:
          reinstatedCount > 0
            ? `${reinstatedCount} of ${batchSize} ${noun} from this batch are back on the active list${skipNote}.`
            : `Every phrase in this batch was already accounted for${skipNote}.`,
      });
      // Task #177 — close any open dry-run preview for this batch once the
      // real call has fired so the panel doesn't linger with stale data.
      setReinstatePreview((prev) =>
        prev && prev.removedAtIso === removedAtIso ? null : prev,
      );
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reinstate batch.";
      toast({ title: "Batch reinstate failed", description: msg, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // Task #177 — fetch a dry-run preview of /reinstate-batch so the reviewer
  // can inspect the per-phrase outcome (would reinstate / already reinstated /
  // already active) before committing. Mirrors the bulk-remove preview flow:
  // the actual mutating call only fires when the reviewer presses the
  // "Confirm reinstate" button rendered inside the preview panel.
  const handlePreviewReinstateBatch = async (removedAtIso: string) => {
    const key = `reinstate-batch-preview:${removedAtIso}`;
    setBusy(key);
    // Drop any in-flight preview for this batch up front so a failed
    // refresh doesn't leave a stale (and possibly misleading) panel
    // visible while the reviewer figures out what went wrong.
    setReinstatePreview((prev) =>
      prev && prev.removedAtIso === removedAtIso ? null : prev,
    );
    try {
      const resp = await reinstateHandwavyPhrasesBatch({
        removedAt: removedAtIso,
        reviewer: reviewer.trim() || undefined,
        dryRun: true,
      });
      // The discriminated response uses `dryRun: true` to mark the preview
      // path. Bail loudly if the server somehow ran the mutating path so we
      // don't silently render a confirm button that double-applies.
      if (
        !("dryRun" in resp) ||
        (resp as HandwavyPhraseReinstateBatchDryRunResponse).dryRun !== true
      ) {
        throw new Error(
          "Server did not honor dryRun: refusing to render preview.",
        );
      }
      setReinstatePreview({
        removedAtIso,
        data: resp as HandwavyPhraseReinstateBatchDryRunResponse,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to preview reinstate.";
      toast({
        title: "Reinstate preview failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  // Task #130 + Task #141 — mirror of #121's reinstate. After adding a phrase
  // by mistake a reviewer can press Undo within UNDO_WINDOW_MS to remove it;
  // the resulting history row is tagged `undone: true` so the audit trail
  // reads "added then undone" rather than producing an unrelated
  // manual-removal entry. Task #141 broadened this from "only the single most
  // recent add" to "every FLAT add still inside the window" so a reviewer
  // who fires two phrases back-to-back and realises both were mistakes can
  // undo each of them through this flow rather than dropping the older one
  // into the regular Trash (which would record a manual-removal entry
  // instead). The Trash button is still rendered as a fallback for entries
  // that have aged out of the window or were never reviewer-added (curated
  // defaults).
  const UNDO_WINDOW_MS = 5 * 60 * 1000;
  // Task #140 — when a row's undo window has fewer than this many ms
  // remaining its Undo button switches from amber to red + pulse so
  // reviewers see the urgency at a glance.
  const UNDO_URGENT_MS = 30 * 1000;
  // Task #130 + Task #141 — Map of phrase -> { addedAtIso, addedAtMs } for
  // every active marker that was added by a reviewer (curated defaults
  // have no `addedAt` so they're skipped — there's nothing to undo on
  // them). Whether each entry is still inside its 5-minute undo window is
  // decided LIVE in `undoCandidates` below, off Date.now() + the 1Hz
  // tick, so per-row buttons can disappear at the exact 0s mark instead
  // of waiting for the next phrases refresh. Task #141 keyed this by
  // phrase (instead of "single most recent" as in Task #130) so a
  // reviewer who fires multiple adds back-to-back can roll back any of
  // them through the audit-friendly undo path; Task #140 layered the
  // live countdown + urgent styling on top of that per-row.
  const reviewerAddedByPhrase = useMemo(() => {
    const map = new Map<string, { addedAtIso: string; addedAtMs: number }>();
    for (const m of phrases) {
      if (!m.addedAt) continue;
      const iso = String(m.addedAt);
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue;
      map.set(m.phrase, { addedAtIso: iso, addedAtMs: ms });
    }
    return map;
  }, [phrases]);
  // Task #140 — re-render every second while at least one reviewer-added
  // phrase is still inside its 5-minute undo window so each row's
  // countdown ("Undo (4m 12s)" → "(4m 11s)" → …) ticks down live and the
  // button vanishes cleanly the moment that row's window elapses, rather
  // than waiting for a 15s poll. The interval is gated on the LATEST
  // expiry across all reviewer-added phrases (not just the map being
  // non-empty) so panels whose newest reviewer add is already past
  // expiry don't pay a permanent 1Hz render cost. The interval also
  // self-clears once every candidate has expired so the final render
  // flips the buttons to hidden cleanly without flashing.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const latestExpiryMs = useMemo(() => {
    let best = 0;
    for (const entry of reviewerAddedByPhrase.values()) {
      const expires = entry.addedAtMs + UNDO_WINDOW_MS;
      if (expires > best) best = expires;
    }
    return best;
  }, [reviewerAddedByPhrase, UNDO_WINDOW_MS]);
  useEffect(() => {
    if (latestExpiryMs === 0) return;
    const initialNow = Date.now();
    setNowMs(initialNow);
    if (initialNow >= latestExpiryMs) {
      // Every reviewer-added phrase is already past its window — nothing
      // to count down, so don't arm the 1Hz ticker at all.
      return;
    }
    const id = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= latestExpiryMs) {
        window.clearInterval(id);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [latestExpiryMs]);
  // Per-phrase undo entries that are still INSIDE their window, keyed by
  // phrase so each row's lookup is O(1). Each value carries the live
  // remainingMs so the row can render its own countdown text + urgent
  // styling without recomputing Date.now() at the call site. Entries
  // whose window has elapsed are dropped here so the per-row check
  // (`undoCandidates.get(m.phrase)`) doubles as the show/hide gate.
  const undoCandidates = useMemo(() => {
    const map = new Map<
      string,
      { addedAtIso: string; addedAtMs: number; remainingMs: number }
    >();
    for (const [phrase, entry] of reviewerAddedByPhrase) {
      const remainingMs = Math.max(
        0,
        entry.addedAtMs + UNDO_WINDOW_MS - nowMs,
      );
      if (remainingMs <= 0) continue;
      map.set(phrase, { ...entry, remainingMs });
    }
    return map;
  }, [reviewerAddedByPhrase, nowMs, UNDO_WINDOW_MS]);

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
  // phrases at once) carry a `phrases[]` list of inner removals. Each inner
  // phrase becomes a per-phrase row, but we ALSO emit a parent "batch"
  // group so Task #144's audit panel can render a single header row with
  // "Batch removal of N phrases by <reviewer> on <date>" + a single
  // "Reinstate all" button. Per-phrase reinstate buttons still work for
  // partial undos on the inner rows beneath the header.
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
    undone?: boolean;
    undoneBy?: string;
    batchSize?: number;
  };
  type DisplayHistoryGroup =
    | { kind: "single"; sortKey: number; row: DisplayHistoryRow }
    | {
        kind: "batch";
        sortKey: number;
        removedAtIso: string;
        removedBy?: string;
        batchSize: number;
        reinstatedCount: number;
        allReinstated: boolean;
        rows: DisplayHistoryRow[];
      };
  const historyGroups: DisplayHistoryGroup[] = [];
  for (const h of history) {
    const sortKey = Date.parse(String(h.removedAt ?? "")) || 0;
    if (Array.isArray(h.phrases) && h.phrases.length > 0) {
      const rows: DisplayHistoryRow[] = h.phrases.map((inner) => ({
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
        batchSize: h.phrases!.length,
      }));
      const removedAtIso =
        h.removedAt instanceof Date ? h.removedAt.toISOString() : String(h.removedAt);
      const reinstatedCount = rows.filter((r) => r.reinstated).length;
      historyGroups.push({
        kind: "batch",
        sortKey,
        removedAtIso,
        removedBy: h.removedBy,
        batchSize: rows.length,
        reinstatedCount,
        allReinstated: h.reinstated === true || (rows.length > 0 && reinstatedCount === rows.length),
        rows,
      });
    } else if (typeof h.phrase === "string" && h.phrase.length > 0) {
      historyGroups.push({
        kind: "single",
        sortKey,
        row: {
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
          undone: h.undone,
          undoneBy: h.undoneBy,
        },
      });
    }
  }
  const sortedHistoryGroups = historyGroups.sort((a, b) => b.sortKey - a.sortKey);
  const totalHistoryRowCount = historyGroups.reduce(
    (sum, g) => sum + (g.kind === "single" ? 1 : g.rows.length),
    0,
  );
  // Preserve the original row-count cap (25) introduced before grouping —
  // accumulate groups until we'd cross the cap, but always include each
  // group whole so a batch never renders with a partial inner row list.
  const HISTORY_ROW_CAP = 25;
  const visibleHistoryGroups: DisplayHistoryGroup[] = [];
  let runningRowCount = 0;
  for (const g of sortedHistoryGroups) {
    const rowsInGroup = g.kind === "single" ? 1 : g.rows.length;
    if (visibleHistoryGroups.length > 0 && runningRowCount + rowsInGroup > HISTORY_ROW_CAP) break;
    visibleHistoryGroups.push(g);
    runningRowCount += rowsInGroup;
  }
  const visibleHistoryRowCount = runningRowCount;

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

  // Task #138 — when the "Most contentious first" toggle is on, reorder the
  // active list by descending thrash count. Original index is the tie-breaker
  // so phrases with equal counts (and the long tail of zero-thrash phrases)
  // keep their curated insertion order — flipping the toggle off therefore
  // restores the exact default ordering.
  const originalPhraseIndex = new Map<string, number>();
  phrases.forEach((p, i) => {
    originalPhraseIndex.set(p.phrase, i);
  });
  const displayPhrases = sortByThrash
    ? [...phrases].sort((a, b) => {
        const ca = thrashByPhrase.get(a.phrase)?.length ?? 0;
        const cb = thrashByPhrase.get(b.phrase)?.length ?? 0;
        if (cb !== ca) return cb - ca;
        return (
          (originalPhraseIndex.get(a.phrase) ?? 0) -
          (originalPhraseIndex.get(b.phrase) ?? 0)
        );
      })
    : phrases;
  // Count only ACTIVE phrases that have a thrash history — a previously
  // thrashed phrase that's currently inactive wouldn't actually move when
  // the toggle is flipped, so including it here would overstate the effect
  // in the toggle's tooltip.
  let contentiousCount = 0;
  for (const p of phrases) {
    const cycles = thrashByPhrase.get(p.phrase);
    if (cycles && cycles.length > 0) contentiousCount++;
  }

  return (
    <>
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
          {/* Task #125 — reviewer-tunable production-scan window. The dry-run
              preview's second signal scores the candidate against the most
              recent N production reports (capped server-side at 10000).
              Heavy-user installs can widen the window for a sharper false-
              positive signal; small installs can tighten it to focus on
              recent reporter behavior. The chosen value is also surfaced in
              the production-block subtitle below so reviewers know exactly
              how deep the second signal went. */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 text-[11px] text-muted-foreground">
            <label
              htmlFor="handwavy-production-scan-limit"
              className="shrink-0"
            >
              Production scan window:
            </label>
            <input
              id="handwavy-production-scan-limit"
              type="number"
              inputMode="numeric"
              min={HANDWAVY_PRODUCTION_SCAN_LIMIT_MIN}
              max={HANDWAVY_PRODUCTION_SCAN_LIMIT_MAX}
              step={100}
              value={productionScanLimitInput}
              onChange={(e) => setProductionScanLimitInput(e.target.value)}
              className={cn(
                "h-7 w-24 px-2 rounded-md border bg-background/40 text-xs focus:outline-none focus:ring-1",
                productionScanLimitValid || productionScanLimitInput.trim() === ""
                  ? "border-border/40 focus:ring-primary/40"
                  : "border-red-500/60 focus:ring-red-500/60",
              )}
              data-testid="handwavy-production-scan-limit"
              aria-label="Production scan window (most recent N reports)"
              disabled={busy === "preview" || busy === "confirm" || preview !== null}
            />
            <span className="text-muted-foreground/70">
              most recent reports ({HANDWAVY_PRODUCTION_SCAN_LIMIT_MIN}–
              {HANDWAVY_PRODUCTION_SCAN_LIMIT_MAX}; default{" "}
              {HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT})
            </span>
            {!productionScanLimitValid && productionScanLimitInput.trim() !== "" && (
              <span
                className="text-red-400"
                data-testid="handwavy-production-scan-limit-warning"
              >
                Out of range — the next preview will use{" "}
                {HANDWAVY_PRODUCTION_SCAN_LIMIT_DEFAULT} until you fix this.
              </span>
            )}
          </div>
        </form>
        {/* Task #129 — pre-preview overlap hint. Surfaces inline as the
            reviewer types the candidate, *before* they click "Preview impact",
            so an obvious near-duplicate can be caught without paying for the
            full dry-run round-trip (corpus scan + production DB hit). The
            hint is suppressed once the preview block is open so the two
            warnings don't stack — the dry-run already includes its own
            overlap detection on the server side. */}
        {preview === null && draftOverlaps.length > 0 && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-amber-100 flex items-start gap-2"
            data-testid="handwavy-overlap-hint"
            role="status"
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300" />
            <div className="flex-1">
              <span className="font-semibold">
                Likely redundant — overlaps with {draftOverlaps.length} existing curated{" "}
                {draftOverlaps.length === 1 ? "phrase" : "phrases"}:
              </span>{" "}
              <span data-testid="handwavy-overlap-hint-top">
                {describeHandwavyOverlapRelation(draftOverlaps[0].relation)}{" "}
                <span className="font-mono">&ldquo;{draftOverlaps[0].phrase}&rdquo;</span>{" "}
                <span className="text-amber-200/70">
                  [{CATEGORY_LABELS[draftOverlaps[0].category]}]
                </span>
              </span>
              {draftOverlaps.length > 1 && (
                <span className="text-amber-200/60">
                  {" "}
                  (+{draftOverlaps.length - 1} more — full list shown in the dry-run preview)
                </span>
              )}
            </div>
          </div>
        )}
        {preview && (() => {
          // Task #119 — combined false-positive count across BOTH the curated
          // benchmark cohorts and the production-archive scan. Either signal
          // turning red flips the outer card + confirm button to destructive
          // styling so a phrase that's clean against the curated set but
          // catastrophic against production still trips the warning UI.
          const curatedFp = preview.matches.falsePositives;
          const productionFp = preview.productionMatches?.falsePositives ?? 0;
          const anyFp = curatedFp + productionFp;
          // Task #128 — surface curated-phrase overlap (Task #123) the same
          // way the CLI does. Overlaps don't crater AVRI like a false
          // positive does, but they DO mean the add is redundant, so we
          // tint the outer card red on an overlap as well and switch the
          // confirm button copy to "Add anyway".
          const overlapCount = preview.overlaps?.total ?? 0;
          const hasWarning = anyFp > 0 || overlapCount > 0;
          return (
          <div
            className={cn(
              "rounded-md border p-3 space-y-3",
              hasWarning
                ? "border-red-500/40 bg-red-500/5"
                : "border-emerald-500/40 bg-emerald-500/5",
            )}
            data-testid="handwavy-preview"
          >
            <div className="flex items-start gap-2">
              {hasWarning ? (
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
            {/* Task #128 — Overlap with already-curated phrases callout
                (mirrors the CLI's `renderOverlaps` block). Rendered ABOVE
                the corpus-impact grid so reviewers see redundancy warnings
                before they scroll the false-positive numbers. The block
                self-hides when there are no overlaps to keep the panel
                compact for the common (non-overlapping) case. */}
            <PreviewOverlapsBlock
              overlaps={preview.overlaps}
              candidate={preview.phrase}
            />
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
                variant={hasWarning ? "destructive" : "default"}
                onClick={handleConfirmPreview}
                disabled={busy === "confirm"}
                data-testid="handwavy-preview-confirm"
              >
                {busy === "confirm"
                  ? "Adding…"
                  : hasWarning
                  ? "Add anyway"
                  : "Confirm add"}
              </Button>
            </div>
          </div>
          );
        })()}
        {/* Task #154 — bulk-removal preview panel. Wires the calibration UI
            to the same DELETE `{phrases, dryRun: true}` endpoint the CLI's
            `--dry-run` flag consumes, so reviewers see the per-phrase
            outcomes (`wouldRemove` / `notFound` / `duplicateInBatch`) plus
            the corpus + production impact summary BEFORE the destructive
            action. The "Remove these N" button stays disabled until the
            reviewer ticks the explicit acknowledgment checkbox when valid
            T3/T4 detections would be lost in either corpus.
            Task #151 — additionally, phrases with >=2 completed
            remove+reinstate cycles get an amber thrash badge in the
            per-phrase outcomes list and a summary line at the top of the
            preview panel, mirroring the per-row warning so a bulk sweep
            can't quietly take out contentious phrases. */}
        {bulkPreview && (() => {
          const data = bulkPreview.data;
          const corpus = data.dryRunImpact.corpus;
          const production = data.dryRunImpact.production ?? null;
          const productionError = data.dryRunImpact.productionError ?? null;
          const productionLimit = data.dryRunImpact.productionLimit ?? null;
          const corpusLost = corpus.validDetectionsLost;
          const productionLost = production?.validDetectionsLost ?? 0;
          const totalValidLost = corpusLost + productionLost;
          const requiresAck = totalValidLost > 0;
          // Task #178 — the reviewer can drop individual phrases inline
          // from the per-phrase outcomes list, so the rendered counts
          // ("Removal preview for N", "X would be removed", the Remove
          // button label, etc.) MUST be recomputed against the current
          // `requestedPhrases` instead of the original dry-run totals.
          // We don't re-run the dry-run on every drop — the corpus and
          // production impact figures stay as-shown (worst case, the
          // ack warning over-warns by counting reports the dropped
          // phrase contributed to; that's a safe direction to err in).
          const requestedSet = new Set(bulkPreview.requestedPhrases);
          const visibleResults: HandwavyPhraseBatchRemoveResultEntry[] =
            data.results.filter((r: HandwavyPhraseBatchRemoveResultEntry) =>
              requestedSet.has(r.raw),
            );
          const wouldRemove = visibleResults.filter((r) => r.removed).length;
          const visibleNotFound = visibleResults.filter(
            (r) => !r.removed && r.reason === "not-found",
          ).length;
          const visibleDuplicate = visibleResults.filter(
            (r) => !r.removed && r.reason === "duplicate-in-batch",
          ).length;
          const visibleProjectedTotal = data.total - wouldRemove;
          const selectionDrifted =
            selectedInList.length !== bulkPreview.requestedPhrases.length ||
            !bulkPreview.requestedPhrases.every((p) =>
              selectedInList.includes(p),
            );
          const removalDisabled =
            wouldRemove === 0 ||
            busy === "bulk-remove" ||
            (requiresAck && !bulkPreview.acknowledged);
          // Task #151 — count selected phrases that have already been
          // removed and reinstated >= HIGH_THRASH_MIN times. We surface
          // this both as a summary banner and as per-row badges below so
          // a reviewer batching 20 phrases can't miss the thrash signal.
          const HIGH_THRASH_MIN = 2;
          const highThrashCount = bulkPreview.requestedPhrases.reduce(
            (acc, p) => {
              const cycles = thrashByPhrase.get(p)?.length ?? 0;
              return acc + (cycles >= HIGH_THRASH_MIN ? 1 : 0);
            },
            0,
          );
          return (
          <div
            className={cn(
              "rounded-md border p-3 space-y-3 text-xs",
              requiresAck
                ? "border-red-500/40 bg-red-500/5"
                : "border-amber-500/40 bg-amber-500/5",
            )}
            data-testid="handwavy-bulk-preview"
          >
            <div className="flex items-start gap-2">
              {requiresAck ? (
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
              ) : (
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
              )}
              <div className="flex-1">
                <div className="font-semibold text-foreground">
                  Removal preview for {bulkPreview.requestedPhrases.length} phrase
                  {bulkPreview.requestedPhrases.length === 1 ? "" : "s"}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Of these {bulkPreview.requestedPhrases.length}, <span className="text-foreground/90">{wouldRemove}</span> would be removed
                  {visibleNotFound > 0 && (
                    <>
                      , <span className="text-foreground/90">{visibleNotFound}</span> {visibleNotFound === 1 ? "is" : "are"} not on the active list
                    </>
                  )}
                  {visibleDuplicate > 0 && (
                    <>
                      , <span className="text-foreground/90">{visibleDuplicate}</span> {visibleDuplicate === 1 ? "is a duplicate" : "are duplicates"} in this batch
                    </>
                  )}
                  . The active list would shrink from{" "}
                  <span className="text-foreground/90">{data.total}</span> to{" "}
                  <span className="text-foreground/90">{visibleProjectedTotal}</span>{" "}
                  phrases. Nothing has been removed yet.
                </div>
              </div>
            </div>
            {highThrashCount > 0 && (
              <div
                className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200"
                data-testid="handwavy-bulk-preview-thrash-summary"
              >
                <RotateCcw className="w-3 h-3 mt-0.5 shrink-0 text-amber-300" />
                <span>
                  {highThrashCount} of {bulkPreview.requestedPhrases.length} selected phrase
                  {bulkPreview.requestedPhrases.length === 1 ? "" : "s"}{" "}
                  {highThrashCount === 1 ? "has" : "have"} been removed and reinstated{" "}
                  {HIGH_THRASH_MIN}+ times — flagged below.
                </span>
              </div>
            )}
            <div
              className="grid grid-cols-1 lg:grid-cols-2 gap-3"
              data-testid="handwavy-bulk-preview-impact"
            >
              <BulkRemovalImpactBlock
                kind="curated"
                title="Curated benchmark"
                subtitle={`${corpus.corpusSize} fixtures`}
                impact={corpus}
                emptyHint="No curated detections would be lost"
              />
              {production ? (
                <BulkRemovalImpactBlock
                  kind="production"
                  title="Production archive"
                  subtitle={
                    productionLimit != null
                      ? `last ${production.corpusSize} of up to ${productionLimit} reports`
                      : `last ${production.corpusSize} reports`
                  }
                  impact={production}
                  emptyHint="No production detections would be lost"
                />
              ) : (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200"
                  data-testid="handwavy-bulk-preview-production-error"
                >
                  <div className="font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Production archive scan unavailable
                  </div>
                  <div className="mt-1 text-amber-100/80">
                    {productionError ??
                      "The production archive scan did not return a result. Only the curated-corpus signal is shown."}
                  </div>
                </div>
              )}
            </div>
            <details className="text-[11px]" data-testid="handwavy-bulk-preview-results-details">
              <summary className="cursor-pointer text-muted-foreground/80 hover:text-foreground/80 select-none">
                Per-phrase outcomes ({visibleResults.length})
              </summary>
              <ul
                className="mt-1 max-h-48 overflow-y-auto space-y-0.5 border-l border-border/30 pl-2"
                data-testid="handwavy-bulk-preview-results"
              >
                {visibleResults.map((r, idx) => {
                  const cfg = r.removed
                    ? {
                        label: "would remove",
                        color: "text-emerald-400",
                        icon: <CheckCircle2 className="w-3 h-3" />,
                      }
                    : r.reason === "duplicate-in-batch"
                      ? {
                          label: "duplicate",
                          color: "text-amber-400",
                          icon: <AlertTriangle className="w-3 h-3" />,
                        }
                      : {
                          label: "not-found",
                          color: "text-yellow-400",
                          icon: <AlertTriangle className="w-3 h-3" />,
                        };
                  // Task #151 — flag rows whose phrase has >=2 completed
                  // remove+reinstate cycles so a reviewer can spot
                  // contentious phrases inside this preview list too.
                  const cycleCount = thrashByPhrase.get(r.raw)?.length ?? 0;
                  const isHighThrash = cycleCount >= HIGH_THRASH_MIN;
                  return (
                    <li
                      key={`${r.raw}-${idx}`}
                      className="flex items-start gap-2 text-[11px]"
                      data-testid={
                        isHighThrash
                          ? "handwavy-bulk-preview-result-row-thrash"
                          : "handwavy-bulk-preview-result-row"
                      }
                      data-outcome={r.removed ? "would-remove" : r.reason ?? "unknown"}
                    >
                      <span className={cn("flex items-center gap-1 w-28 shrink-0", cfg.color)}>
                        {cfg.icon}
                        <span className="uppercase tracking-wide font-bold text-[9px]">
                          {cfg.label}
                        </span>
                      </span>
                      <span className="font-mono text-foreground/80 break-all flex-1">
                        {r.raw}
                      </span>
                      {isHighThrash && (
                        <Badge
                          variant="outline"
                          className="text-[10px] border-amber-500/40 text-amber-300 font-sans shrink-0"
                          data-testid="handwavy-bulk-preview-thrash-badge"
                          aria-label={`Removed and reinstated ${cycleCount} time${cycleCount === 1 ? "" : "s"}`}
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          {cycleCount}× cycles
                        </Badge>
                      )}
                      {/* Task #178 — per-row dismiss button. Lets the
                          reviewer drop just this phrase from the pending
                          batch (e.g., the one high-thrash entry in 20)
                          without backing out and re-ticking everything
                          else. Dropping the last phrase closes the
                          panel — see `dropPhraseFromBulkPreview`. */}
                      <button
                        type="button"
                        onClick={() => dropPhraseFromBulkPreview(r.raw)}
                        disabled={busy === "bulk-remove"}
                        className="shrink-0 inline-flex items-center justify-center rounded p-0.5 text-muted-foreground/70 hover:text-foreground hover:bg-foreground/10 focus:outline-none focus:ring-1 focus:ring-foreground/30 disabled:opacity-40 disabled:cursor-not-allowed"
                        data-testid="handwavy-bulk-preview-result-drop"
                        data-phrase={r.raw}
                        aria-label={`Drop "${r.raw}" from this batch`}
                        title="Drop this phrase from the batch"
                      >
                        <XIcon className="w-3 h-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
            {selectionDrifted && (
              <div
                className="text-[11px] text-amber-200 italic flex items-start gap-1"
                data-testid="handwavy-bulk-preview-stale"
              >
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                Selection has changed since this preview was generated. Re-preview to refresh — confirming will still apply to the {bulkPreview.requestedPhrases.length} phrase
                {bulkPreview.requestedPhrases.length === 1 ? "" : "s"} shown above.
              </div>
            )}
            {requiresAck ? (
              <label
                className="flex items-start gap-2 text-[11px] text-red-100 cursor-pointer select-none"
                data-testid="handwavy-bulk-preview-ack-label"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-red-500"
                  checked={bulkPreview.acknowledged}
                  onChange={(e) => setBulkPreviewAcknowledged(e.target.checked)}
                  data-testid="handwavy-bulk-preview-ack"
                  aria-label="I understand legitimate detections would be lost"
                />
                <span>
                  I understand this would un-flag{" "}
                  <span className="font-semibold">{totalValidLost}</span>{" "}
                  legitimately-flagged hand-wavy {totalValidLost === 1 ? "report" : "reports"}
                  {corpusLost > 0 && productionLost > 0
                    ? ` (${corpusLost} curated + ${productionLost} production)`
                    : corpusLost > 0
                      ? ` in the curated benchmark corpus`
                      : ` in the recent production sample`}{" "}
                  and proceed anyway.
                </span>
              </label>
            ) : wouldRemove > 0 ? (
              <div className="text-[11px] text-emerald-200 flex items-start gap-1">
                <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                No legitimate hand-wavy detections would be lost. Safe to proceed.
              </div>
            ) : (
              <div className="text-[11px] text-amber-200 flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                Nothing in this batch would be removed (every phrase is already off the active list or duplicated). Cancel and adjust your selection.
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelBulkPreview}
                disabled={busy === "bulk-remove"}
                data-testid="handwavy-bulk-preview-cancel"
              >
                Back out
              </Button>
              <Button
                size="sm"
                variant={requiresAck ? "destructive" : "default"}
                onClick={confirmBulkRemoveFromPreview}
                disabled={removalDisabled}
                data-testid="handwavy-bulk-preview-confirm"
              >
                {busy === "bulk-remove"
                  ? "Removing…"
                  : wouldRemove === 0
                    ? "Nothing to remove"
                    : requiresAck
                      ? `Remove ${wouldRemove} anyway`
                      : `Remove ${wouldRemove} phrase${wouldRemove === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
          );
        })()}
        {/* Task #139 — confirm panel for high-thrash single removals. Only
            shown when the trash button is pressed on a phrase with >=2
            completed remove+reinstate cycles, so reviewers see the prior
            disagreement before triggering what's likely cycle #N+1. */}
        {removeConfirm && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2 text-xs"
            data-testid="handwavy-remove-confirm"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
              <div className="flex-1">
                <div className="font-semibold text-foreground">
                  Remove "{removeConfirm.phrase}" anyway?
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  This phrase has already been removed and reinstated{" "}
                  {removeConfirm.cycles.length}× — the next removal is more likely
                  to get reverted again. Consider starting a discussion before
                  flipping it once more.
                </div>
              </div>
            </div>
            <ol
              className="max-h-48 overflow-y-auto pl-2 border-l border-amber-500/30 space-y-1.5 text-[10px] leading-snug"
              data-testid="handwavy-remove-confirm-cycles"
            >
              {removeConfirm.cycles.map((c, i) => (
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
            <div className="flex justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelRemoveConfirm}
                disabled={busy === `rm:${removeConfirm.phrase}`}
                data-testid="handwavy-remove-confirm-cancel"
              >
                Back out
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={confirmRemoveAnyway}
                disabled={
                  busy === `rm:${removeConfirm.phrase}` ||
                  busy === `rm-preview:${removeConfirm.phrase}`
                }
                data-testid="handwavy-remove-confirm-go"
              >
                Remove anyway
              </Button>
            </div>
          </div>
        )}
        {/* Task #173 — single-phrase removal-impact preview panel. Shown
            after the per-row Trash button issues a `DELETE {phrase,
            dryRun: true}` and the response indicates that valid
            hand-wavy detections WOULD be lost in the curated and/or
            production corpus. Reuses the same `BulkRemovalImpactBlock`
            renderer the batch confirm step uses so reviewers see one
            consistent impact summary, and gates the destructive removal
            behind an explicit acknowledgment checkbox. Zero-impact
            removals never reach this panel — they are fired in one
            click from `requestRemoveWithImpactPreview`. */}
        {removePreview && (() => {
          const { phrase, data, acknowledged } = removePreview;
          const corpus = data.dryRunImpact.corpus;
          const production = data.dryRunImpact.production ?? null;
          const productionError = data.dryRunImpact.productionError;
          const productionLimit = data.dryRunImpact.productionLimit;
          const corpusLost = corpus.validDetectionsLost;
          const productionLost = production?.validDetectionsLost ?? 0;
          const totalValidLost = corpusLost + productionLost;
          const requireAck = totalValidLost > 0;
          const inFlight =
            busy === `rm:${phrase}` || busy === `rm-preview:${phrase}`;
          return (
            <div
              className="rounded-md border border-red-500/40 bg-red-500/5 p-3 space-y-3 text-xs"
              data-testid="handwavy-remove-preview"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-red-400" />
                <div className="flex-1">
                  <div className="font-semibold text-foreground">
                    Remove "{phrase}"?
                  </div>
                  <div
                    className="text-[10px] text-muted-foreground mt-0.5"
                    data-testid="handwavy-remove-preview-summary"
                  >
                    Removing this phrase would un-flag{" "}
                    <span className="text-red-300 font-semibold">
                      {totalValidLost}
                    </span>{" "}
                    valid hand-wavy detection{totalValidLost === 1 ? "" : "s"}
                    {corpusLost > 0 && productionLost > 0
                      ? ` (${corpusLost} curated + ${productionLost} production)`
                      : corpusLost > 0
                        ? " in the curated benchmark"
                        : " in the production archive"}
                    . Review the impact below before confirming.
                  </div>
                </div>
              </div>
              <div
                className="grid grid-cols-1 lg:grid-cols-2 gap-3"
                data-testid="handwavy-remove-preview-impact"
              >
                <BulkRemovalImpactBlock
                  kind="curated"
                  title="Curated benchmark"
                  subtitle={`${corpus.corpusSize} fixtures`}
                  impact={corpus}
                  emptyHint="No curated detections would be lost"
                />
                {production ? (
                  <BulkRemovalImpactBlock
                    kind="production"
                    title="Production archive"
                    subtitle={
                      productionLimit != null
                        ? `last ${production.corpusSize} of up to ${productionLimit} reports`
                        : `last ${production.corpusSize} reports`
                    }
                    impact={production}
                    emptyHint="No production detections would be lost"
                  />
                ) : (
                  <div
                    className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200"
                    data-testid="handwavy-remove-preview-production-error"
                  >
                    <div className="font-semibold flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Production archive scan unavailable
                    </div>
                    <div className="mt-1 text-amber-100/80">
                      {productionError ??
                        "The production archive scan did not return a result. Only the curated-corpus signal is shown."}
                    </div>
                  </div>
                )}
              </div>
              {requireAck && (
                <label
                  className="flex items-start gap-2 text-[11px] text-foreground/90 cursor-pointer select-none"
                  data-testid="handwavy-remove-preview-ack-label"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledged}
                    onChange={(e) => setRemovePreviewAcknowledged(e.target.checked)}
                    disabled={inFlight}
                    data-testid="handwavy-remove-preview-ack"
                  />
                  <span>
                    I understand this will un-flag {totalValidLost} valid
                    hand-wavy detection{totalValidLost === 1 ? "" : "s"} and
                    want to remove "{phrase}" anyway.
                  </span>
                </label>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancelRemovePreview}
                  disabled={inFlight}
                  data-testid="handwavy-remove-preview-cancel"
                >
                  Back out
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={confirmRemoveFromPreview}
                  disabled={inFlight || (requireAck && !acknowledged)}
                  data-testid="handwavy-remove-preview-confirm"
                >
                  Remove anyway
                </Button>
              </div>
            </div>
          );
        })()}
        {/* Task #134 — per-phrase results banner shown after a bulk batch
            finishes, mirroring the CLI's per-phrase outcome summary.
            Task #142 — the same banner is reused for the "Undo this batch"
            action that appears when the just-completed batch retired at
            least one phrase: clicking it reinstates each removed phrase
            via the existing single-phrase reinstate endpoint and then
            replaces these rows with the per-phrase reinstate outcomes. */}
        {bulkResults && (() => {
          // Task #142 — the Undo affordance is gated purely on REMOVED
          // rows existing (the literal Done-looks-like wording). Rows
          // that somehow lack the `removedAt` history identifier still
          // show up in the count so the banner doesn't lie about what
          // the click will attempt; `handleUndoBulkBatch` flags those
          // identifier-less rows as per-phrase errors with a "reinstate
          // manually from the history log" message rather than silently
          // skipping them.
          const removedRows = bulkResults.kind === "remove"
            ? bulkResults.rows.filter((r) => r.status === "removed")
            : [];
          const removedCount = removedRows.length;
          const reinstatedCount = bulkResults.kind === "undo"
            ? bulkResults.rows.filter((r) => r.status === "reinstated").length
            : 0;
          const undoBusy = busy === "bulk-undo";
          const headingLabel = bulkResults.kind === "undo"
            ? "Bulk undo results"
            : "Bulk removal results";
          const summaryLabel = bulkResults.kind === "undo"
            ? `${reinstatedCount} / ${bulkResults.rows.length} reinstated`
            : `${removedCount} / ${bulkResults.rows.length} removed`;
          return (
          <div
            className="rounded-md border border-border/40 bg-background/40 p-3 space-y-2 text-xs"
            data-testid="handwavy-bulk-results"
            data-kind={bulkResults.kind}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground">{headingLabel}</span>
              <Badge variant="outline" className="text-[10px]">
                {summaryLabel}
              </Badge>
              {/* Task #142 — "Undo this batch" lives next to the dismiss
                  control so it sits in reviewers' eyeline the moment the
                  removal results render. We show it on the removal banner
                  (not after the undo itself completes) whenever at least
                  one row reports REMOVED. Rows missing the captured
                  `removedAt` identifier are still counted here; the
                  handler surfaces them as per-phrase errors with a
                  manual-reinstate hint rather than silently dropping
                  them. */}
              {bulkResults.kind === "remove" && removedCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 px-2 text-[11px]"
                  onClick={handleUndoBulkBatch}
                  disabled={undoBusy}
                  data-testid="handwavy-bulk-undo"
                >
                  <Undo2 className="w-3 h-3 mr-1" />
                  {undoBusy
                    ? `Undoing ${removedCount}…`
                    : `Undo this batch (${removedCount})`}
                </Button>
              )}
              <button
                type="button"
                className={cn(
                  "text-[10px] text-muted-foreground hover:text-foreground underline",
                  bulkResults.kind === "remove" && removedCount > 0
                    ? ""
                    : "ml-auto",
                )}
                onClick={dismissBulkResults}
                data-testid="handwavy-bulk-dismiss"
              >
                Dismiss
              </button>
            </div>
            <ul className="space-y-0.5">
              {bulkResults.rows.map((r) => {
                const cfg =
                  r.status === "removed"
                    ? { label: "removed", color: "text-emerald-400", icon: <CheckCircle2 className="w-3 h-3" /> }
                    : r.status === "reinstated"
                      ? { label: "reinstated", color: "text-emerald-400", icon: <RotateCcw className="w-3 h-3" /> }
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
                    data-status={r.status}
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
          );
        })()}
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
              {/* Task #138 — "Most contentious first" toggle. Sits inside
                  the sticky toolbar so reviewers can flip the ordering at
                  any scroll depth. Disabled when there are no thrashed
                  phrases at all so the affordance doesn't promise an order
                  change that wouldn't visibly happen. */}
              <label
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 text-[11px] select-none",
                  contentiousCount === 0
                    ? "text-muted-foreground/60 cursor-not-allowed"
                    : "text-muted-foreground cursor-pointer",
                )}
                title={
                  contentiousCount === 0
                    ? "No phrases have been removed and reinstated yet"
                    : `Sort the ${contentiousCount} thrashed phrase${contentiousCount === 1 ? "" : "s"} to the top`
                }
                data-testid="handwavy-sort-thrash-label"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                  checked={sortByThrash && contentiousCount > 0}
                  disabled={contentiousCount === 0}
                  onChange={(e) => setSortByThrash(e.target.checked)}
                  aria-label="Show most contentious phrases first"
                  data-testid="handwavy-sort-thrash"
                />
                <RotateCcw className="w-3 h-3" />
                <span>Most contentious first</span>
              </label>
              {/* Task #154 — sole bulk-remove entry point. The reviewer
                  is always routed through the side-by-side preview panel
                  (`handwavy-bulk-preview`) before any DELETE fires. The
                  preview panel itself owns the destructive confirm + the
                  acknowledgment checkbox when valid detections would be
                  lost. */}
              <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                disabled={
                  selectedInList.length === 0 ||
                  busy === "bulk-remove" ||
                  busy === "bulk-preview" ||
                  bulkPreview !== null
                }
                onClick={handlePreviewBulkRemove}
                data-testid="handwavy-bulk-remove"
                title="Open the side-by-side removal preview. You'll see how many active phrases would be removed, plus how many flagged reports would lose their flag, before anything is committed."
              >
                <Trash2 className="w-3.5 h-3.5" />
                {busy === "bulk-preview"
                  ? "Previewing…"
                  : `Remove selected${selectedInList.length > 0 ? ` (${selectedInList.length})` : ""}`}
              </Button>
            </div>
            <div className="divide-y divide-border/20">
            {displayPhrases.map((m) => {
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
              const bulkBusy = busy === "bulk-remove" || bulkPreview !== null;
              // Task #141 — every active marker that's still inside its own
              // undo window gets its own Undo button (not just the single
              // most-recent one), so a reviewer who fired two adds back-to-
              // back can roll back either of them through the audit-friendly
              // undo path. Look the row up by phrase in `undoCandidates`.
              // Task #140 — the entry also carries its own live `remainingMs`
              // so this row's countdown text + urgent styling tick down
              // independently of every other row.
              const undoEntry = undoCandidates.get(m.phrase) ?? null;
              const isUndoTarget = undoEntry !== null;
              const undoBusyKey = undoEntry
                ? `undo:${m.phrase}:${undoEntry.addedAtIso}`
                : null;
              const undoRemainingMs = undoEntry?.remainingMs ?? 0;
              const undoIsUrgent =
                undoEntry !== null && undoRemainingMs <= UNDO_URGENT_MS;
              // Task #131 — count of completed remove+reinstate cycles for
              // this phrase, derived from the existing history log. Surfaced
              // as a hover-able badge so reviewers can spot contentious
              // markers at a glance.
              const cycles = thrashByPhrase.get(m.phrase) ?? [];
              // Task #149 — count category transitions from the in-row edit
              // history so reviewers can spot phrases that have bounced
              // between absence/hedging/buzzword multiple times without
              // expanding the full history panel. We only count edits that
              // actually changed the category (the audit log omits the
              // `category` field when only the rationale changed) and only
              // surface the badge once there are >= 2 distinct transitions
              // to keep noise off rows that just had a one-off correction.
              const categoryFlips = editsList.filter(
                (e) => e.category && e.category.from !== e.category.to,
              );
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
                    {/* Task #149 — category-flip badge sits next to the
                       thrash badge so the two "this phrase is unstable"
                       signals (remove+reinstate cycles vs. category
                       reassignments) live side by side. Only renders when
                       reviewers have moved the phrase between categories
                       at least twice, otherwise the row stays clean. */}
                    {categoryFlips.length >= 2 && (
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger
                            type="button"
                            className="cursor-help inline-flex"
                            data-testid="handwavy-category-flip-badge"
                            aria-label={`Category changed ${categoryFlips.length} times across edit history`}
                          >
                            <Badge
                              variant="outline"
                              className="text-[10px] border-sky-500/40 text-sky-300"
                            >
                              <ArrowLeftRight className="w-3 h-3 mr-1" />
                              {categoryFlips.length} category flips
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            align="end"
                            collisionPadding={12}
                            className="max-w-xs glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal"
                            data-testid="handwavy-category-flip-tooltip"
                          >
                            <div className="text-[11px] font-semibold mb-1">
                              Category changed {categoryFlips.length} times
                            </div>
                            <ol className="space-y-1 text-[10px] leading-snug">
                              {categoryFlips.map((e, i) => {
                                const at = formatAuditTimestamp(e.editedAt);
                                return (
                                  <li
                                    key={`${e.editedAt}-${i}`}
                                    className="space-y-0.5"
                                  >
                                    <div>
                                      <span className="text-muted-foreground">#{i + 1}:</span>{" "}
                                      <span className="text-foreground/90 capitalize">
                                        {e.category!.from}
                                      </span>
                                      {" → "}
                                      <span className="text-foreground/90 capitalize">
                                        {e.category!.to}
                                      </span>
                                    </div>
                                    <div className="text-muted-foreground">
                                      by{" "}
                                      <span className="text-foreground/80">
                                        {e.editedBy || "anonymous"}
                                      </span>
                                      {at && <> • {at}</>}
                                    </div>
                                  </li>
                                );
                              })}
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
                        {isUndoTarget && undoEntry && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-7 px-2 text-[10px]",
                              undoIsUrgent
                                ? "text-red-400 hover:text-red-300 animate-pulse"
                                : "text-amber-300 hover:text-amber-200",
                            )}
                            disabled={editing !== null || busy === undoBusyKey}
                            onClick={() => handleUndo(m.phrase, undoEntry.addedAtIso)}
                            data-testid="handwavy-undo"
                            data-undo-remaining-ms={undoRemainingMs}
                            data-undo-urgent={undoIsUrgent ? "true" : "false"}
                            aria-label={`Undo adding phrase ${m.phrase} (${formatUndoRemaining(undoRemainingMs)} left)`}
                            title={`Undo this brand-new add — ${formatUndoRemaining(undoRemainingMs)} left in the 5-minute window`}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />
                            {busy === undoBusyKey
                              ? "Undoing…"
                              : `Undo (${formatUndoRemaining(undoRemainingMs)})`}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground hover:text-primary"
                          disabled={
                            editing !== null ||
                            busy === `rm:${m.phrase}` ||
                            busy === `rm-preview:${m.phrase}` ||
                            bulkBusy
                          }
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
                          disabled={
                            editing !== null ||
                            busy === `rm:${m.phrase}` ||
                            busy === `rm-preview:${m.phrase}` ||
                            bulkBusy
                          }
                          onClick={() => requestRemove(m.phrase, cycles)}
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
                          currentCategory: m.category,
                          currentRationale: m.rationale,
                          editing,
                          busy,
                          onRevertClick: (entry) =>
                            setRevertConfirm({ phrase: m.phrase, entry }),
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
                          currentCategory: m.category,
                          currentRationale: m.rationale,
                          editing,
                          busy,
                          onRevertClick: (entry) =>
                            setRevertConfirm({ phrase: m.phrase, entry }),
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
        {/* Task #175 — dedicated "Recent batch removals" picker, sourced
            from GET /feedback/calibration/handwavy-phrases/removal-batches.
            Shows the same data the Task #160 reinstate-batch CLI picker
            uses (timestamp, reviewer, phrase count, sample phrases,
            already-reinstated badge) so reviewers can pick a batch and
            reinstate it without scrolling the full removal-history panel
            below. The button reuses handleReinstateBatch (Task #144), so
            after a successful round-trip both this panel and the active
            phrase list refresh through the same `refresh()` call. */}
        {(removalBatchesQuery.isLoading ||
          removalBatchesQuery.isError ||
          removalBatchesQuery.isSuccess) && (
          <div
            className="pt-2 border-t border-border/20"
            data-testid="handwavy-removal-batches-panel"
          >
            <div className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider flex items-center gap-1 mb-2">
              <Layers className="w-3 h-3 text-primary/80" />
              Recent batch removals
              {removalBatchesQuery.data &&
                typeof removalBatchesQuery.data.totalBatches === "number" &&
                removalBatchesQuery.data.totalBatches > removalBatches.length && (
                  <span className="ml-1 text-muted-foreground/70 normal-case font-normal">
                    (showing {removalBatches.length} of {removalBatchesQuery.data.totalBatches})
                  </span>
                )}
            </div>
            {removalBatchesQuery.isLoading ? (
              <div className="text-[11px] text-muted-foreground italic">Loading recent batches…</div>
            ) : removalBatchesQuery.isError ? (
              <div className="text-[11px] text-destructive">
                Failed to load recent batch removals.
              </div>
            ) : removalBatches.length === 0 ? (
              <div
                className="text-[11px] text-muted-foreground italic"
                data-testid="handwavy-removal-batches-empty"
              >
                No recent batch removals.
              </div>
            ) : (
              <div
                className="border border-border/20 rounded-md divide-y divide-border/10 max-h-64 overflow-y-auto"
                data-testid="handwavy-removal-batches-list"
              >
                {removalBatches.map((b) => {
                  const removedAtIso = String(b.removedAt);
                  const batchKey = `reinstate-batch:${removedAtIso}`;
                  const phraseCount = b.phraseCount ?? 0;
                  const samples = Array.isArray(b.samplePhrases) ? b.samplePhrases : [];
                  const hiddenSampleCount = Math.max(0, phraseCount - samples.length);
                  return (
                    <div
                      key={removedAtIso}
                      className="px-3 py-2 text-[11px] space-y-1"
                      data-testid="handwavy-removal-batches-row"
                      data-batch-removed-at={removedAtIso}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-foreground/80 flex-1 min-w-0">
                          <strong className="text-foreground">{phraseCount}</strong>{" "}
                          phrase{phraseCount === 1 ? "" : "s"} removed by{" "}
                          <span className="text-foreground/90">{b.removedBy || "anonymous"}</span>
                          {" • "}
                          {formatAuditTimestamp(b.removedAt) ?? "unknown date"}
                        </span>
                        {b.reinstated ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-500/40 text-emerald-300"
                            data-testid="handwavy-removal-batches-reinstated"
                          >
                            Already reinstated
                          </Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-emerald-300 hover:text-emerald-200"
                            disabled={busy === batchKey}
                            onClick={() => handleReinstateBatch(removedAtIso, phraseCount)}
                            data-testid="handwavy-removal-batches-reinstate"
                            aria-label={`Reinstate this batch of ${phraseCount} phrase${phraseCount === 1 ? "" : "s"} removed on ${formatAuditTimestamp(b.removedAt) ?? "unknown date"}`}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />
                            {busy === batchKey ? "Reinstating…" : "Reinstate this batch"}
                          </Button>
                        )}
                      </div>
                      {samples.length > 0 && (
                        <ul
                          className="pl-4 list-disc text-foreground/70 space-y-0.5 marker:text-muted-foreground/40"
                          data-testid="handwavy-removal-batches-samples"
                        >
                          {samples.map((p, i) => (
                            <li key={`${removedAtIso}-sample-${i}`} className="font-mono break-all">
                              {p}
                            </li>
                          ))}
                          {hiddenSampleCount > 0 && (
                            <li className="list-none italic text-muted-foreground/70 not-italic-break">
                              + {hiddenSampleCount} more
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {sortedHistoryGroups.length > 0 && (
          <div className="pt-2 border-t border-border/20">
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground/80 flex items-center gap-1"
              data-testid="handwavy-history-toggle"
              aria-expanded={showHistory}
            >
              <Clock className="w-3 h-3" />
              {showHistory ? "Hide" : "Show"} removal &amp; undo history ({totalHistoryRowCount})
            </button>
            {showHistory && (
              <div
                className="mt-2 border border-border/20 rounded-md divide-y divide-border/10 max-h-64 overflow-y-auto"
                data-testid="handwavy-history-list"
              >
                {visibleHistoryGroups.map((group, gIdx) => {
                  const renderRow = (
                    h: DisplayHistoryRow,
                    rowIdx: number,
                    opts: { insideBatch?: boolean } = {},
                  ) => {
                    const removedAtKey =
                      h.removedAt instanceof Date
                        ? h.removedAt.toISOString()
                        : String(h.removedAt);
                    const reinstateKey = `reinstate:${h.phrase}:${removedAtKey}`;
                    const isActive = phrases.some(
                      (m: { phrase: string }) => m.phrase === h.phrase,
                    );
                    const isUndone = h.undone === true;
                    // Task #179 — flag inner phrases of a batch group whose
                    // completed remove+reinstate cycle count is >= 2 so a
                    // bulk-reinstate (which would push them onto the active
                    // list and start cycle #N+1) doesn't quietly hide the
                    // thrash signal. Mirrors the per-row badge in the bulk-
                    // REMOVE preview from Task #151. Only shown for rows the
                    // batch button would actually flip — already-reinstated
                    // or already-active rows are no-ops, so adding a badge
                    // there would be noise.
                    const HANDWAVY_HIGH_THRASH_MIN = 2;
                    const cycleCount = thrashByPhrase.get(h.phrase)?.length ?? 0;
                    const showBatchThrashBadge =
                      opts.insideBatch === true &&
                      !h.reinstated &&
                      !isActive &&
                      cycleCount >= HANDWAVY_HIGH_THRASH_MIN;
                    return (
                      <div
                        key={`${h.phrase}-${removedAtKey}-${rowIdx}`}
                        className={cn(
                          "px-3 py-2 text-[11px] text-muted-foreground space-y-0.5",
                          isUndone && "bg-amber-500/5 border-l-2 border-amber-500/40",
                          opts.insideBatch && "pl-6 bg-background/20",
                        )}
                        data-testid="handwavy-history-row"
                        data-history-kind={isUndone ? "undone" : "removed"}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-foreground/70 break-all flex-1 line-through">{h.phrase}</span>
                          {showBatchThrashBadge && (
                            <Badge
                              variant="outline"
                              className="text-[10px] border-amber-500/40 text-amber-300"
                              data-testid="handwavy-history-batch-thrash-badge"
                              aria-label={`Removed and reinstated ${cycleCount} time${cycleCount === 1 ? "" : "s"}`}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" />
                              {cycleCount}× cycles
                            </Badge>
                          )}
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
                              onClick={() => setReinstateConfirm(h)}
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
                          {!opts.insideBatch && h.batchSize && h.batchSize > 1 && (
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
                  };

                  if (group.kind === "single") {
                    return renderRow(group.row, gIdx);
                  }

                  // Task #144 — batch group: a single header row with one
                  // "Reinstate all" button, then the inner per-phrase rows
                  // beneath it (still independently reinstateable).
                  const batchKey = `reinstate-batch:${group.removedAtIso}`;
                  // Task #177 — busy key for the dry-run preview fetch. Kept
                  // distinct from the mutating key so the spinner only blocks
                  // the button the reviewer actually pressed.
                  const previewKey = `reinstate-batch-preview:${group.removedAtIso}`;
                  // Number of inner phrases that aren't already reinstated
                  // AND aren't already in the active list — i.e. what the
                  // batch button would actually re-add.
                  const remainingRows = group.rows.filter(
                    (r) => !r.reinstated && !phrases.some((m: { phrase: string }) => m.phrase === r.phrase),
                  );
                  const remainingCount = remainingRows.length;
                  // Task #177 — when this batch's dry-run preview is open,
                  // surface the per-phrase outcomes inline below the header
                  // so the reviewer can confirm or cancel without losing the
                  // surrounding history context.
                  const previewForGroup =
                    reinstatePreview &&
                    reinstatePreview.removedAtIso === group.removedAtIso
                      ? reinstatePreview
                      : null;
                  // Task #179 — count how many of the rows the batch button
                  // would actually flip have already cycled (remove +
                  // reinstate) >= 2 times. Surfaced as a summary line below
                  // the batch header so a reviewer can't miss the thrash
                  // signal before the batch fires. Mirrors the bulk-REMOVE
                  // preview's `handwavy-bulk-preview-thrash-summary` from
                  // Task #151. We deliberately scope the count to
                  // `remainingRows` (not `group.rows`) so the summary
                  // matches the batch button's "Reinstate all N" label.
                  const HISTORY_HIGH_THRASH_MIN = 2;
                  const remainingHighThrashCount = remainingRows.reduce(
                    (acc, r) =>
                      acc +
                      ((thrashByPhrase.get(r.phrase)?.length ?? 0) >=
                      HISTORY_HIGH_THRASH_MIN
                        ? 1
                        : 0),
                    0,
                  );
                  return (
                    <div
                      key={`batch-${group.removedAtIso}-${gIdx}`}
                      data-testid="handwavy-history-batch-group"
                      data-batch-removed-at={group.removedAtIso}
                    >
                      <div
                        className="px-3 py-2 text-[11px] bg-primary/5 border-l-2 border-primary/40 flex items-center gap-2 flex-wrap"
                        data-testid="handwavy-history-batch-header"
                      >
                        <Layers className="w-3 h-3 text-primary/80 shrink-0" />
                        <span className="text-foreground/80 flex-1 min-w-0">
                          Batch removal of <strong>{group.batchSize}</strong> phrase{group.batchSize === 1 ? "" : "s"} by{" "}
                          <span className="text-foreground/90">{group.removedBy || "anonymous"}</span>
                          {" on "}
                          {formatAuditTimestamp(group.removedAtIso) ?? "unknown date"}
                          {group.reinstatedCount > 0 && !group.allReinstated && (
                            <span className="ml-2 text-muted-foreground">
                              ({group.reinstatedCount} of {group.batchSize} reinstated)
                            </span>
                          )}
                        </span>
                        {group.allReinstated ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-500/40 text-emerald-300"
                            data-testid="handwavy-history-batch-reinstated"
                          >
                            All reinstated
                          </Badge>
                        ) : remainingCount === 0 ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-muted-foreground"
                            data-testid="handwavy-history-batch-nothing-to-do"
                          >
                            Nothing to reinstate
                          </Badge>
                        ) : (
                          <>
                            {/* Task #177 — dry-run preview affordance next
                                to "Reinstate all". Calls /reinstate-batch
                                with `dryRun: true` so the reviewer can see
                                per-phrase outcomes (would-reinstate /
                                already-reinstated / already-active) before
                                committing. The mutating call still lives
                                on the existing button next to it. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[10px] text-sky-300 hover:text-sky-200"
                              disabled={busy === previewKey || busy === batchKey}
                              onClick={() =>
                                handlePreviewReinstateBatch(group.removedAtIso)
                              }
                              data-testid="handwavy-reinstate-batch-preview"
                              aria-label={`Preview reinstate of ${remainingCount} remaining phrase${remainingCount === 1 ? "" : "s"} from this batch`}
                            >
                              <Info className="w-3 h-3 mr-1" />
                              {busy === previewKey
                                ? "Previewing…"
                                : "Preview reinstate"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[10px] text-emerald-300 hover:text-emerald-200"
                              disabled={busy === batchKey || busy === previewKey}
                              onClick={() => {
                                // Task #180 — gate the direct "Reinstate all"
                                // click behind a confirmation dialog
                                // (mirroring Task #153's per-row reinstate
                                // confirm) so a misclick doesn't re-enable
                                // every phrase from the batch at once. We
                                // capture exactly the rows the button would
                                // actually re-add (skipping ones already
                                // reinstated or already on the active list)
                                // so the dialog can list them. The Task
                                // #177 Preview button next to this is its
                                // own richer confirm flow and is left as
                                // an immediate action.
                                const phrasesToReinstate = group.rows
                                  .filter(
                                    (r) =>
                                      !r.reinstated &&
                                      !phrases.some(
                                        (m: { phrase: string }) => m.phrase === r.phrase,
                                      ),
                                  )
                                  .map((r) => r.phrase);
                                setReinstateBatchConfirm({
                                  removedAtIso: group.removedAtIso,
                                  removedBy: group.removedBy,
                                  batchSize: group.batchSize,
                                  phrasesToReinstate,
                                });
                              }}
                              data-testid="handwavy-reinstate-batch"
                              aria-label={`Reinstate all ${remainingCount} remaining phrase${remainingCount === 1 ? "" : "s"} from this batch`}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" />
                              {busy === batchKey
                                ? "Reinstating…"
                                : `Reinstate all ${remainingCount}`}
                            </Button>
                          </>

                        )}
                      </div>
                      {previewForGroup && (() => {
                        const data = previewForGroup.data;
                        const wouldReinstateCount =
                          typeof data.reinstatedCount === "number"
                            ? data.reinstatedCount
                            : 0;
                        const skippedCount =
                          typeof data.skipped === "number" ? data.skipped : 0;
                        const projectedTotal =
                          typeof data.total === "number" ? data.total : null;
                        const results: HandwavyPhraseReinstateBatchEntryResult[] =
                          Array.isArray(data.results) ? data.results : [];
                        const noun =
                          wouldReinstateCount === 1 ? "phrase" : "phrases";
                        const confirming = busy === batchKey;
                        return (
                          <div
                            className="px-3 py-2 border-l-2 border-sky-500/40 bg-sky-500/5 space-y-2"
                            data-testid="handwavy-reinstate-batch-preview-panel"
                            data-batch-removed-at={group.removedAtIso}
                          >
                            <div className="flex items-start gap-2">
                              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-300" />
                              <div className="flex-1 text-[11px]">
                                <div className="font-semibold text-foreground">
                                  Reinstate preview for {group.batchSize}{" "}
                                  {group.batchSize === 1 ? "phrase" : "phrases"}
                                </div>
                                <div className="text-[10px] text-muted-foreground mt-0.5">
                                  <span className="text-foreground/90">
                                    {wouldReinstateCount}
                                  </span>{" "}
                                  of {group.batchSize} {noun} would be
                                  reinstated
                                  {skippedCount > 0 && (
                                    <>
                                      ,{" "}
                                      <span className="text-foreground/90">
                                        {skippedCount}
                                      </span>{" "}
                                      skipped (already reinstated or already
                                      active)
                                    </>
                                  )}
                                  .{" "}
                                  {projectedTotal != null && (
                                    <>
                                      The active list would grow to{" "}
                                      <span className="text-foreground/90">
                                        {projectedTotal}
                                      </span>{" "}
                                      phrases.{" "}
                                    </>
                                  )}
                                  Nothing has changed yet.
                                </div>
                              </div>
                            </div>
                            <ul
                              className="max-h-48 overflow-y-auto space-y-0.5 border-l border-border/30 pl-2"
                              data-testid="handwavy-reinstate-batch-preview-results"
                            >
                              {results.map((r, idx) => {
                                const cfg = r.reinstated
                                  ? {
                                      label: "would reinstate",
                                      color: "text-emerald-400",
                                      icon: <CheckCircle2 className="w-3 h-3" />,
                                    }
                                  : r.reason === "already-reinstated"
                                    ? {
                                        label: "already reinstated",
                                        color: "text-muted-foreground",
                                        icon: <CheckCircle2 className="w-3 h-3" />,
                                      }
                                    : r.reason === "already-active"
                                      ? {
                                          label: "already active",
                                          color: "text-amber-300",
                                          icon: <Info className="w-3 h-3" />,
                                        }
                                      : {
                                          label: "skipped",
                                          color: "text-yellow-400",
                                          icon: <AlertTriangle className="w-3 h-3" />,
                                        };
                                return (
                                  <li
                                    key={`${r.phrase}-${idx}`}
                                    className="flex items-start gap-2 text-[11px]"
                                    data-testid="handwavy-reinstate-batch-preview-row"
                                    data-outcome={
                                      r.reinstated
                                        ? "would-reinstate"
                                        : r.reason ?? "unknown"
                                    }
                                  >
                                    <span
                                      className={cn(
                                        "flex items-center gap-1 w-32 shrink-0",
                                        cfg.color,
                                      )}
                                    >
                                      {cfg.icon}
                                      <span className="uppercase tracking-wide font-bold text-[9px]">
                                        {cfg.label}
                                      </span>
                                    </span>
                                    <span className="font-mono text-foreground/80 break-all flex-1">
                                      {r.phrase}
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                                disabled={confirming}
                                onClick={() => setReinstatePreview(null)}
                                data-testid="handwavy-reinstate-batch-preview-cancel"
                              >
                                Cancel
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[10px] text-emerald-300 hover:text-emerald-200"
                                disabled={
                                  confirming || wouldReinstateCount === 0
                                }
                                onClick={() =>
                                  handleReinstateBatch(
                                    group.removedAtIso,
                                    group.batchSize,
                                  )
                                }
                                data-testid="handwavy-reinstate-batch-preview-confirm"
                                aria-label={`Confirm reinstate of ${wouldReinstateCount} ${noun} from this batch`}
                              >
                                <RotateCcw className="w-3 h-3 mr-1" />
                                {confirming
                                  ? "Reinstating…"
                                  : wouldReinstateCount > 0
                                    ? `Confirm reinstate (${wouldReinstateCount})`
                                    : "Nothing to reinstate"}
                              </Button>
                            </div>
                          </div>
                        );
                      })()}
                      {/* Task #179 — high-thrash summary: only rendered when
                          the batch button has work to do AND at least one of
                          those rows is high-thrash, so a batch with zero
                          high-thrash phrases is visually identical to the
                          pre-#179 layout. */}
                      {remainingCount > 0 && remainingHighThrashCount > 0 && (
                        <div
                          className="px-3 py-1.5 text-[10px] bg-amber-500/5 border-l-2 border-amber-500/40 flex items-start gap-1.5 text-amber-200"
                          data-testid="handwavy-history-batch-thrash-summary"
                        >
                          <RotateCcw className="w-3 h-3 mt-0.5 shrink-0 text-amber-300" />
                          <span>
                            {remainingHighThrashCount} of {remainingCount} selected phrase
                            {remainingCount === 1 ? "" : "s"}{" "}
                            {remainingHighThrashCount === 1 ? "has" : "have"} already cycled{" "}
                            {HISTORY_HIGH_THRASH_MIN}+ times — flagged below.
                          </span>
                        </div>
                      )}
                      <div className="divide-y divide-border/10">
                        {group.rows.map((row, rIdx) =>
                          renderRow(row, rIdx, { insideBatch: true }),
                        )}
                      </div>
                    </div>
                  );
                })}
                {totalHistoryRowCount > visibleHistoryRowCount && (
                  <div className="px-3 py-2 text-[10px] italic text-muted-foreground/70">
                    Showing the {visibleHistoryRowCount} most recent of {totalHistoryRowCount} removals.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>

    {/* Task #146 — confirmation prompt before reverting an edit. The dialog
        summarizes which fields will change and to what values so reviewers
        can spot a misclick before any audit-log mutation happens. */}
    <AlertDialog
      open={revertConfirm !== null}
      onOpenChange={(open) => {
        if (!open) setRevertConfirm(null);
      }}
    >
      <AlertDialogContent data-testid="handwavy-revert-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Revert this edit?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {revertConfirm && (
                <>
                  <div>
                    Restore <span className="font-mono text-foreground/80">“{revertConfirm.phrase}”</span>{" "}
                    to the values from before the edit by{" "}
                    <span className="text-foreground/80">
                      {revertConfirm.entry.editedBy || "anonymous"}
                    </span>
                    {(() => {
                      const lbl = formatAuditTimestamp(revertConfirm.entry.editedAt);
                      return lbl ? <> on {lbl}</> : null;
                    })()}
                    .
                  </div>
                  {(revertConfirm.entry.category || revertConfirm.entry.rationale) ? (
                    <ul
                      className="list-disc pl-5 space-y-1 text-foreground/80"
                      data-testid="handwavy-revert-confirm-changes"
                    >
                      {revertConfirm.entry.category && (
                        <li>
                          category{" "}
                          <span className="text-foreground">{revertConfirm.entry.category.to}</span>
                          {" → "}
                          <span className="text-foreground">{revertConfirm.entry.category.from}</span>
                        </li>
                      )}
                      {revertConfirm.entry.rationale && (
                        <li>
                          rationale{" "}
                          <span className="text-foreground">
                            {revertConfirm.entry.rationale.to && revertConfirm.entry.rationale.to.length > 0
                              ? `“${revertConfirm.entry.rationale.to}”`
                              : "(empty)"}
                          </span>
                          {" → "}
                          <span className="text-foreground">
                            {revertConfirm.entry.rationale.from && revertConfirm.entry.rationale.from.length > 0
                              ? `“${revertConfirm.entry.rationale.from}”`
                              : "(empty)"}
                          </span>
                        </li>
                      )}
                    </ul>
                  ) : (
                    <div className="italic">
                      This edit didn't record any field changes — reverting will be a no-op.
                    </div>
                  )}
                  <div className="text-xs italic">
                    The original entry stays in place; the revert is recorded as a new audit entry.
                  </div>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="handwavy-revert-confirm-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="handwavy-revert-confirm-confirm"
            onClick={() => {
              if (revertConfirm) {
                const { phrase, entry } = revertConfirm;
                setRevertConfirm(null);
                void handleRevertEdit(phrase, entry);
              }
            }}
          >
            Revert edit
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Task #153 — confirmation prompt before reinstating a removed phrase.
        The dialog summarizes the phrase, its category, and the original
        rationale so reviewers can spot a misclick before the phrase is
        re-enabled on the active list. */}
    <AlertDialog
      open={reinstateConfirm !== null}
      onOpenChange={(open) => {
        if (!open) setReinstateConfirm(null);
      }}
    >
      <AlertDialogContent data-testid="handwavy-reinstate-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Reinstate this phrase?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {reinstateConfirm && (
                <>
                  <div>
                    Restore{" "}
                    <span className="font-mono text-foreground/80">
                      “{reinstateConfirm.phrase}”
                    </span>{" "}
                    to the active list. New triages will start flagging it
                    again immediately.
                  </div>
                  <ul
                    className="list-disc pl-5 space-y-1 text-foreground/80"
                    data-testid="handwavy-reinstate-confirm-summary"
                  >
                    <li>
                      category{" "}
                      <span className="text-foreground capitalize">
                        {CATEGORY_LABELS[
                          reinstateConfirm.category as keyof typeof CATEGORY_LABELS
                        ] ?? reinstateConfirm.category ?? "absence"}
                      </span>
                    </li>
                    <li>
                      rationale{" "}
                      <span className="text-foreground">
                        {reinstateConfirm.rationale && reinstateConfirm.rationale.length > 0
                          ? `“${reinstateConfirm.rationale}”`
                          : "(none recorded)"}
                      </span>
                    </li>
                  </ul>
                  <div className="text-xs italic">
                    The original removal entry stays in the history; the reinstate is recorded as a new audit entry.
                  </div>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="handwavy-reinstate-confirm-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="handwavy-reinstate-confirm-confirm"
            onClick={() => {
              if (reinstateConfirm) {
                const entry = reinstateConfirm;
                setReinstateConfirm(null);
                void handleReinstate(entry);
              }
            }}
          >
            Reinstate phrase
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Task #180 — confirmation prompt before reinstating an entire batch
        removal entry. Mirrors Task #153's per-row reinstate confirm and
        Task #146's revert confirm so reviewers get the same blast-radius
        guard whether they click "Reinstate" on a single row or
        "Reinstate all N" on the batch header. The dialog spells out how
        many phrases are about to come back to the active list and lists
        them so a misclick is obvious before any audit-log mutation
        happens. */}
    <AlertDialog
      open={reinstateBatchConfirm !== null}
      onOpenChange={(open) => {
        if (!open) setReinstateBatchConfirm(null);
      }}
    >
      <AlertDialogContent data-testid="handwavy-reinstate-batch-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {reinstateBatchConfirm
              ? `Reinstate ${reinstateBatchConfirm.phrasesToReinstate.length} phrase${
                  reinstateBatchConfirm.phrasesToReinstate.length === 1 ? "" : "s"
                } from this batch?`
              : "Reinstate batch?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {reinstateBatchConfirm && (
                <>
                  <div>
                    Restore the{" "}
                    <strong>
                      {reinstateBatchConfirm.phrasesToReinstate.length}
                    </strong>{" "}
                    remaining phrase
                    {reinstateBatchConfirm.phrasesToReinstate.length === 1
                      ? ""
                      : "s"}{" "}
                    from the batch removal of{" "}
                    <strong>{reinstateBatchConfirm.batchSize}</strong>
                    {" by "}
                    <span className="text-foreground/80">
                      {reinstateBatchConfirm.removedBy || "anonymous"}
                    </span>{" "}
                    to the active list. New triages will start flagging them
                    again immediately.
                  </div>
                  {reinstateBatchConfirm.phrasesToReinstate.length > 0 && (
                    <ul
                      className="list-disc pl-5 space-y-1 text-foreground/80 max-h-48 overflow-y-auto"
                      data-testid="handwavy-reinstate-batch-confirm-summary"
                    >
                      {reinstateBatchConfirm.phrasesToReinstate.map((p) => (
                        <li key={p}>
                          <span className="font-mono text-foreground/80">
                            “{p}”
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="text-xs italic">
                    The original batch removal entry stays in the history; each
                    reinstate is recorded as a new audit entry. Cancel leaves
                    the batch untouched.
                  </div>
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="handwavy-reinstate-batch-confirm-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="handwavy-reinstate-batch-confirm-confirm"
            onClick={() => {
              if (reinstateBatchConfirm) {
                const { removedAtIso, batchSize } = reinstateBatchConfirm;
                setReinstateBatchConfirm(null);
                void handleReinstateBatch(removedAtIso, batchSize);
              }
            }}
          >
            Reinstate batch
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
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

// Task #47 — `/api/test/run` augments cohorts with sampled real reports
// from the curated dataset when it's mounted. Mirrors the response shape
// asserted in test-fixtures.route.test.ts.
interface DatasetCohort {
  tier: string;
  label: string;
  count: number;
  compositeMean: number | null;
  compositeMin: number | null;
  compositeMax: number | null;
  engine2Mean: number | null;
}

type DatasetSamples =
  | { available: false }
  | {
      available: true;
      sourcePath: string;
      sampleSizeRequestedPerLabel: number;
      sampleCount: number;
      cohorts: DatasetCohort[];
      legitMean: number | null;
      slopMean: number | null;
      gap: number | null;
      gapTarget: number;
      gapMeetsTarget: boolean;
    };

interface TestRunResponse {
  archetypes?: ArchetypeRow[];
  datasetSamples?: DatasetSamples;
}

export interface ArchetypeHistorySnapshot {
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

/**
 * Task #98 — derive a human-readable date range and day span from a
 * series of archetype-history snapshots. Returns null when the series
 * is empty so callers can opt out of rendering the chip / appendix.
 *
 * All calendar math uses UTC so that aggregated rows stored at
 * `YYYY-MM-DDT00:00:00.000Z` render as the same day for every viewer,
 * regardless of local timezone. Otherwise reviewers in negative-UTC
 * timezones would see the day label slip backwards by one.
 */
export function formatHistoryRange(
  snapshots: ArchetypeHistorySnapshot[],
): { startLabel: string; endLabel: string; days: number; label: string } | null {
  if (snapshots.length === 0) return null;
  const first = new Date(snapshots[0]!.timestamp);
  const last = new Date(snapshots[snapshots.length - 1]!.timestamp);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  // Force UTC so the label matches the UTC day key the backend uses
  // when rolling up older snapshots.
  const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  const startLabel = first.toLocaleDateString(undefined, fmt);
  const endLabel = last.toLocaleDateString(undefined, fmt);
  // Compute an inclusive day span from the UTC calendar dates of the
  // endpoints, not the raw ms delta. This avoids ±1 drift from
  // sub-day timestamps or DST boundaries in the viewer's locale.
  const startDay = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const endDay = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.round((endDay - startDay) / dayMs) + 1);
  const label =
    snapshots.length === 1 || startLabel === endLabel
      ? startLabel
      : `${startLabel} → ${endLabel}`;
  return { startLabel, endLabel, days, label };
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
  // Task #98 — surface the date range covered so reviewers can tell at
  // a glance how far back the trend extends, distinct from the raw vs.
  // aggregated point counts.
  const range = formatHistoryRange(snapshots);
  const tooltip =
    `${parts.join(" + ")}: ${ys[0]!.toFixed(1)}pt → ${last.toFixed(1)}pt headroom` +
    (range ? ` (${range.label})` : "");

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
            {(() => {
              // Task #98 — show the date span covered by the trend so
              // reviewers can see at a glance how far back history goes,
              // distinct from the raw vs. aggregated counts already in
              // the sparkline tooltip.
              const range = formatHistoryRange(history);
              if (!range) return null;
              return (
                <>
                  {" · "}
                  <span className="tabular-nums">{range.days}</span> day{range.days === 1 ? "" : "s"}
                  {" ("}
                  <span className="tabular-nums">{range.label}</span>
                  {")"}
                </>
              );
            })()}
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
const ARCHETYPE_HISTORY_CONFIG_QUERY_KEY = ["test-run-archetype-history-config"] as const;

// Task #99 — shape returned by GET /api/test/archetype-history/config so the
// reviewer can see *why* the effective compaction window is what it is
// (env var override, persisted reviewer setting, or the built-in default).
interface ArchetypeHistoryConfigResponse {
  effectiveDays: number;
  source: "env" | "persisted" | "default";
  envOverride: number | null;
  persistedDays: number | null;
  defaultDays: number;
  min: number;
  max: number;
}

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

// Task #196 — Persisted dedup state for AVRI drift notifications. Each
// entry represents a flag that has already been dispatched to the
// reviewer webhook and would be silently suppressed on the next dispatch
// run. The "Re-arm" button POSTs the entry's `key` back to the server so
// the matching flag fires again on the next call to
// /feedback/calibration/avri-drift/notify.
function NotifiedFlagsPanel({
  authState,
  notificationsQueryKey,
  driftReportQueryKey,
}: {
  authState: CalibrationAuthState;
  notificationsQueryKey: ReturnType<typeof getGetAvriDriftNotificationsQueryKey>;
  driftReportQueryKey: ReturnType<typeof getGetAvriDriftReportQueryKey>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The list endpoint uses requireCalibrationAuthStrict, which 401s
  // unconditionally unless CALIBRATION_TOKEN is set on the server AND
  // the request supplies a matching token — even in "open" mode (where
  // the server has no token configured) the strict gate still rejects
  // the read. So only fire the request when we know the reviewer's
  // build is shipping a valid token; everything else gets a static
  // explainer instead of a load error.
  const enabled = authState.kind === "valid";
  const { data, isLoading, isError, refetch } = useGetAvriDriftNotifications({
    query: {
      queryKey: notificationsQueryKey,
      refetchInterval: 300_000,
      enabled,
      retry: 1,
    },
  });

  if (!enabled) {
    let message: string;
    switch (authState.kind) {
      case "loading":
        message = "Checking reviewer auth before loading the dedup state…";
        break;
      case "open":
        message =
          "The dedup state is only viewable when a reviewer token is configured on both the server (CALIBRATION_TOKEN) and the dashboard (VITE_CALIBRATION_TOKEN). The server currently has no token configured, so this read is gated off.";
        break;
      case "missing":
      case "invalid":
        message =
          "A valid reviewer token is required to view or re-arm previously-notified drift flags.";
        break;
      case "probe-failed":
        message =
          "Could not reach the reviewer auth probe — the dedup state read is gated off until auth status is known.";
        break;
      default:
        message =
          "A valid reviewer token is required to view or re-arm previously-notified drift flags.";
    }
    return (
      <p className="text-[11px] text-muted-foreground/60 italic leading-relaxed">
        {message}
      </p>
    );
  }

  if (isLoading) {
    return <Skeleton className="h-16 rounded-md" />;
  }
  if (isError || !data) {
    return (
      <p className="text-[11px] text-red-400/80 italic leading-relaxed">
        Could not load the AVRI drift notification dedup state.
      </p>
    );
  }
  const notified: AvriDriftNotificationRecord[] = data.notified ?? [];
  if (notified.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground/60 italic flex items-center gap-2">
        <CheckCircle2 className="w-3 h-3 text-green-400" />
        No previously-notified flags are currently being suppressed.
      </p>
    );
  }

  // Newest-first so the most recently dispatched entries are at the top.
  const sorted = [...notified].sort((a, b) => {
    const ta = new Date(a.notifiedAt).getTime();
    const tb = new Date(b.notifiedAt).getTime();
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return 0;
  });

  const handleRearm = async (record: AvriDriftNotificationRecord) => {
    const key = record.key;
    setBusyKey(key);
    try {
      const resp = await rearmAvriDriftNotifications({ keys: [key] });
      toast({
        title: "Drift flag re-armed",
        description: `"${record.detail}" will fire again on the next dispatch run.`,
      });
      // Defensive: a 200 with rearmed===0 shouldn't happen for a single
      // known key, but if the backend ever changes its mind we still
      // surface the divergence rather than silently swallowing it.
      if (resp.rearmed === 0) {
        toast({
          title: "Nothing to re-arm",
          description:
            "The dedup entry was already gone — refreshing the dashboard to catch up.",
        });
      }
      // Refresh both the dedup state (to drop the row) and the drift
      // report itself (so the flag re-appears in the active flag list
      // immediately when the next /notify dispatch repopulates it).
      queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
      queryClient.invalidateQueries({ queryKey: driftReportQueryKey });
      await refetch();
    } catch (err) {
      // The backend returns 404 when none of the requested keys matched
      // (e.g. another reviewer already re-armed it, or the dedup file
      // was pruned out-of-band). That's an expected business outcome
      // for a stale row, not a hard failure — surface it as an info
      // toast and refresh the panel so the row disappears.
      if (err instanceof ApiError && err.status === 404) {
        toast({
          title: "Already re-armed",
          description:
            "This entry was already gone from the dedup state — refreshing the list.",
        });
        queryClient.invalidateQueries({ queryKey: notificationsQueryKey });
        queryClient.invalidateQueries({ queryKey: driftReportQueryKey });
        await refetch();
      } else {
        const msg = err instanceof Error ? err.message : "Failed to re-arm flag.";
        toast({ title: "Re-arm failed", description: msg, variant: "destructive" });
      }
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <ul className="space-y-1.5">
      {sorted.map((record) => {
        const isBusy = busyKey === record.key;
        const notifiedAt = new Date(record.notifiedAt);
        const notifiedAtLabel = Number.isFinite(notifiedAt.getTime())
          ? notifiedAt.toISOString().replace("T", " ").slice(0, 16) + "Z"
          : record.notifiedAt;
        const kindLabel =
          record.kind === "GAP_BELOW_45" ? "Gap < threshold" : "Family shift";
        const kindColor =
          record.kind === "GAP_BELOW_45"
            ? "text-red-400 bg-red-400/10 border-red-400/30"
            : "text-orange-400 bg-orange-400/10 border-orange-400/30";
        return (
          <li
            key={record.key}
            className="flex items-start gap-2 text-xs p-2 rounded-md border border-border/40 bg-muted/[0.03]"
          >
            <Badge
              variant="outline"
              className={cn("text-[10px] gap-1 font-mono shrink-0", kindColor)}
            >
              <AlertTriangle className="w-3 h-3" /> {kindLabel}
            </Badge>
            <div className="flex-1 min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70 font-mono">
                <span>week {record.weekStart}</span>
                <span className="text-muted-foreground/40">·</span>
                <span title={record.notifiedAt}>notified {notifiedAtLabel}</span>
              </div>
              <div className="text-foreground/80 leading-relaxed break-words">
                {record.detail}
              </div>
              <div className="text-[10px] text-muted-foreground/40 font-mono break-all">
                key: {record.key}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px] gap-1 shrink-0"
              disabled={isBusy || !authState.mutationsAllowed}
              onClick={() => handleRearm(record)}
              title={
                authState.mutationsAllowed
                  ? "Remove this entry from the dedup state so the flag re-pages reviewers on the next dispatch run."
                  : "A valid reviewer token is required to re-arm flags."
              }
            >
              <RotateCcw className="w-3 h-3" />
              {isBusy ? "Re-arming…" : "Re-arm"}
            </Button>
          </li>
        );
      })}
    </ul>
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
  const { toast } = useToast();

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

  // Task #99 — read the effective compaction window so the reviewer can
  // both see what's currently in force and edit the persisted value
  // inline. The endpoint is dev-only (404s in production) and shares the
  // same gating as the rest of this section, so we tolerate failures
  // silently rather than rendering a noisy error.
  const { data: configData } = useQuery<ArchetypeHistoryConfigResponse>({
    queryKey: ARCHETYPE_HISTORY_CONFIG_QUERY_KEY,
    queryFn: async () => {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/test/archetype-history/config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 300_000,
    retry: false,
    enabled: !isError,
  });

  // Local draft for the compaction window so the reviewer can type a new
  // value without firing a PUT on every keystroke. We sync it with the
  // server-reported effective value whenever that changes.
  const [compactDraft, setCompactDraft] = useState<string>("");
  const [compactSaving, setCompactSaving] = useState(false);
  const [compactResetting, setCompactResetting] = useState(false);
  useEffect(() => {
    if (configData) setCompactDraft(String(configData.effectiveDays));
  }, [configData?.effectiveDays]);

  const compactMin = configData?.min ?? 7;
  const compactMax = configData?.max ?? 365;
  const compactDraftNum = Number(compactDraft);
  const compactDraftValid =
    Number.isFinite(compactDraftNum)
    && Number.isInteger(compactDraftNum)
    && compactDraftNum >= compactMin
    && compactDraftNum <= compactMax;
  const compactDraftDirty =
    configData != null && compactDraftValid && compactDraftNum !== configData.effectiveDays;
  const envLocked = configData?.envOverride != null;

  async function saveCompactWindow() {
    if (!compactDraftValid || compactSaving || compactResetting || envLocked) return;
    setCompactSaving(true);
    try {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const headers: Record<string, string> = { "content-type": "application/json" };
      const tok = getCalibrationToken();
      if (tok) headers["x-calibration-token"] = tok;
      const res = await fetch(`${baseUrl}/api/test/archetype-history/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ compactAfterDays: compactDraftNum }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        effectiveDays?: number;
      };
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast({
        title: "Compaction window updated",
        description: `Snapshots older than ${body.effectiveDays}d will be rolled up to one row per day on the next /api/test/run.`,
      });
      queryClient.invalidateQueries({ queryKey: ARCHETYPE_HISTORY_CONFIG_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ARCHETYPE_HISTORY_QUERY_KEY });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update the compaction window.";
      toast({ title: "Could not save", description: msg, variant: "destructive" });
    } finally {
      setCompactSaving(false);
    }
  }

  // Task #210 — clear the persisted JSON entirely so the resolved source
  // flips back to "default" (or "env" if the env override is set).
  // Disabled when nothing is persisted, when the env override is winning
  // anyway, or while another mutation is in flight.
  async function resetCompactWindow() {
    if (compactResetting || compactSaving || envLocked) return;
    if (configData?.persistedDays == null) return;
    setCompactResetting(true);
    try {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const headers: Record<string, string> = {};
      const tok = getCalibrationToken();
      if (tok) headers["x-calibration-token"] = tok;
      const res = await fetch(`${baseUrl}/api/test/archetype-history/config`, {
        method: "DELETE",
        headers,
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        effectiveDays?: number;
        defaultDays?: number;
      };
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast({
        title: "Compaction window reset",
        description: `Reverted to the built-in default (${body.effectiveDays ?? body.defaultDays}d).`,
      });
      queryClient.invalidateQueries({ queryKey: ARCHETYPE_HISTORY_CONFIG_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ARCHETYPE_HISTORY_QUERY_KEY });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reset the compaction window.";
      toast({ title: "Could not reset", description: msg, variant: "destructive" });
    } finally {
      setCompactResetting(false);
    }
  }

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
        {configData && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-muted/[0.04] px-3 py-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Compaction window</span>
            <input
              type="number"
              min={compactMin}
              max={compactMax}
              step={1}
              value={compactDraft}
              disabled={envLocked || compactSaving || compactResetting}
              onChange={e => setCompactDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveCompactWindow();
                }
              }}
              aria-label="Compaction window in days"
              className={cn(
                "w-16 px-2 py-1 rounded-md bg-background border text-foreground tabular-nums text-xs",
                compactDraft.length > 0 && !compactDraftValid
                  ? "border-red-400/60"
                  : "border-border",
                (envLocked || compactSaving || compactResetting) && "opacity-60 cursor-not-allowed",
              )}
            />
            <span>days</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={!compactDraftDirty || compactSaving || compactResetting || envLocked}
              onClick={() => void saveCompactWindow()}
            >
              {compactSaving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={
                envLocked
                || compactSaving
                || compactResetting
                || configData.persistedDays == null
              }
              onClick={() => void resetCompactWindow()}
              title={
                envLocked
                  ? "ARCHETYPE_HISTORY_COMPACT_DAYS is set; unset it to take effect."
                  : configData.persistedDays == null
                    ? `Already on the built-in default (${configData.defaultDays}d).`
                    : `Clear the persisted setting and revert to the built-in default (${configData.defaultDays}d).`
              }
            >
              {compactResetting ? "Resetting…" : "Reset to default"}
            </Button>
            <span className="text-muted-foreground/70">
              effective <span className="font-mono text-foreground">{configData.effectiveDays}d</span>
              {" · "}
              {configData.source === "env" && (
                <>source <span className="font-mono">env</span> (ARCHETYPE_HISTORY_COMPACT_DAYS)</>
              )}
              {configData.source === "persisted" && (
                <>source <span className="font-mono">reviewer setting</span></>
              )}
              {configData.source === "default" && (
                <>source <span className="font-mono">default ({configData.defaultDays}d)</span></>
              )}
            </span>
            {envLocked && (
              <Badge
                variant="outline"
                className="text-[10px] gap-1 text-orange-400 bg-orange-400/10 border-orange-400/30"
              >
                <AlertTriangle className="w-3 h-3" />
                env override active — reviewer changes won't take effect until ARCHETYPE_HISTORY_COMPACT_DAYS is unset
              </Badge>
            )}
            {!envLocked
              && configData.persistedDays != null
              && configData.persistedDays !== configData.effectiveDays && (
                <span className="text-muted-foreground/60">
                  (persisted: {configData.persistedDays}d)
                </span>
              )}
            {compactDraft.length > 0 && !compactDraftValid && (
              <span className="text-red-400">
                Enter a whole number between {compactMin} and {compactMax}.
              </span>
            )}
          </div>
        )}
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

// Task #186 — render the dataset cohort means + T1−T3 gap from
// `/api/test/run`'s `datasetSamples` block. Mirrors the gating used by
// EmergingArchetypesSection (dev-only endpoint, hidden in prod) and
// shares its query cache so both components consume one fetch. When the
// dataset isn't mounted the section still renders, surfacing a short
// "dataset not mounted" hint instead of being hidden — that distinguishes
// "no curated data on disk" from "endpoint unavailable".
const DATASET_COHORT_TIER_LABELS: Record<string, string> = {
  T1_LEGIT: "T1 · Legit",
  T2_BORDERLINE: "T2 · Borderline",
  T3_SLOP: "T3 · Slop",
};
const DATASET_COHORT_ORDER = ["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"] as const;

function DatasetCohortMeansSection() {
  const { data, isLoading, isError } = useQuery<TestRunResponse>({
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

  if (isLoading) return <Skeleton className="h-40 rounded-xl" />;
  // /api/test/run is dev-only; in production the endpoint 404s. Hide
  // the panel rather than surface a noisy error to reviewers.
  if (isError || !data?.datasetSamples) return null;

  const ds = data.datasetSamples;

  if (!ds.available) {
    return (
      <Card className="glass-card rounded-xl border-primary/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Curated Dataset Cohort Means
          </CardTitle>
          <CardDescription>
            Per-cohort composite means and the T1−T3 gap from up to 75 sampled real reports.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/[0.04] px-3 py-2 text-[11px] text-muted-foreground">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground/70" />
            <span>
              Dataset not mounted — set <span className="font-mono">VULNRAP_DATASETS_DIR</span> (or
              place <span className="font-mono">vuln_reports_dataset_v2.json.gz</span> at
              {" "}<span className="font-mono">/mnt/vulnrap/data</span>) to surface drift on real reports.
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const cohortByTier = new Map(ds.cohorts.map(c => [c.tier, c]));
  const orderedCohorts = DATASET_COHORT_ORDER
    .map(t => cohortByTier.get(t))
    .filter((c): c is DatasetCohort => c != null);

  const gapText = ds.gap != null ? `${ds.gap.toFixed(1)}pt` : "n/a";
  const gapColor = ds.gap == null
    ? "text-muted-foreground bg-muted/20 border-border/40"
    : ds.gapMeetsTarget
      ? "text-green-400 bg-green-400/10 border-green-400/30"
      : "text-orange-400 bg-orange-400/10 border-orange-400/30";

  return (
    <Card className="glass-card rounded-xl border-primary/10">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Curated Dataset Cohort Means
            <Badge variant="secondary" className="text-[10px]">{ds.sampleCount} samples</Badge>
          </CardTitle>
          <Badge variant="outline" className={cn("text-[10px] gap-1 tabular-nums", gapColor)}>
            <Shield className="w-3 h-3" />
            T1−T3 gap {gapText} (target ≥{ds.gapTarget}pt)
          </Badge>
        </div>
        <CardDescription>
          Per-cohort composite means and the T1−T3 gap from up to {ds.sampleSizeRequestedPerLabel} sampled
          real reports per label. Drawn live from the curated dataset on each run, so calibration drift
          shows up on a much larger sample than the {data.archetypes?.reduce((n, a) => n + a.count, 0) ?? 0}-fixture
          synthetic battery.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {orderedCohorts.map(c => (
            <div
              key={c.tier}
              className="rounded-md border border-border/40 bg-muted/[0.04] px-3 py-2"
            >
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="font-mono">{DATASET_COHORT_TIER_LABELS[c.tier] ?? c.tier}</span>
                <span className="tabular-nums text-muted-foreground/60">n={c.count}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-lg font-semibold tabular-nums text-foreground">
                  {c.compositeMean != null ? c.compositeMean.toFixed(1) : "—"}
                </span>
                <span className="text-[10px] text-muted-foreground">composite mean</span>
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                {c.compositeMin != null && c.compositeMax != null
                  ? <>range {c.compositeMin.toFixed(1)}–{c.compositeMax.toFixed(1)}</>
                  : "no samples"}
                {c.engine2Mean != null && (
                  <> · E2 mean {c.engine2Mean.toFixed(1)}</>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground/70 font-mono break-all">
          source: {ds.sourcePath}
        </div>
      </CardContent>
    </Card>
  );
}

const AVRI_DRIFT_LOOKBACK_OPTIONS = [4, 8, 13, 26] as const;
type AvriDriftLookbackWeeks = (typeof AVRI_DRIFT_LOOKBACK_OPTIONS)[number];
const AVRI_DRIFT_DEFAULT_WEEKS: AvriDriftLookbackWeeks = 8;
const AVRI_DRIFT_LOOKBACK_QUERY_KEY = "driftWeeks";
const AVRI_DRIFT_LOOKBACK_STORAGE_KEY = "vulnrap.avri.driftWeeks";

function isValidDriftLookback(value: number): value is AvriDriftLookbackWeeks {
  return (AVRI_DRIFT_LOOKBACK_OPTIONS as readonly number[]).includes(value);
}

function parseDriftLookback(raw: string | null | undefined): AvriDriftLookbackWeeks | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return isValidDriftLookback(n) ? n : null;
}

function readStoredDriftLookback(): AvriDriftLookbackWeeks | null {
  if (typeof window === "undefined") return null;
  try {
    return parseDriftLookback(window.localStorage.getItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY));
  } catch {
    return null;
  }
}

function AvriDriftSection() {
  // Sprint 13 — Persist the lookback selection across reloads. The URL query
  // param (?driftWeeks=26) makes the panel state shareable in chat/links;
  // localStorage covers reviewers who navigate back to the page without the
  // query string. Precedence rules:
  //   - URL present + valid  -> use URL (so a shared link wins).
  //   - URL present + invalid -> fall back to the default (NOT storage), so a
  //     bad/garbled link can't produce reviewer-specific behaviour.
  //   - URL absent           -> use stored value, else default.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawUrlValue = searchParams.get(AVRI_DRIFT_LOOKBACK_QUERY_KEY);
  const urlPresent = rawUrlValue !== null;
  const urlWeeks = urlPresent ? parseDriftLookback(rawUrlValue) : null;
  const weeks: AvriDriftLookbackWeeks = urlPresent
    ? (urlWeeks ?? AVRI_DRIFT_DEFAULT_WEEKS)
    : (readStoredDriftLookback() ?? AVRI_DRIFT_DEFAULT_WEEKS);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, String(weeks));
    } catch {
      // Ignore quota / privacy-mode write errors — the URL param still works.
    }
  }, [weeks]);

  // Normalize the URL on first render so the address bar always matches the
  // visible state and is safely shareable:
  //   - URL has a malformed/out-of-range value -> strip it (we resolved to 8).
  //   - URL is absent but storage gave us a non-default value -> add it so
  //     the reviewer can copy/share the current view.
  // Uses replace so we don't add an extra history entry.
  useEffect(() => {
    const urlInvalid = urlPresent && urlWeeks === null;
    const shouldAddFromStorage = !urlPresent && weeks !== AVRI_DRIFT_DEFAULT_WEEKS;
    if (!urlInvalid && !shouldAddFromStorage) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (urlInvalid) {
          next.delete(AVRI_DRIFT_LOOKBACK_QUERY_KEY);
        } else {
          next.set(AVRI_DRIFT_LOOKBACK_QUERY_KEY, String(weeks));
        }
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setWeeks = (value: AvriDriftLookbackWeeks) => {
    // Write storage synchronously here — not just via the [weeks] effect.
    // When switching back to the default we drop the query param, so the
    // immediate re-render falls into the "URL absent -> read storage"
    // branch. Without this synchronous write, storage would still hold the
    // previous non-default value and the chooser would visibly snap back.
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, String(value));
      } catch {
        // Ignore quota / privacy-mode write errors — URL handling still works.
      }
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === AVRI_DRIFT_DEFAULT_WEEKS) {
          next.delete(AVRI_DRIFT_LOOKBACK_QUERY_KEY);
        } else {
          next.set(AVRI_DRIFT_LOOKBACK_QUERY_KEY, String(value));
        }
        return next;
      },
      { replace: false },
    );
  };

  const params = { weeks };
  const driftReportQueryKey = getGetAvriDriftReportQueryKey(params);
  const notificationsQueryKey = getGetAvriDriftNotificationsQueryKey();
  const authState = useCalibrationAuthState();
  const { data, isLoading, isFetching, error } = useGetAvriDriftReport(params, {
    query: {
      queryKey: driftReportQueryKey,
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
            <span className="text-[10px] font-normal text-muted-foreground tabular-nums">
              · last {report.weeksRequested} weeks
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <div
              role="radiogroup"
              aria-label="Lookback window (weeks)"
              className="inline-flex items-center rounded-md border border-border/50 bg-muted/20 p-0.5"
            >
              {AVRI_DRIFT_LOOKBACK_OPTIONS.map(opt => {
                const active = opt === weeks;
                return (
                  <button
                    key={opt}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={isFetching && active}
                    onClick={() => setWeeks(opt)}
                    className={cn(
                      "px-2 py-0.5 text-[10px] font-mono rounded-sm transition-colors tabular-nums",
                      active
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
                    )}
                  >
                    {opt}w
                  </button>
                );
              })}
            </div>
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

        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
            <span>Notified flags (suppressed from re-paging)</span>
            <span className="text-muted-foreground/40 normal-case font-normal italic">
              re-arm to re-fire on the next dispatch run
            </span>
          </div>
          <NotifiedFlagsPanel
            authState={authState}
            notificationsQueryKey={notificationsQueryKey}
            driftReportQueryKey={driftReportQueryKey}
          />
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

      <DatasetCohortMeansSection />

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
