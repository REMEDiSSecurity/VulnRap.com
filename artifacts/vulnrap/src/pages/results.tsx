import { useParams, useNavigate } from "react-router-dom";
import { useGetReport, getGetReportQueryKey, useGetVerification, getGetVerificationQueryKey, useDeleteReport, useCompareReports, getCompareReportsQueryKey, type Verification, type VerificationCheck, type VerificationSummary, type TriageRecommendation, type ChallengeQuestion, type TemporalSignal, type TemplateMatch, type RevisionResult } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, Copy, AlertTriangle, FileText, Clock, Search, HelpCircle, Lightbulb, ShieldCheck, Hash, Layers, Award, Trash2, Brain, Cpu, GitCompare, ChevronDown, ChevronUp, Download, BarChart3, Target, Eye, Gauge, Leaf, Shield, MessageSquareWarning, RefreshCw, Fingerprint, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import FeedbackForm from "@/components/feedback-form";
import { anonymizeId } from "@/lib/utils";
import { SettingsButton } from "@/components/settings-panel";
import { getSettings, saveSettings, getSlopColorCustom, getSlopProgressColorCustom, adjustScore, adjustTier, SENSITIVITY_PRESETS, type VulnRapSettings, type SensitivityPreset } from "@/lib/settings";

function getQualityColor(score: number) {
  if (score >= 70) return "text-green-500";
  if (score >= 40) return "text-yellow-500";
  return "text-destructive";
}

function getQualityProgressColor(score: number) {
  if (score >= 70) return "bg-green-500";
  if (score >= 40) return "bg-yellow-500";
  return "bg-destructive";
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "High";
  if (confidence >= 0.5) return "Medium";
  return "Low";
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "text-green-400";
  if (confidence >= 0.5) return "text-yellow-400";
  return "text-orange-400";
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
  if (score <= 20) return "This report shows strong indicators of being human-written: specific technical details, varied sentence structure, and natural vocabulary.";
  if (score <= 35) return "Mostly looks human-written, but has a few patterns sometimes associated with AI generation. Likely fine.";
  if (score <= 55) return "Some structural patterns match known AI-generation signatures. Consider adding more specific technical details and reproduction steps.";
  if (score <= 75) return "Multiple AI-generation indicators detected. Triage teams may flag this. Significantly revise with concrete exploit details and unique observations.";
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

const EVIDENCE_TYPE_LABELS: Record<string, string> = {
  ai_phrase: "AI Phrase Detected",
  template_match: "Template Pattern",
  severity_inflation: "Severity Inflation",
  invalid_cvss: "Invalid CVSS Score",
  cwe_stuffing: "CWE Stuffing",
  taxonomy_padding: "Taxonomy Padding",
  placeholder_url: "Placeholder URL",
  generic_path: "Generic API Path",
  fake_asan: "Fabricated ASan Output",
  repeating_stack: "Repeating Stack Frames",
  fake_registers: "Fabricated Register Dump",
  uniform_http: "Uniform HTTP Responses",
  future_cve: "Future CVE Year",
  invalid_cve_year: "Invalid CVE Year",
  cve_cluster: "CVE Year Clustering",
  fabricated_cve: "Fabricated CVE",
  hallucinated_function: "Hallucinated Function",
  statistical: "Statistical Signal",
  low_sentence_cv: "Low Sentence Variation",
  bigram_entropy_low: "Low Bigram Entropy",
  human_contractions: "Human Signal: Contractions",
  human_terse_style: "Human Signal: Terse Style",
  human_informal_language: "Human Signal: Informal Language",
  human_commit_refs: "Human Signal: Commit References",
  human_patched_version: "Human Signal: Patched Version",
  human_no_pleasantries: "Human Signal: Advisory Format",
};

function getDeleteToken(reportId: number): string | null {
  try {
    const tokens = JSON.parse(sessionStorage.getItem("vulnrap_delete_tokens") || "{}");
    return tokens[reportId] || null;
  } catch {
    return null;
  }
}

function removeDeleteToken(reportId: number) {
  try {
    const tokens = JSON.parse(sessionStorage.getItem("vulnrap_delete_tokens") || "{}");
    delete tokens[reportId];
    sessionStorage.setItem("vulnrap_delete_tokens", JSON.stringify(tokens));
  } catch {}
}

function SectionStatusBadge({ status }: { status: string }) {
  if (status === "identical") return <Badge variant="destructive" className="text-[9px] px-1.5 py-0 h-4">Identical</Badge>;
  if (status === "different") return <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">Different</Badge>;
  return <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 text-muted-foreground">Unique</Badge>;
}

function AxisBar({ label, score, icon, color }: { label: string; score: number; icon: React.ReactNode; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className={`font-mono font-bold ${score >= 50 ? "text-destructive" : score >= 25 ? "text-yellow-500" : "text-green-500"}`}>{score}</span>
      </div>
      <Progress value={score} className="h-1.5" indicatorClassName={color} />
    </div>
  );
}

function LlmDimensionBar({ label, score }: { label: string; score: number }) {
  const color = score >= 50 ? "bg-destructive" : score >= 25 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-mono font-bold ${score >= 50 ? "text-destructive" : score >= 25 ? "text-yellow-500" : "text-green-500"}`}>{score}</span>
      </div>
      <Progress value={score} className="h-1" indicatorClassName={color} />
    </div>
  );
}

function VerificationPanel({ checks, summary }: { checks: VerificationCheck[]; summary?: VerificationSummary }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card className="glass-card rounded-xl">
      <CardHeader className="cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <CardTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          Active Verification
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{checks.length} checks</Badge>
          <Hint text="VulnRap actively verified referenced file paths, CVE IDs, and PoC resources against live sources (GitHub, NVD, npm, PyPI). Green = confirmed to exist. Red = could not be found. Yellow = partial match or warning." />
          <span className="ml-auto">{expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}</span>
        </CardTitle>
        <CardDescription>Live verification of referenced files, CVEs, and resources</CardDescription>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2">
          {summary && (
            <div className="flex items-center gap-4 mb-3 text-xs">
              {(summary.verified ?? 0) > 0 && <span className="flex items-center gap-1 text-green-400"><CheckCircle className="w-3.5 h-3.5" />{summary.verified} verified</span>}
              {(summary.notFound ?? 0) > 0 && <span className="flex items-center gap-1 text-destructive"><AlertCircle className="w-3.5 h-3.5" />{summary.notFound} not found</span>}
              {(summary.warnings ?? 0) > 0 && <span className="flex items-center gap-1 text-yellow-500"><AlertTriangle className="w-3.5 h-3.5" />{summary.warnings} warning{(summary.warnings ?? 0) !== 1 ? "s" : ""}</span>}
            </div>
          )}
          {checks.map((check, i) => {
            const icon = check.result === "verified"
              ? <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
              : check.result === "not_found"
                ? <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                : <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />;
            const bg = check.result === "verified"
              ? "bg-green-500/5 border-green-500/15"
              : check.result === "not_found"
                ? "bg-destructive/5 border-destructive/15"
                : "bg-yellow-500/5 border-yellow-500/15";
            return (
              <div key={i} className={`rounded-lg border p-3 flex items-start gap-3 ${bg}`}>
                <div className="mt-0.5">{icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{check.type.replace(/_/g, " ")}</span>
                    <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${
                      check.result === "verified" ? "border-green-500/40 text-green-400" :
                      check.result === "not_found" ? "border-destructive/40 text-destructive" :
                      "border-yellow-500/40 text-yellow-500"
                    }`}>
                      {check.result.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  <p className="text-sm leading-relaxed">{check.detail}</p>
                </div>
              </div>
            );
          })}
        </CardContent>
      )}
    </Card>
  );
}

