import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChevronDown, ChevronUp, Activity, AlertCircle, Download, ClipboardCopy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Task 62: keep in sync with VerificationMode in
// artifacts/api-server/src/lib/engines/avri/families.ts.
type VerificationModeUI = "SOURCE_CODE" | "ENDPOINT" | "MANUAL_ONLY" | "GENERIC";

const VERIFICATION_MODE_DESCRIPTION: Record<VerificationModeUI, string> = {
  SOURCE_CODE:
    "Probes detected GitHub repos for the file paths and symbols cited in the report; PoC/endpoint plausibility checks are skipped.",
  ENDPOINT:
    "Runs PoC plausibility checks (URLs, payloads, HTTP responses); GitHub source-path probes are skipped because endpoint-class bugs live or die by the request, not the file tree.",
  MANUAL_ONLY:
    "Automated source/endpoint probes are not meaningful for this family — the report needs a human reviewer to reproduce. Only CVE existence is checked.",
  GENERIC:
    "No specific CWE family detected — runs both GitHub source-path checks and endpoint/PoC plausibility checks (legacy behavior).",
};

const VERIFICATION_MODE_TONE: Record<VerificationModeUI, string> = {
  SOURCE_CODE: "text-blue-400 border-blue-500/40",
  ENDPOINT: "text-purple-400 border-purple-500/40",
  MANUAL_ONLY: "text-yellow-400 border-yellow-500/40",
  GENERIC: "text-muted-foreground border-muted-foreground/30",
};

interface PerplexityBreakdown {
  bigramEntropy?: number;
  functionWordRate?: number;
  syntaxValidityScore?: number;
  combinedScore?: number;
  rawEngine1Score?: number;
  rawEngine1Verdict?: string;
}

interface TriggeredIndicator {
  signal?: string;
  value?: unknown;
  threshold?: number;
  strength?: "HIGH" | "MEDIUM" | "LOW";
  explanation?: string;
}

interface EngineResult {
  engine: string;
  score: number;
  verdict: "GREEN" | "YELLOW" | "RED" | "GREY";
  confidence?: "HIGH" | "MEDIUM" | "LOW";
  triggeredIndicators?: TriggeredIndicator[];
  signalBreakdown?: Record<string, unknown> & { perplexity?: PerplexityBreakdown };
  note?: string;
}

interface PipelineStageTiming {
  stage: string;
  durationMs: number;
  startedAt?: number;
  endedAt?: number;
}

export interface AvriDiagnosticsBlock {
  family: string;
  familyName: string;
  classification: {
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reason: string;
    evidence: string[];
    technology: string | null;
  };
  goldHitCount: number;
  velocityPenalty: number;
  templatePenalty: number;
  rawCompositeBeforeBehavioralPenalties: number;
}

