import { useState, useRef } from "react";
import { UploadCloud, Shield, Loader2, CheckCircle, XCircle, Search, AlertTriangle, ClipboardPaste, Hash, Layers, Lightbulb, ShieldCheck, HelpCircle, ExternalLink, Link2, BarChart3, Target, Brain, Cpu, FileText, Eye, Gauge, AlertCircle, ChevronDown, ChevronUp, Leaf, MessageSquareWarning, Copy, RefreshCw, Fingerprint, Timer, Crosshair, ListChecks, Microscope, UserCheck, BrainCircuit, ShieldOff, Zap } from "lucide-react";
import { useCheckReport, type Verification, type VerificationCheck, type VerificationSummary, type TriageRecommendation, type ChallengeQuestion, type TemporalSignal, type TemplateMatch, type RevisionResult, type CheckReportBody, type TriageAssistant, type GapItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, anonymizeId } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";
import { addHistoryEntry } from "@/lib/history";
import { getSettings, saveSettings, getSlopColorCustom, getSlopProgressColorCustom, adjustScore, adjustTier, SENSITIVITY_PRESETS, type SensitivityPreset } from "@/lib/settings";
import { AnalysisStepper } from "@/components/analysis-stepper";
import { ConfidenceGauge } from "@/components/confidence-gauge";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md"];

type InputMode = "file" | "text" | "link";

function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(e => ext.endsWith(e));
  if (!hasValidExt) return `Unsupported file type. Accepted formats: ${ALLOWED_EXTENSIONS.join(", ")}`;
  if (file.size > MAX_FILE_SIZE) return `File too large. Maximum size is 5MB.`;
  if (file.size === 0) return "File is empty.";
  return null;
}

