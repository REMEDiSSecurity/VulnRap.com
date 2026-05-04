import {
  useGetLatencyHistory,
  getGetLatencyHistoryQueryKey,
} from "@workspace/api-client-react";
import { TrendingUp } from "lucide-react";
import {
  LineChart,
  Line,
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

const ENGINE_COLORS: Record<string, string> = {
  linguistic: "hsl(var(--chart-2))",
  substance: "hsl(var(--chart-1))",
  cwe: "hsl(var(--chart-4))",
  avri: "hsl(var(--chart-5))",
  llm_gate: "hsl(var(--chart-4))",
  composite: "#ec4899",
};

const FALLBACK_COLORS = [
  "hsl(var(--chart-2))",
  "hsl(var(--chart-1))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-4))",
  "#ec4899",
  "#8b5cf6",
  "#14b8a6",
];

function getEngineColor(engine: string, idx: number): string {
  return ENGINE_COLORS[engine] ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function HistoryTooltip({
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
            {formatMs(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function LatencyHistoryCard() {
  const { data, isLoading } = useGetLatencyHistory(
    { days: 14 },
    {
      query: {
        queryKey: getGetLatencyHistoryQueryKey({ days: 14 }),
        refetchInterval: 300_000,
      },
    },
  );

  const [metric, setMetric] = useState<"p95" | "p50" | "p99">("p95");

  const allEngines = useMemo(() => {
    if (!data?.daily) return [];
    const set = new Set<string>();
    for (const day of data.daily) {
      for (const eng of day.engines) {
        set.add(eng.engine);
      }
    }
    return Array.from(set).sort();
  }, [data]);

  const chartData = useMemo(() => {
    if (!data?.daily) return [];
    return data.daily.map((day) => {
      const row: Record<string, string | number> = {
        date: formatDate(day.date),
        Pipeline: day.pipeline[metric],
      };
      for (const eng of day.engines) {
        row[eng.engine] = eng.percentiles[metric];
      }
      return row;
    });
  }, [data, metric]);

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader>
        <div className="flex items-start justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-cyan-400" />
            <div>
              <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                Latency Over Time
              </CardTitle>
              <CardDescription>
                Daily {metric.toUpperCase()} latency — pipeline & per-engine
                (last {data?.days ?? 14} days)
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {(["p50", "p95", "p99"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMetric(m)}
                className={`px-2 py-1 rounded text-[10px] font-mono uppercase border transition-colors ${
                  metric === m
                    ? "bg-primary/20 border-primary/40 text-primary"
                    : "border-border/30 text-muted-foreground hover:text-foreground"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : !data || data.daily.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            No latency history available yet.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant="outline" className="text-xs font-mono">
                {data.daily.reduce((s, d) => s + d.sampleCount, 0).toLocaleString()}{" "}
                total samples
              </Badge>
              <Badge variant="outline" className="text-xs font-mono">
                {data.daily.length} days
              </Badge>
            </div>

            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={chartData}
                margin={{ top: 5, right: 5, bottom: 5, left: -10 }}
              >
                <defs>
                  <linearGradient id="pipelineGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" />
                    <stop offset="100%" stopColor="hsl(var(--chart-2))" />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--chart-grid)"
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "var(--chart-tick)" }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--chart-tick)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => formatMs(v)}
                />
                <Tooltip content={<HistoryTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line
                  type="monotone"
                  dataKey="Pipeline"
                  stroke="url(#pipelineGrad)"
                  strokeWidth={2.5}
                  dot={{ r: 3, fill: "hsl(var(--chart-1))" }}
                  activeDot={{ r: 5 }}
                  name="Pipeline"
                />
                {allEngines.map((engine, i) => (
                  <Line
                    key={engine}
                    type="monotone"
                    dataKey={engine}
                    stroke={getEngineColor(engine, i)}
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                    name={engine}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </CardContent>
    </Card>
  );
}