function TriageCard({ triage, challengeQuestions, temporalSignals, templateMatch, revision, toast }: {
  triage: TriageRecommendation;
  challengeQuestions: ChallengeQuestion[];
  temporalSignals: TemporalSignal[];
  templateMatch: TemplateMatch | null;
  revision: RevisionResult | null;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  return (
    <Card className={`glass-card rounded-xl ${
      triage.action === "AUTO_CLOSE" ? "border-destructive/30" :
      triage.action === "PRIORITIZE" ? "border-green-500/30" :
      triage.action === "CHALLENGE_REPORTER" ? "border-yellow-500/30" : ""
    }`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareWarning className="w-5 h-5 text-primary" />
          Triage Recommendation
          <Badge variant={
            triage.action === "AUTO_CLOSE" ? "destructive" :
            triage.action === "PRIORITIZE" ? "default" :
            triage.action === "CHALLENGE_REPORTER" ? "secondary" : "outline"
          } className="text-[10px] px-1.5 py-0 h-4 uppercase">
            {triage.action.replace(/_/g, " ")}
          </Badge>
          <Hint text="Automated triage action based on slop score, confidence, and active verification results. AUTO_CLOSE = high AI confidence, CHALLENGE_REPORTER = send questions, MANUAL_REVIEW = assign senior triager, PRIORITIZE = likely legitimate, STANDARD_TRIAGE = follow normal process." />
        </CardTitle>
        <CardDescription>{triage.reason}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="glass-card rounded-lg p-4 text-sm leading-relaxed">{triage.note}</div>

        {challengeQuestions.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-yellow-500" />
                Challenge Questions ({challengeQuestions.length})
              </h4>
              <Button variant="outline" size="sm" className="gap-1.5 glass-card hover:border-primary/30 text-xs" onClick={() => {
                const text = challengeQuestions.map((q, i) => `${i + 1}. ${q.question}`).join("\n\n");
                navigator.clipboard.writeText(text);
                toast({ title: "Copied", description: "Challenge questions copied to clipboard." });
              }}>
                <Copy className="w-3 h-3" /> Copy All
              </Button>
            </div>
            {challengeQuestions.map((q, i) => (
              <div key={i} className="rounded-lg bg-yellow-500/5 border border-yellow-500/15 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-yellow-500/70">{q.category.replace(/_/g, " ")}</span>
                  <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {
                    navigator.clipboard.writeText(q.question);
                    toast({ title: "Copied", description: "Question copied." });
                  }}>
                    <Copy className="w-3 h-3" />
                  </Button>
                </div>
                <p className="text-sm leading-relaxed">{q.question}</p>
                <p className="text-xs text-muted-foreground mt-1 italic">{q.context}</p>
              </div>
            ))}
          </div>
        )}

        {temporalSignals.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-bold flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" />
              Temporal Signals
            </h4>
            {temporalSignals.map((s, i) => (
              <div key={i} className={`rounded-lg border p-3 flex items-center justify-between text-sm ${
                s.signal === "suspiciously_fast" ? "bg-destructive/5 border-destructive/15" :
                s.signal === "fast_turnaround" ? "bg-yellow-500/5 border-yellow-500/15" :
                "bg-muted/20 border-border/30"
              }`}>
                <div>
                  <span className="font-mono text-primary">{s.cveId}</span>
                  <span className="text-muted-foreground ml-2">
                    {s.hoursSincePublication < 1 ? `${Math.round(s.hoursSincePublication * 60)}min` : `${s.hoursSincePublication.toFixed(1)}h`} after publication
                  </span>
                </div>
                <Badge variant={s.signal === "suspiciously_fast" ? "destructive" : s.signal === "fast_turnaround" ? "secondary" : "outline"} className="text-[10px]">
                  {s.signal.replace(/_/g, " ")}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {templateMatch && (
          <div className="rounded-lg bg-orange-500/5 border border-orange-500/15 p-3 flex items-center gap-3">
            <Fingerprint className="w-5 h-5 text-orange-400 flex-shrink-0" />
            <div>
              <div className="text-sm font-medium">Template Reuse Detected</div>
              <div className="text-xs text-muted-foreground">
                Matches {templateMatch.matchedReportIds.length} previous report{templateMatch.matchedReportIds.length !== 1 ? "s" : ""} with identical structure (weight: {templateMatch.weight})
              </div>
            </div>
          </div>
        )}

        {revision && (
          <div className={`rounded-lg border p-3 flex items-center gap-3 ${
            revision.direction === "improved" ? "bg-green-500/5 border-green-500/15" :
            revision.direction === "worsened" ? "bg-destructive/5 border-destructive/15" :
            "bg-muted/20 border-border/30"
          }`}>
            <RefreshCw className={`w-5 h-5 flex-shrink-0 ${
              revision.direction === "improved" ? "text-green-400" :
              revision.direction === "worsened" ? "text-destructive" : "text-muted-foreground"
            }`} />
            <div>
              <div className="text-sm font-medium">
                Revision of {anonymizeId(revision.originalReportId)}
                <Badge variant={revision.direction === "improved" ? "default" : revision.direction === "worsened" ? "destructive" : "outline"} className="text-[10px] ml-2">
                  {revision.direction === "improved" ? `Score dropped ${Math.abs(revision.scoreChange)} pts` :
                   revision.direction === "worsened" ? `Score rose ${revision.scoreChange} pts` : "No change"}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {revision.similarity.toFixed(0)}% similar to original (score: {revision.originalScore})
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ComparePanel({ reportId, matchId, matchSimilarity, matchType, settings }: { reportId: number; matchId: number; matchSimilarity: number; matchType: string; settings: VulnRapSettings }) {
  const { data: comparison, isLoading, isError } = useCompareReports(reportId, matchId, {
    query: { enabled: true, queryKey: getCompareReportsQueryKey(reportId, matchId) },
  });

  if (isLoading) {
    return (
      <div className="mt-3 space-y-2">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (isError || !comparison) {
    return (
      <div className="mt-3 text-xs text-muted-foreground italic">
        Could not load comparison data.
      </div>
    );
  }

  const src = comparison.sourceReport;
  const mtch = comparison.matchedReport;
  const sections = comparison.sectionComparison || [];
  const identical = comparison.identicalSections ?? 0;
  const total = comparison.totalSections ?? 0;

  return (
    <div className="mt-3 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
      {total > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <Layers className="w-3.5 h-3.5 text-primary" />
          <span className="font-medium">Section Map:</span>
          <span className={identical > 0 ? "text-destructive font-bold" : "text-green-400"}>
            {identical} of {total} sections identical
          </span>
        </div>
      )}

      {sections.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {sections.map((sec) => (
            <div key={sec.sectionTitle} className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">{sec.sectionTitle}</span>
              <SectionStatusBadge status={sec.status} />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Your Report ({src.reportCode})</span>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                Score: <span className={getSlopColorCustom(src.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh)}>{src.slopScore}</span>
              </Badge>
              <Badge variant="outline" className="text-[9px] text-muted-foreground">{src.contentMode === "similarity_only" ? "hash only" : "full"}</Badge>
            </div>
          </div>
          <div className="glass-card rounded-lg p-3 max-h-64 overflow-y-auto">
            {src.snippet ? (
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-foreground/80">{src.snippet}{src.snippet.length >= 2000 ? "\n\n[truncated...]" : ""}</pre>
            ) : (
              <p className="text-xs text-muted-foreground italic">Content not available (similarity-only mode)</p>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Matched Report ({mtch.reportCode})</span>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                Score: <span className={getSlopColorCustom(mtch.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh)}>{mtch.slopScore}</span>
              </Badge>
              <Badge variant="outline" className="text-[9px] text-muted-foreground">{mtch.contentMode === "similarity_only" ? "hash only" : "full"}</Badge>
            </div>
          </div>
          <div className="glass-card rounded-lg p-3 max-h-64 overflow-y-auto">
            {mtch.snippet ? (
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-foreground/80">{mtch.snippet}{mtch.snippet.length >= 2000 ? "\n\n[truncated...]" : ""}</pre>
            ) : (
              <p className="text-xs text-muted-foreground italic">Content not available (similarity-only mode)</p>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>Submitted: {new Date(src.createdAt).toLocaleDateString()} vs {new Date(mtch.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

export default function Results() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();
  const navigate = useNavigate();
  const [showFullReport, setShowFullReport] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [expandedCompare, setExpandedCompare] = useState<number | null>(null);
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityPreset>(() => getSettings().sensitivityPreset);
  const handleSensitivityChange = (preset: SensitivityPreset) => {
    setSensitivity(preset);
    saveSettings({ sensitivityPreset: preset });
  };
  const deleteToken = getDeleteToken(id);

  const deleteMutation = useDeleteReport({
    mutation: {
      onSuccess: () => {
        removeDeleteToken(id);
        toast({ title: "Report deleted", description: "Your report and all associated data have been permanently removed." });
        setTimeout(() => navigate("/"), 1500);
      },
      onError: () => {
        toast({ title: "Delete failed", description: "Could not delete the report. The delete token may be invalid.", variant: "destructive" });
      },
    },
  });

  const handleDelete = () => {
    if (!deleteToken) return;
    deleteMutation.mutate({ id, data: { deleteToken } });
  };

  const settings = getSettings();

  const exportJSON = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vulnrap-report-${anonymizeId(id)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: "JSON report downloaded." });
  };

  const exportText = () => {
    if (!report) return;
    const bd = report.breakdown as { linguistic?: number; factual?: number; template?: number; llm?: number | null; quality?: number } | undefined;
    const ev = report.evidence as Array<{ type: string; description: string; weight: number; matched?: string | null }> | undefined;
    const llmBd = report.llmBreakdown as { specificity?: number; originality?: number; voice?: number; coherence?: number; hallucination?: number } | undefined;
    const lines: string[] = [
      `VulnRap Analysis Report — ${anonymizeId(id)}`,
      `Generated: ${new Date().toISOString()}`,
      ``,
      `SLOP SCORE (AI Detection): ${report.slopScore}/100 (${report.slopTier})`,
    ];
    if (isAdjusted) {
      lines.push(`ADJUSTED SCORE (${SENSITIVITY_PRESETS[sensitivity].label}): ${displayScore}/100 (${displayTier})`);
    }
    if (report.qualityScore != null) {
      lines.push(`QUALITY SCORE (Report Completeness): ${report.qualityScore}/100`);
    }
    if (report.confidence != null) {
      lines.push(`CONFIDENCE: ${(report.confidence * 100).toFixed(0)}% (${getConfidenceLabel(report.confidence)})`);
    }
    lines.push(``);
    if (bd) {
      lines.push(`AXIS BREAKDOWN:`);
      lines.push(`  Linguistic: ${bd.linguistic ?? "N/A"}/100`);
      lines.push(`  Factual: ${bd.factual ?? "N/A"}/100`);
      lines.push(`  Template: ${bd.template ?? "N/A"}/100`);
      lines.push(`  LLM: ${bd.llm != null ? `${bd.llm}/100` : "N/A (not available)"}`);
      lines.push(`  Quality: ${bd.quality ?? "N/A"}/100`);
      lines.push(``);
    }
    if (llmBd && report.llmEnhanced) {
      lines.push(`LLM DIMENSIONS:`);
      if (llmBd.specificity != null) lines.push(`  Specificity: ${llmBd.specificity}/100`);
      if (llmBd.originality != null) lines.push(`  Originality: ${llmBd.originality}/100`);
      if (llmBd.voice != null) lines.push(`  Voice: ${llmBd.voice}/100`);
      if (llmBd.coherence != null) lines.push(`  Coherence: ${llmBd.coherence}/100`);
      if (llmBd.hallucination != null) lines.push(`  Hallucination: ${llmBd.hallucination}/100`);
      lines.push(``);
    }
    if (ev && ev.length > 0) {
      lines.push(`EVIDENCE (${ev.length} signals):`);
      ev.forEach((e) => {
        lines.push(`  [${EVIDENCE_TYPE_LABELS[e.type] || e.type}] (weight: ${e.weight}) ${e.description}${e.matched ? ` — matched: "${e.matched}"` : ""}`);
      });
      lines.push(``);
    }
    lines.push(`FILE: ${report.fileName || "Unknown"} (${(report.fileSize / 1024).toFixed(2)} KB)`);
    lines.push(`HASH: ${report.contentHash}`);
    lines.push(`MODE: ${report.contentMode}`);
    lines.push(`DATE: ${new Date(report.createdAt).toLocaleString()}`);
    lines.push(``);
    if (report.similarityMatches && report.similarityMatches.length > 0) {
      lines.push(`SIMILARITY MATCHES: ${report.similarityMatches.length}`);
      report.similarityMatches.forEach((m) => {
        lines.push(`  ${anonymizeId(m.reportId)} — ${Math.round(m.similarity)}% (${m.matchType})`);
      });
    } else {
      lines.push(`SIMILARITY MATCHES: None (unique)`);
    }
    lines.push(``);
    const rs = report.redactionSummary as { totalRedactions: number; categories: Record<string, number> } | undefined;
    if (rs && rs.totalRedactions > 0) {
      lines.push(`REDACTIONS: ${rs.totalRedactions} total`);
      Object.entries(rs.categories).forEach(([cat, count]) => {
        lines.push(`  ${REDACTION_LABELS[cat] || cat}: ${count}`);
      });
      lines.push(``);
    }
    if (report.feedback && report.feedback.length > 0) {
      lines.push(`HEURISTIC FEEDBACK:`);
      report.feedback.forEach((f) => lines.push(`  • ${f}`));
      lines.push(``);
    }
    if (report.llmFeedback && report.llmFeedback.length > 0) {
      lines.push(`LLM FEEDBACK:`);
      report.llmFeedback.forEach((f) => lines.push(`  • ${f}`));
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(`Report: ${window.location.href}`);
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vulnrap-report-${anonymizeId(id)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: "Text report downloaded." });
  };

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
  const breakdown = report.breakdown as { linguistic?: number; factual?: number; template?: number; llm?: number | null; quality?: number } | undefined;
  const evidence = report.evidence as Array<{ type: string; description: string; weight: number; matched?: string | null }> | undefined;
  const activeVerification = report.verification as Verification | null | undefined;
  const triage = report.triageRecommendation as TriageRecommendation | null | undefined;
  const triageChecks = activeVerification?.checks ?? [];
  const triageSummary = activeVerification?.summary;
  const challengeQuestions = triage?.challengeQuestions ?? [];
  const temporalSignals = triage?.temporalSignals ?? [];
  const templateMatch = triage?.templateMatch ?? null;
  const revisionInfo = triage?.revision ?? null;
  const llmBreakdown = report.llmBreakdown as { specificity?: number; originality?: number; voice?: number; coherence?: number; hallucination?: number } | undefined;
  const humanIndicators = (report.humanIndicators ?? []) as Array<{ type: string; description: string; weight: number; matched?: string | null }>;
  const qualityScore = report.qualityScore as number | undefined;
  const confidence = report.confidence as number | undefined;

  const adjusted = adjustScore(report.slopScore, sensitivity, breakdown, humanIndicators);
  const isAdjusted = sensitivity !== "balanced";
  const displayScore = isAdjusted ? adjusted : report.slopScore;
  const displayTier = isAdjusted ? adjustTier(adjusted, settings.slopThresholdLow, settings.slopThresholdHigh) : report.slopTier;
  const slopColor = getSlopColorCustom(displayScore, settings.slopThresholdLow, settings.slopThresholdHigh);
  const slopProgressColor = getSlopProgressColorCustom(displayScore, settings.slopThresholdLow, settings.slopThresholdHigh);

  const visibleEvidence = evidence && evidence.length > 0
    ? (showAllEvidence ? evidence : evidence.slice(0, 6))
    : [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pb-4 sm:pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
            <FileText className="w-6 h-6 sm:w-8 sm:h-8 text-primary shrink-0" />
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
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={copyLink} className="gap-2 glass-card hover:border-primary/30">
            <Copy className="w-4 h-4" />
            Share Link
          </Button>
          <Button variant="outline" onClick={exportJSON} className="gap-2 glass-card hover:border-primary/30">
            <Download className="w-4 h-4" />
            JSON
          </Button>
          <Button variant="outline" onClick={exportText} className="gap-2 glass-card hover:border-primary/30">
            <Download className="w-4 h-4" />
            TXT
          </Button>
          {deleteToken && (
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(true)}
              className="gap-2 glass-card hover:border-destructive/30 text-destructive hover:text-destructive"
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="w-4 h-4" />
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          )}
          <SettingsButton />
        </div>
      </div>
      <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent -mt-4" />

      {showDeleteConfirm && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-destructive">Permanently delete this report?</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                This will permanently remove the report, all hashes, similarity data, and redacted text from our database. This action cannot be undone. Once deleted, the verification badge link will stop working.
              </p>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)} className="glass-card">
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {deleteMutation.isPending ? "Deleting..." : "Yes, delete permanently"}
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 glass-card-accent rounded-xl">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              AI Detection Score
              {report.llmEnhanced ? (
                <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                  <Brain className="w-2.5 h-2.5" />
                  LLM Enhanced
                </Badge>
              ) : (
                <Badge variant="outline" className="border-violet-500/40 text-violet-400/70 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                  <Cpu className="w-2.5 h-2.5" />
                  Heuristic
                </Badge>
              )}
              <Hint text="Multi-axis AI detection score fusing linguistic fingerprinting, factual verification, template detection, and LLM semantic analysis. Higher = more likely AI-generated." />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-6">
            <div className="flex items-center justify-center gap-1 mb-4">
              {(Object.entries(SENSITIVITY_PRESETS) as [SensitivityPreset, { label: string; description: string }][]).map(([key, preset]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleSensitivityChange(key)}
                  className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all ${
                    sensitivity === key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted/30"
                  }`}
                  title={preset.description}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-8 w-full max-w-lg justify-center">
              <div className="flex flex-col items-center">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">AI Likelihood</div>
                <div className={`text-6xl font-bold font-mono tracking-tighter ${slopColor} glow-text`}>
                  {displayScore}
                </div>
                <div className="mt-2 text-sm font-medium tracking-wide uppercase">
                  {displayTier}
                </div>
                {isAdjusted && (
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    canonical: {report.slopScore} ({report.slopTier})
                  </div>
                )}
              </div>
              {qualityScore != null && (
                <>
                  <div className="h-20 w-px bg-border/30" />
                  <div className="flex flex-col items-center">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Report Quality</div>
                    <div className={`text-6xl font-bold font-mono tracking-tighter ${getQualityColor(qualityScore)} glow-text`}>
                      {qualityScore}
                    </div>
                    <div className="mt-2 text-sm font-medium tracking-wide uppercase text-muted-foreground">
                      {qualityScore >= 70 ? "Good" : qualityScore >= 40 ? "Fair" : "Poor"}
                    </div>
                  </div>
                </>
              )}
            </div>

            {confidence != null && (
              <div className="w-full max-w-md mt-5 flex items-center gap-3">
                <Gauge className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className={`font-mono font-bold ${getConfidenceColor(confidence)}`}>
                      {(confidence * 100).toFixed(0)}% — {getConfidenceLabel(confidence)}
                    </span>
                  </div>
                  <Progress value={confidence * 100} className="h-1.5" indicatorClassName={confidence >= 0.8 ? "bg-green-500" : confidence >= 0.5 ? "bg-yellow-500" : "bg-orange-500"} />
                </div>
              </div>
            )}

            <div className="w-full max-w-md mt-4 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>0 (Human)</span>
                <span>100 (Pure AI Slop)</span>
              </div>
              <Progress value={displayScore} className="h-2" indicatorClassName={slopProgressColor} />
            </div>

            <p className="mt-5 text-xs text-muted-foreground text-center max-w-md leading-relaxed">
              {getSlopExplainer(displayScore)}
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

      {breakdown && (
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              Axis Breakdown
              <Hint text="Each axis measures a different dimension of AI detection. Linguistic = AI phrase patterns and statistical features. Factual = severity inflation, placeholder URLs, fabricated evidence. Template = known slop report templates. LLM = semantic analysis across 5 dimensions (if available)." />
            </CardTitle>
            <CardDescription>Per-axis scores from the multi-axis scoring engine</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <AxisBar
                label="Linguistic"
                score={breakdown.linguistic ?? 0}
                icon={<Cpu className="w-3.5 h-3.5" />}
                color={(breakdown.linguistic ?? 0) >= 50 ? "bg-destructive" : (breakdown.linguistic ?? 0) >= 25 ? "bg-yellow-500" : "bg-green-500"}
              />
              <AxisBar
                label="Factual"
                score={breakdown.factual ?? 0}
                icon={<Target className="w-3.5 h-3.5" />}
                color={(breakdown.factual ?? 0) >= 50 ? "bg-destructive" : (breakdown.factual ?? 0) >= 25 ? "bg-yellow-500" : "bg-green-500"}
              />
              <AxisBar
                label="Template"
                score={breakdown.template ?? 0}
                icon={<FileText className="w-3.5 h-3.5" />}
                color={(breakdown.template ?? 0) >= 50 ? "bg-destructive" : (breakdown.template ?? 0) >= 25 ? "bg-yellow-500" : "bg-green-500"}
              />
              {breakdown.llm != null ? (
                <AxisBar
                  label="LLM Analysis"
                  score={breakdown.llm}
                  icon={<Brain className="w-3.5 h-3.5" />}
                  color={breakdown.llm >= 50 ? "bg-destructive" : breakdown.llm >= 25 ? "bg-yellow-500" : "bg-green-500"}
                />
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Brain className="w-3.5 h-3.5" />
                      LLM Analysis
                    </span>
                    <span className="font-mono text-muted-foreground/50 text-[10px]">N/A</span>
                  </div>
                  <Progress value={0} className="h-1.5" indicatorClassName="bg-muted" />
                </div>
              )}
            </div>
            {qualityScore != null && (
              <>
                <Separator className="bg-border/30" />
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Eye className="w-3.5 h-3.5" />
                      Report Quality (separate from AI detection)
                    </span>
                    <span className={`font-mono font-bold ${getQualityColor(qualityScore)}`}>{qualityScore}</span>
                  </div>
                  <Progress value={qualityScore} className="h-1.5" indicatorClassName={getQualityProgressColor(qualityScore)} />
                  <p className="text-[10px] text-muted-foreground mt-1">Measures report completeness (version info, code blocks, repro steps) — does not affect AI detection score.</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {report.llmEnhanced && llmBreakdown && (
        <Card className="glass-card rounded-xl border-cyan-500/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-cyan-400" />
              LLM Dimension Scores
              <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                <Brain className="w-2.5 h-2.5" />
                LLM Enhanced
              </Badge>
              <Hint text="Five semantic dimensions evaluated by the LLM: Specificity (technical detail), Originality (unique observations), Voice (natural writing style), Coherence (logical consistency), Hallucination (fabricated details). Higher = more AI-like." />
            </CardTitle>
            <CardDescription>Per-dimension LLM semantic analysis</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
              {llmBreakdown.specificity != null && <LlmDimensionBar label="Specificity" score={llmBreakdown.specificity} />}
              {llmBreakdown.originality != null && <LlmDimensionBar label="Originality" score={llmBreakdown.originality} />}
              {llmBreakdown.voice != null && <LlmDimensionBar label="Voice" score={llmBreakdown.voice} />}
              {llmBreakdown.coherence != null && <LlmDimensionBar label="Coherence" score={llmBreakdown.coherence} />}
              {llmBreakdown.hallucination != null && <LlmDimensionBar label="Hallucination" score={llmBreakdown.hallucination} />}
            </div>
          </CardContent>
        </Card>
      )}

      {evidence && evidence.length > 0 && (
        <Card className="glass-card rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-primary" />
              Evidence Signals
              <Badge variant="outline" className="text-[10px]">{evidence.length} found</Badge>
              <Hint text="Specific signals detected during analysis. Each signal has a weight indicating its significance. Higher-weight signals contribute more to the final score." />
            </CardTitle>
            <CardDescription>Specific indicators detected during multi-axis analysis</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {visibleEvidence.map((item, i) => (
              <div key={i} className="glass-card rounded-lg p-3 flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <Badge
                    variant={item.weight >= 10 ? "destructive" : "secondary"}
                    className="text-[9px] px-1.5 py-0 h-4 font-mono"
                  >
                    w:{item.weight}
                  </Badge>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {EVIDENCE_TYPE_LABELS[item.type] || item.type}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed">{item.description}</p>
                  {item.matched && (
                    <span className="inline-block mt-1 text-xs font-mono text-primary/70 bg-primary/5 rounded px-1.5 py-0.5 truncate max-w-full">
                      {item.matched}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {evidence.length > 6 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAllEvidence(!showAllEvidence)}
              >
                {showAllEvidence ? (
                  <><ChevronUp className="w-3 h-3 mr-1" /> Show fewer</>
                ) : (
                  <><ChevronDown className="w-3 h-3 mr-1" /> Show all {evidence.length} signals</>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {humanIndicators.length > 0 && (
        <Card className="glass-card rounded-xl" style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Leaf className="w-5 h-5 text-green-400" />
              Human Signals
              <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-400">{humanIndicators.length} found</Badge>
              <Hint text="Patterns commonly found in human-written reports that reduced the AI-detection score. These include contractions, terse/informal style, commit references, and advisory-style formatting." />
            </CardTitle>
            <CardDescription>Writing patterns that indicate human authorship</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {humanIndicators.map((item, i) => (
              <div key={i} className="rounded-lg bg-green-500/5 border border-green-500/10 p-3 flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 font-mono border-green-500/40 text-green-400">
                    {item.weight}
                  </Badge>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-green-400/70">
                    {EVIDENCE_TYPE_LABELS[item.type] || item.type}
                  </span>
                  <p className="text-sm leading-relaxed">{item.description}</p>
                  {item.matched && (
                    <span className="inline-block mt-1 text-xs font-mono text-green-400/70 bg-green-500/5 rounded px-1.5 py-0.5 truncate max-w-full">
                      {item.matched}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {activeVerification && triageChecks.length > 0 && (
        <VerificationPanel checks={triageChecks} summary={triageSummary} />
      )}

      {triage && (
        <TriageCard
          triage={triage}
          challengeQuestions={challengeQuestions}
          temporalSignals={temporalSignals}
          templateMatch={templateMatch}
          revision={revisionInfo}
          toast={toast}
        />
      )}

      {verification && (
        <Card className="glass-card-accent rounded-xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="w-5 h-5 text-primary" />
              Verification Badge
              <Hint text="Copy this badge and paste it into your report submission. It gives the receiver a link to independently verify your report's slop score and uniqueness." />
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
                Score: <span className={getSlopColorCustom(verification.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh)}>{verification.slopScore}/100</span> ({verification.slopTier})
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
              {report.similarityMatches.map((match, i) => {
                const isExpanded = expandedCompare === match.reportId;
                return (
                  <div key={i} className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="font-mono text-sm">
                        Match <span className="text-primary glow-text-sm">{anonymizeId(match.reportId)}</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <Badge variant={match.similarity >= settings.similarityThreshold ? "destructive" : "secondary"}>
                          {match.matchType}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <Progress value={match.similarity} className="flex-1 h-2" indicatorClassName={match.similarity >= settings.similarityThreshold ? "bg-destructive" : "bg-primary"} />
                      <span className="font-mono text-sm w-12 text-right">{Math.round(match.similarity)}%</span>
                    </div>
                    {match.similarity >= settings.similarityThreshold && (
                      <p className="text-xs text-destructive/80 italic pl-1">High similarity -- this may be a duplicate of a previously reported vulnerability.</p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 glass-card hover:border-primary/30 text-xs mt-1"
                      onClick={() => setExpandedCompare(isExpanded ? null : match.reportId)}
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                      {isExpanded ? "Hide" : "Compare"} Side by Side
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </Button>
                    {isExpanded && (
                      <ComparePanel
                        reportId={id}
                        matchId={match.reportId}
                        matchSimilarity={match.similarity}
                        matchType={match.matchType}
                        settings={settings}
                      />
                    )}
                  </div>
                );
              })}
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
            Heuristic Feedback
            <Badge variant="outline" className="border-violet-500/40 text-violet-400/70 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
              <Cpu className="w-2.5 h-2.5" />
              Rule Engine
            </Badge>
            <Hint text="Actionable suggestions from the deterministic rule engine — based on structural and linguistic patterns. Same input always produces the same feedback." />
          </CardTitle>
          <CardDescription>Structural and linguistic flags from the heuristic engine</CardDescription>
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
              <p className="text-sm">No structural issues flagged by the heuristic engine.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {report.llmEnhanced && report.llmFeedback && report.llmFeedback.length > 0 && (
        <Card className="glass-card rounded-xl border-cyan-500/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-cyan-400" />
              LLM Semantic Analysis
              <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                <Brain className="w-2.5 h-2.5" />
                LLM Enhanced
              </Badge>
              <Hint text="Semantic observations from the LLM analyzer, evaluating reports from a PSIRT triage perspective. Covers specificity, originality, voice, coherence, and hallucination signals." />
            </CardTitle>
            <CardDescription>PSIRT triage observations across five credibility dimensions</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {report.llmFeedback.map((item, i) => (
                <li key={i} className="flex items-start gap-3 rounded-lg bg-cyan-500/5 border border-cyan-500/10 p-3">
                  <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-cyan-400/60 flex-shrink-0" />
                  <span className="text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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

      <FeedbackForm reportId={id} />

      <Card className="glass-card rounded-xl">
        <CardContent className="flex flex-col sm:flex-row items-center justify-center gap-3 py-6">
          <Button onClick={() => navigate("/")} className="gap-2 w-full sm:w-auto">
            <FileText className="w-4 h-4" />
            Submit Another Report
          </Button>
          <Button variant="outline" onClick={() => navigate("/check")} className="gap-2 glass-card hover:border-primary/30 w-full sm:w-auto">
            <Search className="w-4 h-4" />
            Check Another
          </Button>
          <Button variant="outline" onClick={() => navigate("/compare")} className="gap-2 glass-card hover:border-primary/30 w-full sm:w-auto">
            <GitCompare className="w-4 h-4" />
            Compare Two Reports
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
