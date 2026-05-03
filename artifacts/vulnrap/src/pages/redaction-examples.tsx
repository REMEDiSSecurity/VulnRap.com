import { ShieldOff, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Example {
  title: string;
  pattern: string;
  description: string;
  matches: string[];
}

const EXAMPLES: Example[] = [
  {
    title: "Internal hostnames (corp domain)",
    pattern: String.raw`[a-z0-9-]+\.corp\.example\.com`,
    description: "Matches subdomains under your private corporate zone.",
    matches: ["jira.corp.example.com", "build-01.corp.example.com"],
  },
  {
    title: "Project codenames",
    pattern: String.raw`\bPROJECT-[A-Z]{4,}\b`,
    description: "Matches uppercase codename tokens like internal program names.",
    matches: ["PROJECT-AURORA", "PROJECT-NEPTUNE"],
  },
  {
    title: "Internal ticket IDs",
    pattern: String.raw`\b(JIRA|TKT)-\d{3,6}\b`,
    description: "Matches Jira/ticket-style identifiers from internal trackers.",
    matches: ["JIRA-1234", "TKT-98765"],
  },
  {
    title: "Employee email handles",
    pattern: String.raw`[a-z]+\.[a-z]+@example\.com`,
    description: "Matches first.last style internal email addresses.",
    matches: ["jane.doe@example.com"],
  },
  {
    title: "Internal IP ranges (RFC1918 /16)",
    pattern: String.raw`\b10\.42\.\d{1,3}\.\d{1,3}\b`,
    description: "Matches a specific internal subnet you want to redact.",
    matches: ["10.42.1.5", "10.42.250.17"],
  },
  {
    title: "S3 buckets with company prefix",
    pattern: String.raw`acme-[a-z0-9-]+`,
    description: "Matches private bucket names that start with your org prefix.",
    matches: ["acme-prod-logs", "acme-staging-uploads"],
  },
  {
    title: "Customer reference codes",
    pattern: String.raw`\bCUST-[A-Z0-9]{6,}\b`,
    description: "Matches opaque customer identifiers used in tickets.",
    matches: ["CUST-AB12CD34"],
  },
];

export default function RedactionExamples() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <Link to="/check" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Check
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <ShieldOff className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Redaction Pattern Examples
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Copy these regex patterns into the Custom redaction panel on the Check page. Patterns use standard JavaScript regex syntax.
          Add one pattern per line. Lines starting with <code className="text-xs px-1 py-0.5 rounded bg-muted/50">#</code> are treated as comments.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
        <strong className="text-yellow-500">Reminder:</strong> Custom patterns run client-side only and are used to highlight matches in your text before submission.
        They do not perform server-side redaction. If you disable built-in PII redaction, you must remove sensitive content yourself before submitting.
      </div>

      <div className="grid grid-cols-1 gap-4">
        {EXAMPLES.map((ex) => (
          <Card key={ex.title} className="glass-card rounded-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{ex.title}</CardTitle>
              <CardDescription className="text-xs">{ex.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <pre className="text-xs font-mono rounded-md bg-muted/30 px-3 py-2 overflow-x-auto">{ex.pattern}</pre>
              <div className="text-[11px] text-muted-foreground">
                Example matches:{" "}
                {ex.matches.map((m, i) => (
                  <span key={m}>
                    <code className="px-1 py-0.5 rounded bg-muted/40 font-mono">{m}</code>
                    {i < ex.matches.length - 1 ? " " : ""}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="text-xs text-muted-foreground">
        <p>
          Tip: test your patterns on a representative sample using the <strong>Test</strong> button in the Custom redaction panel before pasting a real report.
        </p>
      </div>
    </div>
  );
}
