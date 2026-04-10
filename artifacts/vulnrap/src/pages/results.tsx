import { useParams } from "react-router-dom";
import { useGetReport, getGetReportQueryKey, useGetVerification, getGetVerificationQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, Copy, AlertTriangle, FileText, Clock, Search, HelpCircle, Lightbulb, ShieldCheck, Hash, Layers, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

function anonymizeId(id: number): string {
  const hex = id.toString(16).padStart(4, "0");
  return `VR-${hex.toUpperCase()}`;
}

function getSlopColor(score: number) {
  if (score < 30) return "text-green-500";
  if (score < 70) return "text-yellow-500";
  return "text-destructive";
}

function getSlopProgressColor(score: number) {
  if (score < 30) return "bg-green-500";
  if (score < 70) return "bg-yellow-500";
  return "bg-destructive";
}

function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 rounded-md glass-card px-3 py-2 text-xs text-popover-foreground opacity-0 group-hover:opacity-100 transition-opacity z-50 glow-border text-left font-normal normal-case">
        {text}
      </span>
    </span>
  );
}

function getSlopExplainer(score: number): string {
  if (score < 15) return "This report shows strong indicators of being human-written: specific technical details, varied sentence structure, and natural vocabulary.";
  if (score < 30) return "Mostly looks human-written, but has a few patterns sometimes associated with AI generation. Likely fine.";
  if (score < 50) return "Some structural patterns match known AI-generation signatures. Consider adding more specific technical details and reproduction steps.";
  if (score < 70) return "Multiple AI-generation indicators detected. Triage teams may flag this. Significantly revise with concrete exploit details and unique observations.";
  return "Strong AI-generation signals throughout. This report will likely be flagged or rejected by most triage teams. A complete rewrite with original research is recommended.";
}

const REDACTION_LABELS: Record<string, string> = {
  email: "Email Addresses",
  ipv4: "IPv4 Addresses",
  ipv6: "IPv6 Addresses",
  api_key: "API Keys",
  bearer_token: "Bearer Tokens",
  jwt: "JWT Tokens",
  aws_key: "AWS Keys",
  private_key: "Private Keys",
  password: "Passwords",
  connection_string: "Connection Strings",
  url_with_creds: "URLs with Credentials",
  hex_secret: "Hex Secrets",
  uuid: "UUIDs",
  phone: "Phone Numbers",
  ssn: "SSNs",
  credit_card: "Credit Cards",
  internal_hostname: "Internal Hostnames",
  internal_url: "Internal URLs",
  company_name: "Company Names",
  username: "Usernames",
};

