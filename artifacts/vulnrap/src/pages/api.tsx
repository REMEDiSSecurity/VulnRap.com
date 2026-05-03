import { Code, ExternalLink, FileText, Search, Shield, Activity, MessageSquare, Heart, Terminal, Copy, Check, ChevronDown, ChevronUp, Plug, Bot, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState } from "react";

function CopyBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <pre className="glass-card rounded-xl p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed text-muted-foreground">
        <code>{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-3 right-3 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-primary transition-all sm:opacity-0 sm:group-hover:opacity-100"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

const endpoints = [
  {
    method: "POST",
    path: "/api/reports",
    title: "Submit a Report",
    description: "Upload a vulnerability report for full analysis — multi-engine consensus scoring, similarity matching, auto-redaction, and section-level hashing.",
    badge: "Write",
    badgeColor: "border-green-500 text-green-500",
    example: `# Upload a file
curl -X POST https://vulnrap.com/api/reports \\
  -F "file=@my-report.txt" \\
  -F "contentMode=full"

# Or submit via URL (GitHub, Gist, GitLab, Pastebin, etc.)
curl -X POST https://vulnrap.com/api/reports \\
  -F "reportUrl=https://github.com/user/repo/blob/main/report.md" \\
  -F "contentMode=full"`,
    responseHint: "Returns report ID, delete token, vulnrap composite (score + label + per-engine breakdown for AI Authorship / Technical Substance / CWE Coherence), legacy slopScore (mapped from composite), llmFeedback, heuristic feedback, similarity matches, redaction summary, and a correlation id for diagnostics lookup",
  },
  {
    method: "DELETE",
    path: "/api/reports/:id",
    title: "Delete a Report",
    description: "Permanently delete a report and all associated data (hashes, similarity records, redacted text). Requires the delete token returned at submission time.",
    badge: "Write",
    badgeColor: "border-red-500 text-red-500",
    example: `curl -X DELETE https://vulnrap.com/api/reports/42 \\
  -H "Content-Type: application/json" \\
  -d '{"deleteToken": "your-token-here"}'`,
    responseHint: "Returns confirmation message. Deletion is permanent and irreversible.",
  },
  {
    method: "POST",
    path: "/api/reports/check",
    title: "Check a Report (Read-Only)",
    description: "Run the full analysis pipeline without storing anything. Ideal for PSIRT teams validating incoming reports.",
    badge: "Read-Only",
    badgeColor: "border-cyan-500 text-cyan-500",
    example: `# Paste text directly
curl -X POST https://vulnrap.com/api/reports/check \\
  -F "rawText=Your report text here..."

# Or check via URL
curl -X POST https://vulnrap.com/api/reports/check \\
  -F "reportUrl=https://gist.github.com/user/abc123"`,
    responseHint: "Returns vulnrap composite (score + label + per-engine breakdown), legacy slopScore (mapped from composite), llmFeedback, similarity matches, section hashes — nothing saved",
  },
  {
    method: "GET",
    path: "/api/reports/:id",
    title: "Get Report Results",
    description: "Retrieve the full analysis results for a previously submitted report.",
    badge: "Read",
    badgeColor: "border-blue-500 text-blue-500",
    example: `curl https://vulnrap.com/api/reports/42`,
    responseHint: "Returns full analysis: redacted text, slop score, matches, sections",
  },
  {
    method: "GET",
    path: "/api/reports/:id/diagnostics",
    title: "Pipeline Diagnostics",
    description: "Returns the full pipeline trace for a report — composite breakdown, per-engine scores and verdicts, applied overrides, perplexity signals, input signals summary, per-stage timings (correlation id), and the legacy slop-score mapping. Powers the \"Why this score?\" panel on the report detail page.",
    badge: "Read",
    badgeColor: "border-blue-500 text-blue-500",
    example: `curl https://vulnrap.com/api/reports/42/diagnostics`,
    responseHint: "Returns composite, engines[], perplexity, overridesApplied, warnings, trace { correlationId, stages[], signalsSummary }, legacyMapping { slopScore, displayMode, note }, featureFlags",
  },
  {
    method: "GET",
    path: "/api/reports/:id/verify",
    title: "Verify a Report",
    description: "Lightweight verification endpoint — returns just the badge data (slop score, match counts, content hash) for embedding or sharing.",
    badge: "Read",
    badgeColor: "border-blue-500 text-blue-500",
    example: `curl https://vulnrap.com/api/reports/42/verify`,
    responseHint: "Returns slop score, match counts, content hash, verify URL",
  },
  {
    method: "GET",
    path: "/api/reports/lookup/:hash",
    title: "Lookup by Hash",
    description: "Find a report by its SHA-256 content hash. Useful for deduplication workflows.",
    badge: "Read",
    badgeColor: "border-blue-500 text-blue-500",
    example: `curl https://vulnrap.com/api/reports/lookup/abc123...`,
    responseHint: "Returns the report if found, 404 otherwise",
  },
  {
    method: "GET",
    path: "/api/stats",
    title: "Platform Statistics",
    description: "Aggregate stats: total reports, duplicate count, average slop score, today's submissions.",
    badge: "Read",
    badgeColor: "border-blue-500 text-blue-500",
    example: `curl https://vulnrap.com/api/stats`,
    responseHint: "Returns totalReports, duplicatesDetected, avgSlopScore, reportsByMode",
  },
  {
    method: "POST",
    path: "/api/feedback",
    title: "Submit Feedback",
    description: "Submit user feedback about the platform — rating, helpfulness, and optional comments.",
    badge: "Write",
    badgeColor: "border-green-500 text-green-500",
    example: `curl -X POST https://vulnrap.com/api/feedback \\
  -H "Content-Type: application/json" \\
  -d '{"rating": 5, "helpful": true, "comment": "Great tool!"}'`,
    responseHint: "Returns confirmation of feedback submission",
  },
];

export default function ApiDocs() {
  const apiDocsUrl = "/api/docs/";
  const [swaggerOpen, setSwaggerOpen] = useState(false);

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Code className="w-8 h-8 text-primary" />
          API Documentation
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Integrate VulnRap directly into your workflow. All endpoints are free, anonymous, and require no authentication. Use them with your own tools, CI/CD pipelines, or triage systems.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="glass-card-accent rounded-xl">
          <CardContent className="p-6 flex flex-col items-center text-center gap-4">
            <div className="p-3 rounded-lg icon-glow-cyan">
              <Terminal className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm mb-1">Interactive API Explorer</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Full Swagger UI with try-it-out functionality. Test every endpoint directly in your browser.
              </p>
            </div>
            <Button className="glow-button gap-2" onClick={() => setSwaggerOpen((v) => !v)}>
              {swaggerOpen ? "Hide" : "Open"} Swagger UI {swaggerOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardContent className="p-6 flex flex-col items-center text-center gap-4">
            <div className="p-3 rounded-lg icon-glow-green">
              <Shield className="w-6 h-6 text-green-400" />
            </div>
            <div>
              <h3 className="font-bold text-sm mb-1">No Auth Required</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                All endpoints are open and anonymous. No API keys, no accounts, no rate limits beyond basic abuse protection (100 req / 15 min).
              </p>
            </div>
            <Badge variant="outline" className="border-green-500/30 text-green-400">
              Free & Open
            </Badge>
          </CardContent>
        </Card>
      </div>

      {swaggerOpen && (
        <Card className="glass-card rounded-xl overflow-hidden">
          <CardContent className="p-0">
            <iframe
              src={apiDocsUrl}
              title="Swagger UI"
              className="w-full border-0 rounded-xl bg-white"
              style={{ height: "80vh", minHeight: "500px" }}
            />
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          Quick Start
        </h2>
        <p className="text-sm text-muted-foreground">
          Submit a report and get results in two requests:
        </p>
        <CopyBlock
          language="bash"
          code={`# 1. Submit a report for analysis
curl -X POST https://vulnrap.com/api/reports \\
  -F "file=@vulnerability-report.txt" \\
  -F "contentMode=full"

# Response: { "id": 42, "slopScore": 12, ... }

# 2. Retrieve the full results
curl https://vulnrap.com/api/reports/42

# Or check a report without storing it (read-only)
curl -X POST https://vulnrap.com/api/reports/check \\
  -F "rawText=Your report content here..."`}
        />
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Search className="w-5 h-5 text-primary" />
          Endpoints
        </h2>

        <div className="space-y-3">
          {endpoints.map((ep, i) => (
            <Card key={i} className="glass-card rounded-xl">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Badge variant="outline" className={ep.badgeColor + " text-[10px] font-mono uppercase"}>
                      {ep.method}
                    </Badge>
                    <code className="text-primary font-mono text-xs">{ep.path}</code>
                  </CardTitle>
                  <Badge variant="secondary" className="text-[10px]">{ep.badge}</Badge>
                </div>
                <CardDescription className="mt-1">{ep.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CopyBlock language="bash" code={ep.example} />
                <p className="text-[11px] text-muted-foreground/60 italic">{ep.responseHint}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Code className="w-5 h-5 text-primary" />
          Official SDKs
        </h2>
        <p className="text-sm text-muted-foreground">
          Hand-written, idiomatic clients that wrap the four most common endpoints. No code generation, no extra dependencies.
        </p>

        <Card className="glass-card rounded-xl" data-testid="card-sdk-python">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-yellow-500 text-yellow-500 text-[10px] font-mono uppercase">Python</Badge>
              <code className="text-primary font-mono text-xs">pip install vulnrap</code>
            </CardTitle>
            <CardDescription className="mt-1">
              Idiomatic Python client for security teams scripting PSIRT workflows, CI gates, and triage bots.
              Methods: <code className="font-mono text-xs text-foreground">score_report</code>,{" "}
              <code className="font-mono text-xs text-foreground">lookup_report</code>,{" "}
              <code className="font-mono text-xs text-foreground">query_stats</code>,{" "}
              <code className="font-mono text-xs text-foreground">test_yourself</code>.
              Fully type-hinted (<code className="font-mono text-xs text-foreground">py.typed</code>),
              one runtime dep (<code className="font-mono text-xs text-foreground">httpx</code>),
              typed errors via <code className="font-mono text-xs text-foreground">vulnrap.APIError</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CopyBlock language="python" code={`pip install vulnrap

from vulnrap import Client

with Client() as c:
    res = c.test_yourself(raw_text="Found a path traversal in /api/files...")
    print(f"slop={res.slop_score}/{res.slop_tier} confidence={res.confidence:.2f}")`} />
            <a
              href="https://github.com/vulnrap/vulnrap/blob/main/sdks/python/vulnrap/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              data-testid="link-python-sdk-readme"
            >
              <FileText className="w-3.5 h-3.5" />
              Read the Python SDK docs
              <ExternalLink className="w-3 h-3" />
            </a>
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl" data-testid="card-sdk-go">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-cyan-500 text-cyan-500 text-[10px] font-mono uppercase">Go</Badge>
              <code className="text-primary font-mono text-xs">github.com/vulnrap/vulnrap/sdks/go/vulnrap</code>
            </CardTitle>
            <CardDescription className="mt-1">
              Pure standard-library Go client for cloud-native security tooling and CI gates.
              Methods: <code className="font-mono text-xs text-foreground">ScoreReport</code>,{" "}
              <code className="font-mono text-xs text-foreground">LookupReport</code>,{" "}
              <code className="font-mono text-xs text-foreground">QueryStats</code>,{" "}
              <code className="font-mono text-xs text-foreground">TestYourself</code>.
              Idiomatic <code className="font-mono text-xs text-foreground">context.Context</code>-first API,
              typed errors via <code className="font-mono text-xs text-foreground">*vulnrap.APIError</code>, no panics.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CopyBlock language="go" code={`go get github.com/vulnrap/vulnrap/sdks/go/vulnrap

import (
    "context"
    "log"

    "github.com/vulnrap/vulnrap/sdks/go/vulnrap"
)

func main() {
    c := vulnrap.NewClient()
    res, err := c.TestYourself(context.Background(), &vulnrap.TestYourselfInput{
        RawText: "Found a path traversal in /api/files...",
    })
    if err != nil { log.Fatal(err) }
    log.Printf("slop=%d/%s confidence=%.2f", res.SlopScore, res.SlopTier, res.Confidence)
}`} />
            <a
              href="https://github.com/vulnrap/vulnrap/blob/main/sdks/go/vulnrap/README.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              data-testid="link-go-sdk-readme"
            >
              <FileText className="w-3.5 h-3.5" />
              Read the Go SDK docs
              <ExternalLink className="w-3 h-3" />
            </a>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Download className="w-5 h-5 text-primary" />
          Postman Collection
        </h2>
        <p className="text-sm text-muted-foreground">
          Prefer clicking through endpoints to writing curl? Import the auto-generated Postman v2.1 collection. Insomnia, Bruno, and Hoppscotch accept the same file.
        </p>

        <Card className="glass-card rounded-xl" data-testid="card-postman">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-orange-500 text-orange-500 text-[10px] font-mono uppercase">Postman</Badge>
              <code className="text-primary font-mono text-xs">vulnrap.postman_collection.json</code>
            </CardTitle>
            <CardDescription className="mt-1">
              Every public endpoint, folded into folders by tag, with a single{" "}
              <code className="font-mono text-xs text-foreground">{"{{baseUrl}}"}</code> variable
              defaulting to <code className="font-mono text-xs text-foreground">https://vulnrap.com/api</code>.
              Regenerated from the OpenAPI spec — never hand-edited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button asChild className="glow-button gap-2" data-testid="button-download-postman">
                <a href="/vulnrap.postman_collection.json" download="vulnrap.postman_collection.json">
                  <Download className="w-3.5 h-3.5" />
                  Download Postman collection
                </a>
              </Button>
              <Button asChild variant="outline" className="gap-2" data-testid="link-postman-readme">
                <a
                  href="https://github.com/vulnrap/vulnrap/blob/main/sdks/postman/README.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Import instructions
                  <ExternalLink className="w-3 h-3" />
                </a>
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/60 italic">
              Repo path: <code className="font-mono">sdks/postman/vulnrap.postman_collection.json</code> — regenerate with <code className="font-mono">pnpm --filter @workspace/scripts run generate:postman</code>.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Plug className="w-5 h-5 text-primary" />
          Integration Recipes
        </h2>
        <p className="text-sm text-muted-foreground">
          End-to-end walkthroughs for wiring VulnRap into specific triage platforms. Pure docs — copy the scripts, adapt to your environment.
        </p>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-primary/40 text-primary text-[10px] font-mono uppercase">HackerOne</Badge>
              Score every report, comment back, optionally auto-close
            </CardTitle>
            <CardDescription className="mt-1">
              Wire H1's <code className="font-mono text-xs text-foreground">report-created</code> webhook into{" "}
              <code className="font-mono text-xs text-foreground">/api/reports/check</code>, post the composite score as an internal comment,
              and (opt-in) close the AUTO_CLOSE tier with a templated reply. Reference shell + Python scripts inline.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href="https://github.com/vulnrap/vulnrap/blob/main/artifacts/api-server/docs/integrations/hackerone.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              data-testid="link-hackerone-recipe"
            >
              <FileText className="w-3.5 h-3.5" />
              Read the HackerOne recipe
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="text-[11px] text-muted-foreground/60 italic mt-2">
              Repo path: <code className="font-mono">artifacts/api-server/docs/integrations/hackerone.md</code>
            </p>
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-primary/40 text-primary text-[10px] font-mono uppercase">Bugcrowd</Badge>
              Score every submission, note back, optionally auto-close
            </CardTitle>
            <CardDescription className="mt-1">
              Wire Bugcrowd's <code className="font-mono text-xs text-foreground">submission.created</code> outbound webhook into{" "}
              <code className="font-mono text-xs text-foreground">/api/reports/check</code>, post the composite score as a team-only note,
              and (opt-in) transition the AUTO_CLOSE tier to <code className="font-mono text-xs text-foreground">not_applicable</code> with a templated reply. Reference shell + Python scripts inline.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href="https://github.com/vulnrap/vulnrap/blob/main/artifacts/api-server/docs/integrations/bugcrowd.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              data-testid="link-bugcrowd-recipe"
            >
              <FileText className="w-3.5 h-3.5" />
              Read the Bugcrowd recipe
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="text-[11px] text-muted-foreground/60 italic mt-2">
              Repo path: <code className="font-mono">artifacts/api-server/docs/integrations/bugcrowd.md</code>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-6 space-y-4">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Integration Ideas
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div className="flex items-start gap-2">
              <span className="text-primary mt-0.5">--</span>
              <span><strong className="text-foreground">CI/CD Gate:</strong> POST reports/check in your pipeline to flag AI-generated or duplicate submissions before they reach triage.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary mt-0.5">--</span>
              <span><strong className="text-foreground">Triage Dashboard:</strong> Use the verify endpoint to embed validation badges in your internal tools.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary mt-0.5">--</span>
              <span><strong className="text-foreground">Slack/Discord Bot:</strong> POST incoming reports and surface slop scores and duplicate warnings in your channels.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-primary mt-0.5">--</span>
              <span><strong className="text-foreground">Vulnerability Platform:</strong> Integrate the check endpoint to pre-screen submissions before they enter your queue.</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          Example Scripts
        </h2>
        <p className="text-sm text-muted-foreground">
          Copy-paste scripts you can drop into your workflow:
        </p>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-yellow-500 text-yellow-500 text-[10px] font-mono uppercase">Python</Badge>
              Batch-check a folder of reports
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CopyBlock language="python" code={`import requests, pathlib, json

reports_dir = pathlib.Path("./reports")
for f in reports_dir.glob("*.txt"):
    r = requests.post("https://vulnrap.com/api/reports/check",
                       files={"file": open(f, "rb")})
    data = r.json()
    score = data.get("slopScore", "?")
    dupes = len(data.get("similarityMatches", []))
    print(f"{f.name}: slop={score}, duplicates={dupes}")`} />
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-green-500 text-green-500 text-[10px] font-mono uppercase">Bash</Badge>
              CI/CD gate — fail pipeline if slop score is too high
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CopyBlock language="bash" code={`#!/bin/bash
# Add to your CI pipeline to reject AI-generated reports
REPORT_FILE="$1"
THRESHOLD=50

RESULT=$(curl -s -X POST https://vulnrap.com/api/reports/check \\
  -F "file=@$REPORT_FILE")

SCORE=$(echo "$RESULT" | jq '.slopScore')
echo "Slop score: $SCORE / 100"

if [ "$SCORE" -gt "$THRESHOLD" ]; then
  echo "FAILED: Report exceeds slop threshold ($THRESHOLD)"
  exit 1
fi
echo "PASSED: Report looks human-written"`} />
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="border-blue-500 text-blue-500 text-[10px] font-mono uppercase">Node.js</Badge>
              Slack bot — post analysis results to a channel
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CopyBlock language="javascript" code={`const FormData = require("form-data");
const axios = require("axios");
const fs = require("fs");

async function analyzeAndPost(filePath, slackWebhook) {
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const { data } = await axios.post(
    "https://vulnrap.com/api/reports/check",
    form, { headers: form.getHeaders() }
  );

  const emoji = data.slopScore < 30 ? ":white_check_mark:"
    : data.slopScore < 70 ? ":warning:" : ":x:";
  const dupes = data.similarityMatches?.length || 0;

  await axios.post(slackWebhook, {
    text: \`\${emoji} *VulnRap Analysis*\\n\`
      + \`Slop Score: \${data.slopScore}/100 (\${data.slopTier})\\n\`
      + \`Similar Reports: \${dupes}\\n\`
      + \`Redacted Items: \${data.redactionSummary?.total || 0}\`
  });
}`} />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" />
          MCP Server (for Claude Desktop, Cursor, &amp; agents)
        </h2>
        <p className="text-sm text-muted-foreground">
          A standalone <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Model Context Protocol</a> server
          exposes the public VulnRap API as MCP tools so any LLM-tool ecosystem can call VulnRap from inside an agent
          chat. The server lives in <code className="font-mono text-xs text-foreground">lib/mcp-server</code> and ships
          nine tools that map 1:1 to the public REST endpoints — reviewer-only endpoints are intentionally not exposed.
        </p>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tools exposed</CardTitle>
            <CardDescription className="mt-1">
              Each tool wraps a single public endpoint with input validation via{" "}
              <code className="font-mono text-xs text-foreground">@workspace/api-zod</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <div><code className="font-mono text-foreground">score_report</code> → <code className="font-mono">POST /api/reports/check</code></div>
              <div><code className="font-mono text-foreground">lookup_report</code> → <code className="font-mono">GET /api/reports/&#123;id&#125;</code></div>
              <div><code className="font-mono text-foreground">query_stats</code> → <code className="font-mono">GET /api/stats</code></div>
              <div><code className="font-mono text-foreground">query_transparency</code> → <code className="font-mono">GET /api/public/corpus-stats</code></div>
              <div><code className="font-mono text-foreground">query_gallery</code> → <code className="font-mono">GET /api/reports/feed</code></div>
              <div><code className="font-mono text-foreground">get_drift_summary</code> → <code className="font-mono">GET /api/public/drift-summary</code></div>
              <div><code className="font-mono text-foreground">query_signal_metrics</code> → <code className="font-mono">GET /api/feedback/holdout-eval</code></div>
              <div><code className="font-mono text-foreground">get_cohort_baseline</code> → <code className="font-mono">GET /api/cohort/baseline</code></div>
              <div><code className="font-mono text-foreground">test_yourself</code> → <code className="font-mono">GET /api/test/run</code></div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Build &amp; run</CardTitle>
          </CardHeader>
          <CardContent>
            <CopyBlock language="bash" code={`pnpm --filter @workspace/mcp-server build
node ./lib/mcp-server/dist/index.js
# Override the API base URL for self-hosted deployments:
VULNRAP_API_BASE_URL=https://my-vulnrap.example pnpm --filter @workspace/mcp-server start`} />
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Claude Desktop config</CardTitle>
            <CardDescription className="mt-1">
              Add this block to <code className="font-mono text-xs text-foreground">claude_desktop_config.json</code> and
              restart Claude Desktop. The server speaks MCP over stdio — no network ports, no auth.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CopyBlock language="json" code={`{
  "mcpServers": {
    "vulnrap": {
      "command": "node",
      "args": ["/absolute/path/to/lib/mcp-server/dist/index.js"],
      "env": {
        "VULNRAP_API_BASE_URL": "https://vulnrap.com"
      }
    }
  }
}`} />
          </CardContent>
        </Card>
      </div>

      <div className="text-center text-xs text-muted-foreground/50 pb-4">
        <button type="button" onClick={() => { setSwaggerOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="hover:text-primary transition-colors">
          Full OpenAPI spec available at /api/docs
        </button>
      </div>
    </div>
  );
}
