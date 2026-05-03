// Task #707 — Public incident postmortems page.
//
// Lists every operational incident (engine outage, scoring regression,
// calibration mistake) with date, duration, severity, summary, root
// cause, remediation, and an optional link to the related changelog
// anchor. Sourced from `GET /api/incidents`. Empty-state friendly.
import { Link } from "react-router-dom";
import {
  ShieldAlert, Loader2, AlertCircle, Calendar, Clock, FileText,
  GitBranch, Wrench, ScrollText, CheckCircle2,
} from "lucide-react";
import {
  useListIncidents,
  type IncidentEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Severity = IncidentEntry["severity"];

interface SeverityMeta {
  label: string;
  tone: string;
}

const SEVERITY_META: Record<Severity, SeverityMeta> = {
  low: {
    label: "Low",
    tone: "border-blue-500/40 text-blue-300/90 bg-blue-500/5",
  },
  medium: {
    label: "Medium",
    tone: "border-yellow-500/40 text-yellow-300/90 bg-yellow-500/5",
  },
  high: {
    label: "High",
    tone: "border-orange-500/40 text-orange-300/90 bg-orange-500/5",
  },
  critical: {
    label: "Critical",
    tone: "border-red-500/40 text-red-300/90 bg-red-500/5",
  },
};

function formatDate(iso: string): string {
  // Be defensive — the value comes from a curated JSON file but we
  // don't want a malformed date to throw on the entire page.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function IncidentCard({ incident }: { incident: IncidentEntry }) {
  const meta = SEVERITY_META[incident.severity];
  return (
    <Card
      className="glass-card rounded-xl"
      data-testid={`incident-card-${incident.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1.5 min-w-0 flex-1">
            <CardTitle className="text-base sm:text-lg leading-tight">
              {incident.summary}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/85 font-mono">
              <span className="inline-flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                {formatDate(incident.date)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {incident.duration}
              </span>
            </div>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] uppercase tracking-wider shrink-0",
              meta.tone,
            )}
          >
            {meta.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80 inline-flex items-center gap-1.5">
            <GitBranch className="w-3 h-3" /> Root cause
          </div>
          <p className="text-xs sm:text-sm text-foreground/85 leading-relaxed">
            {incident.rootCause}
          </p>
        </div>

        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80 inline-flex items-center gap-1.5">
            <Wrench className="w-3 h-3" /> What we changed
          </div>
          <p className="text-xs sm:text-sm text-foreground/85 leading-relaxed">
            {incident.remediation}
          </p>
        </div>

        {incident.changelogAnchor && (
          <div className="pt-1">
            <Button asChild variant="outline" size="sm" className="text-xs">
              <Link
                to={`/changelog#${incident.changelogAnchor}`}
                data-testid={`incident-changelog-${incident.id}`}
              >
                <ScrollText className="w-3.5 h-3.5 mr-1.5" />
                See related changelog
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Incidents() {
  const { data, isLoading, isError, error, refetch } = useListIncidents();

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <ShieldAlert className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Incident History
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Every operational incident on the public record — engine outages, scoring regressions, calibration mistakes — with what happened, root cause, and what we changed to prevent it from happening again.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading incident log…
        </div>
      )}

      {isError && (
        <Card className="glass-card border-destructive/40">
          <CardContent className="py-6 flex flex-col sm:flex-row items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-destructive mb-1">Failed to load incident log</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {data && data.incidents.length === 0 && (
        <Card
          className="glass-card-accent rounded-xl"
          data-testid="incidents-empty-state"
        >
          <CardContent className="py-10 sm:py-14 flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-primary" />
            </div>
            <div className="space-y-2 max-w-md">
              <h2 className="text-lg font-semibold text-foreground">
                No incidents yet
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This is the page where we'd be honest if there were any. When something operational goes wrong — an engine outage, a scoring regression, a calibration mistake — it gets a postmortem here with root cause and remediation.
              </p>
              <div className="pt-2 flex flex-wrap gap-2 justify-center">
                <Button asChild variant="outline" size="sm">
                  <Link to="/changelog">
                    <ScrollText className="w-3.5 h-3.5 mr-1.5" />
                    Read the changelog
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/transparency">
                    <FileText className="w-3.5 h-3.5 mr-1.5" />
                    Transparency report
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {data && data.incidents.length > 0 && (
        <div className="space-y-4 sm:space-y-5" data-testid="incidents-list">
          {data.incidents.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}

      {data && (
        <div className="text-[10px] text-muted-foreground/60 font-mono text-right">
          incidents v{data.version}
        </div>
      )}
    </div>
  );
}
