import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useGetPublicStatus,
  getGetPublicStatusQueryKey,
  useGetPublicStatusIncidents,
  getGetPublicStatusIncidentsQueryKey,
} from "@workspace/api-client-react";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Timer,
  Gauge,
  Clock,
  ChevronDown,
  ChevronUp,
  Shield,
  ExternalLink,
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

function formatDuration(ms: number | null): string {
  if (ms === null) return "ongoing";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / (60 * 60_000));
  const mins = Math.round((ms % (60 * 60_000)) / 60_000);
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default function Status() {
  const { data, isLoading } = useGetPublicStatus({
    query: {
      queryKey: getGetPublicStatusQueryKey(),
      refetchInterval: 60_000,
    },
  });

  const { data: incidentsData, isLoading: incidentsLoading } =
    useGetPublicStatusIncidents({
      query: {
        queryKey: getGetPublicStatusIncidentsQueryKey(),
        refetchInterval: 60_000,
      },
    });

  const [expandedIncident, setExpandedIncident] = useState<string | null>(null);

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

      <Card className="glass-card rounded-xl" data-testid="incidents-section">
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wide flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Recent Incidents
          </CardTitle>
          <CardDescription>
            Detected degradations and outages from the last 30 days, derived
            from pipeline telemetry gaps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {incidentsLoading ? (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          ) : !incidentsData || incidentsData.incidents.length === 0 ? (
            <div className="flex items-center gap-3 px-4 py-6 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-center justify-center">
              <Shield className="w-5 h-5 text-emerald-400" />
              <span className="text-sm text-muted-foreground">
                No incidents detected in the last{" "}
                {incidentsData?.windowDays ?? 30} days
              </span>
            </div>
          ) : (
            incidentsData.incidents.map((incident) => {
              const isExpanded = expandedIncident === incident.id;
              const isOngoing = incident.endedAt === null;
              const severityMeta =
                incident.severity === "outage"
                  ? {
                      color: "text-red-400",
                      bg: "bg-red-500/10",
                      ring: "border-red-500/30",
                      icon: <XCircle className="w-4 h-4" />,
                      label: "Outage",
                    }
                  : {
                      color: "text-yellow-400",
                      bg: "bg-yellow-500/10",
                      ring: "border-yellow-500/30",
                      icon: <AlertTriangle className="w-4 h-4" />,
                      label: "Degraded",
                    };

              return (
                <div key={incident.id} className="rounded-lg border overflow-hidden">
                  <button
                    type="button"
                    className={cn(
                      "w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30",
                      severityMeta.ring,
                      severityMeta.bg,
                    )}
                    onClick={() =>
                      setExpandedIncident(isExpanded ? null : incident.id)
                    }
                    data-testid={`incident-row-${incident.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={severityMeta.color}>
                        {severityMeta.icon}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">
                            {formatDateTime(incident.startedAt)}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "uppercase font-mono text-[10px] tracking-wider",
                              severityMeta.color,
                              severityMeta.ring,
                            )}
                          >
                            {severityMeta.label}
                          </Badge>
                          {isOngoing && (
                            <Badge
                              variant="outline"
                              className="uppercase font-mono text-[10px] tracking-wider text-red-400 border-red-500/40 animate-pulse"
                            >
                              Ongoing
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                          Duration: {formatDuration(incident.durationMs)} ·{" "}
                          {incident.affectedEngines.length} engine
                          {incident.affectedEngines.length === 1 ? "" : "s"}{" "}
                          affected
                        </div>
                      </div>
                    </div>
                    <span className="text-muted-foreground shrink-0">
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </span>
                  </button>

                  {isExpanded && (
                    <div
                      className="px-4 py-3 border-t border-border/40 bg-muted/10 space-y-3"
                      data-testid={`incident-detail-${incident.id}`}
                    >
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider mb-1">
                            Started
                          </div>
                          <div className="font-mono text-sm">
                            {formatDateTime(incident.startedAt)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider mb-1">
                            Recovered
                          </div>
                          <div className="font-mono text-sm">
                            {incident.endedAt
                              ? formatDateTime(incident.endedAt)
                              : "Not yet recovered"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-end justify-between gap-4">
                        <div>
                          <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider mb-2">
                            Affected Engines
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {incident.affectedEngines.map((eng) => (
                              <Badge
                                key={eng.id}
                                variant="outline"
                                className="text-xs font-mono"
                              >
                                {eng.label}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <Link
                          to={`/status/incidents/${incident.id}`}
                          className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline shrink-0"
                          data-testid={`incident-link-${incident.id}`}
                        >
                          View details
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                      </div>
                    </div>
                  )}
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
        never observed. Incidents are auto-detected from contiguous gaps of
        more than one hour in pipeline telemetry.
      </p>
    </div>
  );
}
