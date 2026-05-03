// Task #654 — /quickstart: a hand-holding "do this in 5 minutes" walkthrough
// from zero to first scored report. Each step ships with a copy-paste curl
// command and a "Try it" widget that runs the call against the live API and
// pretty-prints the response.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Rocket,
  Terminal,
  Copy,
  Check,
  Play,
  Loader2,
  ArrowLeft,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const SAMPLE_REPORT = `Title: Stored XSS in /admin/notes via "title" field

Affected: AcmeCMS 4.2.0 (latest, commit 9f1c2ab)
CWE: CWE-79

Steps to reproduce:
1. Log in as any user with the "editor" role.
2. POST to /admin/notes with title=<svg/onload=alert(1)>.
3. Visit /admin/notes/list — the payload fires for every viewer.

Request:
\`\`\`
POST /admin/notes HTTP/1.1
Host: demo.acme.test
Cookie: session=...
Content-Type: application/x-www-form-urlencoded

title=%3Csvg%2Fonload%3Dalert%281%29%3E&body=hi
\`\`\`

Impact: Any admin loading the notes index executes attacker JS in the
admin origin, allowing session theft and privileged action forgery.

References:
- https://cwe.mitre.org/data/definitions/79.html
- https://owasp.org/www-community/attacks/xss/
`;

type StepKind = "stats" | "check" | "submit" | "get" | "delete";

interface Step {
  n: number;
  kind: StepKind;
  title: string;
  blurb: string;
  curl: (ctx: Ctx) => string;
  request: (ctx: Ctx) => Promise<TryResult>;
  expected: string;
}

interface Ctx {
  reportId: number | null;
  deleteToken: string | null;
}

interface TryResult {
  status: number;
  ok: boolean;
  body: unknown;
}

function curlSubmit() {
  return `curl -X POST https://vulnrap.com/api/reports/check \\
  -F 'rawText=Title: Stored XSS in /admin/notes via "title" field

Affected: AcmeCMS 4.2.0 (latest, commit 9f1c2ab)
CWE: CWE-79

Steps to reproduce:
1. Log in as any user with the "editor" role.
2. POST to /admin/notes with title=<svg/onload=alert(1)>.
3. Visit /admin/notes/list — the payload fires for every viewer.

Impact: Any admin loading the notes index executes attacker JS in the
admin origin, allowing session theft and privileged action forgery.

References:
- https://cwe.mitre.org/data/definitions/79.html'`;
}

