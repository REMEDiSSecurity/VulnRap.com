import { useState } from "react";
import { GitCompare, Loader2, CheckCircle, AlertTriangle, Layers, Search, ShieldCheck, Lightbulb, HelpCircle, BarChart3, Gauge, AlertCircle } from "lucide-react";
import { useCheckReport } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";

interface CompareResult {
  slopScore: number;
  slopTier: string;
  qualityScore?: number;
  confidence?: number;
  breakdown?: { linguistic?: number; factual?: number; template?: number; llm?: number | null; quality?: number };
  evidence?: Array<{ type: string; description: string; weight: number; matched?: string | null }>;
  feedback: string[];
  redactionSummary: { totalRedactions: number; categories: Record<string, number> };
  sectionHashes: Record<string, string>;
  llmEnhanced?: boolean;
}

function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md glass-card px-3 py-2 text-xs text-popover-foreground opacity-0 group-hover:opacity-100 transition-opacity z-50 glow-border text-left font-normal normal-case">
        {text}
      </span>
    </span>
  );
}

function getQualityColor(score: number) {
  if (score >= 70) return "text-green-500";
  if (score >= 40) return "text-yellow-500";
  return "text-destructive";
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "text-green-400";
  if (confidence >= 0.5) return "text-yellow-400";
  return "text-orange-400";
}

function computeSectionOverlap(
  hashesA: Record<string, string>,
  hashesB: Record<string, string>
): { identical: string[]; total: number } {
  const keysA = Object.entries(hashesA).filter(([k]) => k !== "__full_document");
  const valuesB = new Set(Object.entries(hashesB).filter(([k]) => k !== "__full_document").map(([, v]) => v));
  const identical = keysA.filter(([, v]) => valuesB.has(v)).map(([k]) => k);
  const allKeys = new Set([
    ...keysA.map(([k]) => k),
    ...Object.keys(hashesB).filter((k) => k !== "__full_document"),
  ]);
  return { identical, total: allKeys.size };
}

