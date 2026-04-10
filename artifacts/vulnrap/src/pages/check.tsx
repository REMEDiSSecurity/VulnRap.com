import { useState, useRef } from "react";
import { UploadCloud, Shield, Loader2, CheckCircle, XCircle, Search, AlertTriangle, ClipboardPaste, Hash, Layers, Lightbulb, ShieldCheck, HelpCircle, ExternalLink } from "lucide-react";
import { useCheckReport } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Link } from "react-router-dom";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md"];

type InputMode = "file" | "text";

function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(e => ext.endsWith(e));
  if (!hasValidExt) return `Unsupported file type. Accepted formats: ${ALLOWED_EXTENSIONS.join(", ")}`;
  if (file.size > MAX_FILE_SIZE) return `File too large. Maximum size is 20MB.`;
  if (file.size === 0) return "File is empty.";
  return null;
}

function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-popover border border-border px-3 py-2 text-xs text-popover-foreground opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg text-left font-normal normal-case">
        {text}
      </span>
    </span>
  );
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

function anonymizeId(id: number): string {
  return `VR-${id.toString(16).padStart(4, "0").toUpperCase()}`;
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

interface CheckResultData {
  slopScore: number;
  slopTier: string;
  similarityMatches: Array<{ reportId: number; similarity: number; matchType: string }>;
  sectionHashes: Record<string, string>;
  sectionMatches: Array<{ sectionTitle: string; matchedReportId: number; matchedSectionTitle: string; similarity: number }>;
  redactionSummary: { totalRedactions: number; categories: Record<string, number> };
  feedback: string[];
  previouslySubmitted: boolean;
  existingReportId?: number | null;
}

export default function Check() {
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("text");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<CheckResultData | null>(null);

  const checkMutation = useCheckReport({
    mutation: {
      onSuccess: (data) => {
        setResult(data as unknown as CheckResultData);
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
      checkMutation.mutate({ data: { file } });
    } else {
      const trimmed = rawText.trim();
      if (!trimmed) {
        toast({ title: "No text", description: "Please paste report text first.", variant: "destructive" });
        return;
      }
      checkMutation.mutate({ data: { rawText: trimmed } });
    }
  };

  const hasContent = inputMode === "file" ? !!file : rawText.trim().length > 0;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="space-y-2 pt-4">
        <h1 className="text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-3">
          <Shield className="w-8 h-8" />
          Check a Report
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          For bug bounty programs and report receivers. Check an incoming vulnerability report against our database for duplicates and AI-generated content. Nothing is stored -- this is a read-only check.
        </p>
      </div>

      <Card className="border-primary/20 bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            Paste or Upload the Report
            <Hint text="This check runs the full analysis pipeline (redaction, similarity, slop scoring) but does NOT store the report in our database. Use this to validate incoming reports without contributing to the corpus." />
          </CardTitle>
          <CardDescription>Analysis only -- nothing is stored or saved</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors",
                inputMode === "text" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted text-muted-foreground"
              )}
              onClick={() => setInputMode("text")}
            >
              <ClipboardPaste className="w-4 h-4" />
              Paste Text
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-medium transition-colors border-l border-border",
                inputMode === "file" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted text-muted-foreground"
              )}
              onClick={() => setInputMode("file")}
            >
              <UploadCloud className="w-4 h-4" />
              Upload File
            </button>
          </div>

          {inputMode === "text" ? (
            <div className="space-y-2">
              <textarea
                className="w-full h-48 rounded-lg border border-border bg-background p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary placeholder:text-muted-foreground/50"
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
          ) : (
            <div
              className={cn(
                "border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer",
                isDragging ? "border-primary bg-primary/5" : "border-muted hover:border-primary/50",
                file && !fileError ? "border-primary/50 bg-primary/5" : "",
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
                  <span className="text-xs text-muted-foreground">.txt, .md (max 20MB)</span>
                </>
              )}
              {fileError && <span className="text-xs text-destructive">{fileError}</span>}
            </div>
          )}
        </CardContent>
        <CardFooter>
          <Button
            className="w-full h-12 text-lg font-bold gap-2"
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

      {result && (
        <div className="space-y-6">
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <CheckCircle className="w-6 h-6 text-primary" />
            Check Results
            <Badge variant="outline" className="ml-2 text-xs">Not stored</Badge>
          </h2>

          {result.previouslySubmitted && (
            <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
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
            <Card className="border-primary/20 bg-card/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">AI Sloppiness Score</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-center py-4">
                <div className={`text-5xl font-bold font-mono ${getSlopColor(result.slopScore)}`}>{result.slopScore}</div>
                <div className="mt-2 text-sm font-medium uppercase">{result.slopTier}</div>
                <div className="w-full max-w-xs mt-4">
                  <Progress value={result.slopScore} className="h-2" indicatorClassName={getSlopProgressColor(result.slopScore)} />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-card/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Similarity Check</CardTitle>
              </CardHeader>
              <CardContent>
                {result.similarityMatches.length > 0 ? (
                  <div className="space-y-3">
                    {result.similarityMatches.map((match, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="font-mono text-sm text-primary">{anonymizeId(match.reportId)}</span>
                        <div className="flex items-center gap-2">
                          <Progress value={match.similarity} className="w-24 h-2" indicatorClassName={match.similarity > 80 ? "bg-destructive" : "bg-primary"} />
                          <span className="font-mono text-sm w-12 text-right">{Math.round(match.similarity)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-4 text-center">
                    <CheckCircle className="w-8 h-8 text-green-500 mb-2" />
                    <span className="text-sm font-medium">No duplicates found</span>
                    <span className="text-xs text-muted-foreground">Unique in our database</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {result.redactionSummary.totalRedactions > 0 && (
            <Card className="bg-card/40 border-green-500/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="w-4 h-4 text-green-500" />
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
            <Card className="bg-card/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Layers className="w-4 h-4 text-primary" />
                  Matching Sections
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.sectionMatches.map((match, i) => (
                  <div key={i} className="bg-yellow-500/10 border border-yellow-500/20 rounded p-3 text-sm flex justify-between items-center">
                    <span><strong>{match.sectionTitle}</strong> matches {anonymizeId(match.matchedReportId)}</span>
                    <Badge variant="secondary" className="font-mono">{match.similarity}%</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {result.feedback.length > 0 && (
            <Card className="bg-card/40">
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
        </div>
      )}
    </div>
  );
}
