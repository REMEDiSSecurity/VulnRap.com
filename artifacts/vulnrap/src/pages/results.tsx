import { useParams, useNavigate } from "react-router-dom";
import { useGetReport, getGetReportQueryKey, useGetVerification, getGetVerificationQueryKey, useDeleteReport, useCompareReports, getCompareReportsQueryKey, type Verification, type VerificationCheck, type VerificationSummary, type TriageRecommendation, type TriageMatrixInputs, type ChallengeQuestion, type TemporalSignal, type TemplateMatch, type RevisionResult, type TriageAssistant, type ReproGuidance, type GapItem, type DontMissItem, type ReporterFeedbackItem, type LLMTriageGuidance, type ReproRecipe, type HardwareComponent } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, Copy, AlertTriangle, FileText, Clock, Search, HelpCircle, Lightbulb, ShieldCheck, Hash, Layers, Award, Trash2, Brain, Cpu, GitCompare, ChevronDown, ChevronUp, Download, BarChart3, Target, Eye, Gauge, Leaf, Shield, MessageSquareWarning, RefreshCw, Fingerprint, Timer, Crosshair, ListChecks, Microscope, UserCheck, BrainCircuit, ShieldOff, FlaskConical, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import FeedbackForm from "@/components/feedback-form";
import { anonymizeId } from "@/lib/utils";
import { SettingsButton } from "@/components/settings-panel";
import { getSettings, saveSettings, getSlopColorCustom, getSlopProgressColorCustom, adjustScore, adjustTier, SENSITIVITY_PRESETS, type VulnRapSettings, type SensitivityPreset } from "@/lib/settings";
import { RadarChart } from "@/components/radar-chart";
import { ConfidenceGauge } from "@/components/confidence-gauge";
import { HighlightedReport } from "@/components/evidence-highlighter";
import { DiagnosticsPanel, fetchDiagnostics, buildMarkdownSummary, type DiagnosticsResponse } from "@/components/diagnostics-panel";

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
  const [open, setOpen] = useState(false);
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <button
        type="button"
        className="inline-flex"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onBlur={() => setOpen(false)}
        aria-label="More info"
      >
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      </button>
      <span className={`pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 rounded-md glass-card px-3 py-2 text-xs text-popover-foreground transition-opacity z-50 glow-border text-left font-normal normal-case ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
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
  // v3.6.0 §2: Surface the same referenced/search-fallback split that the
  // diagnostics panel shows reviewers, so submitters can see which checks
  // were against repos they explicitly cited vs. ones VulnRap guessed.
  const referencedChecks = checks.filter((c) => c.source === "referenced_in_report");
  const fallbackChecks = checks.filter((c) => c.source === "search_fallback");
  const verifiedReferenced = referencedChecks.filter((c) => c.result === "verified").length;
  const hasSourceBreakdown = referencedChecks.length + fallbackChecks.length > 0;
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
          {hasSourceBreakdown && (
            <div className="flex items-center gap-2 mb-3 text-[11px] font-mono text-muted-foreground">
              <span>verified {verifiedReferenced}/{referencedChecks.length}</span>
              <span>·</span>
              <span>referenced: {referencedChecks.length}</span>
              <span>·</span>
              <span>search-fallback: {fallbackChecks.length}</span>
              <Hint text="Referenced = checks against repos you explicitly cited (GitHub/GitLab URLs, versioned package names). Search-fallback = checks against repos VulnRap guessed from a project keyword. Fallback checks inform diagnostics but do not lower your score." />
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

function MatrixInputsWidget({ inputs }: { inputs: TriageMatrixInputs }) {
  const cells: Array<{ label: string; value: string; hint: string; tone: "good" | "warn" | "bad" | "neutral" }> = [
    {
      label: "Composite",
      value: `${Math.round(inputs.compositeScore)}`,
      hint: "v3.6.0 composite score (0-100, higher = more legitimate). Bands: ≥70 prioritize, ≥60 standard, ≥45 mid, ≥30 low, <30 auto-close.",
      tone: inputs.compositeScore >= 60 ? "good" : inputs.compositeScore >= 45 ? "warn" : inputs.compositeScore >= 30 ? "warn" : "bad",
    },
    {
      label: "Engine 2",
      value: `${Math.round(inputs.engine2Score)}`,
      hint: "Technical Substance Analyzer score (0-100). Reflects evidence strength, claim coherence, and technical depth.",
      tone: inputs.engine2Score >= 60 ? "good" : inputs.engine2Score >= 50 ? "warn" : "bad",
    },
    {
      label: "Verification",
      value: `${Math.round(inputs.verificationRatio * 100)}%`,
      hint: "Ratio of verified vs. not_found checks against items the report explicitly references (search-fallback misses excluded).",
      tone: inputs.verificationRatio >= 0.5 ? "good" : inputs.verificationRatio >= 0.3 ? "warn" : "bad",
    },
    {
      label: "Strong Evidence",
      value: `${inputs.strongEvidenceCount}`,
      hint: "Count of hard-to-fabricate signals (CRASH_OUTPUT, STACK_TRACE, CODE_DIFF, SHELL_COMMAND, etc.). 3+ overrides a CHALLENGE_REPORTER decision.",
      tone: inputs.strongEvidenceCount >= 3 ? "good" : inputs.strongEvidenceCount >= 1 ? "warn" : "neutral",
    },
  ];
  const toneClass = (t: "good" | "warn" | "bad" | "neutral") =>
    t === "good" ? "text-green-400 border-green-500/20"
      : t === "warn" ? "text-yellow-400 border-yellow-500/20"
      : t === "bad" ? "text-destructive border-destructive/20"
      : "text-muted-foreground border-border/30";
  return (
    <div className="rounded-lg border border-border/30 bg-muted/10 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Layers className="w-4 h-4 text-primary" />
        <h4 className="text-sm font-bold">Matrix Inputs</h4>
        <Hint text="The four v3.6.0 matrix inputs that drove this recommendation. Watch for values near a band boundary — that's where the matrix is most likely to flip on the next re-check." />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {cells.map((c) => (
          <div key={c.label} className={`glass-card rounded-md border p-2 text-center ${toneClass(c.tone)}`}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center justify-center gap-1">
              {c.label}
              <Hint text={c.hint} />
            </div>
            <div className="text-lg font-mono font-bold leading-tight">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
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

        {triage.matrixInputs && (
          <MatrixInputsWidget inputs={triage.matrixInputs} />
        )}

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
              {revision.changeSummary && (
                <p className="text-xs text-muted-foreground mt-1 italic">{revision.changeSummary}</p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CopyableCodeBlock({ code, language, label, toast }: { code: string; language?: string; label: string; toast: ReturnType<typeof useToast>["toast"] }) {
  const copyCode = () => {
    navigator.clipboard.writeText(code);
    toast({ title: "Copied", description: `${label} copied to clipboard.` });
  };
  return (
    <div className="glass-card rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/20 border-b border-muted/20">
        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Terminal className="w-3 h-3" />{label}{language ? ` (${language})` : ""}
        </span>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={copyCode}>
          <Copy className="w-3 h-3" />
        </Button>
      </div>
      <pre className="p-3 text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words font-mono text-green-300/90 bg-black/30">
        {code}
      </pre>
    </div>
  );
}

function RecipeTabContent({ recipe, toast }: { recipe: ReproRecipe; toast: ReturnType<typeof useToast>["toast"] }) {
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex items-center gap-2">
        <FlaskConical className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-medium">{recipe.title}</span>
      </div>

      {recipe.target && (
        <div className="glass-card rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Target</div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 text-[10px]">{recipe.target.name}</Badge>
            {recipe.target.version && <Badge variant="outline" className="border-muted/40 text-[10px]">v{recipe.target.version}</Badge>}
            {recipe.target.language && <Badge variant="outline" className="border-muted/40 text-[10px]">{recipe.target.language}</Badge>}
            {recipe.target.packageManager && <Badge variant="outline" className="border-muted/40 text-[10px]">{recipe.target.packageManager}</Badge>}
          </div>
          {recipe.target.source && (
            <a href={recipe.target.source} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline mt-1.5 block truncate">{recipe.target.source}</a>
          )}
        </div>
      )}

      {recipe.setupCommands.length > 0 && (
        <CopyableCodeBlock
          code={recipe.setupCommands.join("\n")}
          language="bash"
          label="Setup Commands"
          toast={toast}
        />
      )}

      {recipe.pocScript && (
        <CopyableCodeBlock
          code={recipe.pocScript}
          language={recipe.pocLanguage || "bash"}
          label="PoC Script"
          toast={toast}
        />
      )}

      {recipe.expectedOutput && (
        <div className="glass-card rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
            <Eye className="w-3 h-3" />Expected Output
          </div>
          <p className="text-xs leading-relaxed">{recipe.expectedOutput}</p>
        </div>
      )}

      {recipe.dockerfile && (
        <CopyableCodeBlock
          code={recipe.dockerfile}
          language="dockerfile"
          label="Dockerfile"
          toast={toast}
        />
      )}

      {recipe.hardware && recipe.hardware.length > 0 && (
        <div className="space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Cpu className="w-3 h-3" />Hardware Components
          </div>
          {recipe.hardware.map((hw: HardwareComponent, i: number) => (
            <div key={i} className="glass-card rounded-lg p-3 border border-orange-500/15">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="border-orange-500/40 text-orange-400 text-[10px]">{hw.vendor}</Badge>
                {hw.model && <span className="text-xs font-medium">{hw.model}</span>}
                <Badge variant="outline" className="border-muted/40 text-[9px]">{hw.type}</Badge>
              </div>
              {hw.productUrl && (
                <a href={hw.productUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline block mb-2 truncate">{hw.productUrl}</a>
              )}
              {hw.emulationOptions.length > 0 && (
                <div className="mt-1.5">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Emulation Options</div>
                  <ul className="space-y-0.5">
                    {hw.emulationOptions.map((opt, j) => (
                      <li key={j} className="text-xs flex items-start gap-1.5">
                        <span className="w-1 h-1 rounded-full bg-orange-400 mt-1.5 flex-shrink-0" />{opt}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {recipe.notes.length > 0 && (
        <div className="glass-card rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Notes</div>
          <ul className="space-y-1">
            {recipe.notes.map((note, i) => (
              <li key={i} className="text-xs flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 text-yellow-400 mt-0.5 flex-shrink-0" />
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type AssistantTab = "reproduce" | "recipe" | "gaps" | "dontmiss" | "feedback";

interface VulnrapEngineResultPanel {
  engine: string;
  score: number;
  verdict: "GREEN" | "YELLOW" | "RED" | "GREY";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  triggeredIndicators?: Array<{ signal: string; explanation: string; strength?: "HIGH" | "MEDIUM" | "LOW" }>;
  signalBreakdown?: Record<string, unknown>;
  note?: string;
}

interface VulnrapPanelData {
  compositeScore: number;
  label: string;
  engines: VulnrapEngineResultPanel[];
  overridesApplied: string[];
  warnings?: string[];
  engineCount?: number;
  compositeBreakdown?: { weightedSum: number; totalWeight: number; beforeOverride: number; afterOverride: number };
  reconstructed?: boolean;
}

const VULNRAP_LABEL_COLOR: Record<string, string> = {
  "LIKELY INVALID": "text-red-400 border-red-500/40",
  "HIGH RISK": "text-orange-400 border-orange-500/40",
  "NEEDS REVIEW": "text-yellow-400 border-yellow-500/40",
  REASONABLE: "text-emerald-300 border-emerald-500/40",
  PROMISING: "text-emerald-400 border-emerald-500/40",
  STRONG: "text-green-400 border-green-500/40",
};

const VULNRAP_VERDICT_COLOR: Record<string, string> = {
  RED: "bg-destructive",
  YELLOW: "bg-yellow-500",
  GREEN: "bg-green-500",
  GREY: "bg-muted",
};

function TriageAssistantPanel({ assistant, toast }: { assistant: TriageAssistant; toast: ReturnType<typeof useToast>["toast"] }) {
  const [expanded, setExpanded] = useState(true);
  const [activeTab, setActiveTab] = useState<AssistantTab>("reproduce");

  const hasRepro = !!assistant.reproGuidance;
  const hasRecipe = !!assistant.reproRecipe && (assistant.reproRecipe.setupCommands.length > 0 || !!assistant.reproRecipe.pocScript);
  const hasGaps = assistant.gaps.length > 0 || (assistant.llmTriageGuidance?.missingInfo?.length ?? 0) > 0;
  const hasDontMiss = assistant.dontMiss.length > 0 || (assistant.llmTriageGuidance?.dontMiss?.length ?? 0) > 0;
  const hasFeedback = assistant.reporterFeedback.length > 0 || !!assistant.llmTriageGuidance?.reporterFeedback;

  const tabs: { id: AssistantTab; label: string; icon: React.ReactNode; active: boolean; count?: number }[] = [
    { id: "reproduce", label: "Reproduce", icon: <Crosshair className="w-3.5 h-3.5" />, active: hasRepro },
    { id: "recipe", label: "Recipe", icon: <FlaskConical className="w-3.5 h-3.5" />, active: hasRecipe },
    { id: "gaps", label: "Gaps", icon: <ListChecks className="w-3.5 h-3.5" />, active: hasGaps, count: assistant.gaps.length + (assistant.llmTriageGuidance?.missingInfo?.length ?? 0) },
    { id: "dontmiss", label: "Don't Miss", icon: <Microscope className="w-3.5 h-3.5" />, active: hasDontMiss, count: assistant.dontMiss.length + (assistant.llmTriageGuidance?.dontMiss?.length ?? 0) },
    { id: "feedback", label: "Reporter", icon: <UserCheck className="w-3.5 h-3.5" />, active: hasFeedback },
  ];

  const copyAssistantMarkdown = () => {
    const lines: string[] = ["# Triage Assistant Summary", ""];
    if (assistant.reproGuidance) {
      const rg = assistant.reproGuidance;
      lines.push(`## Reproduction (${rg.vulnClass})`, "");
      rg.steps.forEach(s => lines.push(`${s.order}. ${s.instruction}${s.note ? ` (${s.note})` : ""}`));
      lines.push("", "Environment: " + rg.environment.join(", "), "Tools: " + rg.tools.join(", "), "");
    }
    if (assistant.gaps.length > 0) {
      lines.push("## Gaps", "");
      assistant.gaps.forEach(g => lines.push(`- [${g.severity}] ${g.description} — ${g.suggestion}`));
      lines.push("");
    }
    if (assistant.dontMiss.length > 0) {
      lines.push("## Don't Miss", "");
      assistant.dontMiss.forEach(d => lines.push(`- ${d.area}: ${d.warning}`));
      lines.push("");
    }
    if (assistant.reporterFeedback.length > 0) {
      lines.push("## Reporter Feedback", "");
      assistant.reporterFeedback.forEach(f => lines.push(`- ${f.message}`));
      lines.push("");
    }
    if (assistant.reproRecipe) {
      const rr = assistant.reproRecipe;
      lines.push(`## Reproduction Recipe: ${rr.title}`, "");
      if (rr.target) {
        lines.push(`Target: ${rr.target.name}${rr.target.version ? ` v${rr.target.version}` : ""}${rr.target.source ? ` (${rr.target.source})` : ""}`);
        lines.push("");
      }
      if (rr.setupCommands.length > 0) {
        lines.push("### Setup", "```bash");
        rr.setupCommands.forEach(cmd => lines.push(cmd));
        lines.push("```", "");
      }
      if (rr.pocScript) {
        lines.push(`### PoC Script (${rr.pocLanguage || "bash"})`, `\`\`\`${rr.pocLanguage || "bash"}`);
        lines.push(rr.pocScript);
        lines.push("```", "");
      }
      if (rr.expectedOutput) {
        lines.push("### Expected Output", rr.expectedOutput, "");
      }
      if (rr.dockerfile) {
        lines.push("### Dockerfile", "```dockerfile");
        lines.push(rr.dockerfile);
        lines.push("```", "");
      }
      if (rr.hardware && rr.hardware.length > 0) {
        lines.push("### Hardware Components");
        for (const hw of rr.hardware) {
          lines.push(`- **${hw.vendor}${hw.model ? ` ${hw.model}` : ""}** (${hw.type})`);
          if (hw.productUrl) lines.push(`  Product: ${hw.productUrl}`);
          if (hw.emulationOptions.length > 0) lines.push(`  Emulation: ${hw.emulationOptions[0]}`);
        }
        lines.push("");
      }
      if (rr.notes.length > 0) {
        lines.push("### Notes");
        rr.notes.forEach(n => lines.push(`- ${n}`));
        lines.push("");
      }
    }
    if (assistant.llmTriageGuidance) {
      const ltg = assistant.llmTriageGuidance;
      lines.push("## AI-Assisted Guidance", "");
      if (ltg.reproSteps.length > 0) { lines.push("Steps:"); ltg.reproSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`)); lines.push(""); }
      if (ltg.missingInfo.length > 0) { lines.push("Missing:"); ltg.missingInfo.forEach(s => lines.push(`- ${s}`)); lines.push(""); }
      if (ltg.dontMiss.length > 0) { lines.push("Don't overlook:"); ltg.dontMiss.forEach(s => lines.push(`- ${s}`)); lines.push(""); }
      if (ltg.reporterFeedback) lines.push(`Reporter: ${ltg.reporterFeedback}`, "");
    }
    navigator.clipboard.writeText(lines.join("\n"));
    toast({ title: "Copied", description: "Triage assistant summary copied to clipboard." });
  };

  const severityColor = (s: string) => s === "critical" ? "text-destructive" : s === "important" ? "text-yellow-500" : "text-blue-400";
  const severityBg = (s: string) => s === "critical" ? "bg-destructive/5 border-destructive/15" : s === "important" ? "bg-yellow-500/5 border-yellow-500/15" : "bg-blue-500/5 border-blue-500/15";
  const toneIcon = (t: string) => t === "positive" ? <CheckCircle className="w-4 h-4 text-green-400" /> : t === "concern" ? <AlertTriangle className="w-4 h-4 text-yellow-500" /> : <HelpCircle className="w-4 h-4 text-blue-400" />;

  return (
    <Card className="glass-card rounded-xl border-indigo-500/20">
      <CardHeader className="cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <CardTitle className="flex items-center gap-2">
          <Crosshair className="w-5 h-5 text-indigo-400" />
          Triage Assistant
          {assistant.llmTriageGuidance && (
            <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
              <Brain className="w-2.5 h-2.5" />
              AI Enhanced
            </Badge>
          )}
          <Hint text="Automated triage assistance: reproduction guidance tailored to the detected vulnerability class, gap analysis showing what's missing from the report, don't-miss warnings for common triage pitfalls, and reporter behavior assessment." />
          <span className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); copyAssistantMarkdown(); }}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </span>
        </CardTitle>
        <CardDescription>Reproduction guidance, gap analysis, and reporter assessment</CardDescription>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          <div className="flex rounded-xl overflow-hidden glass-card">
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-all ${
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : tab.active ? "hover:bg-muted/30 text-muted-foreground" : "text-muted-foreground/40 cursor-not-allowed"
                }`}
                disabled={!tab.active}
              >
                {tab.icon}
                {tab.label}
                {tab.count != null && tab.count > 0 && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 ml-0.5">{tab.count}</Badge>
                )}
              </button>
            ))}
          </div>

          {activeTab === "reproduce" && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {assistant.reproGuidance && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className="border-indigo-500/40 text-indigo-400 text-[10px]">
                      {assistant.reproGuidance.vulnClass}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {(assistant.reproGuidance.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <div className="space-y-2">
                    {assistant.reproGuidance.steps.map((step) => (
                      <div key={step.order} className={`flex items-start gap-3 rounded-lg p-3 ${step.source === "llm" ? "border border-cyan-500/15 bg-cyan-500/5" : "glass-card"}`}>
                        <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step.source === "llm" ? "bg-cyan-500/10 border border-cyan-500/30 text-cyan-400" : "bg-indigo-500/10 border border-indigo-500/30 text-indigo-400"}`}>
                          {step.order}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm leading-relaxed flex-1">{step.instruction}</p>
                            {step.source === "llm" && <Brain className="w-3 h-3 text-cyan-400 flex-shrink-0" />}
                          </div>
                          {step.note && <p className="text-[10px] text-muted-foreground mt-1 italic">{step.note}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="glass-card rounded-lg p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Environment</div>
                      <ul className="space-y-1">
                        {assistant.reproGuidance.environment.map((env, i) => (
                          <li key={i} className="text-xs flex items-start gap-1.5"><span className="w-1 h-1 rounded-full bg-indigo-400 mt-1.5 flex-shrink-0" />{env}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="glass-card rounded-lg p-3">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-2">Tools</div>
                      <ul className="space-y-1">
                        {assistant.reproGuidance.tools.map((tool, i) => (
                          <li key={i} className="text-xs flex items-start gap-1.5"><span className="w-1 h-1 rounded-full bg-indigo-400 mt-1.5 flex-shrink-0" />{tool}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
              {assistant.llmTriageGuidance && (assistant.llmTriageGuidance.expectedBehavior || assistant.llmTriageGuidance.testingTips.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {assistant.llmTriageGuidance.expectedBehavior && (
                    <div className="glass-card rounded-lg p-3 border border-cyan-500/15">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-cyan-400 mb-2 flex items-center gap-1.5">
                        <Brain className="w-3 h-3" />Expected Behavior
                      </div>
                      <p className="text-xs leading-relaxed">{assistant.llmTriageGuidance.expectedBehavior}</p>
                    </div>
                  )}
                  {assistant.llmTriageGuidance.testingTips.length > 0 && (
                    <div className="glass-card rounded-lg p-3 border border-cyan-500/15">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-cyan-400 mb-2 flex items-center gap-1.5">
                        <Brain className="w-3 h-3" />Testing Tips
                      </div>
                      <ul className="space-y-1">
                        {assistant.llmTriageGuidance.testingTips.map((tip, i) => (
                          <li key={i} className="text-xs flex items-start gap-1.5"><span className="w-1 h-1 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0" />{tip}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {!assistant.reproGuidance && (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  Could not detect a specific vulnerability class for reproduction guidance.
                </div>
              )}
            </div>
          )}

          {activeTab === "recipe" && assistant.reproRecipe && (
            <RecipeTabContent recipe={assistant.reproRecipe} toast={toast} />
          )}

          {activeTab === "gaps" && (
            <div className="space-y-3 animate-in fade-in duration-200">
              {assistant.gaps.map((gap, i) => (
                <div key={i} className={`rounded-lg border p-3 ${severityBg(gap.severity)}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 uppercase ${severityColor(gap.severity)}`}>{gap.severity}</Badge>
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{gap.category.replace(/_/g, " ")}</span>
                  </div>
                  <p className="text-sm leading-relaxed">{gap.description}</p>
                  {gap.triagerGuidance && (
                    <div className="mt-2 rounded border border-blue-500/15 bg-blue-500/5 px-2.5 py-1.5">
                      <span className="text-[10px] font-bold uppercase text-blue-400 tracking-wide">For Triager</span>
                      <p className="text-xs text-blue-300/80 mt-0.5">{gap.triagerGuidance}</p>
                    </div>
                  )}
                  {gap.reporterGuidance && (
                    <div className="mt-1.5 rounded border border-amber-500/15 bg-amber-500/5 px-2.5 py-1.5">
                      <span className="text-[10px] font-bold uppercase text-amber-400 tracking-wide">For Reporter</span>
                      <p className="text-xs text-amber-300/80 mt-0.5">{gap.reporterGuidance}</p>
                    </div>
                  )}
                </div>
              ))}
              {assistant.llmTriageGuidance && assistant.llmTriageGuidance.missingInfo.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Brain className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-bold text-cyan-400">AI-Detected Missing Information</span>
                  </div>
                  {assistant.llmTriageGuidance.missingInfo.map((info, i) => (
                    <div key={i} className="rounded-lg border border-cyan-500/15 bg-cyan-500/5 p-3 text-sm leading-relaxed">{info}</div>
                  ))}
                </div>
              )}
              {assistant.gaps.length === 0 && !(assistant.llmTriageGuidance?.missingInfo?.length) && (
                <div className="flex flex-col items-center py-6 text-center">
                  <CheckCircle className="w-8 h-8 text-green-400 mb-2" />
                  <span className="text-sm font-medium">No significant gaps detected</span>
                  <span className="text-xs text-muted-foreground">The report appears to contain the essential elements</span>
                </div>
              )}
            </div>
          )}

          {activeTab === "dontmiss" && (
            <div className="space-y-3 animate-in fade-in duration-200">
              {assistant.dontMiss.map((item, i) => (
                <div key={i} className="rounded-lg border border-orange-500/15 bg-orange-500/5 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />
                    <span className="text-sm font-medium">{item.area}</span>
                  </div>
                  <p className="text-sm leading-relaxed">{item.warning}</p>
                  <p className="text-xs text-muted-foreground mt-1.5">{item.reason}</p>
                </div>
              ))}
              {assistant.llmTriageGuidance && assistant.llmTriageGuidance.dontMiss.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Brain className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-xs font-bold text-cyan-400">AI Warnings</span>
                  </div>
                  {assistant.llmTriageGuidance.dontMiss.map((warning, i) => (
                    <div key={i} className="rounded-lg border border-cyan-500/15 bg-cyan-500/5 p-3 text-sm leading-relaxed">{warning}</div>
                  ))}
                </div>
              )}
              {assistant.dontMiss.length === 0 && !(assistant.llmTriageGuidance?.dontMiss?.length) && (
                <div className="text-center py-6 text-muted-foreground text-sm">No specific warnings for this report.</div>
              )}
            </div>
          )}

          {activeTab === "feedback" && (
            <div className="space-y-3 animate-in fade-in duration-200">
              {assistant.reporterFeedbackSummary && (
                <div className="rounded-lg border border-muted/30 bg-muted/10 p-3 flex items-center gap-4">
                  <div className="text-center">
                    <div className={`text-xl font-bold ${
                      assistant.reporterFeedbackSummary.clarityScore >= 70 ? "text-green-400" :
                      assistant.reporterFeedbackSummary.clarityScore >= 40 ? "text-yellow-400" :
                      "text-red-400"
                    }`}>{assistant.reporterFeedbackSummary.clarityScore}</div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Clarity</div>
                  </div>
                  <div className="h-8 w-px bg-muted/30" />
                  <div className="text-center">
                    <Badge variant="outline" className={`text-[10px] px-2 py-0.5 ${
                      assistant.reporterFeedbackSummary.actionability === "high" ? "border-green-500/30 text-green-400" :
                      assistant.reporterFeedbackSummary.actionability === "medium" ? "border-yellow-500/30 text-yellow-400" :
                      "border-red-500/30 text-red-400"
                    }`}>{assistant.reporterFeedbackSummary.actionability} actionability</Badge>
                  </div>
                </div>
              )}
              {assistant.reporterFeedback.map((fb, i) => (
                <div key={i} className={`rounded-lg border p-3 flex items-start gap-3 ${
                  fb.tone === "positive" ? "bg-green-500/5 border-green-500/15" :
                  fb.tone === "concern" ? "bg-yellow-500/5 border-yellow-500/15" :
                  "bg-blue-500/5 border-blue-500/15"
                }`}>
                  {toneIcon(fb.tone)}
                  <p className="text-sm leading-relaxed">{fb.message}</p>
                </div>
              ))}
              {assistant.llmTriageGuidance?.reporterFeedback && (
                <div className="rounded-lg border border-cyan-500/15 bg-cyan-500/5 p-3 flex items-start gap-3">
                  <Brain className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
                  <p className="text-sm leading-relaxed">{assistant.llmTriageGuidance.reporterFeedback}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
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

  const loadDiagnosticsForExport = async (): Promise<DiagnosticsResponse | null> => {
    try {
      return await fetchDiagnostics(id);
    } catch (err) {
      toast({
        title: "Diagnostics unavailable",
        description: err instanceof Error ? err.message : "Could not load pipeline diagnostics; export will omit them.",
        variant: "destructive",
      });
      return null;
    }
  };

  const exportJSON = async () => {
    if (!report) return;
    const diagnostics = await loadDiagnosticsForExport();
    const payload = { ...report, diagnostics };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vulnrap-report-${anonymizeId(id)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({
      title: "Exported",
      description: diagnostics ? "JSON report downloaded with diagnostics." : "JSON report downloaded (diagnostics omitted).",
    });
  };

  const exportText = async () => {
    if (!report) return;
    const bd = report.breakdown as { linguistic?: number; factual?: number; template?: number; llm?: number | null; quality?: number } | undefined;
    const ev = report.evidence as Array<{ type: string; description: string; weight: number; matched?: string | null }> | undefined;
    const llmBd = report.llmBreakdown as { claimSpecificity?: number; evidenceQuality?: number; internalConsistency?: number; hallucinationSignals?: number; validityScore?: number; verdict?: string; specificity?: number; originality?: number; voice?: number; coherence?: number; hallucination?: number } | undefined;
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
      lines.push(`LLM VALIDITY ASSESSMENT:`);
      if (llmBd.claimSpecificity != null) {
        lines.push(`  Claim Specificity: ${llmBd.claimSpecificity}/25`);
        lines.push(`  Evidence Quality: ${llmBd.evidenceQuality ?? "N/A"}/25`);
        lines.push(`  Internal Consistency: ${llmBd.internalConsistency ?? "N/A"}/25`);
        lines.push(`  Hallucination Signals: ${llmBd.hallucinationSignals ?? "N/A"}/25`);
        if (llmBd.validityScore != null) lines.push(`  Overall Validity: ${llmBd.validityScore}/100`);
        if (llmBd.verdict) lines.push(`  Verdict: ${llmBd.verdict}`);
      } else {
        if (llmBd.specificity != null) lines.push(`  Specificity: ${llmBd.specificity}/100`);
        if (llmBd.originality != null) lines.push(`  Originality: ${llmBd.originality}/100`);
        if (llmBd.voice != null) lines.push(`  Voice: ${llmBd.voice}/100`);
        if (llmBd.coherence != null) lines.push(`  Coherence: ${llmBd.coherence}/100`);
        if (llmBd.hallucination != null) lines.push(`  Hallucination: ${llmBd.hallucination}/100`);
      }
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
    const diagnostics = await loadDiagnosticsForExport();
    if (diagnostics) {
      lines.push(`PIPELINE DIAGNOSTICS:`);
      lines.push(buildMarkdownSummary(diagnostics));
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
  const triageAssistant = report.triageAssistant as TriageAssistant | null | undefined;
  const triageChecks = activeVerification?.checks ?? [];
  const triageSummary = activeVerification?.summary;
  const challengeQuestions = triage?.challengeQuestions ?? [];
  const temporalSignals = triage?.temporalSignals ?? [];
  const templateMatch = triage?.templateMatch ?? null;
  const revisionInfo = triage?.revision ?? null;
  const llmBreakdown = report.llmBreakdown as { claimSpecificity?: number; evidenceQuality?: number; internalConsistency?: number; hallucinationSignals?: number; validityScore?: number; verdict?: string; redFlags?: string[]; greenFlags?: string[]; specificity?: number; originality?: number; voice?: number; coherence?: number; hallucination?: number } | undefined;
  const humanIndicators = (report.humanIndicators ?? []) as Array<{ type: string; description: string; weight: number; matched?: string | null }>;
  const qualityScore = report.qualityScore as number | undefined;
  const vulnrap = (report as { vulnrap?: VulnrapPanelData | null }).vulnrap ?? null;
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

      {(report.llmUsed === false || report.redactionApplied === false) && (
        <div className="flex flex-col sm:flex-row gap-2">
          {report.llmUsed === false && (
            <div className="flex-1 rounded-lg bg-violet-500/10 border border-violet-500/30 px-3 py-2 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4 text-violet-400 flex-shrink-0" />
              <p className="text-xs text-violet-300">
                <strong>Analysis: heuristic only</strong> — AI analysis was disabled for this report. Scoring is based on local heuristic and statistical signals only.
              </p>
            </div>
          )}
          {report.redactionApplied === false && (
            <div className="flex-1 rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-2 flex items-center gap-2">
              <ShieldOff className="w-4 h-4 text-orange-400 flex-shrink-0" />
              <p className="text-xs text-orange-300">
                <strong>PII redaction was disabled</strong> — report text was not sanitized for personally identifiable information before analysis.
              </p>
            </div>
          )}
        </div>
      )}

      {vulnrap && vulnrap.engines && vulnrap.engines.length > 0 && (
        <Card className={`glass-card-accent rounded-xl ${vulnrap.reconstructed ? "border-amber-500/50" : "border-primary/40"}`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <Layers className="w-6 h-6 text-primary" />
              <span className="text-base">VulnRap Multi-Engine Consensus</span>
              <Badge variant="outline" className={`text-[11px] px-2 py-0.5 h-6 font-mono ${VULNRAP_LABEL_COLOR[vulnrap.label] || "text-muted-foreground"}`}>
                {vulnrap.label}
              </Badge>
              {vulnrap.reconstructed && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-2 py-0.5 h-6 font-mono uppercase tracking-wide text-amber-300 border-amber-500/50 bg-amber-500/10 flex items-center gap-1"
                  data-testid="badge-vulnrap-reconstructed"
                >
                  <AlertTriangle className="w-3 h-3" />
                  Reconstructed · approximate
                  <Hint text="Composite was rebuilt from cached v3.5.0 signals (slop / validity / quality / evidence list) because the original report text was not retained. CWE coherence is neutralized to 50, perplexity is unavailable, and per-engine confidence is LOW. Treat the score as approximate." />
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Three independent engines (AI Authorship 5%, Technical Substance 55%, CWE Coherence 40%) score this report. Higher composite = stronger evidence of a real, reproducible issue.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {vulnrap.reconstructed && (
              <div
                className="rounded-lg bg-amber-500/10 border border-amber-500/40 px-3 py-2 flex items-start gap-2"
                data-testid="banner-vulnrap-reconstructed"
              >
                <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-200/90 leading-relaxed">
                  <strong className="text-amber-300">Reconstructed from cached signals.</strong>{" "}
                  This report was analyzed before raw text was retained, so the composite was rebuilt from cached v3.5.0 signals
                  (slop, validity, quality, and the evidence list) rather than a fresh pipeline run. CWE coherence is neutralized
                  at 50, no perplexity is available, and per-engine confidence is <span className="font-mono">LOW</span>.
                  Triage decisions based on this score should be treated as approximate.
                </div>
              </div>
            )}
            <div className="flex flex-col items-center justify-center py-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Composite Score</div>
              <div className={`text-7xl font-bold font-mono tracking-tighter glow-text ${vulnrap.compositeScore <= 35 ? "text-red-400" : vulnrap.compositeScore <= 50 ? "text-orange-400" : vulnrap.compositeScore <= 65 ? "text-yellow-400" : vulnrap.compositeScore <= 80 ? "text-emerald-400" : "text-green-400"}`}>
                {vulnrap.compositeScore}
              </div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">/ 100</div>
            </div>
            <div className="space-y-3">
              {vulnrap.engines.map((eng) => (
                <div key={eng.engine} className="glass-card rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold truncate">{eng.engine}</span>
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 font-mono ${eng.verdict === "RED" ? "text-red-400 border-red-500/40" : eng.verdict === "YELLOW" ? "text-yellow-400 border-yellow-500/40" : eng.verdict === "GREEN" ? "text-green-400 border-green-500/40" : "text-muted-foreground"}`}>
                        {eng.verdict}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">conf: {eng.confidence}</span>
                    </div>
                    <span className="font-mono text-sm font-bold">{eng.score}</span>
                  </div>
                  <Progress value={eng.score} className="h-1.5" indicatorClassName={VULNRAP_VERDICT_COLOR[eng.verdict] || "bg-muted"} />
                  {eng.note && <p className="text-[11px] text-muted-foreground leading-relaxed">{eng.note}</p>}
                  {eng.triggeredIndicators && eng.triggeredIndicators.length > 0 && (
                    <div className="space-y-1 pt-1">
                      {eng.triggeredIndicators.slice(0, 4).map((ind, i) => (
                        <div key={i} className="flex items-start gap-2 text-[11px]">
                          <Badge variant="outline" className={`text-[9px] px-1 py-0 h-3.5 font-mono shrink-0 ${ind.strength === "HIGH" ? "text-red-400 border-red-500/40" : ind.strength === "MEDIUM" ? "text-yellow-400 border-yellow-500/40" : "text-muted-foreground"}`}>
                            {ind.signal}
                          </Badge>
                          <span className="text-muted-foreground leading-snug">{ind.explanation}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {vulnrap.overridesApplied && vulnrap.overridesApplied.length > 0 && (
              <>
                <Separator className="bg-border/30" />
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">Composite Overrides Applied</div>
                  {vulnrap.overridesApplied.map((rule, i) => (
                    <div key={i} className="text-[11px] font-mono text-orange-400/90">· {rule}</div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {vulnrap && <DiagnosticsPanel reportId={report.id} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 glass-card rounded-xl opacity-90">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-muted-foreground/30 text-muted-foreground/70 normal-case">Legacy v4 (supplementary)</Badge>
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
                <div className={`text-3xl font-bold font-mono tracking-tighter ${slopColor}`}>
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
                    <div className={`text-3xl font-bold font-mono tracking-tighter ${getQualityColor(qualityScore)}`}>
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
              <div className="mt-4">
                <ConfidenceGauge value={confidence} size={130} label="Analysis Confidence" />
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
              LLM Validity Assessment
              <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                <Brain className="w-2.5 h-2.5" />
                LLM Enhanced
              </Badge>
              <Hint text="Four substance criteria evaluated by the LLM: Claim Specificity, Evidence Quality, Internal Consistency, and Hallucination Signals. Each scored 0-25. Higher = more credible report." />
            </CardTitle>
            <CardDescription>Per-criterion LLM validity analysis</CardDescription>
          </CardHeader>
          <CardContent>
            {llmBreakdown.claimSpecificity != null ? (
              <div className="flex flex-col md:flex-row items-center gap-6">
                <div className="flex-shrink-0">
                  <RadarChart
                    data={[
                      { label: "Claim Specificity", value: (llmBreakdown.claimSpecificity ?? 0) * 4, max: 100 },
                      { label: "Evidence Quality", value: (llmBreakdown.evidenceQuality ?? 0) * 4, max: 100 },
                      { label: "Consistency", value: (llmBreakdown.internalConsistency ?? 0) * 4, max: 100 },
                      { label: "Hallucination", value: (llmBreakdown.hallucinationSignals ?? 0) * 4, max: 100 },
                    ]}
                    size={220}
                  />
                </div>
                <div className="flex-1 w-full space-y-3">
                  <LlmDimensionBar label="Claim Specificity" score={(llmBreakdown.claimSpecificity ?? 0) * 4} />
                  <LlmDimensionBar label="Evidence Quality" score={(llmBreakdown.evidenceQuality ?? 0) * 4} />
                  <LlmDimensionBar label="Internal Consistency" score={(llmBreakdown.internalConsistency ?? 0) * 4} />
                  <LlmDimensionBar label="Hallucination Signals" score={(llmBreakdown.hallucinationSignals ?? 0) * 4} />
                  {llmBreakdown.validityScore != null && (
                    <div className="pt-2 border-t border-white/5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Overall Validity</span>
                        <span className={`font-mono font-bold ${llmBreakdown.validityScore >= 70 ? "text-green-400" : llmBreakdown.validityScore >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                          {llmBreakdown.validityScore}/100
                        </span>
                      </div>
                      {llmBreakdown.verdict && (
                        <span className={`text-[10px] font-mono ${llmBreakdown.verdict === "LIKELY_VALID" ? "text-green-400" : llmBreakdown.verdict === "UNCERTAIN" ? "text-yellow-400" : "text-red-400"}`}>
                          {llmBreakdown.verdict.replace(/_/g, " ")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row items-center gap-6">
                <div className="flex-shrink-0">
                  <RadarChart
                    data={[
                      { label: "Specificity", value: llmBreakdown.specificity ?? 0, max: 100 },
                      { label: "Originality", value: llmBreakdown.originality ?? 0, max: 100 },
                      { label: "Voice", value: llmBreakdown.voice ?? 0, max: 100 },
                      { label: "Coherence", value: llmBreakdown.coherence ?? 0, max: 100 },
                      { label: "Hallucination", value: llmBreakdown.hallucination ?? 0, max: 100 },
                    ]}
                    size={220}
                  />
                </div>
                <div className="flex-1 w-full space-y-3">
                  {llmBreakdown.specificity != null && <LlmDimensionBar label="Specificity" score={llmBreakdown.specificity} />}
                  {llmBreakdown.originality != null && <LlmDimensionBar label="Originality" score={llmBreakdown.originality} />}
                  {llmBreakdown.voice != null && <LlmDimensionBar label="Voice" score={llmBreakdown.voice} />}
                  {llmBreakdown.coherence != null && <LlmDimensionBar label="Coherence" score={llmBreakdown.coherence} />}
                  {llmBreakdown.hallucination != null && <LlmDimensionBar label="Hallucination" score={llmBreakdown.hallucination} />}
                </div>
              </div>
            )}
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

      {triageAssistant && (
        <TriageAssistantPanel assistant={triageAssistant} toast={toast} />
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
                        className="h-6 w-6 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
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
              <Hint text="Semantic observations from the LLM analyzer, evaluating reports from a PSIRT triage perspective. Assesses claim specificity, evidence quality, internal consistency, and hallucination signals." />
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
        <HighlightedReport
          text={report.redactedText}
          evidence={evidence ?? []}
          humanIndicators={humanIndicators}
          typeLabels={EVIDENCE_TYPE_LABELS}
        />
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
