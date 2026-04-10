import { useState, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { UploadCloud, Shield, FileText, Loader2, CheckCircle, XCircle, Search, Zap, Eye, HelpCircle, Lock, Fingerprint, ShieldCheck, Volume2, VolumeX, ClipboardPaste, Clock, ExternalLink } from "lucide-react";
import { LogoBeams } from "@/components/laser-effects";
import { useSubmitReport, SubmitReportBodyContentMode, useGetReportFeed } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import logoSrc from "@/assets/logo.png";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_TEXT_LENGTH = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md"];

function anonymizeId(id: number): string {
  return `VR-${id.toString(16).padStart(4, "0").toUpperCase()}`;
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

function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

type InputMode = "file" | "text";
type UploadStage = "idle" | "uploading" | "analyzing" | "done" | "error";

function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(e => ext.endsWith(e));
  if (!hasValidExt) {
    return `Unsupported file type. Accepted formats: ${ALLOWED_EXTENSIONS.join(", ")}`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 20MB.`;
  }
  if (file.size === 0) {
    return "File is empty. Please select a file with content.";
  }
  return null;
}

function Explainer({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-popover border border-border px-3 py-2 text-xs text-popover-foreground opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg text-left font-normal normal-case">
        {text}
      </span>
    </span>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<SubmitReportBodyContentMode>(SubmitReportBodyContentMode.full);
  const [showInFeed, setShowInFeed] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<UploadStage>("idle");

  const submitMutation = useSubmitReport({
    mutation: {
      onMutate: () => {
        setStage("uploading");
        setTimeout(() => setStage((prev) => prev === "uploading" ? "analyzing" : prev), 800);
      },
      onSuccess: (data) => {
        setStage("done");
        toast({ title: "Analysis complete", description: "Navigating to results..." });
        setTimeout(() => navigate(`/results/${data.id}`), 600);
      },
      onError: (err: unknown) => {
        setStage("error");
        let message = "An error occurred during analysis.";
        if (err && typeof err === "object") {
          const e = err as Record<string, unknown>;
          if ("data" in e && e.data && typeof e.data === "object" && "error" in (e.data as Record<string, unknown>)) {
            message = String((e.data as Record<string, unknown>).error);
          } else if ("message" in e && typeof e.message === "string") {
            message = e.message;
          } else if ("error" in e) {
            message = String(e.error);
          }
        }
        toast({
          title: "Upload failed",
          description: message,
          variant: "destructive"
        });
      }
    }
  });

  const handleFileSelect = (selectedFile: File) => {
    const error = validateFile(selectedFile);
    if (error) {
      setFile(null);
      setFileError(error);
      toast({ title: "Invalid file", description: error, variant: "destructive" });
      return;
    }
    setFile(selectedFile);
    setFileError(null);
    setStage("idle");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleSubmit = () => {
    if (inputMode === "file") {
      if (!file) {
        toast({ title: "No file selected", description: "Please select a report file first.", variant: "destructive" });
        return;
      }
      const error = validateFile(file);
      if (error) {
        setFileError(error);
        toast({ title: "Invalid file", description: error, variant: "destructive" });
        return;
      }
      submitMutation.mutate({ data: { file, contentMode: mode, showInFeed: (mode === "full" && showInFeed) ? "true" : "false" } });
    } else {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        toast({ title: "No text entered", description: "Please paste your report text first.", variant: "destructive" });
        return;
      }
      if (new Blob([trimmed]).size > MAX_TEXT_LENGTH) {
        toast({ title: "Text too large", description: "Pasted text exceeds the 20MB limit.", variant: "destructive" });
        return;
      }
      submitMutation.mutate({ data: { rawText: trimmed, contentMode: mode, showInFeed: (mode === "full" && showInFeed) ? "true" : "false" } });
    }
  };

  const hasContent = inputMode === "file" ? !!file : rawText.trim().length > 0;
  const isProcessing = stage === "uploading" || stage === "analyzing" || stage === "done";

  const getButtonContent = () => {
    switch (stage) {
      case "uploading":
        return <><Loader2 className="w-5 h-5 animate-spin" /> Uploading...</>;
      case "analyzing":
        return <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing report...</>;
      case "done":
        return <><CheckCircle className="w-5 h-5" /> Complete</>;
      case "error":
        return <><XCircle className="w-5 h-5" /> Failed - Try Again</>;
      default:
        return "Analyze Report";
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="space-y-6 text-center pt-6">
        <div className="relative flex justify-center">
          <div className="relative">
            <LogoBeams />
            <div className="absolute inset-0 rounded-xl bg-primary/10 blur-3xl scale-150 z-0" />
            <img src={logoSrc} alt="VulnRap" className="relative z-10 w-24 h-24 md:w-28 md:h-28 rounded-xl logo-glow gradient-border" />
          </div>
        </div>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-primary uppercase glow-text" data-testid="text-heading">Report Validation</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Validate your bug bounty reports before submission. We check for similarities against known reports and analyze your content for AI-generated "slop".
        </p>
      </div>

      <div className="rounded-xl glass-card-accent overflow-hidden">
        <video
          className="w-full"
          controls
          playsInline
          preload="metadata"
        >
          <source src={`${import.meta.env.BASE_URL}vulnrap-intro.mp4`} type="video/mp4" />
          Your browser does not support video playback.
        </video>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="feature-card flex items-start gap-3 p-5 rounded-xl glass-card">
          <div className="p-2.5 rounded-lg icon-glow-green flex-shrink-0">
            <ShieldCheck className="w-5 h-5 text-green-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1.5">Auto-Redaction</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">PII, secrets, credentials, and company names are automatically scrubbed before your report is stored or compared.</p>
          </div>
        </div>
        <div className="feature-card flex items-start gap-3 p-5 rounded-xl glass-card">
          <div className="p-2.5 rounded-lg icon-glow-cyan flex-shrink-0">
            <Fingerprint className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1.5">Section-Level Hashing</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">Each section of your report is hashed independently, detecting partial matches even when full documents differ.</p>
          </div>
        </div>
        <div className="feature-card flex items-start gap-3 p-5 rounded-xl glass-card">
          <div className="p-2.5 rounded-lg icon-glow-violet flex-shrink-0">
            <Eye className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1.5">AI Slop Detection</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">Structural and linguistic analysis scores how likely your report is AI-generated, with actionable feedback.</p>
          </div>
        </div>
      </div>

      <Card className="glass-card-accent rounded-xl overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            Submit Report
            <Explainer text="Submit a vulnerability report for analysis. Upload a file or paste your report text directly. We'll analyze it for AI-generated content and check it against previously submitted reports for similarity." />
          </CardTitle>
          <CardDescription>Upload a file or paste text directly (Max 20MB)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-yellow-500">Heads up:</strong> We auto-redact PII, secrets, credentials, and company names before storing or comparing your report. But auto-redaction is regex-based and may miss edge cases. If your report contains specific details you want kept private, pre-sanitize those sections yourself before uploading.
          </div>
          <div className="flex rounded-xl overflow-hidden glass-card">
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-all",
                inputMode === "file"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => { setInputMode("file"); setStage("idle"); }}
              data-testid="tab-file"
            >
              <UploadCloud className="w-4 h-4" />
              Upload File
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-all border-l border-border/30",
                inputMode === "text"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => { setInputMode("text"); setStage("idle"); }}
              data-testid="tab-text"
            >
              <ClipboardPaste className="w-4 h-4" />
              Paste Text
            </button>
          </div>

          {inputMode === "file" ? (
          <div
            data-testid="dropzone"
            className={cn(
              "border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center gap-4 transition-all cursor-pointer",
              isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/20 hover:border-primary/40",
              file && !fileError ? "border-primary/40 bg-primary/5" : "",
              fileError ? "border-destructive bg-destructive/5" : ""
            )}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".txt,.md"
              onChange={handleFileChange}
              data-testid="input-file"
            />
            {fileError ? (
              <>
                <div className="p-4 rounded-full bg-destructive/10">
                  <XCircle className="w-8 h-8 text-destructive" />
                </div>
                <div className="text-center">
                  <p className="font-medium text-destructive">{fileError}</p>
                  <p className="text-sm text-muted-foreground mt-1">Click to select a different file</p>
                </div>
              </>
            ) : file ? (
              <>
                <FileText className="w-12 h-12 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-lg" data-testid="text-filename">{file.name}</p>
                  <p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); setFileError(null); setStage("idle"); }} className="mt-2" data-testid="button-clear">
                  Clear Selection
                </Button>
              </>
            ) : (
              <>
                <div className="p-4 rounded-full bg-muted">
                  <UploadCloud className="w-8 h-8 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <p className="font-medium">Drag & drop your report here</p>
                  <p className="text-sm text-muted-foreground mt-1">or click to browse files (.txt, .md)</p>
                </div>
              </>
            )}
          </div>
          ) : (
          <div className="space-y-2">
            <textarea
              data-testid="input-rawtext"
              className="w-full h-64 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
              placeholder="Paste your vulnerability report text here...&#10;&#10;This field accepts plain text only. All content is treated as text -- no HTML, markdown rendering, or code execution."
              value={rawText}
              onChange={(e) => { setRawText(e.target.value); setStage("idle"); }}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex justify-between items-center text-xs text-muted-foreground">
              <span>{rawText.length > 0 ? `${rawText.length.toLocaleString()} characters` : "No text entered"}</span>
              {rawText.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  onClick={() => { setRawText(""); setStage("idle"); }}
                  data-testid="button-clear-text"
                >
                  Clear text
                </button>
              )}
            </div>
          </div>
          )}

          <div className="space-y-4">
            <h3 className="font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              How should we handle your report?
            </h3>
            <RadioGroup value={mode} onValueChange={(v) => { setMode(v as SubmitReportBodyContentMode); if (v === "similarity_only") setShowInFeed(false); }} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "full" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.full)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.full} id="full" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="full" className="font-bold cursor-pointer">Share with the community <span className="font-normal text-muted-foreground">(this is the only way this site can work)</span></Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">Your report (with PII and secrets auto-removed) is saved and helps everyone detect duplicates. Best for most submissions.</p>
                  </div>
                </div>
                {mode === "full" && (
                  <label className="flex items-center gap-2 mt-3 ml-7 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={showInFeed}
                      onChange={(e) => setShowInFeed(e.target.checked)}
                      className="rounded border-border accent-primary w-4 h-4"
                    />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">Show in the recent reports feed on this site</span>
                  </label>
                )}
              </div>
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "similarity_only" ? "border-primary bg-primary/5" : "border-border")} onClick={() => { setMode(SubmitReportBodyContentMode.similarity_only); setShowInFeed(false); }}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.similarity_only} id="similarity_only" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="similarity_only" className="font-bold cursor-pointer">Keep it private</Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">We only store a mathematical fingerprint of your report -- no text is saved at all. Use this for sensitive zero-days you want to keep confidential.</p>
                  </div>
                </div>
              </div>
            </RadioGroup>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button
            className="w-full h-12 text-lg font-bold gap-2 glow-button"
            onClick={handleSubmit}
            disabled={!hasContent || isProcessing || !!fileError}
            data-testid="button-submit"
          >
            {getButtonContent()}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Free and anonymous. No account required. <Link to="/privacy" className="text-primary hover:underline">Read our privacy policy</Link> to learn exactly what we store.
          </p>
        </CardFooter>
      </Card>

      <div className="glass-card rounded-xl p-6 space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          How It Works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-2 p-4 rounded-xl glass-card feature-card">
            <div className="text-3xl font-bold step-number">01</div>
            <h3 className="font-medium text-sm">Submit</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Upload a .txt or .md file, or paste your report text directly. We extract the content and begin processing immediately.
            </p>
          </div>
          <div className="space-y-2 p-4 rounded-xl glass-card feature-card">
            <div className="text-3xl font-bold step-number">02</div>
            <h3 className="font-medium text-sm">Auto-Redact</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              PII, secrets, credentials, and company names are automatically scrubbed. Only the redacted version is used from this point.
            </p>
          </div>
          <div className="space-y-2 p-4 rounded-xl glass-card feature-card">
            <div className="text-3xl font-bold step-number">03</div>
            <h3 className="font-medium text-sm">Analyze</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We hash each section independently, compare against all existing reports, and score AI-generation likelihood.
            </p>
          </div>
          <div className="space-y-2 p-4 rounded-xl glass-card feature-card">
            <div className="text-3xl font-bold step-number">04</div>
            <h3 className="font-medium text-sm">Results</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Get your slop score, similarity matches, section-level hash analysis, redaction summary, and improvement feedback.
            </p>
          </div>
        </div>
      </div>

      <RecentReportsFeed />
    </div>
  );
}

function RecentReportsFeed() {
  const { data, isLoading } = useGetReportFeed({ limit: 10 });
  const reports = (data as unknown as { reports: Array<{ id: number; reportCode: string; slopScore: number; slopTier: string; matchCount: number; contentMode: string; createdAt: string }> })?.reports;

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Recent Reports
        </h2>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-muted/20 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Recent Reports
        </h2>
        <p className="text-sm text-muted-foreground text-center py-6">
          No public reports yet. Be the first to share one with the community.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Recent Reports
        </h2>
        <span className="text-xs text-muted-foreground">{reports.length} report{reports.length !== 1 ? "s" : ""} in feed</span>
      </div>
      <div className="space-y-2">
        {reports.map((report) => (
          <Link
            key={report.id}
            to={`/verify/${report.id}`}
            className="flex items-center justify-between p-3 rounded-lg glass-card hover:border-primary/20 transition-all group"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-sm text-primary font-medium glow-text-sm">{report.reportCode}</span>
              <Badge variant="secondary" className="text-[10px] hidden sm:inline-flex">
                {report.contentMode === "full" ? "Shared" : "Private"}
              </Badge>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Progress value={report.slopScore} className="w-16 h-1.5 hidden sm:block" indicatorClassName={getSlopProgressColor(report.slopScore)} />
                <span className={cn("font-mono text-xs font-medium w-6 text-right", getSlopColor(report.slopScore))}>{report.slopScore}</span>
              </div>
              {report.matchCount > 0 && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Search className="w-2.5 h-2.5" />{report.matchCount}
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground w-14 text-right">{timeAgo(report.createdAt)}</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover:text-primary transition-colors" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