const STEPS: Step[] = [
  {
    n: 1,
    kind: "stats",
    title: "Verify the API is up",
    blurb:
      "A read-only sanity check. /api/stats requires no auth and returns aggregate platform numbers — a great smoke test before you wire anything else up.",
    curl: () => `curl https://vulnrap.com/api/stats`,
    request: async () => {
      const res = await fetch("/api/stats");
      const body = await safeJson(res);
      return { status: res.status, ok: res.ok, body };
    },
    expected: `{
  "totalReports": 1234,
  "duplicatesDetected": 87,
  "avgSlopScore": 31.4,
  "reportsByMode": { "full": 900, "preview": 334 }
}`,
  },
  {
    n: 2,
    kind: "check",
    title: "Score a report without saving it",
    blurb:
      "POST /api/reports/check runs the full pipeline (multi-engine consensus, similarity, redaction) and returns the verdict — but does NOT persist anything. Ideal for evaluating an incoming report before triage.",
    curl: curlSubmit,
    request: async () => {
      const fd = new FormData();
      fd.append("rawText", SAMPLE_REPORT);
      const res = await fetch("/api/reports/check", {
        method: "POST",
        body: fd,
      });
      const body = await safeJson(res);
      return { status: res.status, ok: res.ok, body };
    },
    expected: `{
  "vulnrap": {
    "score": 72,
    "label": "likely-valid",
    "engines": [
      { "name": "ai-authorship",     "score": 18, "verdict": "human" },
      { "name": "technical-substance", "score": 78, "verdict": "substantive" },
      { "name": "cwe-coherence",     "score": 81, "verdict": "coherent" }
    ]
  },
  "slopScore": 28,
  "matches": [],
  "llmFeedback": "Concrete repro, fenced request, two references..."
}`,
  },
  {
    n: 3,
    kind: "submit",
    title: "Submit a report (persisted)",
    blurb:
      "Same pipeline as /check, but the report is stored and assigned an id. The response includes a deleteToken — keep it if you might want to remove the record later.",
    curl: () => `curl -X POST https://vulnrap.com/api/reports \\
  -F "file=@my-report.txt" \\
  -F "contentMode=full"`,
    request: async (_ctx) => {
      const fd = new FormData();
      fd.append("rawText", SAMPLE_REPORT);
      fd.append("contentMode", "full");
      const res = await fetch("/api/reports", { method: "POST", body: fd });
      const body = await safeJson(res);
      return { status: res.status, ok: res.ok, body };
    },
    expected: `{
  "id": 4242,
  "deleteToken": "dt_9f1c…",
  "vulnrap": { "score": 72, "label": "likely-valid", "engines": [ … ] },
  "slopScore": 28,
  "correlationId": "cor_…"
}`,
  },
  {
    n: 4,
    kind: "get",
    title: "Fetch the stored result",
    blurb:
      "Once a report is submitted you can re-read its full analysis any time using its id. This is the same payload the web UI renders on /results/:id.",
    curl: (ctx) =>
      `curl https://vulnrap.com/api/reports/${ctx.reportId ?? "<id>"}`,
    request: async (ctx) => {
      if (ctx.reportId == null) {
        throw new Error("Run step 3 first to get a report id.");
      }
      const res = await fetch(`/api/reports/${ctx.reportId}`);
      const body = await safeJson(res);
      return { status: res.status, ok: res.ok, body };
    },
    expected: `{
  "id": 4242,
  "createdAt": "2026-05-03T12:00:00.000Z",
  "vulnrap": { … },
  "slopScore": 28,
  "redactedText": "…",
  "matches": [],
  "sections": [ … ]
}`,
  },
  {
    n: 5,
    kind: "delete",
    title: "Clean up: delete your report",
    blurb:
      "Permanently remove the record using the deleteToken from step 3. This is irreversible — there is no recovery once deleted.",
    curl: (ctx) =>
      `curl -X DELETE https://vulnrap.com/api/reports/${ctx.reportId ?? "<id>"} \\
  -H "Content-Type: application/json" \\
  -d '{"deleteToken": "${ctx.deleteToken ?? "<token>"}"}'`,
    request: async (ctx) => {
      if (ctx.reportId == null || !ctx.deleteToken) {
        throw new Error("Run step 3 first to obtain an id and deleteToken.");
      }
      const res = await fetch(`/api/reports/${ctx.reportId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteToken: ctx.deleteToken }),
      });
      const body = await safeJson(res);
      return { status: res.status, ok: res.ok, body };
    },
    expected: `{
  "ok": true,
  "message": "Report 4242 permanently deleted."
}`,
  },
];

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-primary transition-all sm:opacity-0 sm:group-hover:opacity-100"
      aria-label="Copy to clipboard"
      data-testid="quickstart-copy"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative group">
      <pre className="glass-card rounded-xl p-4 text-xs sm:text-sm font-mono whitespace-pre overflow-x-auto leading-relaxed text-muted-foreground">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} />
    </div>
  );
}

interface TryItProps {
  step: Step;
  ctx: Ctx;
  onResult: (kind: StepKind, result: TryResult) => void;
}

function TryIt({ step, ctx, onResult }: TryItProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const r = await step.request(ctx);
      setResult(r);
      onResult(step.kind, r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const pretty = useMemo(() => {
    if (!result) return "";
    if (typeof result.body === "string") return result.body;
    try {
      return JSON.stringify(result.body, null, 2);
    } catch {
      return String(result.body);
    }
  }, [result]);

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-primary">
          <Play className="w-3.5 h-3.5" /> Try it live
        </div>
        <Button
          type="button"
          size="sm"
          onClick={run}
          disabled={loading}
          data-testid={`quickstart-run-${step.kind}`}
          className="h-8"
        >
          {loading ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 mr-1.5" /> Run step {step.n}
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 p-3">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
            <span
              className={
                result.ok
                  ? "px-2 py-0.5 rounded border border-green-500/40 text-green-400"
                  : "px-2 py-0.5 rounded border border-red-500/40 text-red-400"
              }
            >
              HTTP {result.status}
            </span>
            <span>{result.ok ? "success" : "error response"}</span>
          </div>
          <div className="relative group">
            <pre
              className="rounded-lg bg-black/40 border border-primary/15 p-3 text-[11px] sm:text-xs font-mono whitespace-pre overflow-x-auto max-h-80 text-foreground/90"
              data-testid={`quickstart-response-${step.kind}`}
            >
              <code>{pretty}</code>
            </pre>
            {pretty && <CopyButton value={pretty} />}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Quickstart() {
  const [ctx, setCtx] = useState<Ctx>({ reportId: null, deleteToken: null });
  const stepRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Re-clear ctx if a delete succeeds so the user can run the flow again.
  function handleResult(kind: StepKind, result: TryResult) {
    if (
      kind === "submit" &&
      result.ok &&
      result.body &&
      typeof result.body === "object"
    ) {
      const body = result.body as Record<string, unknown>;
      const id =
        typeof body.id === "number"
          ? body.id
          : typeof body.id === "string"
            ? Number(body.id)
            : null;
      const token =
        typeof body.deleteToken === "string" ? body.deleteToken : null;
      setCtx({
        reportId: Number.isFinite(id as number) ? (id as number) : null,
        deleteToken: token,
      });
    }
    if (kind === "delete" && result.ok) {
      setCtx({ reportId: null, deleteToken: null });
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace("#", "");
    const m = hash.match(/^step-(\d+)$/);
    if (!m) return;
    const n = Number(m[1]);
    const el = stepRefs.current[n];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <Link
          to="/developers"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3 h-3" /> Back to API reference
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Rocket className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Quickstart
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Five steps, about five minutes. By the end you'll have scored a
          report, fetched its results, and cleaned up — all against the live
          public API. No auth required.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge variant="outline" className="border-primary/40 text-primary">
            Public API
          </Badge>
          <Badge
            variant="outline"
            className="border-muted text-muted-foreground"
          >
            No key required
          </Badge>
          <Badge
            variant="outline"
            className="border-muted text-muted-foreground"
          >
            ~5 min
          </Badge>
        </div>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      {(ctx.reportId != null || ctx.deleteToken) && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs font-mono text-muted-foreground flex flex-wrap gap-x-6 gap-y-1">
          <span>
            <span className="text-primary">reportId</span> ={" "}
            <span className="text-foreground/90">{ctx.reportId ?? "—"}</span>
          </span>
          <span>
            <span className="text-primary">deleteToken</span> ={" "}
            <span className="text-foreground/90">
              {ctx.deleteToken ? `${ctx.deleteToken.slice(0, 10)}…` : "—"}
            </span>
          </span>
          <span className="text-muted-foreground/70">
            (carried automatically into steps 4 &amp; 5)
          </span>
        </div>
      )}

      {STEPS.map((step) => (
        <Card
          key={step.n}
          ref={(el) => {
            stepRefs.current[step.n] = el;
          }}
          id={`step-${step.n}`}
          className="glass-card rounded-xl scroll-mt-20"
        >
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full border border-primary/40 bg-primary/10 text-primary font-mono text-sm flex items-center justify-center shrink-0">
                {step.n}
              </span>
              <CardTitle className="text-base sm:text-lg flex items-center gap-2">
                <Terminal className="w-4 h-4 text-primary/80" />
                {step.title}
              </CardTitle>
            </div>
            <CardDescription className="pt-1 leading-relaxed">
              {step.blurb}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
                Copy-paste curl
              </div>
              <CodeBlock code={step.curl(ctx)} />
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
                Expected response (shape)
              </div>
              <CodeBlock code={step.expected} />
            </div>
            <TryIt step={step} ctx={ctx} onResult={handleResult} />
          </CardContent>
        </Card>
      ))}

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Where to next</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2 leading-relaxed">
          <p>
            Full endpoint reference, schemas, and rate limits live on the{" "}
            <Link to="/developers" className="text-primary hover:underline">
              API page
            </Link>
            . The{" "}
            <Link to="/architecture" className="text-primary hover:underline">
              architecture diagram
            </Link>{" "}
            shows how a request flows through the scoring pipeline, and the{" "}
            <Link
              to="/docs/good-report"
              className="text-primary hover:underline"
            >
              "what makes a good report" guide
            </Link>{" "}
            explains what the scorers are looking for.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
