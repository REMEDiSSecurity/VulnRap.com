import {
  useGetLatencySnapshot,
  getGetLatencySnapshotQueryKey,
} from "@workspace/api-client-react";
import { Timer, AlertTriangle, Info } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const ENGINE_COLORS = [
  "#06b6d4",
  "#a78bfa",
  "#f97316",
  "#22c55e",
  "#eab308",
  "#ec4899",
];

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function binLabel(ltMs: number, idx: number, edges: number[]): string {
  if (idx === 0) return `<${formatMs(ltMs)}`;
  if (idx === edges.length - 1) return `≥${formatMs(edges[idx - 1])}`;
  return `${formatMs(edges[idx - 1])}–${formatMs(ltMs)}`;
}

function HistTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card rounded-lg px-3 py-2 border border-border/30 text-xs space-y-1">
      <div className="font-mono text-muted-foreground">{label}</div>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{entry.name}:</span>
          <span className="font-mono font-bold text-foreground">
            {entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function PercentileBadge({
  label,
  value,
  tip,
}: {
  label: string;
  value: number;
  tip: string;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <UITooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/30 cursor-help">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
              {label}
            </span>
            <span className="font-mono font-bold text-sm">
              {formatMs(value)}
            </span>
            <Info className="w-3 h-3 text-muted-foreground/60" />
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </UITooltip>
    </TooltipProvider>
  );
}

export default function LatencySnapshotCard() {
  const { data, isLoading } = useGetLatencySnapshot({
    query: {
      queryKey: getGetLatencySnapshotQueryKey(),
      refetchInterval: 120_000,
    },
  });

  const [view, setView] = useState<"pipeline" | "engines">("pipeline");

  const pipelineChartData = useMemo(() => {
    if (!data) return [];
    const edges = data.pipeline.bins.map((b) => b.ltMs);
    return data.pipeline.bins.map((b, i) => ({
      label: binLabel(b.ltMs, i, edges),
      Pipeline: b.count,
    }));
  }, [data]);

  const engineChartData = useMemo(() => {
    if (!data || data.engines.length === 0) return [];
    const top = data.engines.slice(0, ENGINE_COLORS.length);
    const edges = top[0].bins.map((b) => b.ltMs);
    return top[0].bins.map((b, i) => {
      const row: Record<string, string | number> = {
        label: binLabel(b.ltMs, i, edges),
      };
      for (const eng of top) {
        row[eng.engine] = eng.bins[i]?.count ?? 0;
      }
      return row;
    });
  }, [data]);

  const topEngines = data?.engines.slice(0, ENGINE_COLORS.length) ?? [];

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader>
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-cyan-400" />
            <div>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Scoring Latency (last 24h)
              </CardTitle>
              <CardDescription>
                End-to-end scoring time distribution and per-engine breakdown
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView("pipeline")}
              className={`px-2 py-1 rounded text-[10px] font-mono uppercase border transition-colors ${
                view === "pipeline"
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "border-border/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              Pipeline
            </button>
            <button
              onClick={() => setView("engines")}
              className={`px-2 py-1 rounded text-[10px] font-mono uppercase border transition-colors ${
                view === "engines"
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "border-border/30 text-muted-foreground hover:text-foreground"
              }`}
            >
              Per-Engine
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : !data || data.sampleCount === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            No scoring activity in the last 24 hours yet.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <PercentileBadge
                label="p50"
                value={data.pipeline.percentiles.p50}
                tip="Median latency: half of all scoring requests in the last 24h finished faster than this."
              />
              <PercentileBadge
                label="p95"
                value={data.pipeline.percentiles.p95}
                tip="95th percentile: only 1 in 20 requests took longer than this. A good measure of the typical worst-case experience."
              />
              <PercentileBadge
                label="p99"
                value={data.pipeline.percentiles.p99}
                tip="99th percentile: tail latency. Only 1 in 100 requests took longer. Useful for spotting outliers and engine regressions."
              />
              <Badge variant="outline" className="text-xs font-mono">
                {data.sampleCount.toLocaleString()} samples
              </Badge>
            </div>

            {data.worstEngine && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <div className="text-xs leading-relaxed">
                  <span className="font-bold text-amber-300">
                    {data.worstEngine.engine}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    is dragging the tail — p95 of{" "}
                  </span>
                  <span className="font-mono text-foreground">
                    {formatMs(data.worstEngine.p95)}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    ({data.worstEngine.ratio.toFixed(2)}× the median engine).
                  </span>
                </div>
              </div>
            )}

            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={view === "pipeline" ? pipelineChartData : engineChartData}
                margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.05)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  angle={-25}
                  textAnchor="end"
                  height={50}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "rgba(255,255,255,0.4)" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<HistTooltip />} />
                {view === "pipeline" ? (
                  <Bar
                    dataKey="Pipeline"
                    fill="#06b6d4"
                    radius={[4, 4, 0, 0]}
                  />
                ) : (
                  <>
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {topEngines.map((eng, i) => (
                      <Bar
                        key={eng.engine}
                        dataKey={eng.engine}
                        stackId="engines"
                        fill={ENGINE_COLORS[i]}
                      />
                    ))}
                  </>
                )}
              </BarChart>
            </ResponsiveContainer>

            {view === "engines" && topEngines.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                {topEngines.map((eng, i) => (
                  <div
                    key={eng.engine}
                    className="flex items-center justify-between px-2 py-1 rounded bg-muted/20 border border-border/20"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: ENGINE_COLORS[i] }}
                      />
                      <span className="truncate font-mono">{eng.engine}</span>
                    </div>
                    <span className="font-mono text-muted-foreground shrink-0 ml-2">
                      p95 {formatMs(eng.percentiles.p95)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
