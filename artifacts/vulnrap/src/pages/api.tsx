import { Code, ExternalLink, FileText, Search, Shield, Activity, MessageSquare, Heart, Terminal, Copy, Check } from "lucide-react";
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
        className="absolute top-3 right-3 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-primary transition-all opacity-0 group-hover:opacity-100"
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
    description: "Upload a vulnerability report for full analysis — similarity matching, AI slop scoring, auto-redaction, and section-level hashing.",
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
    responseHint: "Returns report ID, delete token, slopScore (blended), llmSlopScore, llmEnhanced flag, llmFeedback, heuristic feedback, similarity matches, redaction summary",
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
    responseHint: "Returns slopScore (blended), llmSlopScore, llmEnhanced, llmFeedback, similarity matches, section hashes — nothing saved",
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
            <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer">
              <Button className="glow-button gap-2">
                Open Swagger UI <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </a>
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

      <div className="text-center text-xs text-muted-foreground/50 pb-4">
        <a href={apiDocsUrl} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">
          Full OpenAPI spec available at /api/docs
        </a>
      </div>
    </div>
  );
}
