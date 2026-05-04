// Task #707 — Public incident postmortems page.
//
// Lists every operational incident (engine outage, scoring regression,
// calibration mistake) with date, duration, severity, summary, root
// cause, remediation, and an optional link to the related changelog
// anchor. Sourced from `GET /api/incidents`. Empty-state friendly.
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ShieldAlert,
  Loader2,
  AlertCircle,
  Calendar,
  Clock,
  FileText,
  GitBranch,
  Wrench,
  ScrollText,
  CheckCircle2,
  Rss,
  Mail,
  Send,
} from "lucide-react";
import {
  useListIncidents,
  useSubscribeNewsletter,
  getNewsletterChallenge,
  ApiError,
  type IncidentEntry,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
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
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function solveNewsletterChallenge(
  prefix: string,
  nonce: string,
  difficulty: number,
): Promise<string> {
  const required = "0".repeat(difficulty);
  const encoder = new TextEncoder();
  for (let i = 0; i < 5_000_000; i++) {
    const solution = i.toString(16);
    const buf = encoder.encode(prefix + nonce + solution);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const hashArr = new Uint8Array(hashBuf);
    let hex = "";
    for (let j = 0; j < hashArr.length; j++) {
      hex += hashArr[j].toString(16).padStart(2, "0");
    }
    if (hex.startsWith(required)) return solution;
    if ((i & 0x3ff) === 0x3ff) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error("Could not solve challenge in time. Please try again.");
}

function IncidentSubscribe() {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [solving, setSolving] = useState(false);
  const [submitted, setSubmitted] = useState<{
    alreadySubscribed: boolean;
    pendingConfirmation: boolean;
  } | null>(null);
  const subscribe = useSubscribeNewsletter();
  const busy = subscribe.isPending || solving;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      toast({
        title: "Email required",
        description: "Please enter your email address.",
        variant: "destructive",
      });
      return;
    }
    try {
      setSolving(true);
      const challenge = await getNewsletterChallenge();
      const challengeSolution = await solveNewsletterChallenge(
        challenge.prefix,
        challenge.nonce,
        challenge.difficulty,
      );
      setSolving(false);
      const res = await subscribe.mutateAsync({
        data: {
          email: trimmed,
          challengeId: challenge.challengeId,
          challengeSolution,
        },
      });
      setSubmitted({
        alreadySubscribed: res.alreadySubscribed,
        pendingConfirmation: res.pendingConfirmation,
      });
      toast({
        title: res.alreadySubscribed
          ? "Already subscribed"
          : res.pendingConfirmation
            ? "Check your inbox"
            : "Subscribed",
        description: res.message,
      });
      if (!res.alreadySubscribed) setEmail("");
    } catch (err) {
      setSolving(false);
      const message =
        err instanceof ApiError
          ? err.data && typeof err.data === "object" && "error" in err.data
            ? String((err.data as { error: unknown }).error)
            : err.message
          : err instanceof Error
            ? err.message
            : "Subscription failed.";
      toast({
        title: "Subscription failed",
        description: message,
        variant: "destructive",
      });
    }
  }

  return (
    <Card className="glass-card border-primary/30" data-testid="incidents-subscribe">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 text-primary">
          <Mail className="w-5 h-5" />
          Subscribe to incident updates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 text-xs"
          >
            <a
              href="/incidents/feed.xml"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="incidents-rss-link"
            >
              <Rss className="w-3.5 h-3.5 mr-1.5" />
              Atom / RSS feed
            </a>
          </Button>
          <span className="text-xs text-muted-foreground/70 self-center hidden sm:inline">
            or subscribe by email:
          </span>
          <span className="text-xs text-muted-foreground/70 sm:hidden">
            Or subscribe by email:
          </span>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="flex-1 min-w-0 rounded-md bg-background/60 border border-border/70 px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors disabled:opacity-50"
            data-testid="input-incidents-email"
          />
          <Button
            type="submit"
            disabled={busy}
            className="shrink-0"
            data-testid="button-incidents-subscribe"
          >
            {busy ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                {solving ? "Verifying…" : "Subscribing…"}
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5 mr-2" />
                Subscribe
              </>
            )}
          </Button>
        </form>
        {submitted && (
          <div
            className={
              "flex items-start gap-2 rounded-md border px-3 py-2 text-xs " +
              (submitted.alreadySubscribed
                ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
                : "border-emerald-500/30 bg-emerald-500/5 text-emerald-200")
            }
            data-testid="text-incidents-subscribe-result"
          >
            {submitted.alreadySubscribed ? (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span className="leading-relaxed">
              {submitted.alreadySubscribed
                ? "That address is already on the list. Thanks for sticking with us."
                : submitted.pendingConfirmation
                  ? "Almost there — check your inbox for a confirmation link."
                  : "You're on the list. We'll send a quick welcome email with a one-click unsubscribe link shortly."}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
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
          Every operational incident on the public record — engine outages,
          scoring regressions, calibration mistakes — with what happened, root
          cause, and what we changed to prevent it from happening again.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <IncidentSubscribe />

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
              <div className="font-semibold text-destructive mb-1">
                Failed to load incident log
              </div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
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
                This is the page where we'd be honest if there were any. When
                something operational goes wrong — an engine outage, a scoring
                regression, a calibration mistake — it gets a postmortem here
                with root cause and remediation.
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
