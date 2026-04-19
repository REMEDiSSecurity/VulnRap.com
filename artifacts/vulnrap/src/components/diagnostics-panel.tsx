import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChevronDown, ChevronUp, Activity, AlertCircle } from "lucide-react";

interface PerplexityBreakdown {
  bigramEntropy?: number;
  functionWordRate?: number;
  syntaxValidityScore?: number;
  combinedScore?: number;
  rawEngine1Score?: number;
  rawEngine1Verdict?: string;
}

interface EngineResult {
  engine: string;
  score: number;
  verdict: "GREEN" | "YELLOW" | "RED" | "GREY";
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  signalBreakdown?: Record<string, unknown> & { perplexity?: PerplexityBreakdown };
  note?: string;
}

interface PipelineStageTiming {
  stage: string;
  durationMs: number;
  startedAt?: number;
  endedAt?: number;
}

interface DiagnosticsResponse {
  reportId: number;
  correlationId: string | null;
  durationMs: number | null;
  composite: {
    score: number;
    label: string;
    overridesApplied: string[];
  } | null;
  legacyMapping: {
    slopScore: number;
    displayMode: string;
    note: string;
  } | null;
  featureFlags: Record<string, boolean | string>;
  trace: {
    correlationId: string;
    totalDurationMs: number;
    stages: PipelineStageTiming[];
    enginesUsed: string[];
    composite: {
      overallScore: number;
      label: string;
      overridesApplied: string[];
      warnings: string[];
    } | null;
    signalsSummary: {
      wordCount: number;
      codeBlockCount: number;
      realUrlCount: number;
      completenessScore: number;
      claimEvidenceRatio: number;
      claimedCwes: string[];
    } | null;
    featureFlags: Record<string, boolean | string>;
    notes: string[];
  } | null;
  engines: {
    engines?: EngineResult[];
    compositeBreakdown?: { weightedSum: number; totalWeight: number; beforeOverride: number; afterOverride: number };
    warnings?: string[];
    engineCount?: number;
  } | null;
}

const VERDICT_COLOR: Record<string, string> = {
  RED: "text-red-400 border-red-500/40",
  YELLOW: "text-yellow-400 border-yellow-500/40",
  GREEN: "text-green-400 border-green-500/40",
  GREY: "text-muted-foreground border-muted-foreground/30",
};

