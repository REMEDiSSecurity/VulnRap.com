// Task #617 — Public, read-only AVRI calibration drift widget for the
// `/transparency` page. Shows the last 12 weeks of T1−T3 mean composite
// spread as a sparkline plus the current spread vs last-week delta.
//
// The widget intentionally renders only public-safe fields (weekly
// spread + current/previous/delta). All reviewer-only fields (per-family
// means, flag detail strings, bucket counts, thresholds, runbook path)
// stay behind the calibration auth gate — the widget consumes the
// `/api/public/drift-summary` DTO that strips them server-side.
import {
  useGetPublicDriftSummary,
  getGetPublicDriftSummaryQueryKey,
} from "@workspace/api-client-react";
import { Activity, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

function formatWeek(weekStart: string): string {
  const d = new Date(weekStart + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return weekStart;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface TrendHintInput {
  weeks: Array<{ spread: number | null }>;
}

export function computeTrendHint(input: TrendHintInput): string {
  const spreads = input.weeks
    .map((w) => w.spread)
    .filter((s): s is number => s != null);

  if (spreads.length === 0) {
    return "Not enough data to determine a trend yet.";
  }
  if (spreads.length === 1) {
    return "Only one week of data so far — trend will appear once more weeks come in.";
  }

  const recent = spreads.slice(-4);

  const deltas = recent.slice(1).map((v, i) => v - recent[i]);

  const steadyThreshold = 1.5;
  const allSteady = deltas.every((d) => Math.abs(d) <= steadyThreshold);

  if (allSteady) {
    const streakLen = recent.length;
    return `The gap has held steady for ${streakLen} week${streakLen === 1 ? "" : "s"}.`;
  }

  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  if (avgDelta > 0) {
    if (avgDelta > 3) {
      return "Spread widened noticeably over recent weeks — the engine is separating tiers more strongly.";
    }
    return "Spread has been gradually widening — the engine is pulling tiers further apart.";
  }

  if (avgDelta < 0) {
    if (avgDelta < -3) {
      return "Spread narrowed noticeably over recent weeks — the tiers are closer together than before.";
    }
    return "Spread narrowed slightly over recent weeks.";
  }

  return "The gap has held steady over recent weeks.";
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-mono"
        data-testid="badge-drift-delta-empty"
      >
        <Minus className="w-3 h-3 mr-1" />
        no prior week
      </Badge>
    );
  }
  if (delta === 0) {
    return (
      <Badge
        variant="outline"
        className="text-xs font-mono"
        data-testid="badge-drift-delta"
      >
        <Minus className="w-3 h-3 mr-1" />
        flat vs last week
      </Badge>
    );
  }
  // A wider gap (positive delta) means the rubric is separating better,
  // which is the healthy direction for calibration. Use a green/amber
  // visual cue accordingly so the public reader can interpret the
  // arrow without needing the legend.
  const widening = delta > 0;
  const Icon = widening ? ArrowUpRight : ArrowDownRight;
  const sign = widening ? "+" : "";
  return (
    <Badge
      variant="outline"
      className={
        "text-xs font-mono " +
        (widening
          ? "text-emerald-400 border-emerald-500/40"
          : "text-amber-400 border-amber-500/40")
      }
      data-testid="badge-drift-delta"
    >
      <Icon className="w-3 h-3 mr-1" />
      {sign}
      {delta.toFixed(1)}pt vs last week
    </Badge>
  );
}

function DriftTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card rounded-lg px-3 py-2 border border-border/30 text-xs space-y-1">
      <div className="font-mono text-muted-foreground">Week of {label}</div>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-cyan-400" />
        <span className="text-muted-foreground">Spread:</span>
        <span className="font-mono font-bold text-foreground">
          {payload[0].value}pt
        </span>
      </div>
    </div>
  );
}

export function TransparencyDriftWidget() {
  const { data, isLoading, isError } = useGetPublicDriftSummary({
    query: {
      queryKey: getGetPublicDriftSummaryQueryKey(),
      refetchInterval: 5 * 60 * 1000,
    },
  });

  const sparklineData = (data?.weeks ?? []).map((w) => ({
    week: formatWeek(w.weekStart),
    spread: w.spread ?? 0,
  }));

  const hasData = sparklineData.length > 0 && data?.currentSpread != null;

  return (
    <Card
      className="glass-card rounded-xl"
      data-testid="card-transparency-drift-widget"
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold leading-none tracking-tight uppercase flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              Calibration Drift Self-Check
            </h2>
            <CardDescription className="mt-1 max-w-2xl">
              Each week we compare the average score the engine gives the
              strongest reports (T1) against the weakest ones (T3). A wider gap
              means the engine is still telling them apart cleanly. We track
              this in public so anyone can see the platform is monitoring itself
              for drift.
            </CardDescription>
          </div>
          {hasData && <DeltaBadge delta={data?.delta ?? null} />}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton
            className="h-40 w-full"
            data-testid="skeleton-drift-widget"
          />
        ) : isError ? (
          <div
            className="h-40 flex items-center justify-center text-muted-foreground text-sm"
            data-testid="empty-drift-widget"
          >
            Drift summary is temporarily unavailable. Please check back shortly.
          </div>
        ) : !hasData ? (
          <div
            className="h-40 flex flex-col items-center justify-center text-center text-muted-foreground text-sm px-4 gap-2"
            data-testid="empty-drift-widget"
          >
            <span>
              This week's drift aggregate hasn't been computed yet — check back
              once enough reports have come in to compare cohorts.
            </span>
            <p
              className="text-sm text-muted-foreground italic"
              data-testid="text-drift-trend-hint"
            >
              {computeTrendHint({ weeks: data?.weeks ?? [] })}
            </p>
          </div>
        ) : (
          <div className="space-y-4" data-testid="populated-drift-widget">
            <p
              className="text-sm text-muted-foreground italic"
              data-testid="text-drift-trend-hint"
            >
              {computeTrendHint({ weeks: data?.weeks ?? [] })}
            </p>
            <div className="flex items-baseline gap-6 flex-wrap">
              <div>
                <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">
                  Current spread
                </div>
                <div
                  className="text-3xl font-mono font-bold glow-text-sm"
                  data-testid="text-drift-current-spread"
                >
                  {data!.currentSpread!.toFixed(1)}
                  <span className="text-base text-muted-foreground ml-1">
                    pt
                  </span>
                </div>
              </div>
              {data?.previousSpread != null && (
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">
                    Last week
                  </div>
                  <div
                    className="text-xl font-mono text-muted-foreground"
                    data-testid="text-drift-previous-spread"
                  >
                    {data.previousSpread.toFixed(1)}pt
                  </div>
                </div>
              )}
              {!data?.hasCurrentWeek && (
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono"
                  data-testid="badge-drift-awaiting"
                >
                  awaiting this week's aggregate
                </Badge>
              )}
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart
                data={sparklineData}
                margin={{ top: 5, right: 5, bottom: 0, left: -10 }}
              >
                <defs>
                  <linearGradient id="driftFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.45} />
                    <stop
                      offset="100%"
                      stopColor="#06b6d4"
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.05)"
                />
                <XAxis
                  dataKey="week"
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<DriftTooltip />} />
                <Area
                  type="monotone"
                  dataKey="spread"
                  stroke="#06b6d4"
                  fill="url(#driftFill)"
                  strokeWidth={2}
                  name="Spread"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
