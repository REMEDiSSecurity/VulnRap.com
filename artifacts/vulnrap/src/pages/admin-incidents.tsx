// Task #1057 — Reviewer-only admin form to publish a new incident postmortem.
//
// Mirrors the auth pattern from `feedback-analytics.tsx`: reads the
// calibration token from the shared `customFetch` client and sends it
// via `X-Calibration-Token` on POST /api/incidents. Linked from the
// reviewer surfaces (audit-log, feedback-analytics).
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ShieldAlert,
  Loader2,
  CheckCircle2,
  ArrowLeft,
  Plus,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type Severity = "low" | "medium" | "high" | "critical";

interface FormState {
  id: string;
  date: string;
  duration: string;
  severity: Severity;
  summary: string;
  rootCause: string;
  remediation: string;
  changelogAnchor: string;
  reviewer: string;
}

const INITIAL: FormState = {
  id: "",
  date: new Date().toISOString().split("T")[0],
  duration: "",
  severity: "medium",
  summary: "",
  rootCause: "",
  remediation: "",
  changelogAnchor: "",
  reviewer: "",
};

const SEVERITIES: { value: Severity; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
      {...rest}
    />
  );
}

function Textarea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
      {...rest}
    />
  );
}

function Select({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export default function AdminIncidents() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const { toast } = useToast();

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const missing = (["id", "date", "duration", "summary", "rootCause", "remediation"] as const)
      .filter((k) => !form[k].trim());
    if (missing.length > 0) {
      toast({
        title: "Missing fields",
        description: `Please fill in: ${missing.join(", ")}`,
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, string> = {
        id: form.id.trim(),
        date: form.date.trim(),
        duration: form.duration.trim(),
        severity: form.severity,
        summary: form.summary.trim(),
        rootCause: form.rootCause.trim(),
        remediation: form.remediation.trim(),
      };
      if (form.changelogAnchor.trim()) {
        body.changelogAnchor = form.changelogAnchor.trim();
      }
      if (form.reviewer.trim()) {
        body.reviewer = form.reviewer.trim();
      }

      const res = await customFetch("/api/incidents", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }) as { ok: boolean; version: string; incident: { id: string } };

      toast({
        title: "Incident published",
        description: `"${body.id}" added (v${res.version}).`,
      });
      setLastCreated(body.id);
      setForm(INITIAL);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      toast({
        title: "Failed to publish incident",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/incidents">
              <ArrowLeft className="w-4 h-4 mr-1" />
              Incidents
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/audit-log">Audit log</Link>
          </Button>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <ShieldAlert className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Publish Incident
        </h1>
        <p className="text-sm text-muted-foreground max-w-xl leading-relaxed">
          Reviewer-only form to publish a new incident postmortem. Requires
          a valid calibration token. The entry will be appended to the
          incident log and an audit-log record will be created.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      {lastCreated && (
        <Card className="glass-card border-green-500/30">
          <CardContent className="py-4 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
            <div className="flex-1 text-sm">
              Incident <strong>{lastCreated}</strong> published successfully.{" "}
              <Link
                to="/incidents"
                className="text-primary underline underline-offset-2"
              >
                View incidents page
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Incident Postmortem
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="incident-id">ID (slug)</Label>
                <Input
                  id="incident-id"
                  placeholder="e.g. 2026-05-avri-regression"
                  value={form.id}
                  onChange={(e) => update("id", e.target.value)}
                  disabled={submitting}
                  data-testid="incident-id-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="incident-date">Date (YYYY-MM-DD)</Label>
                <Input
                  id="incident-date"
                  type="date"
                  value={form.date}
                  onChange={(e) => update("date", e.target.value)}
                  disabled={submitting}
                  data-testid="incident-date-input"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="incident-duration">Duration</Label>
                <Input
                  id="incident-duration"
                  placeholder='e.g. "42 minutes"'
                  value={form.duration}
                  onChange={(e) => update("duration", e.target.value)}
                  disabled={submitting}
                  data-testid="incident-duration-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="incident-severity">Severity</Label>
                <Select
                  id="incident-severity"
                  value={form.severity}
                  onChange={(e) => update("severity", e.target.value as Severity)}
                  disabled={submitting}
                  data-testid="incident-severity-select"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="incident-summary">Summary</Label>
              <Input
                id="incident-summary"
                placeholder="One-sentence description of what happened"
                value={form.summary}
                onChange={(e) => update("summary", e.target.value)}
                disabled={submitting}
                data-testid="incident-summary-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="incident-rootcause">Root Cause</Label>
              <Textarea
                id="incident-rootcause"
                placeholder="Plain-language root cause analysis"
                value={form.rootCause}
                onChange={(e) => update("rootCause", e.target.value)}
                disabled={submitting}
                data-testid="incident-rootcause-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="incident-remediation">Remediation</Label>
              <Textarea
                id="incident-remediation"
                placeholder="What we changed to prevent recurrence"
                value={form.remediation}
                onChange={(e) => update("remediation", e.target.value)}
                disabled={submitting}
                data-testid="incident-remediation-input"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="incident-changelog">
                  Changelog Anchor{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="incident-changelog"
                  placeholder="e.g. v4-2-1"
                  value={form.changelogAnchor}
                  onChange={(e) => update("changelogAnchor", e.target.value)}
                  disabled={submitting}
                  data-testid="incident-changelog-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="incident-reviewer">
                  Reviewer{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="incident-reviewer"
                  placeholder="Your name for audit log"
                  value={form.reviewer}
                  onChange={(e) => update("reviewer", e.target.value)}
                  disabled={submitting}
                  data-testid="incident-reviewer-input"
                />
              </div>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                disabled={submitting}
                className="w-full sm:w-auto"
                data-testid="incident-submit-btn"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Publishing…
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Publish Incident
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