export default function Compare() {
  const { toast } = useToast();
  const settings = getSettings();
  const [textA, setTextA] = useState("");
  const [textB, setTextB] = useState("");
  const [resultA, setResultA] = useState<CompareResult | null>(null);
  const [resultB, setResultB] = useState<CompareResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const checkA = useCheckReport({
    mutation: {
      onSuccess: (data) => setResultA(data as unknown as CompareResult),
      onError: () => toast({ title: "Analysis failed", description: "Could not analyze Report A.", variant: "destructive" }),
    },
  });

  const checkB = useCheckReport({
    mutation: {
      onSuccess: (data) => setResultB(data as unknown as CompareResult),
      onError: () => toast({ title: "Analysis failed", description: "Could not analyze Report B.", variant: "destructive" }),
    },
  });

  const handleCompare = () => {
    const trimA = textA.trim();
    const trimB = textB.trim();
    if (!trimA || !trimB) {
      toast({ title: "Missing content", description: "Please paste text in both panels.", variant: "destructive" });
      return;
    }
    setResultA(null);
    setResultB(null);
    setAnalyzing(true);
    checkA.mutate({ data: { rawText: trimA } });
    checkB.mutate({ data: { rawText: trimB } });
  };

  const bothDone = resultA && resultB;
  if (analyzing && bothDone) {
    setAnalyzing(false);
  }
  const isPending = checkA.isPending || checkB.isPending;

  const sectionOverlap = bothDone
    ? computeSectionOverlap(resultA.sectionHashes, resultB.sectionHashes)
    : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <GitCompare className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Compare Two Reports
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Paste two vulnerability reports side by side. Both are analyzed independently and compared for section overlap. Nothing is stored.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="glass-card-accent rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Report A</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full h-48 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
              placeholder="Paste the first vulnerability report here..."
              value={textA}
              onChange={(e) => setTextA(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex justify-between items-center text-xs text-muted-foreground mt-1">
              <span>{textA.length > 0 ? `${textA.length.toLocaleString()} chars` : ""}</span>
              {textA.length > 0 && (
                <button type="button" className="hover:text-destructive transition-colors" onClick={() => { setTextA(""); setResultA(null); }}>Clear</button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card-accent rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Report B</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              className="w-full h-48 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
              placeholder="Paste the second vulnerability report here..."
              value={textB}
              onChange={(e) => setTextB(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex justify-between items-center text-xs text-muted-foreground mt-1">
              <span>{textB.length > 0 ? `${textB.length.toLocaleString()} chars` : ""}</span>
              {textB.length > 0 && (
                <button type="button" className="hover:text-destructive transition-colors" onClick={() => { setTextB(""); setResultB(null); }}>Clear</button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Button
        className="w-full h-11 sm:h-12 text-base sm:text-lg font-bold gap-2 glow-button"
        onClick={handleCompare}
        disabled={!textA.trim() || !textB.trim() || isPending}
      >
        {isPending ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing Both Reports...</>
        ) : (
          <><GitCompare className="w-5 h-5" /> Compare Reports</>
        )}
      </Button>

      {bothDone && (
        <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          {sectionOverlap && sectionOverlap.total > 0 && (
            <Card className="glass-card-accent rounded-xl border-primary/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Layers className="w-5 h-5 text-primary" />
                  Section Overlap
                  <Hint text="Sections are parsed from each report independently, then their SHA-256 hashes are compared. Identical hashes mean the section content is exactly the same after redaction." />
                </CardTitle>
                <CardDescription>
                  {sectionOverlap.identical.length} of {sectionOverlap.total} unique sections are identical between the two reports
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sectionOverlap.identical.length > 0 ? (
                  <div className="space-y-2">
                    {sectionOverlap.identical.map((section) => (
                      <div key={section} className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
                        <strong>{section}</strong>
                        <span className="text-muted-foreground">— identical in both reports</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 py-4 justify-center text-center">
                    <div className="p-2 rounded-full icon-glow-green">
                      <CheckCircle className="w-6 h-6 text-green-400" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">No identical sections</p>
                      <p className="text-xs text-muted-foreground">These reports appear to be independently written.</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: "Report A", result: resultA },
              { label: "Report B", result: resultB },
            ].map(({ label, result }) => {
              const slopColor = getSlopColorCustom(result!.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh);
              const progressColor = getSlopProgressColorCustom(result!.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh);
              const bd = result!.breakdown;
              return (
                <Card key={label} className="glass-card rounded-xl">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                      {label}
                      <Badge variant="outline" className="text-[10px]">Not stored</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center">
                        <div className="text-[9px] text-muted-foreground uppercase">Slop</div>
                        <div className={`text-3xl font-bold font-mono ${slopColor} glow-text`}>
                          {result!.slopScore}
                        </div>
                      </div>
                      {result!.qualityScore != null && (
                        <>
                          <div className="h-10 w-px bg-border/30" />
                          <div className="flex flex-col items-center">
                            <div className="text-[9px] text-muted-foreground uppercase">Quality</div>
                            <div className={`text-3xl font-bold font-mono ${getQualityColor(result!.qualityScore)}`}>
                              {result!.qualityScore}
                            </div>
                          </div>
                        </>
                      )}
                      <div className="flex-1 space-y-1 ml-2">
                        <div className="text-xs font-medium uppercase">{result!.slopTier}</div>
                        <Progress value={result!.slopScore} className="h-1.5" indicatorClassName={progressColor} />
                        {result!.confidence != null && (
                          <div className="flex items-center gap-1 text-[10px]">
                            <Gauge className="w-3 h-3 text-muted-foreground" />
                            <span className={`font-mono ${getConfidenceColor(result!.confidence)}`}>
                              {(result!.confidence * 100).toFixed(0)}% — {result!.confidence >= 0.8 ? "High" : result!.confidence >= 0.5 ? "Medium" : "Low"}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {bd && (
                      <>
                        <Separator className="bg-border/30" />
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <BarChart3 className="w-3 h-3 text-primary" />
                            Breakdown
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                            {[
                              { label: "Ling", score: bd.linguistic ?? 0 },
                              { label: "Fact", score: bd.factual ?? 0 },
                              { label: "Tmpl", score: bd.template ?? 0 },
                              { label: "LLM", score: bd.llm },
                            ].map(({ label, score }) => (
                              <div key={label} className="flex items-center justify-between text-[10px]">
                                <span className="text-muted-foreground">{label}</span>
                                {score != null ? (
                                  <span className={`font-mono font-bold ${(score as number) >= 50 ? "text-destructive" : (score as number) >= 25 ? "text-yellow-500" : "text-green-500"}`}>{score}</span>
                                ) : (
                                  <span className="font-mono text-muted-foreground/50">N/A</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {result!.evidence && result!.evidence.length > 0 && (
                      <>
                        <Separator className="bg-border/30" />
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <AlertCircle className="w-3 h-3 text-primary" />
                          {result!.evidence.length} evidence signal{result!.evidence.length !== 1 ? "s" : ""}
                        </div>
                      </>
                    )}

                    {result!.redactionSummary.totalRedactions > 0 && (
                      <>
                        <Separator className="bg-border/30" />
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
                          {result!.redactionSummary.totalRedactions} items redacted
                        </div>
                      </>
                    )}

                    {result!.feedback.length > 0 && (
                      <>
                        <Separator className="bg-border/30" />
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Lightbulb className="w-3.5 h-3.5 text-primary" />
                            Feedback
                          </div>
                          <ul className="space-y-1">
                            {result!.feedback.slice(0, 5).map((item, i) => (
                              <li key={i} className="flex items-start gap-2 text-xs">
                                <div className="mt-1.5 w-1 h-1 rounded-full bg-primary flex-shrink-0" />
                                <span>{item}</span>
                              </li>
                            ))}
                            {result!.feedback.length > 5 && (
                              <li className="text-xs text-muted-foreground pl-3">
                                +{result!.feedback.length - 5} more
                              </li>
                            )}
                          </ul>
                        </div>
                      </>
                    )}

                    {Object.keys(result!.sectionHashes).filter((k) => k !== "__full_document").length > 0 && (
                      <>
                        <Separator className="bg-border/30" />
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Layers className="w-3.5 h-3.5 text-primary" />
                          {Object.keys(result!.sectionHashes).filter((k) => k !== "__full_document").length} sections parsed
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              className="gap-2 glass-card hover:border-primary/30"
              onClick={() => {
                setTextA("");
                setTextB("");
                setResultA(null);
                setResultB(null);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <GitCompare className="w-4 h-4" />
              Compare Another Pair
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
