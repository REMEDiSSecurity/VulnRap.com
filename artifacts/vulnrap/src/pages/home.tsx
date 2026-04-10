import { useState, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { UploadCloud, Shield, FileText, Loader2, CheckCircle, XCircle, Search, Zap, Eye, HelpCircle, Lock, Fingerprint, ShieldCheck, Volume2, VolumeX } from "lucide-react";
import { useSubmitReport, SubmitReportBodyContentMode } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import logoSrc from "@/assets/logo.png";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md"];

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
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<SubmitReportBodyContentMode>(SubmitReportBodyContentMode.similarity_only);
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
    submitMutation.mutate({ data: { file, contentMode: mode } });
  };

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
      <div className="space-y-5 text-center pt-4">
        <div className="flex justify-center">
          <img src={logoSrc} alt="VulnRap" className="w-20 h-20 md:w-24 md:h-24 rounded-lg shadow-lg shadow-primary/20 border border-primary/20" />
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-primary uppercase" data-testid="text-heading">Report Validation</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Validate your bug bounty reports before submission. We check for similarities against known reports and analyze your content for AI-generated "slop".
        </p>
      </div>

      <div className="rounded-lg border border-primary/20 bg-card/30 overflow-hidden">
        <video
          className="w-full"
          controls
          playsInline
          preload="metadata"
        >
          <source src={`${import.meta.env.BASE_URL}vulnrap-intro.mp4`} type="video/mp4" />
          <source src={`${import.meta.env.BASE_URL}vulnrap-intro.mov`} type="video/quicktime" />
          Your browser does not support video playback.
        </video>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-card/30">
          <div className="p-2 rounded-md bg-primary/10">
            <ShieldCheck className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1">Auto-Redaction</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">PII, secrets, credentials, and company names are automatically scrubbed before your report is stored or compared.</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-card/30">
          <div className="p-2 rounded-md bg-primary/10">
            <Fingerprint className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1">Section-Level Hashing</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">Each section of your report is hashed independently, detecting partial matches even when full documents differ.</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-card/30">
          <div className="p-2 rounded-md bg-primary/10">
            <Eye className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-bold mb-1">AI Slop Detection</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">Structural and linguistic analysis scores how likely your report is AI-generated, with actionable feedback.</p>
          </div>
        </div>
      </div>

      <Card className="border-primary/20 bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            Upload Report
            <Explainer text="Upload a vulnerability report file. We'll analyze it for AI-generated content and check it against previously submitted reports for similarity." />
          </CardTitle>
          <CardDescription>Supported formats: .txt, .md (Max 20MB)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          <div
            data-testid="dropzone"
            className={cn(
              "border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center gap-4 transition-colors cursor-pointer",
              isDragging ? "border-primary bg-primary/5" : "border-muted hover:border-primary/50",
              file && !fileError ? "border-primary/50 bg-primary/5" : "",
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
                  <p className="text-sm text-muted-foreground mt-1">or click to browse files</p>
                </div>
              </>
            )}
          </div>

          <div className="space-y-4">
            <h3 className="font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Privacy Mode
              <Explainer text="Choose how your report data is handled after analysis. This controls whether we retain the original text or only store mathematical fingerprints." />
            </h3>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as SubmitReportBodyContentMode)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "similarity_only" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.similarity_only)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.similarity_only} id="similarity_only" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="similarity_only" className="font-medium cursor-pointer">Similarity Only</Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">Report is auto-redacted then hashed. Only hashes are stored -- no text, not even the redacted version. Best for sensitive zero-days.</p>
                  </div>
                </div>
              </div>
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "full" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.full)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.full} id="full" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="full" className="font-medium cursor-pointer">Full Storage</Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">Stores the auto-redacted version (PII/secrets removed) for richer comparison. Contributes to the community corpus. Recommended for disclosed bugs.</p>
                  </div>
                </div>
              </div>
            </RadioGroup>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button
            className="w-full h-12 text-lg font-bold gap-2"
            onClick={handleSubmit}
            disabled={!file || isProcessing || !!fileError}
            data-testid="button-submit"
          >
            {getButtonContent()}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Free and anonymous. No account required. <Link to="/privacy" className="text-primary hover:underline">Read our privacy policy</Link> to learn exactly what we store.
          </p>
        </CardFooter>
      </Card>

      <div className="border border-border/50 rounded-lg p-6 bg-card/20 space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          How It Works
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="space-y-2">
            <div className="text-3xl font-bold text-primary/30">01</div>
            <h3 className="font-medium text-sm">Upload</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Submit your vulnerability report as a .txt or .md file. We extract the text and begin processing immediately.
            </p>
          </div>
          <div className="space-y-2">
            <div className="text-3xl font-bold text-primary/30">02</div>
            <h3 className="font-medium text-sm">Auto-Redact</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              PII, secrets, credentials, and company names are automatically scrubbed. Only the redacted version is used from this point.
            </p>
          </div>
          <div className="space-y-2">
            <div className="text-3xl font-bold text-primary/30">03</div>
            <h3 className="font-medium text-sm">Analyze</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We hash each section independently, compare against all existing reports, and score AI-generation likelihood.
            </p>
          </div>
          <div className="space-y-2">
            <div className="text-3xl font-bold text-primary/30">04</div>
            <h3 className="font-medium text-sm">Results</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Get your slop score, similarity matches, section-level hash analysis, redaction summary, and improvement feedback.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