export default function Results() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const [showFullReport, setShowFullReport] = useState(false);

  const { data: report, isLoading, isError } = useGetReport(id, {
    query: {
      enabled: !!id,
      queryKey: getGetReportQueryKey(id)
    }
  });

  const { data: verification } = useGetVerification(id, {
    query: {
      enabled: !!id,
      queryKey: getGetVerificationQueryKey(id),
    },
  });

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast({ title: "Link copied", description: "Shareable link copied to clipboard." });
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    toast({ title: "Hash copied", description: "Hash copied to clipboard." });
  };

  const copyBadgeMarkdown = () => {
    if (!verification) return;
    const md = `**VulnRap Verified** | Score: ${verification.slopScore}/100 (${verification.slopTier}) | ${verification.similarityMatchCount} similar reports | Verify: ${verification.verifyUrl}`;
    navigator.clipboard.writeText(md);
    toast({ title: "Badge copied", description: "Paste this into your bug report submission." });
  };

  const copyBadgePlain = () => {
    if (!verification) return;
    const lines = [
      `--- VulnRap Verification ---`,
      `Report: ${verification.reportCode}`,
      `Slop Score: ${verification.slopScore}/100 (${verification.slopTier})`,
      `Similar Reports: ${verification.similarityMatchCount}`,
      `Hash: ${verification.contentHash}`,
      `Verify: ${verification.verifyUrl}`,
      `---`,
    ].join("\n");
    navigator.clipboard.writeText(lines);
    toast({ title: "Badge copied", description: "Paste this into your bug report submission." });
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/3" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-48 md:col-span-2" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
        <h2 className="text-2xl font-bold">Report not found</h2>
        <p className="text-muted-foreground mt-2">The requested report could not be loaded or does not exist.</p>
      </div>
    );
  }

  const sectionHashes = report.sectionHashes as Record<string, string> | undefined;
  const sectionMatches = report.sectionMatches as Array<{ sectionTitle: string; matchedReportId: number; matchedSectionTitle: string; similarity: number }> | undefined;
  const redactionSummary = report.redactionSummary as { totalRedactions: number; categories: Record<string, number> } | undefined;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6">
        <div>
          <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
            <FileText className="w-8 h-8 text-primary" />
            Analysis Results
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {new Date(report.createdAt).toLocaleString()}
            </span>
            <span className="flex items-center gap-1">
              <Badge variant="outline" className="uppercase text-xs">{report.contentMode.replace("_", " ")}</Badge>
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={copyLink} className="gap-2 glass-card hover:border-primary/30">
          <Copy className="w-4 h-4" />
          Share Link
        </Button>
      </div>
      <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent -mt-4" />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 glass-card-accent rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center">
              AI Sloppiness Score
              <Hint text="A heuristic score from 0-100 measuring how likely your report is AI-generated. Based on phrase patterns, structural analysis, vocabulary diversity, and presence of technical details like reproduction steps and code blocks." />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-6">
            <div className={`text-7xl font-bold font-mono tracking-tighter ${getSlopColor(report.slopScore)} glow-text`}>
              {report.slopScore}
            </div>
            <div className="mt-4 text-xl font-medium tracking-wide uppercase">
              {report.slopTier}
            </div>
            <div className="w-full max-w-md mt-8 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>0 (Human)</span>
                <span>100 (Pure AI Slop)</span>
              </div>
              <Progress value={report.slopScore} className="h-2" indicatorClassName={getSlopProgressColor(report.slopScore)} />
            </div>
            <p className="mt-6 text-xs text-muted-foreground text-center max-w-md leading-relaxed">
              {getSlopExplainer(report.slopScore)}
            </p>
          </CardContent>
        </Card>

        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">File Metadata</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">File Name</div>
              <div className="font-mono text-sm truncate" title={report.fileName || "Unknown"}>
                {report.fileName || "Unknown"}
              </div>
            </div>
            <Separator className="bg-border/30" />
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">File Size</div>
              <div className="font-mono text-sm">
                {(report.fileSize / 1024).toFixed(2)} KB
              </div>
            </div>
            <Separator className="bg-border/30" />
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1 flex items-center justify-between">
                <span className="flex items-center">
                  SHA-256 Hash
                  <Hint text="A cryptographic fingerprint of your report content (after auto-redaction). If someone uploads the exact same file, this hash will match -- that is how we detect exact duplicates." />
                </span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => copyHash(report.contentHash)}>
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <div className="font-mono text-xs truncate text-primary glow-text-sm" title={report.contentHash}>
                {report.contentHash}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {verification && (
        <Card className="glass-card-accent rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="w-5 h-5 text-primary" />
              Verification Badge
              <Hint text="Copy this badge and paste it into your bug bounty submission. It gives the receiver a link to independently verify your report's slop score and uniqueness." />
            </CardTitle>
            <CardDescription>Include this in your bug report to prove it was validated</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="glass-card rounded-xl p-4 space-y-1">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck className="w-4 h-4 text-green-400" />
                <strong>VulnRap Verified</strong>
                <span className="text-muted-foreground">|</span>
                <span>Report {verification.reportCode}</span>
              </div>
              <div className="text-sm text-muted-foreground">
                Score: <span className={getSlopColor(verification.slopScore)}>{verification.slopScore}/100</span> ({verification.slopTier})
                {" | "}{verification.similarityMatchCount} similar report{verification.similarityMatchCount !== 1 ? "s" : ""}
                {" | "}{verification.sectionMatchCount} section match{verification.sectionMatchCount !== 1 ? "es" : ""}
              </div>
              <div className="text-xs text-primary font-mono truncate glow-text-sm">{verification.verifyUrl}</div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="gap-2 glass-card hover:border-primary/30" onClick={copyBadgeMarkdown}>
                <Copy className="w-3.5 h-3.5" />
                Copy as Markdown
              </Button>
              <Button variant="outline" size="sm" className="gap-2 glass-card hover:border-primary/30" onClick={copyBadgePlain}>
                <Copy className="w-3.5 h-3.5" />
                Copy as Plain Text
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {redactionSummary && redactionSummary.totalRedactions > 0 && (
        <Card className="glass-card rounded-xl" style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-green-400" />
              Auto-Redaction Summary
              <Hint text="Before storing or analyzing your report, we automatically scan for and redact personally identifiable information, secrets, credentials, and company names. Only the redacted version is stored and compared." />
            </CardTitle>
            <CardDescription>
              {redactionSummary.totalRedactions} item{redactionSummary.totalRedactions !== 1 ? "s" : ""} automatically redacted before analysis
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Object.entries(redactionSummary.categories).map(([category, count]) => (
                <div key={category} className="glass-card rounded-lg p-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {REDACTION_LABELS[category] || category}
                  </span>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {count as number}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            Similarity Analysis
            <Hint text="We compare your report against all previously submitted reports using MinHash (fuzzy matching) and Simhash (structural similarity). High similarity to an existing report may indicate a duplicate submission." />
          </CardTitle>
          <CardDescription>Comparison against previously submitted reports</CardDescription>
        </CardHeader>
        <CardContent>
          {report.similarityMatches && report.similarityMatches.length > 0 ? (
            <div className="space-y-6">
              {report.similarityMatches.map((match, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-sm">
                      Match <span className="text-primary glow-text-sm">{anonymizeId(match.reportId)}</span>
                    </span>
                    <Badge variant={match.similarity > 80 ? "destructive" : "secondary"}>
                      {match.matchType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4">
                    <Progress value={match.similarity} className="flex-1 h-2" indicatorClassName={match.similarity > 80 ? "bg-destructive" : "bg-primary"} />
                    <span className="font-mono text-sm w-12 text-right">{Math.round(match.similarity)}%</span>
                  </div>
                  {match.similarity > 80 && (
                    <p className="text-xs text-destructive/80 italic pl-1">High similarity -- this may be a duplicate of a previously reported vulnerability.</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <div className="p-4 rounded-full icon-glow-green mb-4">
                <CheckCircle className="w-12 h-12 text-green-400" />
              </div>
              <p className="font-medium text-foreground">No significant similarities found</p>
              <p className="text-sm">This report appears to be unique in our database.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {sectionHashes && Object.keys(sectionHashes).length > 0 && (
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              Section-Level Analysis
              <Hint text="Your report is parsed into logical sections (by headers or paragraphs). Each section is independently hashed with SHA-256 for granular matching. This detects when individual sections are reused across reports even if the full document differs." />
            </CardTitle>
            <CardDescription>
              {Object.keys(sectionHashes).filter(k => k !== "__full_document").length} sections parsed and hashed independently
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {Object.entries(sectionHashes)
                .filter(([key]) => key !== "__full_document")
                .map(([title, hash]) => (
                  <div key={title} className="flex items-center justify-between glass-card rounded-lg p-3 group">
                    <div className="flex items-center gap-2 min-w-0">
                      <Hash className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                      <span className="text-sm font-medium truncate">{title}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground hidden sm:inline truncate max-w-[200px]">
                        {(hash as string).slice(0, 16)}...
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => copyHash(hash as string)}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
            </div>

            {sectionMatches && sectionMatches.length > 0 && (
              <>
                <Separator className="bg-border/30" />
                <div>
                  <h4 className="text-sm font-bold mb-3 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-yellow-500" />
                    Matching Sections Found
                  </h4>
                  <div className="space-y-2">
                    {sectionMatches.map((match, i) => (
                      <div key={i} className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-sm">
                        <div className="flex justify-between items-center">
                          <span>
                            <strong>{match.sectionTitle}</strong> matches{" "}
                            <span className="font-mono text-primary glow-text-sm">{anonymizeId(match.matchedReportId)}</span>
                            {match.matchedSectionTitle !== match.sectionTitle && (
                              <span className="text-muted-foreground"> ({match.matchedSectionTitle})</span>
                            )}
                          </span>
                          <Badge variant="secondary" className="font-mono">{match.similarity}%</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-primary" />
            Analysis Feedback
            <Hint text="Actionable suggestions based on structural and linguistic patterns in your report. These indicate areas where your report could be improved to appear more thorough and less likely to be flagged as AI-generated." />
          </CardTitle>
          <CardDescription>Observations and suggestions to improve your report</CardDescription>
        </CardHeader>
        <CardContent>
          {report.feedback && report.feedback.length > 0 ? (
            <ul className="space-y-3">
              {report.feedback.map((item, i) => (
                <li key={i} className="flex items-start gap-3 glass-card p-3 rounded-lg">
                  <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                  <span className="text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <div className="p-3 rounded-full icon-glow-green mb-3">
                <CheckCircle className="w-10 h-10 text-green-400" />
              </div>
              <p className="font-medium text-foreground">Looking good</p>
              <p className="text-sm">No specific improvements suggested for this report.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {report.redactedText && (
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              Redacted Report Content
              <Hint text="This is the auto-redacted version of your report that was stored and compared. PII, secrets, and identifying information have been replaced with redaction tags." />
            </CardTitle>
            <CardDescription>Auto-redacted version stored in the platform</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFullReport(!showFullReport)}
              className="mb-4 glass-card hover:border-primary/30"
            >
              {showFullReport ? "Hide Report" : "Show Redacted Report"}
            </Button>
            {showFullReport && (
              <pre className="glass-card rounded-xl p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto leading-relaxed">
                {report.redactedText}
              </pre>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
