import {
  useGetPublicStatus,
  getGetPublicStatusQueryKey,
} from "@workspace/api-client-react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Timer,
  Gauge,
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

const STATUS_META: Record<
  "operational" | "degraded" | "down" | "unknown",
  {
    label: string;
    color: string;
    bg: string;
    ring: string;
    icon: React.ReactNode;
  }
> = {
  operational: {
    label: "Operational",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    ring: "border-emerald-500/40",
    icon: <CheckCircle2 className="w-4 h-4" />,
  },
  degraded: {
    label: "Degraded",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10",
    ring: "border-yellow-500/40",
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  down: {
    label: "Down",
    color: "text-red-400",
    bg: "bg-red-500/10",
    ring: "border-red-500/40",
    icon: <XCircle className="w-4 h-4" />,
  },
  unknown: {
    label: "No data",
    color: "text-muted-foreground",
    bg: "bg-muted/20",
    ring: "border-border/40",
    icon: <HelpCircle className="w-4 h-4" />,
  },
};

const OVERALL_BANNER: Record<
  "operational" | "degraded" | "down",
  { headline: string; color: string; bg: string; ring: string }
> = {
  operational: {
    headline: "All systems operational",
    color: "text-emerald-300",
    bg: "bg-emerald-500/10",
    ring: "border-emerald-500/40",
  },
  degraded: {
    headline: "Some systems degraded",
    color: "text-yellow-300",
    bg: "bg-yellow-500/10",
    ring: "border-yellow-500/40",
  },
  down: {
    headline: "Major outage in progress",
    color: "text-red-300",
    bg: "bg-red-500/10",
    ring: "border-red-500/40",
  },
};

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000)
    return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
}

export default function Status() {
  const { data, isLoading } = useGetPublicStatus({
    query: {
      queryKey: getGetPublicStatusQueryKey(),
      refetchInterval: 60_000,
    },
  });

  const banner = data ? OVERALL_BANNER[data.overallStatus] : null;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Activity className="w-8 h-8 text-primary" />
          System Status
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Live snapshot of API uptime, scoring latency, and the health of each
          scoring engine. Refreshed every 60 seconds. Numbers are computed from
          the platform's own analysis telemetry — no third-party uptime monitor.
        </p>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : (
        <div
          className={cn(
            "rounded-xl border p-5 flex items-center gap-4",
            banner?.bg,
            banner?.ring,
          )}
          data-testid="status-banner"
        >
          <div
            className={cn(
              "w-3 h-3 rounded-full shrink-0",
              data.overallStatus === "operational" &&
                "bg-emerald-400 animate-pulse",
              data.overallStatus === "degraded" &&
                "bg-yellow-400 animate-pulse",
              data.overallStatus === "down" && "bg-red-400 animate-pulse",
            )}
          />
          <div className="flex-1">
            <div
              className={cn(
                "text-lg font-bold uppercase tracking-wide",
                banner?.color,
              )}
            >
              {banner?.headline}
            </div>
            <div className="text-xs text-muted-foreground font-mono mt-0.5">
              Updated {formatRelative(data.generatedAt)}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="glass-card rounded-xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">
                30d Uptime
              </span>
              <Gauge className="w-4 h-4 text-primary" />
            </div>
            {isLoading || !data ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-3xl font-mono font-bold glow-text-sm">
                {data.uptime.uptimePercentage.toFixed(2)}%
              </div>
            )}
            {data && (
              <div className="text-xs text-muted-foreground mt-2">
                {data.uptime.daysWithTraffic} of {data.uptime.windowDays} days
                with traffic
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">
                p50 Latency (24h)
              </span>
              <Timer className="w-4 h-4 text-primary" />
            </div>
            {isLoading || !data ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-3xl font-mono font-bold glow-text-sm">
                {formatMs(data.latency.p50Ms)}
              </div>
            )}
            {data && (
              <div className="text-xs text-muted-foreground mt-2">
                {data.latency.sampleCount} sample
                {data.latency.sampleCount === 1 ? "" : "s"}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider">
                p95 Latency (24h)
              </span>
              <Timer className="w-4 h-4 text-primary" />
            </div>
            {isLoading || !data ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-3xl font-mono font-bold glow-text-sm">
                {formatMs(data.latency.p95Ms)}
              </div>
            )}
            {data && (
              <div className="text-xs text-muted-foreground mt-2">
                Tail latency, last 24 hours
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wide">
            Engine Subsystems
          </CardTitle>
          <CardDescription>
            Health of each scoring engine, derived from the most recent
            successful pipeline traces.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading || !data ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : (
            data.engines.map((eng) => {
              const meta = STATUS_META[eng.status];
              return (
                <div
                  key={eng.id}
                  className={cn(
                    "flex items-center justify-between gap-3 px-4 py-3 rounded-lg border",
                    meta.ring,
                    meta.bg,
                  )}
                  data-testid={`engine-row-${eng.id}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={meta.color}>{meta.icon}</span>
                    <div className="min-w-0">
                      <div className="font-medium text-sm">{eng.label}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">
                        {eng.recentSampleCount} runs in last hour · last seen{" "}
                        {formatRelative(eng.lastSeenAt)}
                      </div>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "uppercase font-mono text-[10px] tracking-wider shrink-0",
                      meta.color,
                      meta.ring,
                    )}
                  >
                    {meta.label}
                  </Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
        Status is derived from the platform's own scoring telemetry. An engine
        is "operational" if its pipeline stage was seen in the last hour,
        "degraded" if seen in the last six hours but not the last hour, "down"
        if older than six hours but seen in the last 30 days, and "no data" if
        never observed. Incident history is intentionally out of scope for this
        page.
      </p>
    </div>
  );
}
