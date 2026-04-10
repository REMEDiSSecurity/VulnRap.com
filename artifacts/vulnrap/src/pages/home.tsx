import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { UploadCloud, Shield, FileText, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useSubmitReport, SubmitReportBodyContentMode } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"];

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

export default function Home() {
  const [, setLocation] = useLocation();
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
        setTimeout(() => setLocation(`/results/${data.id}`), 600);
      },
      onError: (err: unknown) => {
        setStage("error");
        const message = err && typeof err === "object" && "error" in err ? String((err as Record<string, unknown>).error) : "An error occurred during analysis.";
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
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="space-y-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-primary uppercase" data-testid="text-heading">Report Validation</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Validate your bug bounty reports before submission. We check for similarities against known reports and analyze your content for AI-generated "slop".
        </p>
      </div>

      <Card className="border-primary/20 bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            Upload Report
          </CardTitle>
          <CardDescription>Supported formats: .txt, .md, .pdf (Max 20MB)</CardDescription>
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
              accept=".txt,.md,.pdf"
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
            </h3>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as SubmitReportBodyContentMode)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "similarity_only" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.similarity_only)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.similarity_only} id="similarity_only" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="similarity_only" className="font-medium cursor-pointer">Similarity Only</Label>
                    <p className="text-xs text-muted-foreground">Stores only document hashes for comparison. Content is discarded immediately after analysis. Recommended for sensitive zero-days.</p>
                  </div>
                </div>
              </div>
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "full" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.full)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.full} id="full" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="full" className="font-medium cursor-pointer">Full Storage</Label>
                    <p className="text-xs text-muted-foreground">Stores the full content securely. Helps improve the community corpus for better matching.</p>
                  </div>
                </div>
              </div>
            </RadioGroup>
          </div>
        </CardContent>
        <CardFooter>
          <Button
            className="w-full h-12 text-lg font-bold gap-2"
            onClick={handleSubmit}
            disabled={!file || isProcessing || !!fileError}
            data-testid="button-submit"
          >
            {getButtonContent()}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