export interface DiagnosticsResponse {
  reportId: number;
  correlationId: string | null;
  durationMs: number | null;
  composite: {
    score: number;
    label: string;
    overridesApplied: string[];
  } | null;
  /** AVRI composite block; present when VULNRAP_USE_AVRI=true at analysis time. */
  avri?: AvriDiagnosticsBlock | null;
  /**
   * Sprint 12 — Cached AVRI rubric family id from the reports row. Populated for
   * any report (legacy or fresh) that has the column set, so the panel can show
   * the family even when the in-memory `avri` block above is missing.
   */
  cachedAvriFamily?: string | null;
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

export async function fetchDiagnostics(reportId: number): Promise<DiagnosticsResponse> {
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/api/reports/${reportId}/diagnostics`);
  if (!res.ok) {
    throw new Error(`Failed to load diagnostics: HTTP ${res.status}`);
  }
  return res.json();
}

export function DiagnosticsPanel({ reportId }: { reportId: number }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["report-diagnostics", reportId],
    queryFn: () => fetchDiagnostics(reportId),
    enabled: expanded,
    staleTime: 60_000,
  });

  const exportJSON = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vulnrap-diagnostics-${reportId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: "Diagnostics JSON downloaded." });
  };

  const copyMarkdown = async () => {
    if (!data) return;
    const md = buildMarkdownSummary(data);
    try {
      await navigator.clipboard.writeText(md);
      toast({ title: "Copied", description: "Diagnostics markdown summary copied to clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Could not copy to clipboard.", variant: "destructive" });
    }
  };

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
          <div className="flex items-center gap-2 shrink-0">
            {expanded && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8"
                  disabled={!data}
                  aria-label="Export diagnostics JSON"
                  onClick={(e) => { e.stopPropagation(); exportJSON(); }}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="text-xs">Export JSON</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8"
                  disabled={!data}
                  aria-label="Copy diagnostics markdown summary"
                  onClick={(e) => { e.stopPropagation(); void copyMarkdown(); }}
                >
                  <ClipboardCopy className="w-3.5 h-3.5" />
                  <span className="text-xs">Copy Markdown</span>
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-controls={`diagnostics-body-${reportId}`}
              onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <span className="ml-1 text-xs">{expanded ? "Hide" : "Show"}</span>
            </Button>
          </div>
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
                        <EngineRow key={eng.engine} eng={eng} />
                      ))}
                    </div>
                  </section>
                  <EvidenceStrengthSection engines={data.engines.engines} />
                </>
              )}

              {/* AVRI section is rendered outside the engines gate so a
                  partial-data row with a top-level `avri` block (but no
                  engineResults persisted) still surfaces the family rubric. */}
              <AvriFamilySection
                avri={data.avri ?? null}
                engines={data.engines?.engines ?? []}
                overrides={overrides}
                cachedFamily={data.cachedAvriFamily ?? null}
              />

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

// Sprint 11 / Task 60: Render the AVRI family rubric used for this report —
// detected family + classification confidence, expected vs found gold signals,
// any absence penalties applied, contradictions, and AVRI composite overrides.
// Pulls structured data from Engine 2's signalBreakdown.avri (per-signal
// descriptions) and merges it with the composite-level avri block (family
// classification reason / behavioural penalties).
interface AvriEngine2Breakdown {
  family?: string;
  familyName?: string;
  baseScore?: number;
  goldHitCount?: number;
  goldTotalCount?: number;
  goldHits?: Array<{ id: string; description: string; points: number }>;
  goldMisses?: Array<{ id: string; description: string; points: number }>;
  absencePenalty?: number;
  absencePenalties?: Array<{ id: string; description: string; points: number }>;
  contradictions?: string[];
  contradictionPenalty?: number;
  // Sprint 11 / Task 78: stripped-crash-trace block written by Engine 2
  // when a MEMORY_CORRUPTION report's stack trace had no resolvable
  // symbols / contained placeholder offsets. The presence of this block
  // (with isStripped=true) is what triggers the STRIPPED_CRASH_TRACE
  // indicator and the trace-gold revocation surfaced in the panel.
  crashTrace?: {
    framesAnalyzed: number;
    goodFrames: number;
    placeholderFrames: number;
    isStripped: boolean;
    reason: string | null;
    revokedGoldHits: Array<{ id: string; points: number }>;
    penalty: number;
  } | null;
  // Sprint 12 / Task 93: fake-raw-HTTP block written by Engine 2 when a
  // REQUEST_SMUGGLING report's raw HTTP request bytes are fabricated
  // (placeholder header values, no CRLFs, or incoherent TE/CL conflict).
  // The presence of this block (with isFake=true) is what triggers the
  // FAKE_RAW_HTTP indicator and the smuggling-gold revocation surfaced in
  // the panel and the printable export.
  rawHttp?: {
    requestsAnalyzed: number;
    totalHeaders: number;
    placeholderHeaders: number;
    crlfPresent: boolean;
    teClConflicts: number;
    teClBroken: number;
    isFake: boolean;
    reason: string | null;
    revokedGoldHits: Array<{ id: string; points: number }>;
    penalty: number;
  } | null;
  rawAvriScore?: number;
  legacyScore?: number;
  blendedScore?: number;
}

const AVRI_OVERRIDE_LABELS: Array<{ token: string; label: string; tone: string }> = [
  { token: "AVRI_NO_GOLD_SIGNALS", label: "No gold signals for family", tone: "text-red-400" },
  { token: "AVRI_FAMILY_CONTRADICTION", label: "Report contradicts claimed family", tone: "text-red-400" },
  { token: "AVRI_VELOCITY", label: "Submission-velocity penalty", tone: "text-orange-400" },
  { token: "AVRI_TEMPLATE_CAMPAIGN", label: "Template fingerprint reused", tone: "text-orange-400" },
];

function AvriFamilySection({
  avri,
  engines,
  overrides,
  cachedFamily,
}: {
  avri: AvriDiagnosticsBlock | null;
  engines: EngineResult[];
  overrides: string[];
  /**
   * Sprint 12 — Cached AVRI rubric family from the reports row. When the live
   * `avri` block is missing (legacy report or AVRI disabled at write time) we
   * still render a minimal banner so reviewers see which family the report-feed
   * filter is grouping it under.
   */
  cachedFamily?: string | null;
}) {
  const e2 = engines.find((e) => /Technical Substance/i.test(e.engine));
  const e2Avri = (e2?.signalBreakdown?.avri ?? null) as AvriEngine2Breakdown | null;

  // Nothing to show if AVRI didn't run *and* we don't have a cached family on
  // the row. Keep the cached-family-only branch lightweight rather than going
  // through the full rubric layout that needs gold-signal data.
  if (!avri && !e2Avri) {
    if (cachedFamily) {
      return (
        <>
          <Separator className="bg-border/30" />
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                AVRI Family Rubric
              </div>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-5 font-mono normal-case border-primary/40 text-primary"
              >
                {cachedFamily}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Cached family from <code className="text-primary/80">reports.avri_family</code>.
              The full AVRI rubric breakdown isn&apos;t available for this report
              (analyzed before AVRI scoring was enabled).
            </p>
          </section>
        </>
      );
    }
    return null;
  }

  const familyName = avri?.familyName ?? e2Avri?.familyName ?? avri?.family ?? e2Avri?.family ?? "—";
  const familyId = avri?.family ?? e2Avri?.family ?? "—";
  const isFlat = familyId === "FLAT";
  const goldHits = e2Avri?.goldHits ?? [];
  const goldMisses = e2Avri?.goldMisses ?? [];
  const absencePenalties = e2Avri?.absencePenalties ?? [];
  const contradictions = e2Avri?.contradictions ?? [];
  const goldHitCount = e2Avri?.goldHitCount ?? avri?.goldHitCount ?? 0;
  const goldTotalCount = e2Avri?.goldTotalCount ?? goldHits.length + goldMisses.length;
  const crashTrace = e2Avri?.crashTrace ?? null;
  // Sprint 11 / Task 85: the same stripped-trace validator runs for both
  // MEMORY_CORRUPTION (crash traces) and RACE_CONCURRENCY (TSan/Helgrind/DRD
  // tool traces). Pick wording that reads naturally for whichever family
  // produced the downgrade so reviewers see "race trace" / "tool trace"
  // instead of "crash trace" on a race report.
  const traceKindLabel =
    familyId === "RACE_CONCURRENCY" ? "race trace" : familyId === "MEMORY_CORRUPTION" ? "crash trace" : "tool trace";
  const matchingOverrides = overrides
    .map((rule) => {
      const meta = AVRI_OVERRIDE_LABELS.find((m) => rule.startsWith(m.token));
      return meta ? { rule, ...meta } : null;
    })
    .filter((x): x is { rule: string; token: string; label: string; tone: string } => x !== null);

  return (
    <>
      <Separator className="bg-border/30" />
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            AVRI Family Rubric
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-5 font-mono normal-case border-primary/40 text-primary"
            >
              {familyName}
            </Badge>
            {avri?.classification?.confidence && (
              <span className="text-[10px] uppercase text-muted-foreground font-mono">
                class: {avri.classification.confidence}
              </span>
            )}
          </div>
        </div>

        {avri?.classification?.reason && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {avri.classification.reason}
            {avri.classification.technology ? ` · stack: ${avri.classification.technology}` : ""}
          </p>
        )}

        {isFlat ? (
          <div className="text-[11px] text-muted-foreground">
            No specific CWE family detected — generic substance scoring used (no family rubric applied).
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Gold Signals" value={`${goldHitCount}/${goldTotalCount}`} sub="hit / expected" />
              <Stat label="Base Score" value={`${e2Avri?.baseScore ?? "—"}`} sub="from gold signals" />
              <Stat
                label="Absence Penalty"
                value={`${e2Avri?.absencePenalty ?? 0}`}
                sub="post-normalization"
              />
              <Stat
                label="Contradiction Penalty"
                value={`${e2Avri?.contradictionPenalty ?? 0}`}
                sub={contradictions.length > 0 ? `${contradictions.length} phrase(s)` : "none"}
              />
            </div>

            {(goldHits.length > 0 || goldMisses.length > 0) && (
              <div className="space-y-2">
                {goldHits.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Gold Signals Found
                    </div>
                    <ul className="space-y-0.5">
                      {goldHits.map((g) => (
                        <li key={g.id} className="text-[11px] font-mono text-green-400/90 flex items-baseline gap-1">
                          <span>+{g.points}</span>
                          <span className="text-foreground/80">{g.description}</span>
                          <span className="text-muted-foreground">({g.id})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {goldMisses.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Expected Signals Missing
                    </div>
                    <ul className="space-y-0.5">
                      {goldMisses.map((g) => (
                        <li key={g.id} className="text-[11px] font-mono text-muted-foreground flex items-baseline gap-1">
                          <span className="text-red-400/80">−{g.points}</span>
                          <span>{g.description}</span>
                          <span>({g.id})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {absencePenalties.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Absence Penalties Applied
                </div>
                <ul className="space-y-0.5">
                  {absencePenalties.map((a) => (
                    <li key={a.id} className="text-[11px] font-mono text-orange-400/90 flex items-baseline gap-1">
                      <span>−{a.points}</span>
                      <span className="text-foreground/80">{a.description}</span>
                      <span className="text-muted-foreground">({a.id})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {contradictions.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Contradiction Phrases
                </div>
                <div className="flex flex-wrap gap-1">
                  {contradictions.map((c, i) => (
                    <Badge
                      key={`${c}-${i}`}
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-5 font-mono text-red-400 border-red-500/40"
                    >
                      “{c}”
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {crashTrace?.isStripped && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 space-y-2">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-5 font-mono text-red-400 border-red-500/40"
                  >
                    STRIPPED_CRASH_TRACE
                  </Badge>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {traceKindLabel} downgraded ({crashTrace.penalty})
                  </span>
                </div>
                {crashTrace.reason && (
                  <p className="text-[11px] text-red-300/90 leading-relaxed">
                    {crashTrace.reason}
                  </p>
                )}
                <div className="flex flex-wrap gap-3 text-[11px] font-mono text-muted-foreground">
                  <span>frames: {crashTrace.framesAnalyzed}</span>
                  <span className="text-green-400/80">good: {crashTrace.goodFrames}</span>
                  <span className="text-red-400/80">placeholder: {crashTrace.placeholderFrames}</span>
                </div>
                {crashTrace.revokedGoldHits.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Trace Gold Signals Revoked
                    </div>
                    <ul className="space-y-0.5">
                      {crashTrace.revokedGoldHits.map((r) => (
                        <li
                          key={r.id}
                          className="text-[11px] font-mono text-red-400/90 flex items-baseline gap-1"
                        >
                          <span>−{r.points}</span>
                          <span className="text-foreground/80">{r.id}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {(matchingOverrides.length > 0 ||
          (avri && (avri.velocityPenalty < 0 || avri.templatePenalty < 0))) && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              AVRI Composite Overrides
            </div>
            <ul className="space-y-0.5">
              {matchingOverrides.map((o) => (
                <li key={o.rule} className={`text-[11px] font-mono ${o.tone}`}>
                  · {o.label}
                  <span className="text-muted-foreground"> — {o.rule}</span>
                </li>
              ))}
              {avri && avri.velocityPenalty < 0 && !matchingOverrides.some((o) => o.token === "AVRI_VELOCITY") && (
                <li className="text-[11px] font-mono text-orange-400">
                  · Submission-velocity penalty applied: {avri.velocityPenalty}
                </li>
              )}
              {avri && avri.templatePenalty < 0 && !matchingOverrides.some((o) => o.token === "AVRI_TEMPLATE_CAMPAIGN") && (
                <li className="text-[11px] font-mono text-orange-400">
                  · Template-fingerprint penalty applied: {avri.templatePenalty}
                </li>
              )}
            </ul>
            {avri && typeof avri.rawCompositeBeforeBehavioralPenalties === "number" && (
              <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                composite before behavioural penalties: {avri.rawCompositeBeforeBehavioralPenalties}
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
}

// v3.6.0 §9: Surface Engine 2 evidence-type signals (multipliers) and active
// verification source breakdown when present in signalBreakdown.
function EvidenceStrengthSection({ engines }: { engines: EngineResult[] }) {
  const e2 = engines.find(e => /Technical Substance/i.test(e.engine));
  const sb = (e2?.signalBreakdown ?? {}) as Record<string, unknown>;
  const ev = sb.evidenceStrength as
    | { bonus?: number; strongCount?: number; signalCount?: number; signals?: Array<{ type: string; weight?: number; multiplier?: number }> }
    | undefined;
  const verifyBreakdown = sb.verificationSources as
    | { referenced?: number; fallback?: number; verified?: number; total?: number }
    | undefined;
  // Task 62: routing decision recorded by performActiveVerification — which
  // verification mode ran (SOURCE_CODE / ENDPOINT / MANUAL_ONLY / GENERIC)
  // and the AVRI family that drove it.
  const activeVerif = sb.activeVerification as
    | { mode?: VerificationModeUI; familyName?: string | null; skipReason?: string | null }
    | undefined;
  if (!ev && !verifyBreakdown && !activeVerif) return null;
  return (
    <>
      <Separator className="bg-border/30" />
      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Engine 2 — Evidence Strength &amp; Verification Sources
        </div>
        {activeVerif?.mode && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
              <span className="text-muted-foreground">Active verification mode:</span>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 h-5 font-mono ${VERIFICATION_MODE_TONE[activeVerif.mode]}`}
              >
                {activeVerif.mode}
              </Badge>
              {activeVerif.familyName && (
                <span className="text-muted-foreground">— {activeVerif.familyName}</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {VERIFICATION_MODE_DESCRIPTION[activeVerif.mode]}
            </p>
            {activeVerif.mode === "MANUAL_ONLY" && activeVerif.skipReason && (
              <p className="text-[11px] font-mono text-yellow-400/90 leading-relaxed">
                {activeVerif.skipReason}
              </p>
            )}
          </div>
        )}
        {ev && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span>bonus: <span className="font-bold">+{ev.bonus ?? 0}</span></span>
              <span className="text-muted-foreground">
                strong: {ev.strongCount ?? 0}/{ev.signalCount ?? 0}
              </span>
            </div>
            {Array.isArray(ev.signals) && ev.signals.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {ev.signals.slice(0, 12).map((s, i) => (
                  <Badge
                    key={`${s.type}-${i}`}
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-5 font-mono"
                  >
                    {s.type}
                    {typeof s.multiplier === "number" ? ` ×${s.multiplier}` : ""}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
        {verifyBreakdown && (
          <div className="text-[11px] font-mono text-muted-foreground">
            verified {verifyBreakdown.verified ?? 0}/{verifyBreakdown.total ?? 0}
            {" · "}referenced: {verifyBreakdown.referenced ?? 0}
            {" · "}search-fallback: {verifyBreakdown.fallback ?? 0}
          </div>
        )}
      </section>
    </>
  );
}

export function buildMarkdownSummary(data: DiagnosticsResponse): string {
  const lines: string[] = [];
  lines.push(`# VulnRap Diagnostics — Report ${data.reportId}`);
  if (data.correlationId) lines.push(`_Correlation: \`${data.correlationId}\`_`);
  lines.push("");

  const totalMs = data.trace?.totalDurationMs ?? data.durationMs;
  if (totalMs != null) {
    lines.push(`**Total pipeline duration:** ${Math.round(totalMs)} ms`);
    lines.push("");
  }

  if (data.composite) {
    lines.push("## Composite");
    lines.push(`- Score: **${data.composite.score}** (${data.composite.label})`);
    const cb = data.engines?.compositeBreakdown;
    if (cb) {
      lines.push(`- Weighted Sum: ${cb.weightedSum.toFixed(2)} / Total Weight: ${cb.totalWeight.toFixed(2)}`);
      lines.push(`- Before → After Override: ${cb.beforeOverride} → ${cb.afterOverride}`);
    }
    lines.push("");
  }

  const engines = data.engines?.engines ?? [];
  if (engines.length > 0) {
    lines.push("## Per-Engine Scores");
    lines.push("| Engine | Score | Verdict | Confidence |");
    lines.push("| --- | --- | --- | --- |");
    for (const e of engines) {
      lines.push(`| ${e.engine} | ${e.score} | ${e.verdict} | ${e.confidence ?? "—"} |`);
    }
    lines.push("");
    for (const e of engines) {
      const indicators = e.triggeredIndicators ?? [];
      if (indicators.length === 0) continue;
      lines.push(`### Triggered Indicators — ${e.engine}`);
      for (const s of STRENGTH_ORDER) {
        const items = indicators.filter((i) => i.strength === s);
        if (items.length === 0) continue;
        lines.push(`- **${s}**`);
        for (const ind of items) {
          const valueStr = formatIndicatorValue(ind.value);
          const parts: string[] = [];
          if (valueStr !== null) parts.push(`value: ${valueStr}`);
          if (typeof ind.threshold === "number") parts.push(`threshold: ${ind.threshold}`);
          const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          lines.push(`  - \`${ind.signal ?? "—"}\`${meta}${ind.explanation ? ` — ${ind.explanation}` : ""}`);
        }
      }
      const unspecified = indicators.filter(
        (i) => i.strength !== "HIGH" && i.strength !== "MEDIUM" && i.strength !== "LOW",
      );
      if (unspecified.length > 0) {
        lines.push(`- **UNSPECIFIED**`);
        for (const ind of unspecified) {
          const valueStr = formatIndicatorValue(ind.value);
          const parts: string[] = [];
          if (valueStr !== null) parts.push(`value: ${valueStr}`);
          if (typeof ind.threshold === "number") parts.push(`threshold: ${ind.threshold}`);
          const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          lines.push(`  - \`${ind.signal ?? "—"}\`${meta}${ind.explanation ? ` — ${ind.explanation}` : ""}`);
        }
      }
      lines.push("");
    }
  }

  const overrides = data.composite?.overridesApplied ?? data.trace?.composite?.overridesApplied ?? [];
  if (overrides.length > 0) {
    lines.push("## Overrides Applied");
    for (const o of overrides) lines.push(`- ${o}`);
    lines.push("");
  }

  const e2EngineForAvri = data.engines?.engines?.find((e) => /Technical Substance/i.test(e.engine));
  const e2Avri = (e2EngineForAvri?.signalBreakdown?.avri ?? null) as AvriEngine2Breakdown | null;
  if (data.avri || e2Avri) {
    const familyName = data.avri?.familyName ?? e2Avri?.familyName ?? data.avri?.family ?? e2Avri?.family ?? "—";
    lines.push("## AVRI Family Rubric");
    lines.push(`- Family: **${familyName}**`);
    if (data.avri?.classification?.confidence) {
      lines.push(`- Classification confidence: ${data.avri.classification.confidence}`);
    }
    if (data.avri?.classification?.reason) {
      lines.push(`- Classification reason: ${data.avri.classification.reason}`);
    }
    const goldTotal = e2Avri?.goldTotalCount ?? ((e2Avri?.goldHits?.length ?? 0) + (e2Avri?.goldMisses?.length ?? 0));
    lines.push(`- Gold signals: ${e2Avri?.goldHitCount ?? data.avri?.goldHitCount ?? 0}/${goldTotal}`);
    if (e2Avri?.goldHits && e2Avri.goldHits.length > 0) {
      lines.push("- Gold signals found:");
      for (const g of e2Avri.goldHits) lines.push(`  - +${g.points} ${g.description} (${g.id})`);
    }
    if (e2Avri?.goldMisses && e2Avri.goldMisses.length > 0) {
      lines.push("- Expected signals missing:");
      for (const g of e2Avri.goldMisses) lines.push(`  - −${g.points} ${g.description} (${g.id})`);
    }
    if (e2Avri?.absencePenalties && e2Avri.absencePenalties.length > 0) {
      lines.push("- Absence penalties applied:");
      for (const a of e2Avri.absencePenalties) lines.push(`  - −${a.points} ${a.description} (${a.id})`);
    }
    if (e2Avri?.contradictions && e2Avri.contradictions.length > 0) {
      lines.push(`- Contradiction phrases: ${e2Avri.contradictions.map((c) => `"${c}"`).join(", ")}`);
    }
    if (e2Avri?.crashTrace?.isStripped) {
      const ct = e2Avri.crashTrace;
      const familyId = data.avri?.family ?? e2Avri?.family ?? null;
      const traceKindLabel =
        familyId === "RACE_CONCURRENCY"
          ? "race trace"
          : familyId === "MEMORY_CORRUPTION"
            ? "crash trace"
            : "tool trace";
      lines.push(
        `- Stripped ${traceKindLabel} (penalty ${ct.penalty}): ${ct.reason ?? "stripped trace"} — frames ${ct.framesAnalyzed}, good ${ct.goodFrames}, placeholder ${ct.placeholderFrames}`,
      );
      if (ct.revokedGoldHits.length > 0) {
        lines.push(
          `  - Trace gold signals revoked: ${ct.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
        );
      }
    }
    // Sprint 12 / Task 93: surface the FAKE_RAW_HTTP block alongside
    // STRIPPED_CRASH_TRACE so reviewers reading the printable export see
    // why a REQUEST_SMUGGLING report's gold hits were revoked.
    if (e2Avri?.rawHttp?.isFake) {
      const rh = e2Avri.rawHttp;
      const goodHeaders = Math.max(0, rh.totalHeaders - rh.placeholderHeaders);
      lines.push(
        `- Fake raw HTTP request (penalty ${rh.penalty}): ${rh.reason ?? "fabricated raw HTTP request"} — requests ${rh.requestsAnalyzed}, headers ${goodHeaders}/${rh.totalHeaders} good, placeholder ${rh.placeholderHeaders}, CRLF ${rh.crlfPresent ? "yes" : "no"}, TE/CL conflicts ${rh.teClConflicts} (broken ${rh.teClBroken})`,
      );
      if (rh.revokedGoldHits.length > 0) {
        lines.push(
          `  - Smuggling gold signals revoked: ${rh.revokedGoldHits.map((r) => `${r.id} (−${r.points})`).join(", ")}`,
        );
      }
    }
    if (data.avri && (data.avri.velocityPenalty < 0 || data.avri.templatePenalty < 0)) {
      lines.push(`- Behavioural penalties: velocity ${data.avri.velocityPenalty}, template ${data.avri.templatePenalty}`);
    }
    lines.push("");
  }

  const warnings = data.engines?.warnings ?? data.trace?.composite?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("## Warnings");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  const e2Engine = engines.find(e => /Technical Substance/i.test(e.engine));
  const verifyBreakdown = (e2Engine?.signalBreakdown ?? {}) as {
    verificationSources?: { verified?: number; total?: number; referenced?: number; fallback?: number };
    activeVerification?: { mode?: VerificationModeUI; familyName?: string | null; skipReason?: string | null };
  };
  const verifySources = verifyBreakdown.verificationSources;
  const activeVerif = verifyBreakdown.activeVerification;
  if (verifySources || activeVerif?.mode) {
    lines.push("## Active Verification");
    if (activeVerif?.mode) {
      const familySuffix = activeVerif.familyName ? ` — ${activeVerif.familyName}` : "";
      lines.push(`- Mode: **${activeVerif.mode}**${familySuffix}`);
      lines.push(`- ${VERIFICATION_MODE_DESCRIPTION[activeVerif.mode]}`);
      if (activeVerif.mode === "MANUAL_ONLY" && activeVerif.skipReason) {
        lines.push(`- ${activeVerif.skipReason}`);
      }
    }
    if (verifySources) {
      lines.push(
        `- verified ${verifySources.verified ?? 0}/${verifySources.total ?? 0} · referenced: ${verifySources.referenced ?? 0} · search-fallback: ${verifySources.fallback ?? 0}`,
      );
    }
    lines.push("");
  }

  const perplexityEngine = engines.find(e => !!e.signalBreakdown?.perplexity);
  const perplexity = perplexityEngine?.signalBreakdown?.perplexity;
  if (perplexity) {
    lines.push(`## Perplexity Signals (${perplexityEngine?.engine ?? "Engine 1"})`);
    if (typeof perplexity.bigramEntropy === "number") lines.push(`- Bigram Entropy: ${perplexity.bigramEntropy.toFixed(3)} bits`);
    if (typeof perplexity.functionWordRate === "number") lines.push(`- Function-Word Rate: ${perplexity.functionWordRate.toFixed(2)} per 1k tokens`);
    if (typeof perplexity.syntaxValidityScore === "number") lines.push(`- Syntax Validity: ${perplexity.syntaxValidityScore.toFixed(2)}`);
    if (typeof perplexity.combinedScore === "number") lines.push(`- Combined AI-ness: ${perplexity.combinedScore.toFixed(1)}`);
    if (typeof perplexity.rawEngine1Score === "number" || perplexity.rawEngine1Verdict) {
      lines.push(`- Raw Engine 1: ${perplexity.rawEngine1Score ?? "—"}${perplexity.rawEngine1Verdict ? ` (${perplexity.rawEngine1Verdict})` : ""}`);
    }
    lines.push("");
  }

  if (data.legacyMapping) {
    lines.push("## Legacy Slop-Score Mapping");
    lines.push(`- Legacy Slop Score: ${data.legacyMapping.slopScore} (0 = clean, 100 = pure slop)`);
    lines.push(`- Display Mode: ${data.legacyMapping.displayMode}`);
    lines.push(`- Note: ${data.legacyMapping.note}`);
    lines.push("");
  }

  return lines.join("\n");
}

const STRENGTH_TONE: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
  HIGH: "text-red-400 border-red-500/40 bg-red-500/5",
  MEDIUM: "text-orange-400 border-orange-500/40 bg-orange-500/5",
  LOW: "text-muted-foreground border-muted-foreground/30 bg-muted/10",
};

const STRENGTH_ORDER: Array<"HIGH" | "MEDIUM" | "LOW"> = ["HIGH", "MEDIUM", "LOW"];

function formatIndicatorValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function buildIndicatorMarkdown(ind: TriggeredIndicator): string {
  const signal = ind.signal ?? "INDICATOR";
  const strength = ind.strength ?? "UNSPECIFIED";
  const explanation = ind.explanation?.trim();
  const base = `\`${signal}\` (${strength})`;
  return explanation ? `${base} — ${explanation}` : base;
}

function EngineRow({ eng }: { eng: EngineResult }) {
  const indicators = eng.triggeredIndicators ?? [];
  const hasIndicators = indicators.length > 0;
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const copyIndicator = async (ind: TriggeredIndicator) => {
    const md = buildIndicatorMarkdown(ind);
    try {
      await navigator.clipboard.writeText(md);
      toast({ title: "Copied", description: "Indicator copied to clipboard." });
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy to clipboard.",
        variant: "destructive",
      });
    }
  };
  const grouped = STRENGTH_ORDER
    .map((s) => ({
      strength: s,
      items: indicators.filter((i) => i.strength === s),
    }))
    .filter((g) => g.items.length > 0);
  const unspecified = indicators.filter(
    (i) => i.strength !== "HIGH" && i.strength !== "MEDIUM" && i.strength !== "LOW",
  );
  return (
    <div className="rounded-md border border-border/30 bg-muted/5">
      <button
        type="button"
        onClick={() => hasIndicators && setOpen((v) => !v)}
        disabled={!hasIndicators}
        aria-expanded={open}
        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 text-xs font-mono ${hasIndicators ? "cursor-pointer hover:bg-muted/10" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1.5 truncate min-w-0">
          {hasIndicators && (
            open ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate">{eng.engine}</span>
          {hasIndicators && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              ({indicators.length} indicator{indicators.length === 1 ? "" : "s"})
            </span>
          )}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${VERDICT_COLOR[eng.verdict] || ""}`}>
            {eng.verdict}
          </Badge>
          {eng.confidence && (
            <span className="text-[10px] text-muted-foreground uppercase">conf: {eng.confidence}</span>
          )}
          <span className="font-bold w-8 text-right">{eng.score}</span>
        </div>
      </button>
      {hasIndicators && open && (
        <div className="border-t border-border/30 px-2.5 py-2 space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Triggered Indicators
          </div>
          {grouped.map((g) => (
            <div key={g.strength} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-mono">
                {g.strength}
              </div>
              <ul className="space-y-1">
                {g.items.map((ind, i) => {
                  const valueStr = formatIndicatorValue(ind.value);
                  return (
                    <li
                      key={`${ind.signal ?? "indicator"}-${i}`}
                      className={`rounded border px-2 py-1.5 text-[11px] font-mono ${STRENGTH_TONE[g.strength]}`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-semibold">{ind.signal ?? "—"}</span>
                        <div className="flex items-center gap-2">
                          {valueStr !== null && (
                            <span className="text-foreground/80">value: {valueStr}</span>
                          )}
                          {typeof ind.threshold === "number" && (
                            <span className="text-muted-foreground">thr: {ind.threshold}</span>
                          )}
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1 py-0 h-4 ${STRENGTH_TONE[g.strength]}`}
                          >
                            {g.strength}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0"
                            aria-label={`Copy indicator ${ind.signal ?? ""} to clipboard`}
                            title="Copy indicator to clipboard"
                            onClick={() => void copyIndicator(ind)}
                          >
                            <ClipboardCopy className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      {ind.explanation && (
                        <div className="text-foreground/70 mt-0.5 whitespace-pre-wrap break-words">
                          {ind.explanation}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {unspecified.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 font-mono">
                UNSPECIFIED
              </div>
              <ul className="space-y-1">
                {unspecified.map((ind, i) => {
                  const valueStr = formatIndicatorValue(ind.value);
                  return (
                    <li
                      key={`u-${ind.signal ?? "indicator"}-${i}`}
                      className="rounded border border-muted-foreground/30 bg-muted/10 px-2 py-1.5 text-[11px] font-mono"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-semibold">{ind.signal ?? "—"}</span>
                        <div className="flex items-center gap-2">
                          {valueStr !== null && (
                            <span className="text-muted-foreground">value: {valueStr}</span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0"
                            aria-label={`Copy indicator ${ind.signal ?? ""} to clipboard`}
                            title="Copy indicator to clipboard"
                            onClick={() => void copyIndicator(ind)}
                          >
                            <ClipboardCopy className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      {ind.explanation && (
                        <div className="text-foreground/70 mt-0.5 whitespace-pre-wrap break-words">
                          {ind.explanation}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
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
