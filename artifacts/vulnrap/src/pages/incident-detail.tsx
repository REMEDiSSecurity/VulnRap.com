import { useParams, Link } from "react-router-dom";
import {
  useGetPublicStatusIncidents,
  getGetPublicStatusIncidentsQueryKey,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  AlertTriangle,
  XCircle,
  Clock,
  Shield,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatDuration(ms: number | null): string {
  if (ms === null) return "Ongoing";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  const hours = Math.floor(ms / (60 * 60_000));
  const mins = Math.round((ms % (60 * 60_000)) / 60_000);
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export default function IncidentDetail() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading } = useGetPublicStatusIncidents({
    query: {
      queryKey: getGetPublicStatusIncidentsQueryKey(),
    },
  });

  const incident = data?.incidents.find((i) => i.id === id);

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <Button asChild variant="ghost" size="sm">
          <Link to="/status" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Status
          </Link>
        </Button>
        <Card className="glass-card rounded-xl">
          <CardContent className="py-12 text-center">
            <Shield className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Incident not found</h2>
            <p className="text-sm text-muted-foreground">
              This incident may have aged out of the 30-day window or the ID
              is invalid.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isOngoing = incident.endedAt === null;
  const isOutage = incident.severity === "outage";
  const severityMeta = isOutage
    ? {
        color: "text-red-400",
        bg: "bg-red-500/10",
        ring: "border-red-500/30",
        icon: <XCircle className="w-5 h-5" />,
        label: "Outage",
      }
    : {
        color: "text-yellow-400",
        bg: "bg-yellow-500/10",
        ring: "border-yellow-500/30",
        icon: <AlertTriangle className="w-5 h-5" />,
        label: "Degraded",
      };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/status" className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Status
        </Link>
      </Button>

      <div className="border-b border-border pb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={severityMeta.color}>{severityMeta.icon}</span>
          <h1 className="text-2xl font-bold uppercase tracking-tight">
            Incident {incident.id}
          </h1>
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
      </div>

      <Card className={cn("glass-card rounded-xl border", severityMeta.ring)}>
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wide flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
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
            <div>
              <div className="text-[11px] text-muted-foreground uppercase font-bold tracking-wider mb-1">
                Duration
              </div>
              <div className="font-mono text-sm">
                {formatDuration(incident.durationMs)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base uppercase tracking-wide">
            Affected Engines ({incident.affectedEngines.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {incident.affectedEngines.map((eng) => (
            <div
              key={eng.id}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg border",
                severityMeta.ring,
                severityMeta.bg,
              )}
            >
              <span className={severityMeta.color}>{severityMeta.icon}</span>
              <div>
                <div className="font-medium text-sm">{eng.label}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {eng.id}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground/60 leading-relaxed">
        This incident was auto-detected from a gap of more than one hour in
        pipeline telemetry for the affected engine(s). Start and recovery
        times correspond to the last successful trace before and the first
        successful trace after the gap.
      </p>
    </div>
  );
}