function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
      <TooltipTrigger
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="More info"
        className="inline-flex ml-1 cursor-help"
      >
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        collisionPadding={12}
        className="w-56 glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function getSlopColor(score: number) {
  const s = getSettings();
  return getSlopColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function getSlopProgressColor(score: number) {
  const s = getSettings();
  return getSlopProgressColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function getQualityColor(score: number) {
  if (score >= 70) return "text-green-500";
  if (score >= 40) return "text-yellow-500";
  return "text-destructive";
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

function CheckVerificationPanel({ checks, summary }: { checks: VerificationCheck[]; summary?: VerificationSummary }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card className="glass-card rounded-xl">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Shield className="w-4 h-4 text-primary" />
          Active Verification
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{checks.length} checks</Badge>
          <span className="ml-auto">{expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}</span>
        </CardTitle>
        <CardDescription className="text-xs">Live verification of referenced files, CVEs, and resources</CardDescription>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2">
          {summary && (
            <div className="flex items-center gap-3 mb-2 text-xs">
              {(summary.verified ?? 0) > 0 && <span className="flex items-center gap-1 text-green-400"><CheckCircle className="w-3 h-3" />{summary.verified} verified</span>}
              {(summary.notFound ?? 0) > 0 && <span className="flex items-center gap-1 text-destructive"><AlertCircle className="w-3 h-3" />{summary.notFound} not found</span>}
              {(summary.warnings ?? 0) > 0 && <span className="flex items-center gap-1 text-yellow-500"><AlertTriangle className="w-3 h-3" />{summary.warnings} warnings</span>}
            </div>
          )}
          {checks.map((check, i) => (
            <div key={i} className={`rounded-lg border p-2.5 flex items-start gap-2.5 ${
              check.result === "verified" ? "bg-green-500/5 border-green-500/15" :
              check.result === "not_found" ? "bg-destructive/5 border-destructive/15" :
              "bg-yellow-500/5 border-yellow-500/15"
            }`}>
              {check.result === "verified"
                ? <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" />
                : check.result === "not_found"
                  ? <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0 mt-0.5" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />}
              <div className="min-w-0 flex-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{check.type.replace(/_/g, " ")}</span>
                <p className="text-xs leading-relaxed">{check.detail}</p>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function CheckScoreContent({ result, sensitivity, onSensitivityChange }: {
  result: CheckResultData;
  sensitivity: SensitivityPreset;
  onSensitivityChange: (preset: SensitivityPreset) => void;
}) {
  const settings = getSettings();
  const isAdj = sensitivity !== "balanced";
  const adjScore = adjustScore(result.slopScore, sensitivity, result.breakdown, result.humanIndicators);
  const dispScore = isAdj ? adjScore : result.slopScore;
  const dispTier = isAdj ? adjustTier(adjScore, settings.slopThresholdLow, settings.slopThresholdHigh) : result.slopTier;

  return (
    <CardContent className="flex flex-col items-center py-4">
      <div className="flex items-center justify-center gap-1 mb-3">
        {(Object.entries(SENSITIVITY_PRESETS) as [SensitivityPreset, { label: string; description: string }][]).map(([key, preset]) => (
          <button
            key={key}
            type="button"
            onClick={() => onSensitivityChange(key)}
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
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-center">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Slop</div>
          <div className={`text-4xl font-bold font-mono ${getSlopColor(dispScore)} glow-text`}>{dispScore}</div>
          <div className="mt-1 text-xs font-medium uppercase">{dispTier}</div>
          {isAdj && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              canonical: {result.slopScore} ({result.slopTier})
            </div>
          )}
        </div>
        {result.qualityScore != null && (
          <>
            <div className="h-14 w-px bg-border/30" />
            <div className="flex flex-col items-center">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Quality</div>
              <div className={`text-4xl font-bold font-mono ${getQualityColor(result.qualityScore)} glow-text`}>{result.qualityScore}</div>
              <div className="mt-1 text-xs font-medium uppercase text-muted-foreground">
                {result.qualityScore >= 70 ? "Good" : result.qualityScore >= 40 ? "Fair" : "Poor"}
              </div>
            </div>
          </>
        )}
      </div>
      {result.confidence != null && (
        <div className="mt-3">
          <ConfidenceGauge value={result.confidence} size={110} label="Confidence" />
        </div>
      )}
      <div className="w-full max-w-xs mt-3">
        <Progress value={dispScore} className="h-2" indicatorClassName={getSlopProgressColor(dispScore)} />
      </div>
    </CardContent>
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

const REDACTION_LABELS: Record<string, string> = {
  email: "Email Addresses", ipv4: "IPv4 Addresses", ipv6: "IPv6 Addresses",
  api_key: "API Keys", bearer_token: "Bearer Tokens", jwt: "JWT Tokens",
  aws_key: "AWS Keys", private_key: "Private Keys", password: "Passwords",
  connection_string: "Connection Strings", url_with_creds: "URLs with Credentials",
  hex_secret: "Hex Secrets", uuid: "UUIDs", phone: "Phone Numbers",
  ssn: "SSNs", credit_card: "Credit Cards", internal_hostname: "Internal Hostnames",
  internal_url: "Internal URLs", company_name: "Company Names", username: "Usernames",
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

interface CheckResultData {
  slopScore: number;
  slopTier: string;
  qualityScore?: number;
  confidence?: number;
  breakdown?: { linguistic?: number; factual?: number; template?: number; llm?: number | null; quality?: number };
  evidence?: Array<{ type: string; description: string; weight: number; matched?: string | null }>;
  humanIndicators?: Array<{ type: string; description: string; weight: number; matched?: string | null }>;
  llmBreakdown?: { claimSpecificity?: number; evidenceQuality?: number; internalConsistency?: number; hallucinationSignals?: number; validityScore?: number; verdict?: string; redFlags?: string[]; greenFlags?: string[]; specificity?: number; originality?: number; voice?: number; coherence?: number; hallucination?: number };
  llmEnhanced?: boolean;
  llmUsed?: boolean;
  redactionApplied?: boolean;
  similarityMatches: Array<{ reportId: number; similarity: number; matchType: string }>;
  sectionHashes: Record<string, string>;
  sectionMatches: Array<{ sectionTitle: string; matchedReportId: number; matchedSectionTitle: string; similarity: number }>;
  redactionSummary: { totalRedactions: number; categories: Record<string, number> };
  feedback: string[];
  previouslySubmitted: boolean;
  existingReportId?: number | null;
  verification?: Verification;
  triageRecommendation?: TriageRecommendation;
  triageAssistant?: TriageAssistant;
}

export default function Check() {
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [skipLlm, setSkipLlm] = useState(false);
  const [skipRedaction, setSkipRedaction] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<CheckResultData | null>(null);
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [sensitivity, setSensitivity] = useState<SensitivityPreset>(() => getSettings().sensitivityPreset);
  const handleSensitivityChange = (preset: SensitivityPreset) => {
    setSensitivity(preset);
    saveSettings({ sensitivityPreset: preset });
  };

  const checkMutation = useCheckReport({
    mutation: {
      onSuccess: (data) => {
        const r = data as unknown as CheckResultData;
        setResult(r);
        const checkId = Date.now();
        addHistoryEntry({
          id: checkId,
          reportCode: r.existingReportId ? anonymizeId(r.existingReportId) : `CHK-${checkId.toString(16).slice(-4).toUpperCase()}`,
          slopScore: r.slopScore,
          slopTier: r.slopTier,
          matchCount: r.similarityMatches?.length || 0,
          contentMode: "check",
          fileName: inputMode === "file" && file ? file.name : null,
          timestamp: new Date().toISOString(),
          type: "check",
        });
        toast({ title: "Check complete", description: "Report analyzed against our database." });
      },
      onError: (err: unknown) => {
        let message = "An error occurred.";
        if (err && typeof err === "object") {
          const e = err as Record<string, unknown>;
          if ("data" in e && e.data && typeof e.data === "object" && "error" in (e.data as Record<string, unknown>)) {
            message = String((e.data as Record<string, unknown>).error);
          } else if ("message" in e && typeof e.message === "string") {
            message = e.message;
          }
        }
        toast({ title: "Check failed", description: message, variant: "destructive" });
      },
    },
  });

  const handleSubmit = () => {
    if (inputMode === "file") {
      if (!file) {
        toast({ title: "No file", description: "Please select a file first.", variant: "destructive" });
        return;
      }
      const error = validateFile(file);
      if (error) { setFileError(error); return; }
      checkMutation.mutate({ data: { file, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } });
    } else if (inputMode === "link") {
      const trimmedUrl = reportUrl.trim();
      if (!trimmedUrl) {
        toast({ title: "No URL entered", description: "Please enter a link to a report.", variant: "destructive" });
        return;
      }
      try { new URL(trimmedUrl); } catch {
        toast({ title: "Invalid URL", description: "Please enter a valid HTTPS URL.", variant: "destructive" });
        return;
      }
      checkMutation.mutate({ data: { reportUrl: trimmedUrl, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } as CheckReportBody });
    } else {
      const trimmed = rawText.trim();
      if (!trimmed) {
        toast({ title: "No text", description: "Please paste report text first.", variant: "destructive" });
        return;
      }
      checkMutation.mutate({ data: { rawText: trimmed, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } });
    }
  };

  const hasContent = inputMode === "file" ? !!file : inputMode === "link" ? reportUrl.trim().length > 0 : rawText.trim().length > 0;

  const visibleEvidence = result?.evidence && result.evidence.length > 0
    ? (showAllEvidence ? result.evidence : result.evidence.slice(0, 5))
    : [];

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Shield className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Check a Report
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          For report receivers. Check an incoming report against our database for duplicates and AI content. Nothing is stored.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            Paste, Upload, or Link the Report
            <Hint text="This check runs the full analysis pipeline (redaction, similarity, slop scoring) but does NOT store the report in our database. Use this to validate incoming reports without contributing to the corpus." />
          </CardTitle>
          <CardDescription>Auto-redacted during analysis, then discarded -- nothing is saved</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 sm:space-y-6">
          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-3 sm:px-4 py-2.5 sm:py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-yellow-500">Pre-sanitize if you can.</strong> Auto-redaction catches most PII and secrets, but it's regex-based. Redact sensitive details yourself before pasting.
          </div>
          <div className="flex rounded-xl overflow-hidden glass-card">
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all",
                inputMode === "text" ? "bg-primary text-primary-foreground glow-button" : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => setInputMode("text")}
            >
              <ClipboardPaste className="w-4 h-4 shrink-0" />
              Paste
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "file" ? "bg-primary text-primary-foreground glow-button" : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => setInputMode("file")}
            >
              <UploadCloud className="w-4 h-4 shrink-0" />
              File
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "link" ? "bg-primary text-primary-foreground glow-button" : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => setInputMode("link")}
            >
              <Link2 className="w-4 h-4 shrink-0" />
              Link
            </button>
          </div>

          {inputMode === "text" ? (
            <div className="space-y-2">
              <textarea
                className="w-full h-48 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
                placeholder="Paste the vulnerability report text here...&#10;&#10;Plain text only. Content is analyzed but never stored."
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <div className="flex justify-between items-center text-xs text-muted-foreground">
                <span>{rawText.length > 0 ? `${rawText.length.toLocaleString()} characters` : "No text entered"}</span>
                {rawText.length > 0 && (
                  <button type="button" className="text-xs hover:text-destructive transition-colors" onClick={() => setRawText("")}>
                    Clear
                  </button>
                )}
              </div>
            </div>
          ) : inputMode === "link" ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <input
                  type="url"
                  className="w-full rounded-xl glass-card px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
                  placeholder="https://github.com/user/repo/blob/main/report.md"
                  value={reportUrl}
                  onChange={(e) => setReportUrl(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                {reportUrl.trim().length > 0 && (
                  <div className="flex justify-end">
                    <button type="button" className="text-xs text-muted-foreground hover:text-destructive transition-colors" onClick={() => setReportUrl("")}>
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <div className="rounded-lg bg-muted/30 px-4 py-3 text-xs text-muted-foreground leading-relaxed space-y-1.5">
                <p className="font-medium text-foreground/80">Supported sources:</p>
                <p>GitHub (blob URLs auto-converted to raw), GitHub Gists, GitLab, Pastebin, dpaste, hastebin, paste.debian.net</p>
                <p>HTTPS only — max 5MB. The URL must point to plain text, not an HTML page.</p>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "border-2 border-dashed rounded-xl p-6 sm:p-10 flex flex-col items-center justify-center gap-3 transition-all cursor-pointer",
                isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/20 hover:border-primary/40",
                file && !fileError ? "border-primary/40 bg-primary/5" : "",
                fileError ? "border-destructive bg-destructive/5" : ""
              )}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files?.[0]) { const f = e.dataTransfer.files[0]; const err = validateFile(f); if (err) { setFileError(err); setFile(null); } else { setFile(f); setFileError(null); } } }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
            >
              <input type="file" ref={fileInputRef} className="hidden" accept=".txt,.md" onChange={(e) => { if (e.target.files?.[0]) { const f = e.target.files[0]; const err = validateFile(f); if (err) { setFileError(err); setFile(null); } else { setFile(f); setFileError(null); } } }} />
              {file ? (
                <>
                  <UploadCloud className="w-8 h-8 text-primary" />
                  <span className="font-medium">{file.name}</span>
                  <span className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</span>
                </>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-muted-foreground" />
                  <span className="font-medium">Drop a file here or click to browse</span>
                  <span className="text-xs text-muted-foreground">.txt, .md (max 5MB)</span>
                </>
              )}
              {fileError && <span className="text-xs text-destructive">{fileError}</span>}
            </div>
          )}
          <div className="space-y-3 px-4 sm:px-6 pb-2">
            <h3 className="font-medium flex items-center gap-2 text-sm">
              <Zap className="w-4 h-4 text-primary" />
              Analysis Options
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className={`flex items-start gap-3 p-3 rounded-lg border border-border transition-colors ${skipRedaction ? "opacity-60 cursor-not-allowed" : "hover:border-primary/30 cursor-pointer"} group`}>
                <input
                  type="checkbox"
                  checked={skipLlm}
                  onChange={(e) => setSkipLlm(e.target.checked)}
                  disabled={skipRedaction}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-llm"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5" />
                    Skip AI analysis
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {skipRedaction
                      ? "Locked on — AI analysis is disabled when PII redaction is off."
                      : "Heuristic and statistical scoring only. No data sent to any external AI provider."}
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer group">
                <input
                  type="checkbox"
                  checked={skipRedaction}
                  onChange={(e) => { setSkipRedaction(e.target.checked); if (e.target.checked) setSkipLlm(true); }}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-redaction"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <ShieldOff className="w-3.5 h-3.5" />
                    Disable PII redaction
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Skip PII auto-redaction. AI analysis is automatically disabled when redaction is off.
                  </p>
                </div>
              </label>
            </div>
            {skipRedaction && (
              <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-2 flex items-start gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-500 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-orange-300 leading-relaxed">
                  <strong>Warning:</strong> PII, secrets, and company names in your report will <strong>not</strong> be removed.
                </p>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button
            className="w-full h-11 sm:h-12 text-base sm:text-lg font-bold gap-2 glow-button"
            onClick={handleSubmit}
            disabled={!hasContent || checkMutation.isPending}
          >
            {checkMutation.isPending ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Checking...</>
            ) : (
              <><Search className="w-5 h-5" /> Check Report</>
            )}
          </Button>
        </CardFooter>
      </Card>

      <AnalysisStepper isActive={checkMutation.isPending} mode="check" className="my-4" />

      {result && (
        <div className="space-y-6">
          <h2 className="text-lg sm:text-xl font-bold uppercase tracking-tight flex items-center gap-2 flex-wrap">
            <CheckCircle className="w-5 h-5 sm:w-6 sm:h-6 text-primary shrink-0" />
            Check Results
            <Badge variant="outline" className="text-[10px] sm:text-xs">Not stored</Badge>
          </h2>

          {(result.llmUsed === false || result.redactionApplied === false) && (
            <div className="flex flex-col sm:flex-row gap-2">
              {result.llmUsed === false && (
                <div className="flex-1 rounded-lg bg-violet-500/10 border border-violet-500/30 px-3 py-2 flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-violet-400 flex-shrink-0" />
                  <p className="text-xs text-violet-300">
                    <strong>Analysis: heuristic only</strong> — AI analysis was disabled.
                  </p>
                </div>
              )}
              {result.redactionApplied === false && (
                <div className="flex-1 rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-2 flex items-center gap-2">
                  <ShieldOff className="w-4 h-4 text-orange-400 flex-shrink-0" />
                  <p className="text-xs text-orange-300">
                    <strong>PII redaction was disabled</strong> — report text was not sanitized.
                  </p>
                </div>
              )}
            </div>
          )}

          {result.previouslySubmitted && (
            <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 glass-card">
              <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0" />
              <div>
                <div className="font-medium text-sm">Previously Submitted</div>
                <div className="text-xs text-muted-foreground">
                  This exact report has been submitted before
                  {result.existingReportId && (
                    <> as <Link to={`/verify/${result.existingReportId}`} className="text-primary hover:underline inline-flex items-center gap-1">{anonymizeId(result.existingReportId)} <ExternalLink className="w-3 h-3" /></Link></>
                  )}.
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="glass-card-accent rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                  AI Detection
                  {result.llmEnhanced ? (
                    <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 normal-case">LLM</Badge>
                  ) : (
                    <Badge variant="outline" className="border-violet-500/40 text-violet-400/70 text-[10px] px-1.5 py-0 h-4 normal-case">Heuristic</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CheckScoreContent result={result} sensitivity={sensitivity} onSensitivityChange={handleSensitivityChange} />
            </Card>

            <Card className="glass-card rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Similarity Check</CardTitle>
              </CardHeader>
              <CardContent>
                {result.similarityMatches.length > 0 ? (
                  <div className="space-y-3">
                    {result.similarityMatches.map((match, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="font-mono text-sm text-primary glow-text-sm">{anonymizeId(match.reportId)}</span>
                        <div className="flex items-center gap-2">
                          <Progress value={match.similarity} className="w-24 h-2" indicatorClassName={match.similarity > 80 ? "bg-destructive" : "bg-primary"} />
                          <span className="font-mono text-sm w-12 text-right">{Math.round(match.similarity)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4 text-center">
                    <div className="p-3 rounded-full icon-glow-green mb-2">
                      <CheckCircle className="w-8 h-8 text-green-400" />
                    </div>
                    <span className="text-sm font-medium">No duplicates found</span>
                    <span className="text-xs text-muted-foreground">Unique in our database</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {result.breakdown && (
            <Card className="glass-card rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <BarChart3 className="w-4 h-4 text-primary" />
                  Axis Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                  {[
                    { label: "Linguistic", score: result.breakdown.linguistic ?? 0, icon: <Cpu className="w-3 h-3" /> },
                    { label: "Factual", score: result.breakdown.factual ?? 0, icon: <Target className="w-3 h-3" /> },
                    { label: "Template", score: result.breakdown.template ?? 0, icon: <FileText className="w-3 h-3" /> },
                  ].map(({ label, score, icon }) => (
                    <div key={label} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1 text-muted-foreground">{icon}{label}</span>
                        <span className={`font-mono font-bold ${score >= 50 ? "text-destructive" : score >= 25 ? "text-yellow-500" : "text-green-500"}`}>{score}</span>
                      </div>
                      <Progress value={score} className="h-1.5" indicatorClassName={score >= 50 ? "bg-destructive" : score >= 25 ? "bg-yellow-500" : "bg-green-500"} />
                    </div>
                  ))}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1 text-muted-foreground"><Brain className="w-3 h-3" />LLM</span>
                      {result.breakdown.llm != null ? (
                        <span className={`font-mono font-bold ${result.breakdown.llm >= 50 ? "text-destructive" : result.breakdown.llm >= 25 ? "text-yellow-500" : "text-green-500"}`}>{result.breakdown.llm}</span>
                      ) : (
                        <span className="font-mono text-muted-foreground/50 text-[10px]">N/A</span>
                      )}
                    </div>
                    <Progress value={result.breakdown.llm ?? 0} className="h-1.5" indicatorClassName={result.breakdown.llm != null ? (result.breakdown.llm >= 50 ? "bg-destructive" : result.breakdown.llm >= 25 ? "bg-yellow-500" : "bg-green-500") : "bg-muted"} />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {result.evidence && result.evidence.length > 0 && (
            <Card className="glass-card rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <AlertCircle className="w-4 h-4 text-primary" />
                  Evidence Signals
                  <Badge variant="outline" className="text-[10px]">{result.evidence.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {visibleEvidence.map((item, i) => (
                  <div key={i} className="glass-card rounded-lg p-2.5 flex items-start gap-2.5">
                    <Badge
                      variant={item.weight >= 10 ? "destructive" : "secondary"}
                      className="text-[9px] px-1 py-0 h-4 font-mono flex-shrink-0 mt-0.5"
                    >
                      w:{item.weight}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        {EVIDENCE_TYPE_LABELS[item.type] || item.type}
                      </span>
                      <p className="text-xs leading-relaxed">{item.description}</p>
                      {item.matched && (
                        <span className="inline-block mt-0.5 text-[10px] font-mono text-primary/70 bg-primary/5 rounded px-1 py-0.5 truncate max-w-full">
                          {item.matched}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {result.evidence.length > 5 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs text-muted-foreground"
                    onClick={() => setShowAllEvidence(!showAllEvidence)}
                  >
                    {showAllEvidence ? <><ChevronUp className="w-3 h-3 mr-1" /> Show fewer</> : <><ChevronDown className="w-3 h-3 mr-1" /> Show all {result.evidence.length}</>}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {result.humanIndicators && result.humanIndicators.length > 0 && (
            <Card className="glass-card rounded-xl" style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Leaf className="w-4 h-4 text-green-400" />
                  Human Signals
                  <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-400">{result.humanIndicators.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.humanIndicators.map((item, i) => (
                  <div key={i} className="rounded-lg bg-green-500/5 border border-green-500/10 p-2.5 flex items-start gap-2.5">
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 font-mono flex-shrink-0 mt-0.5 border-green-500/40 text-green-400">
                      {item.weight}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-green-400/70">
                        {EVIDENCE_TYPE_LABELS[item.type] || item.type}
                      </span>
                      <p className="text-xs leading-relaxed">{item.description}</p>
                      {item.matched && (
                        <span className="inline-block mt-0.5 text-[10px] font-mono text-green-400/70 bg-green-500/5 rounded px-1 py-0.5 truncate max-w-full">
                          {item.matched}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.verification && (() => {
            const v = result.verification;
            const checks = v.checks ?? [];
            const summary = v.summary;
            return (
              <CheckVerificationPanel checks={checks} summary={summary} />
            );
          })()}

          {result.triageRecommendation && (() => {
            const tr = result.triageRecommendation;
            const questions = tr.challengeQuestions ?? [];
            const temporal = tr.temporalSignals ?? [];
            return (
            <Card className={`glass-card rounded-xl ${
              tr.action === "AUTO_CLOSE" ? "border-destructive/30" :
              tr.action === "PRIORITIZE" ? "border-green-500/30" :
              tr.action === "CHALLENGE_REPORTER" ? "border-yellow-500/30" : ""
            }`}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <MessageSquareWarning className="w-4 h-4 text-primary" />
                  Triage Recommendation
                  <Badge variant={
                    tr.action === "AUTO_CLOSE" ? "destructive" :
                    tr.action === "PRIORITIZE" ? "default" :
                    tr.action === "CHALLENGE_REPORTER" ? "secondary" : "outline"
                  } className="text-[10px] px-1.5 py-0 h-4 uppercase">
                    {tr.action.replace(/_/g, " ")}
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">{tr.reason}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="glass-card rounded-lg p-3 text-xs leading-relaxed">
                  {tr.note}
                </div>

                {questions.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold flex items-center gap-1.5">
                        <HelpCircle className="w-3.5 h-3.5 text-yellow-500" />
                        Challenge Questions ({questions.length})
                      </h4>
                      <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1" onClick={() => {
                        const text = questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n\n");
                        navigator.clipboard.writeText(text);
                        toast({ title: "Copied", description: "Challenge questions copied." });
                      }}>
                        <Copy className="w-3 h-3" /> Copy All
                      </Button>
                    </div>
                    {questions.map((q, i) => (
                      <div key={i} className="rounded-lg bg-yellow-500/5 border border-yellow-500/15 p-2.5">
                        <span className="text-[10px] font-bold uppercase text-yellow-500/70">{q.category.replace(/_/g, " ")}</span>
                        <p className="text-xs leading-relaxed">{q.question}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 italic">{q.context}</p>
                      </div>
                    ))}
                  </div>
                )}

                {temporal.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold flex items-center gap-1.5">
                      <Timer className="w-3.5 h-3.5 text-primary" /> Temporal Signals
                    </h4>
                    {temporal.map((s, i) => (
                      <div key={i} className={`rounded-lg border p-2.5 flex items-center justify-between text-xs ${
                        s.signal === "suspiciously_fast" ? "bg-destructive/5 border-destructive/15" :
                        s.signal === "fast_turnaround" ? "bg-yellow-500/5 border-yellow-500/15" :
                        "bg-muted/20 border-border/30"
                      }`}>
                        <span><span className="font-mono text-primary">{s.cveId}</span> <span className="text-muted-foreground">{s.hoursSincePublication.toFixed(1)}h after pub</span></span>
                        <Badge variant={s.signal === "suspiciously_fast" ? "destructive" : s.signal === "fast_turnaround" ? "secondary" : "outline"} className="text-[9px]">
                          {s.signal.replace(/_/g, " ")}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            );
          })()}

          {result.triageAssistant && (() => {
            const ta = result.triageAssistant;
            const severityColor = (s: string) => s === "critical" ? "text-destructive" : s === "important" ? "text-yellow-500" : "text-blue-400";
            const severityBg = (s: string) => s === "critical" ? "bg-destructive/5 border-destructive/15" : s === "important" ? "bg-yellow-500/5 border-yellow-500/15" : "bg-blue-500/5 border-blue-500/15";
            return (
            <Card className="glass-card rounded-xl border-indigo-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Crosshair className="w-4 h-4 text-indigo-400" />
                  Triage Assistant
                  {ta.llmTriageGuidance && (
                    <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                      <Brain className="w-2.5 h-2.5" />AI
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription className="text-xs">Reproduction guidance, gaps, and reporter assessment</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {ta.reproGuidance && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="border-indigo-500/40 text-indigo-400 text-[10px]">{ta.reproGuidance.vulnClass}</Badge>
                      <span className="text-[10px] text-muted-foreground">{(ta.reproGuidance.confidence * 100).toFixed(0)}% confidence</span>
                    </div>
                    {ta.reproGuidance.steps.map((step) => (
                      <div key={step.order} className="flex items-start gap-2 glass-card rounded-lg p-2.5">
                        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-[10px] font-bold text-indigo-400">{step.order}</div>
                        <div className="flex-1"><p className="text-xs leading-relaxed">{step.instruction}</p></div>
                      </div>
                    ))}
                  </div>
                )}

                {ta.llmTriageGuidance && (ta.llmTriageGuidance.expectedBehavior || (ta.llmTriageGuidance.testingTips && ta.llmTriageGuidance.testingTips.length > 0)) && (
                  <div className="space-y-1.5">
                    {ta.llmTriageGuidance.expectedBehavior && (
                      <div className="glass-card rounded-lg p-2.5 border border-cyan-500/15">
                        <div className="text-[9px] font-bold uppercase tracking-wide text-cyan-400 mb-1 flex items-center gap-1"><Brain className="w-2.5 h-2.5" />Expected Behavior</div>
                        <p className="text-xs leading-relaxed">{ta.llmTriageGuidance.expectedBehavior}</p>
                      </div>
                    )}
                    {ta.llmTriageGuidance.testingTips && ta.llmTriageGuidance.testingTips.length > 0 && (
                      <div className="glass-card rounded-lg p-2.5 border border-cyan-500/15">
                        <div className="text-[9px] font-bold uppercase tracking-wide text-cyan-400 mb-1 flex items-center gap-1"><Brain className="w-2.5 h-2.5" />Testing Tips</div>
                        <ul className="space-y-0.5">
                          {ta.llmTriageGuidance.testingTips.map((tip, i) => (
                            <li key={i} className="text-xs flex items-start gap-1"><span className="w-1 h-1 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0" />{tip}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {ta.gaps.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold flex items-center gap-1.5"><ListChecks className="w-3.5 h-3.5 text-indigo-400" />Gaps ({ta.gaps.length})</h4>
                    {ta.gaps.map((gap, i) => (
                      <div key={i} className={`rounded-lg border p-2.5 ${severityBg(gap.severity)}`}>
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <Badge variant="outline" className={`text-[9px] px-1 py-0 h-3.5 uppercase ${severityColor(gap.severity)}`}>{gap.severity}</Badge>
                          <span className="text-[10px] font-bold text-muted-foreground uppercase">{gap.category.replace(/_/g, " ")}</span>
                        </div>
                        <p className="text-xs leading-relaxed">{gap.description}</p>
                        {gap.triagerGuidance && (
                          <div className="mt-1.5 rounded border border-blue-500/15 bg-blue-500/5 px-2 py-1">
                            <span className="text-[9px] font-bold uppercase text-blue-400 tracking-wide">Triager</span>
                            <p className="text-[11px] text-blue-300/80">{gap.triagerGuidance}</p>
                          </div>
                        )}
                        {gap.reporterGuidance && (
                          <div className="mt-1 rounded border border-amber-500/15 bg-amber-500/5 px-2 py-1">
                            <span className="text-[9px] font-bold uppercase text-amber-400 tracking-wide">Reporter</span>
                            <p className="text-[11px] text-amber-300/80">{gap.reporterGuidance}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {ta.dontMiss.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold flex items-center gap-1.5"><Microscope className="w-3.5 h-3.5 text-orange-400" />Don't Miss ({ta.dontMiss.length})</h4>
                    {ta.dontMiss.map((item, i) => (
                      <div key={i} className="rounded-lg border border-orange-500/15 bg-orange-500/5 p-2.5">
                        <span className="text-xs font-medium">{item.area}</span>
                        <p className="text-xs text-muted-foreground">{item.warning}</p>
                      </div>
                    ))}
                  </div>
                )}

                {ta.reporterFeedback.length > 0 && (
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold flex items-center gap-1.5"><UserCheck className="w-3.5 h-3.5 text-blue-400" />Reporter</h4>
                    {ta.reporterFeedbackSummary && (
                      <div className="rounded-lg border border-muted/30 bg-muted/10 p-2 flex items-center gap-3">
                        <div className="text-center">
                          <div className={`text-lg font-bold ${
                            ta.reporterFeedbackSummary.clarityScore >= 70 ? "text-green-400" :
                            ta.reporterFeedbackSummary.clarityScore >= 40 ? "text-yellow-400" : "text-red-400"
                          }`}>{ta.reporterFeedbackSummary.clarityScore}</div>
                          <div className="text-[9px] text-muted-foreground uppercase">Clarity</div>
                        </div>
                        <div className="h-6 w-px bg-muted/30" />
                        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
                          ta.reporterFeedbackSummary.actionability === "high" ? "border-green-500/30 text-green-400" :
                          ta.reporterFeedbackSummary.actionability === "medium" ? "border-yellow-500/30 text-yellow-400" : "border-red-500/30 text-red-400"
                        }`}>{ta.reporterFeedbackSummary.actionability}</Badge>
                      </div>
                    )}
                    {ta.reporterFeedback.map((fb, i) => (
                      <div key={i} className={`rounded-lg border p-2.5 text-xs ${fb.tone === "positive" ? "bg-green-500/5 border-green-500/15" : fb.tone === "concern" ? "bg-yellow-500/5 border-yellow-500/15" : "bg-blue-500/5 border-blue-500/15"}`}>
                        {fb.message}
                      </div>
                    ))}
                  </div>
                )}

                <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 w-full" onClick={() => {
                  const lines: string[] = ["# Triage Assistant", ""];
                  if (ta.reproGuidance) {
                    lines.push(`## Reproduce (${ta.reproGuidance.vulnClass})`);
                    ta.reproGuidance.steps.forEach(s => lines.push(`${s.order}. ${s.instruction}`));
                    lines.push("");
                  }
                  if (ta.gaps.length > 0) { lines.push("## Gaps"); ta.gaps.forEach(g => lines.push(`- [${g.severity}] ${g.description}`)); lines.push(""); }
                  if (ta.dontMiss.length > 0) { lines.push("## Don't Miss"); ta.dontMiss.forEach(d => lines.push(`- ${d.area}: ${d.warning}`)); lines.push(""); }
                  if (ta.reporterFeedback.length > 0) { lines.push("## Reporter"); ta.reporterFeedback.forEach(f => lines.push(`- ${f.message}`)); lines.push(""); }
                  navigator.clipboard.writeText(lines.join("\n"));
                  toast({ title: "Copied", description: "Triage assistant summary copied." });
                }}>
                  <Copy className="w-3 h-3" /> Copy Summary
                </Button>
              </CardContent>
            </Card>
            );
          })()}

          {result.llmEnhanced && result.llmBreakdown && (
            <Card className="glass-card rounded-xl border-cyan-500/20">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Brain className="w-4 h-4 text-cyan-400" />
                  LLM Validity Assessment
                  <Badge variant="outline" className="border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0 h-4 flex items-center gap-1 normal-case">
                    <Brain className="w-2.5 h-2.5" />
                    LLM Enhanced
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {result.llmBreakdown.claimSpecificity != null ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                      <LlmDimensionBar label="Claim Specificity" score={result.llmBreakdown.claimSpecificity * 4} />
                      <LlmDimensionBar label="Evidence Quality" score={(result.llmBreakdown.evidenceQuality ?? 0) * 4} />
                      <LlmDimensionBar label="Internal Consistency" score={(result.llmBreakdown.internalConsistency ?? 0) * 4} />
                      <LlmDimensionBar label="Hallucination Signals" score={(result.llmBreakdown.hallucinationSignals ?? 0) * 4} />
                    </div>
                    {result.llmBreakdown.validityScore != null && (
                      <div className="pt-2 border-t border-white/5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Overall Validity</span>
                          <span className={`font-mono font-bold ${result.llmBreakdown.validityScore >= 70 ? "text-green-400" : result.llmBreakdown.validityScore >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                            {result.llmBreakdown.validityScore}/100
                          </span>
                        </div>
                        {result.llmBreakdown.verdict && (
                          <span className={`text-[10px] font-mono ${result.llmBreakdown.verdict === "LIKELY_VALID" ? "text-green-400" : result.llmBreakdown.verdict === "UNCERTAIN" ? "text-yellow-400" : "text-red-400"}`}>
                            {result.llmBreakdown.verdict.replace(/_/g, " ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                    {result.llmBreakdown.specificity != null && <LlmDimensionBar label="Specificity" score={result.llmBreakdown.specificity} />}
                    {result.llmBreakdown.originality != null && <LlmDimensionBar label="Originality" score={result.llmBreakdown.originality} />}
                    {result.llmBreakdown.voice != null && <LlmDimensionBar label="Voice" score={result.llmBreakdown.voice} />}
                    {result.llmBreakdown.coherence != null && <LlmDimensionBar label="Coherence" score={result.llmBreakdown.coherence} />}
                    {result.llmBreakdown.hallucination != null && <LlmDimensionBar label="Hallucination" score={result.llmBreakdown.hallucination} />}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {result.redactionSummary.totalRedactions > 0 && (
            <Card className="glass-card rounded-xl" style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="w-4 h-4 text-green-400" />
                  Redaction Analysis
                </CardTitle>
                <CardDescription>{result.redactionSummary.totalRedactions} items would be redacted</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(result.redactionSummary.categories).map(([cat, count]) => (
                    <Badge key={cat} variant="secondary" className="text-xs gap-1">
                      {REDACTION_LABELS[cat] || cat}: {count as number}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {result.sectionMatches.length > 0 && (
            <Card className="glass-card rounded-xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Layers className="w-4 h-4 text-primary" />
                  Matching Sections
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.sectionMatches.map((match, i) => (
                  <div key={i} className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-sm flex justify-between items-center">
                    <span><strong>{match.sectionTitle}</strong> matches {anonymizeId(match.matchedReportId)}</span>
                    <Badge variant="secondary" className="font-mono">{match.similarity}%</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.feedback.length > 0 && (
            <Card className="glass-card rounded-xl">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Lightbulb className="w-4 h-4 text-primary" />
                  Feedback
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {result.feedback.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="flex justify-center">
            <Button
              variant="outline"
              className="gap-2 glass-card hover:border-primary/30"
              onClick={() => {
                setResult(null);
                setRawText("");
                setFile(null);
                setReportUrl("");
                setShowAllEvidence(false);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <Search className="w-4 h-4" />
              Check Another Report
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