async function fetchDiagnostics(reportId: number): Promise<DiagnosticsResponse> {
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/reports/${reportId}/diagnostics`);
  if (!res.ok) {
    throw new Error(`Failed to load diagnostics: HTTP ${res.status}`);
  }
  return res.json();
}

export function DiagnosticsPanel({ reportId }: { reportId: number }) {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["report-diagnostics", reportId],
    queryFn: () => fetchDiagnostics(reportId),
    enabled: expanded,
    staleTime: 60_000,
  });

  const perplexity: PerplexityBreakdown | undefined =
    data?.engines?.engines?.find(e => !!e.signalBreakdown?.perplexity)?.signalBreakdown?.perplexity;
  const stages = data?.trace?.stages ?? [];
  const totalMs = data?.trace?.totalDurationMs ?? data?.durationMs ?? null;
  const overrides = data?.composite?.overridesApplied ?? data?.trace?.composite?.overridesApplied ?? [];
  const warnings = data?.engines?.warnings ?? data?.trace?.composite?.warnings ?? [];
  const compositeBreakdown = data?.engines?.compositeBreakdown;
  const signalsSummary = data?.trace?.signalsSummary ?? null;

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader className="cursor-pointer select-none" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="w-5 h-5 text-primary" />
              Why this score?
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono normal-case text-muted-foreground border-muted-foreground/30">
                Diagnostics
              </Badge>
            </CardTitle>
            <CardDescription className="mt-1">
              Pipeline timings, per-engine breakdown, applied overrides, perplexity signals, and the legacy slop-score mapping for triage auditing.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-expanded={expanded}
            aria-controls={`diagnostics-body-${reportId}`}
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="ml-1 text-xs">{expanded ? "Hide" : "Show"}</span>
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent id={`diagnostics-body-${reportId}`} className="space-y-5">
          {isLoading && (
            <div className="text-xs text-muted-foreground font-mono">Loading diagnostics…</div>
          )}

          {isError && (
            <div className="flex items-start gap-2 text-xs text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error instanceof Error ? error.message : "Failed to load diagnostics."}</span>
            </div>
          )}

          {data && (
            <>
              {data.composite && (
                <section className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Composite Breakdown</div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="Composite" value={`${data.composite.score}`} sub={data.composite.label} />
                    {compositeBreakdown && (
                      <>
                        <Stat label="Weighted Sum" value={compositeBreakdown.weightedSum.toFixed(2)} />
                        <Stat label="Total Weight" value={compositeBreakdown.totalWeight.toFixed(2)} />
                        <Stat
                          label="Before → After Override"
                          value={`${compositeBreakdown.beforeOverride} → ${compositeBreakdown.afterOverride}`}
                        />
                      </>
                    )}
                  </div>
                </section>
              )}

              {data.engines?.engines && data.engines.engines.length > 0 && (
                <>
                  <Separator className="bg-border/30" />
                  <section className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Per-Engine Scores</div>
                    <div className="space-y-1.5">
                      {data.engines.engines.map((eng) => (
                        <div key={eng.engine} className="flex items-center justify-between gap-2 text-xs font-mono">
                          <span className="truncate">{eng.engine}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${VERDICT_COLOR[eng.verdict] || ""}`}>
                              {eng.verdict}
                            </Badge>
                            {eng.confidence && (
                              <span className="text-[10px] text-muted-foreground uppercase">conf: {eng.confidence}</span>
                            )}
                            <span className="font-bold w-8 text-right">{eng.score}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}

              {signalsSummary && (
                <>
                  <Separator className="bg-border/30" />
                  <section className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Input Signals</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                      <Stat label="Word Count" value={`${signalsSummary.wordCount}`} />
                      <Stat label="Code Blocks" value={`${signalsSummary.codeBlockCount}`} />
                      <Stat label="Real URLs" value={`${signalsSummary.realUrlCount}`} />
                      <Stat
                        label="Completeness"
                        value={signalsSummary.completenessScore.toFixed(2)}
                        sub="0 – 1"
                      />
                      <Stat
                        label="Claim/Evidence"
                        value={signalsSummary.claimEvidenceRatio.toFixed(2)}
                        sub="ratio"
                      />
                    </div>
                    {signalsSummary.claimedCwes.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Claimed CWEs
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {signalsSummary.claimedCwes.map((cwe) => (
                            <Badge
                              key={cwe}
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 h-5 font-mono text-muted-foreground border-muted-foreground/30"
                            >
                              {cwe}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                </>
              )}

              {(overrides.length > 0 || warnings.length > 0) && (
                <>
                  <Separator className="bg-border/30" />
                  <section className="space-y-2">
                    {overrides.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Overrides Applied</div>
                        <ul className="space-y-0.5">
                          {overrides.map((rule, i) => (
                            <li key={i} className="text-[11px] font-mono text-orange-400/90">· {rule}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {warnings.length > 0 && (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Warnings</div>
                        <ul className="space-y-0.5">
                          {warnings.map((w, i) => (
                            <li key={i} className="text-[11px] font-mono text-yellow-400/90">· {w}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                </>
              )}

              {perplexity && (
                <>
                  <Separator className="bg-border/30" />
                  <section className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Perplexity Signals (Engine 1)</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {typeof perplexity.bigramEntropy === "number" && (
                        <Stat label="Bigram Entropy" value={perplexity.bigramEntropy.toFixed(3)} sub="bits (lower = more AI-like)" />
                      )}
                      {typeof perplexity.functionWordRate === "number" && (
                        <Stat label="Function-Word Rate" value={perplexity.functionWordRate.toFixed(2)} sub="per 1k tokens" />
                      )}
                      {typeof perplexity.syntaxValidityScore === "number" && (
                        <Stat label="Syntax Validity" value={perplexity.syntaxValidityScore.toFixed(2)} />
                      )}
                      {typeof perplexity.combinedScore === "number" && (
                        <Stat label="Combined AI-ness" value={perplexity.combinedScore.toFixed(1)} />
                      )}
                    </div>
                    {(typeof perplexity.rawEngine1Score === "number" || perplexity.rawEngine1Verdict) && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Raw Engine 1: <span className="font-mono">{perplexity.rawEngine1Score ?? "—"}</span>
                        {perplexity.rawEngine1Verdict ? ` (${perplexity.rawEngine1Verdict})` : ""} — blended with
                        the perplexity signals above to produce the final Engine 1 score.
                      </p>
                    )}
                  </section>
                </>
              )}

              <Separator className="bg-border/30" />
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Pipeline Timings</div>
                  {totalMs != null && (
                    <span className="text-[11px] font-mono text-muted-foreground">total {Math.round(totalMs)} ms</span>
                  )}
                </div>
                {stages.length > 0 ? (
                  <div className="space-y-1">
                    {stages.map((s, i) => {
                      const max = Math.max(1, ...stages.map(x => x.durationMs));
                      const pct = Math.min(100, (s.durationMs / max) * 100);
                      return (
                        <div key={`${s.stage}-${i}`} className="grid grid-cols-[1fr_auto] gap-2 items-center">
                          <div>
                            <div className="flex items-center justify-between text-[11px] font-mono">
                              <span className="truncate">{s.stage}</span>
                              <span className="text-muted-foreground">{s.durationMs} ms</span>
                            </div>
                            <div className="h-1 bg-muted/30 rounded overflow-hidden">
                              <div className="h-full bg-primary/60" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground">No stage timings recorded for this report.</div>
                )}
                {data.correlationId && (
                  <div className="text-[10px] font-mono text-muted-foreground pt-1">correlation: {data.correlationId}</div>
                )}
              </section>

              {data.legacyMapping && (
                <>
                  <Separator className="bg-border/30" />
                  <section className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Legacy Slop-Score Mapping</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <Stat label="Legacy Slop Score" value={`${data.legacyMapping.slopScore}`} sub="0 = clean · 100 = pure slop" />
                      <Stat label="Display Mode" value={data.legacyMapping.displayMode} />
                      <Stat
                        label="VULNRAP_USE_NEW_COMPOSITE"
                        value={String(data.featureFlags?.VULNRAP_USE_NEW_COMPOSITE ?? "—")}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{data.legacyMapping.note}</p>
                  </section>
                </>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-muted/10 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</div>
      <div className="font-mono text-sm font-semibold truncate" title={value}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground truncate" title={sub}>{sub}</div>}
    </div>
  );
}
