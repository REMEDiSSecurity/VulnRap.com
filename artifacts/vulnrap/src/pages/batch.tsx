import { useState, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { UploadCloud, Loader2, CheckCircle, XCircle, FileText, AlertTriangle, Trash2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { addHistoryEntry } from "@/lib/history";
import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";
import { anonymizeId } from "@/lib/utils";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"];
const MAX_FILES = 50;

interface BatchFile {
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  result?: {
    id: number;
    slopScore: number;
    slopTier: string;
    matchCount: number;
    contentMode: string;
    deleteToken?: string;
  };
  error?: string;
}

function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some((e) => ext.endsWith(e));
  if (!hasValidExt) return `Unsupported file type`;
  if (file.size > MAX_FILE_SIZE) return `File too large (max 5MB)`;
  if (file.size === 0) return "File is empty";
  return null;
}

export default function Batch() {
  const { toast } = useToast();
  const settings = getSettings();
  const [files, setFiles] = useState<BatchFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);

  const addFiles = useCallback((fileList: FileList) => {
    const newFiles: BatchFile[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const err = validateFile(f);
      if (err) {
        newFiles.push({ file: f, status: "error", error: err });
      } else {
        newFiles.push({ file: f, status: "pending" });
      }
    }
    setFiles((prev) => {
      const combined = [...prev, ...newFiles];
      if (combined.length > MAX_FILES) {
        toast({
          title: "Too many files",
          description: `Maximum ${MAX_FILES} files at once. Only the first ${MAX_FILES} were kept.`,
          variant: "destructive",
        });
        return combined.slice(0, MAX_FILES);
      }
      return combined;
    });
  }, [toast]);

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setFiles([]);
    abortRef.current = true;
    setIsProcessing(false);
  };

  const processFiles = async () => {
    abortRef.current = false;
    setIsProcessing(true);

    const pendingIndices = files
      .map((f, i) => (f.status === "pending" ? i : -1))
      .filter((i) => i >= 0);

    for (const idx of pendingIndices) {
      if (abortRef.current) break;

      setFiles((prev) =>
        prev.map((f, i) => (i === idx ? { ...f, status: "uploading" } : f))
      );

      try {
        const formData = new FormData();
        formData.append("file", files[idx].file);
        formData.append("contentMode", "full");
        formData.append("showInFeed", "false");

        const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
        const res = await fetch(`${baseUrl}/api/reports`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        const data = await res.json();

        if (data.deleteToken) {
          try {
            const tokens = JSON.parse(sessionStorage.getItem("vulnrap_delete_tokens") || "{}");
            tokens[data.id] = data.deleteToken;
            sessionStorage.setItem("vulnrap_delete_tokens", JSON.stringify(tokens));
          } catch {}
        }

        addHistoryEntry({
          id: data.id,
          reportCode: anonymizeId(data.id),
          slopScore: data.slopScore,
          slopTier: data.slopTier,
          matchCount: data.similarityMatches?.length || 0,
          contentMode: data.contentMode,
          fileName: files[idx].file.name,
          timestamp: new Date().toISOString(),
          type: "submit",
        });

        setFiles((prev) =>
          prev.map((f, i) =>
            i === idx
              ? {
                  ...f,
                  status: "done",
                  result: {
                    id: data.id,
                    slopScore: data.slopScore,
                    slopTier: data.slopTier,
                    matchCount: data.similarityMatches?.length || 0,
                    contentMode: data.contentMode,
                    deleteToken: data.deleteToken,
                  },
                }
              : f
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setFiles((prev) =>
          prev.map((f, i) =>
            i === idx ? { ...f, status: "error", error: message } : f
          )
        );
      }
    }

    setIsProcessing(false);
    if (!abortRef.current) {
      toast({ title: "Batch complete", description: "All files have been processed." });
    }
  };

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const totalCount = files.length;

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <UploadCloud className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Batch Upload
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Drop multiple report files to analyze them all at once. Each file is submitted, analyzed, and stored individually.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl overflow-hidden">
        <CardContent className="p-6">
          <div
            className={cn(
              "border-2 border-dashed rounded-xl p-8 sm:p-12 flex flex-col items-center justify-center gap-3 transition-all cursor-pointer",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/20 hover:border-primary/40",
              isProcessing && "pointer-events-none opacity-50"
            )}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".txt,.md,.pdf"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <UploadCloud className="w-10 h-10 text-muted-foreground" />
            <span className="font-medium text-center">
              Drop report files here or click to browse
            </span>
            <span className="text-xs text-muted-foreground">
              .txt, .md, .pdf — up to {MAX_FILES} files, 5MB each
            </span>
          </div>
        </CardContent>
      </Card>

      {files.length > 0 && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">{totalCount} file{totalCount !== 1 ? "s" : ""}</span>
              {doneCount > 0 && (
                <Badge variant="secondary" className="gap-1">
                  <CheckCircle className="w-3 h-3 text-green-400" />
                  {doneCount} done
                </Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive" className="gap-1">
                  <XCircle className="w-3 h-3" />
                  {errorCount} failed
                </Badge>
              )}
              {pendingCount > 0 && (
                <Badge variant="outline" className="gap-1">
                  {pendingCount} pending
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={clearAll}
                className="gap-2 glass-card hover:border-destructive/30 text-destructive hover:text-destructive"
              >
                <Trash2 className="w-4 h-4" />
                Clear All
              </Button>
              {pendingCount > 0 && (
                <Button
                  size="sm"
                  onClick={processFiles}
                  disabled={isProcessing}
                  className="gap-2 glow-button"
                >
                  {isProcessing ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                  ) : (
                    <><UploadCloud className="w-4 h-4" /> Analyze {pendingCount} File{pendingCount !== 1 ? "s" : ""}</>
                  )}
                </Button>
              )}
            </div>
          </div>

          {isProcessing && (
            <Progress
              value={((doneCount + errorCount) / totalCount) * 100}
              className="h-2"
              indicatorClassName="bg-primary"
            />
          )}

          <div className="space-y-2">
            {files.map((entry, index) => {
              const slopColor = entry.result
                ? getSlopColorCustom(entry.result.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh)
                : "";
              const progressColor = entry.result
                ? getSlopProgressColorCustom(entry.result.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh)
                : "";
              return (
                <Card key={index} className="glass-card rounded-xl">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="shrink-0">
                        {entry.status === "pending" && (
                          <FileText className="w-5 h-5 text-muted-foreground" />
                        )}
                        {entry.status === "uploading" && (
                          <Loader2 className="w-5 h-5 text-primary animate-spin" />
                        )}
                        {entry.status === "done" && (
                          <CheckCircle className="w-5 h-5 text-green-400" />
                        )}
                        {entry.status === "error" && (
                          <XCircle className="w-5 h-5 text-destructive" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {entry.file.name}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {(entry.file.size / 1024).toFixed(1)} KB
                          </span>
                        </div>

                        {entry.status === "error" && entry.error && (
                          <p className="text-xs text-destructive mt-1">{entry.error}</p>
                        )}

                        {entry.status === "done" && entry.result && (
                          <div className="flex items-center gap-3 mt-1.5">
                            <span className={`font-mono text-sm font-bold ${slopColor}`}>
                              {entry.result.slopScore}
                            </span>
                            <Progress
                              value={entry.result.slopScore}
                              className="h-1.5 flex-1 max-w-[120px]"
                              indicatorClassName={progressColor}
                            />
                            <span className="text-xs text-muted-foreground">
                              {entry.result.slopTier}
                            </span>
                            {entry.result.matchCount > 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                                {entry.result.matchCount} match{entry.result.matchCount !== 1 ? "es" : ""}
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {entry.status === "done" && entry.result && (
                          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                            <Link to={`/results/${entry.result.id}`}>
                              <ExternalLink className="w-4 h-4" />
                            </Link>
                          </Button>
                        )}
                        {(entry.status === "pending" || entry.status === "error") && !isProcessing && (
                          <button
                            type="button"
                            onClick={() => removeFile(index)}
                            className="p-1.5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
