import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChevronDown, ChevronUp, Activity, AlertCircle, Download, ClipboardCopy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  AVRI_OVERRIDE_LABELS,
  buildAvriRubricMarkdown,
  GOLD_SIGNAL_LABELS,
  HANDWAVY_CATEGORY_LABELS,
  HANDWAVY_CATEGORY_ORDER,
  type AvriCompositeBlock,
  type AvriEngine2Block,
  type AvriHandwavyCategory,
} from "@workspace/avri-rubric";

/** Task #611: target marker in the AVRI structural-fabrication block for the
 * Evidence Signals card to scroll/flash. The `nonce` lets a caller request
 * the same `id` twice in a row (clicking the same marker bullet) and still
 * re-trigger the scroll+flash animation. */
export interface AvriMarkerScrollTarget {
  id: string;
  nonce: number;
}

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
  /**
   * Task #209 — observation-only audit telemetry. `null` for legacy reports
   * analyzed before this audit pass shipped.
   */
  auditTelemetry?: AuditTelemetryBlock | null;
  /**
   * Task #624 — semver pins for each engine that contributed to this report.
   * Persisted at write time on `reports.engine_versions`. `null` for legacy
   * rows analyzed before the column shipped.
   */
  engineVersions?: {
    linguistic: string;
    substance: string;
    cwe: string;
    avri: string;
    fusion: string;
  } | null;
  /**
   * Task #644 — cross-AI-agent fingerprint. Heuristic detector that picks
   * which AI agent (or "human") the report prose most likely came from.
   * Pure stylistic signal — never a hard attribution claim. `unknown` is
   * returned for short / generic prose and is rendered as such.
   */
  agentFingerprint?: {
    likelyAgent: "gpt4" | "claude" | "gemini" | "cursor-agent" | "replit-agent" | "human" | "unknown";
    likelyAgentLabel: string;
    confidence: number;
    scores: Record<string, number>;
    matches: Array<{ id: string; description: string; weight: number; excerpt?: string }>;
    features: {
      wordCount: number;
      sentenceCount: number;
      avgSentenceLen: number;
      emDashCount: number;
      boldHeaderCount: number;
      bulletCount: number;
    };
  } | null;
}

// Task #209 — these mirror the server types in routes/reports.ts and
// lib/score-fusion.ts. Kept as a structural copy here (rather than importing)
// to keep the vulnrap web artifact decoupled from the api-server's TS source.
export type AuditLlmGateReason =
  | "fired_borderline"
  | "fired_low_confidence"
  | "fired_borderline_and_low_confidence"
  | "fired_borderline_composite"
  | "skipped_above_borderline"
  | "skipped_below_borderline"
  | "skipped_above_borderline_composite"
  | "skipped_below_borderline_composite"
  | "skipped_composite_borderline_heuristic_confirms_slop"
  | "skipped_high_confidence_outside_borderline"
  | "skipped_unavailable";

export interface AuditTelemetryBlock {
  llmGating: {
    shouldCall: boolean;
    reason: AuditLlmGateReason | string;
    heuristicScore: number;
    confidenceUsed: number;
    // Task #442 — composite (Engine 2 / 3-engine, 0–100 higher = more
    // valid) that was used as the primary gate input. `null` for legacy
    // reports analyzed before the composite-driven gate shipped, or when
    // the engine layer was skipped (degraded fallback).
    compositeScoreUsed?: number | null;
    costGuard: { low: number; high: number; confidence: number };
    userSkipped: boolean;
    actuallyFired: boolean;
    llmAvailable: boolean;
  };
  validityFusion: {
    finalApplied: number;
    heuristic: number;
    llmRaw: number | null;
    blended: number | null;
    conservativeFloorApplied: boolean;
    delta: number | null;
    disagreementThreshold: number;
    higherSide: "heuristic" | "llm" | "tied" | null;
  };
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

export const DIAGNOSTICS_STALE_TIME_MS = 60_000;

export function getDiagnosticsQueryKey(reportId: number): readonly unknown[] {
  return ["report-diagnostics", reportId] as const;
}

// Shared diagnostics fetch for the JSON and TXT export buttons. Reuses the
// panel's queryKey + staleTime so back-to-back exports hit the network once.
export async function loadDiagnosticsForExport(
  queryClient: QueryClient,
  reportId: number,
): Promise<DiagnosticsResponse> {
  return queryClient.fetchQuery({
    queryKey: getDiagnosticsQueryKey(reportId),
    queryFn: () => fetchDiagnostics(reportId),
    staleTime: DIAGNOSTICS_STALE_TIME_MS,
  });
}

export function DiagnosticsPanel({
  reportId,
  onStructuralMarkerClick,
  avriMarkerScrollTarget,
}: {
  reportId: number;
  /** Task #451: invoked when a STRUCTURAL_FABRICATION marker bullet that
   * carries a `range` is clicked. The callback receives the 1-based line
   * number into the original report text so the parent page can scroll its
   * `<HighlightedReport>` panel to the offending line. When omitted (or
   * when a marker has no `range`), the marker renders as plain text and is
   * not clickable — preserving the existing diagnostics-panel test
   * fixtures that pass markers without ranges. */
  onStructuralMarkerClick?: (line: number) => void;
  /** Task #611: when set, expand the panel, scroll the matching
   * STRUCTURAL_FABRICATION marker bullet into view, and apply a brief flash
   * highlight. Driven by clicks on the matching Evidence Signals bullet so
   * reviewers can jump from "what looks fake" (Evidence card) to "where it
   * appears in the trace" (this panel). */
  avriMarkerScrollTarget?: AvriMarkerScrollTarget | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  // Task #611: expand the panel automatically when the parent page asks us
  // to scroll to a marker — the AVRI block is only mounted while the panel
  // is expanded, so without this the scroll target would have nothing to
  // land on. Mirrors the auto-expand effect in `<HighlightedReport>`.
  useEffect(() => {
    if (!avriMarkerScrollTarget) return;
    setExpanded(true);
  }, [avriMarkerScrollTarget]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: getDiagnosticsQueryKey(reportId),
    queryFn: () => fetchDiagnostics(reportId),
    enabled: expanded,
    staleTime: DIAGNOSTICS_STALE_TIME_MS,
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

              {data.auditTelemetry && (
                <>
                  <Separator className="bg-border/30" />
                  <AuditTelemetrySection audit={data.auditTelemetry} />
                </>
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
                  <GoldSignalBonusSection engines={data.engines.engines} />
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
                onStructuralMarkerClick={onStructuralMarkerClick}
                avriMarkerScrollTarget={avriMarkerScrollTarget}
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

              {data.agentFingerprint && (
                <>
                  <Separator className="bg-border/30" />
                  <AgentFingerprintSection fingerprint={data.agentFingerprint} />
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

              {/* Task #624 — engine-version footer line. Rendered at the
                  bottom of the panel so reviewers can answer "which engine
                  versions scored this report?" without leaving the panel.
                  Hidden for legacy rows analyzed before the column shipped
                  (engineVersions=null). */}
              {data.engineVersions && (
                <>
                  <Separator className="bg-border/30" />
                  <div
                    data-testid="diagnostics-engine-versions"
                    className="text-[10px] font-mono text-muted-foreground leading-relaxed"
                  >
                    engines:{" "}
                    linguistic v{data.engineVersions.linguistic}
                    {" · "}substance v{data.engineVersions.substance}
                    {" · "}cwe v{data.engineVersions.cwe}
                    {" · "}avri v{data.engineVersions.avri}
                    {" · "}fusion v{data.engineVersions.fusion}
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// Task 107: theme buckets for FLAT-family hand-wavy phrase markers. The
// category type, label table, and ordering are imported from
// `@workspace/avri-rubric` so the on-screen panel and the markdown export
// stay in sync (Task 272). Mirrors HandwavyCategory in
// artifacts/api-server/src/lib/engines/avri/engine2-avri.ts via that
// shared package.

// Task 111: one-line legend per theme so a reviewer seeing these buckets for
// the first time can tell at a glance what the group signals about the
// report. Wording mirrors the comments in
// `api-server/src/lib/engines/avri/engine2-avri.ts` next to the FLAT
// hand-wavy marker list (absence-of-evidence vs. generic hedging vs.
// buzzword-soup framings). UI-only — the markdown export doesn't carry the
// inline legend, so this stays local to the panel.
const HANDWAVY_CATEGORY_HELP: Record<AvriHandwavyCategory | "other", string> = {
  absence:
    "Reporter explicitly admits they have no runnable reproducer, PoC, or enumeration — the bug is asserted, not observed.",
  hedging:
    "Generic \"may / appears / likely\" language that signals zero direct observation of the claimed behavior.",
  buzzword:
    "Marketing-style framings (zero-trust, modern threat landscape, defense-in-depth) with no project-specific specifics — likely AI-generated prose.",
  other:
    "Hand-wavy phrases that don't carry a theme tag (older cached payloads).",
};

// Sprint 11 / Task 60: Render the AVRI family rubric used for this report —
// detected family + classification confidence, expected vs found gold signals,
// any absence penalties applied, contradictions, and AVRI composite overrides.
// Pulls structured data from Engine 2's signalBreakdown.avri (per-signal
// descriptions) and merges it with the composite-level avri block (family
// classification reason / behavioural penalties).
//
// Task 273: the persisted `signalBreakdown.avri` shape used to be
// re-declared here as `AvriEngine2Breakdown` (with crashTrace, rawHttp +
// nested response, and the score components added in earlier sprints);
// it now lives in `@workspace/avri-rubric` as `AvriEngine2Block` (already
// imported above) so the engine, this panel, and the printable triage
// report can't drift.

// Task 272: token+label come from `@workspace/avri-rubric`
// (`AVRI_OVERRIDE_LABELS`) so the panel and the markdown export agree on
// which override tokens are surfaced and what they're called. Tone is a
// UI-only concern (red = composite-killer, orange = behavioural haircut),
// so it stays here, keyed by the same token table.
const AVRI_OVERRIDE_TONES: Record<string, string> = {
  AVRI_NO_GOLD_SIGNALS: "text-red-400",
  AVRI_FAMILY_CONTRADICTION: "text-red-400",
  AVRI_VELOCITY: "text-orange-400",
  AVRI_TEMPLATE_CAMPAIGN: "text-orange-400",
};

// Task #317: short, plain-English label for each Sprint 13B-2 / Task #303
// structural-fabrication marker. Keep the keys in sync with the
// `StructuralMarker.id` union in
// `artifacts/api-server/src/lib/engines/avri/crash-trace.ts`. The marker's
// `description` field already includes the offending excerpt (e.g. the
// round offsets, the frame numbers, the hex region size); these labels are
// the one-line headline reviewers see above each excerpt.
export const STRUCTURAL_MARKER_LABELS: Record<string, string> = {
  round_function_offsets: "Round/zero function offsets",
  frame_numbering_gaps: "Frame-numbering gap inside a block",
  thread_id_inconsistency: "Thread block without `==<pid>==` anchor",
  round_heap_region_size: "Heap region size in hex / textbook power-of-two",
  implausible_function_offset: "Function offsets outside realistic bounds",
  implausible_thread_id: "PID or thread id outside realistic range",
  region_size_vs_access_size: "Region size incompatible with access size",
  // Task #316: register dump and /proc/self/maps shape detectors.
  fabricated_register_state: "Fabricated x86/x64 register dump",
  fabricated_memory_map: "Fabricated /proc/self/maps listing",
};

// Task #450: short, plain-English label for each FAKE_RAW_HTTP fabrication
// signal. Keep the keys in sync with the `RawHttpRequestSignalId` and
// `RawHttpResponseSignalId` unions in
// `artifacts/api-server/src/lib/engines/avri/raw-http.ts` (and the
// `prose_placeholder_payload` id added by `engine2-avri.ts` when the
// payload-class strip-and-retest fallback fires). The signal's
// `description` field already includes the offending excerpt (e.g. the
// header counts, the credential reason, the prose snippet); these labels
// are the one-line headline reviewers see above each excerpt — same
// pattern Task #317 introduced for STRUCTURAL_MARKER_LABELS.
export const RAW_HTTP_SIGNAL_LABELS: Record<string, string> = {
  // Request-side fabrication tells.
  placeholder_headers: "Placeholder header values",
  broken_te_cl_conflict: "Broken Transfer-Encoding/Content-Length conflict",
  missing_crlf: "Missing CRLF line endings",
  no_real_header_values: "No header carries a real value",
  fake_credential_token: "Fabricated credential token",
  placeholder_body: "Placeholder request body",
  prose_placeholder_payload: "Prose-only placeholder payload reference",
  // Response-side fabrication tells.
  missing_date_header: "Missing Date response header",
  missing_server_header: "Missing Server response header",
  suspicious_json_body: "Suspiciously clean JSON response body",
  missing_incidental_headers:
    "Missing incidental response headers (X-Request-Id / Content-Length / Cache-Control / Set-Cookie)",
};

function AvriFamilySection({
  avri,
  engines,
  overrides,
  cachedFamily,
  onStructuralMarkerClick,
  avriMarkerScrollTarget,
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
  /** Task #451: forwarded from `<DiagnosticsPanel>`. When present, each
   * STRUCTURAL_FABRICATION marker that has a `range` renders as a clickable
   * button that scrolls the report panel above to the offending line. */
  onStructuralMarkerClick?: (line: number) => void;
  /** Task #611: forwarded from `<DiagnosticsPanel>`. When this changes, the
   * matching STRUCTURAL_FABRICATION marker is scrolled into view and given a
   * brief flash highlight so the reviewer's eye lands on the row. */
  avriMarkerScrollTarget?: AvriMarkerScrollTarget | null;
}) {
  const e2 = engines.find((e) => /Technical Substance/i.test(e.engine));
  const e2Avri = (e2?.signalBreakdown?.avri ?? null) as AvriEngine2Block | null;

  // Task #611: scroll/flash the matching STRUCTURAL_FABRICATION marker bullet
  // when the parent page (currently `results.tsx`'s Evidence Signals card)
  // bumps `avriMarkerScrollTarget`. The marker rows mount as `<li
  // data-marker-id="...">` so we can find them by selector regardless of
  // whether they rendered as a clickable button (Task #451 — markers with a
  // `range`) or a static bullet (legacy persisted reports without a range).
  // The effect re-runs when the markers list changes too, so the first
  // request after the panel auto-expands and the diagnostics fetch settles
  // still finds its target. The lookup is scoped to this section's root via
  // `sectionRef` so a stray `data-marker-id` elsewhere on the page (a future
  // reuse of the attribute) can't hijack the scroll target.
  //
  // These hooks are declared *before* any early-return branch below so React's
  // rules-of-hooks ordering stays stable across renders that toggle between
  // the cached-family-only branch and the full rubric branch on the same
  // mounted instance.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [flashMarkerId, setFlashMarkerId] = useState<string | null>(null);
  const structuralMarkerIdsKey = (e2Avri?.crashTrace?.structuralMarkers ?? [])
    .map((m) => m.id)
    .join("|");
  useEffect(() => {
    if (!avriMarkerScrollTarget) return;
    // Defer to a microtask so the panel's `expanded`/data-fetch flush has
    // landed before we query the DOM for the target row.
    const raf = requestAnimationFrame(() => {
      const root = sectionRef.current ?? document;
      // `CSS.escape` is not in the very oldest browsers; guard so a runtime
      // without it (e.g. a stripped-down test environment) falls back to the
      // raw id rather than crashing the panel.
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(avriMarkerScrollTarget.id)
          : avriMarkerScrollTarget.id;
      const node = root.querySelector<HTMLElement>(
        `[data-marker-id="${escaped}"]`,
      );
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashMarkerId(avriMarkerScrollTarget.id);
    });
    return () => cancelAnimationFrame(raf);
    // `structuralMarkerIdsKey` is in the dep list so a request that arrives
    // before the markers have mounted retries once the data settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    avriMarkerScrollTarget?.id,
    avriMarkerScrollTarget?.nonce,
    structuralMarkerIdsKey,
  ]);

  // Clear the flash class after ~1.6s so the highlight pulse fades. Re-keyed
  // on `avriMarkerScrollTarget?.nonce` so re-clicking the same marker resets
  // the timer rather than letting the previous timeout clear it early.
  useEffect(() => {
    if (flashMarkerId === null) return;
    const t = window.setTimeout(() => setFlashMarkerId(null), 1600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashMarkerId, avriMarkerScrollTarget?.nonce]);

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
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                <span>AVRI Family Rubric</span>
                <Link
                  to="/changelog#avri-family-rubric"
                  className="text-[11px] text-primary/80 hover:text-primary hover:underline normal-case font-sans tracking-normal"
                >
                  Learn more &rarr;
                </Link>
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
  const rawHttp = e2Avri?.rawHttp ?? null;

  // Task #428 — surface the Task #300 AI self-disclosure detector output
  // (matched phrases + applied penalty) so reviewers can see *which* phrase
  // fired without dropping into the JSON. Optional on the Engine 2 block —
  // legacy reports analyzed before the detector shipped won't carry it.
  const aiSelfDisclosure = e2Avri?.aiSelfDisclosure ?? null;
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
      if (!meta) return null;
      const tone = AVRI_OVERRIDE_TONES[meta.token] ?? "text-orange-400";
      return { rule, token: meta.token, label: meta.label, tone };
    })
    .filter((x): x is { rule: string; token: string; label: string; tone: string } => x !== null);

  return (
    <>
      <Separator className="bg-border/30" />
      <section ref={sectionRef} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span>AVRI Family Rubric</span>
            <Link
              to="/changelog#avri-family-rubric"
              className="text-[11px] text-primary/80 hover:text-primary hover:underline normal-case font-sans tracking-normal"
            >
              Learn more &rarr;
            </Link>
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
          <div className="space-y-2">
            <div className="text-[11px] text-muted-foreground">
              No specific CWE family detected — generic substance scoring used (no family rubric applied).
            </div>
            {absencePenalties.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Hand-wavy Phrases Triggering Slop Haircut
                  <span className="ml-1 text-muted-foreground/70 normal-case">
                    (applied haircut: {e2Avri?.absencePenalty ?? 0}; per-hit markers shown, total capped at −24)
                  </span>
                </div>
                {(() => {
                  // Task 107: group the matched hand-wavy entries by category
                  // so a dozen-row list reads as themed buckets (absence /
                  // hedging / buzzword) rather than one flat scroll. Markers
                  // missing a category (e.g. older cached payloads) fall back
                  // into an "Other" bucket rendered last.
                  const groups = new Map<AvriHandwavyCategory | "other", typeof absencePenalties>();
                  for (const a of absencePenalties) {
                    const key: AvriHandwavyCategory | "other" = a.flatHandwavyCategory ?? "other";
                    const arr = groups.get(key) ?? [];
                    arr.push(a);
                    groups.set(key, arr);
                  }
                  const orderedKeys: Array<AvriHandwavyCategory | "other"> = [
                    ...HANDWAVY_CATEGORY_ORDER.filter((k) => groups.has(k)),
                    ...(groups.has("other") ? (["other"] as const) : []),
                  ];
                  return (
                    <div className="space-y-2">
                      {orderedKeys.map((key) => {
                        const items = groups.get(key) ?? [];
                        const label =
                          key === "other" ? "Other" : HANDWAVY_CATEGORY_LABELS[key];
                        const subtotal = items.reduce((s, a) => s + a.points, 0);
                        const help = HANDWAVY_CATEGORY_HELP[key];
                        return (
                          <div key={key}>
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-0.5 flex items-baseline gap-1">
                              <span>{label}</span>
                              <span className="text-muted-foreground/60 normal-case">
                                ({items.length} phrase{items.length === 1 ? "" : "s"}, −{subtotal} raw)
                              </span>
                            </div>
                            {help && (
                              <div className="text-[11px] text-muted-foreground/80 normal-case mb-1 leading-snug">
                                {help}
                              </div>
                            )}
                            <ul className="space-y-0.5">
                              {items.map((a) => (
                                <li
                                  key={a.id}
                                  className="text-[11px] font-mono text-orange-400/90 flex items-baseline gap-1"
                                >
                                  <span>−{a.points}</span>
                                  <span className="text-foreground/80">{a.description}</span>
                                  <span className="text-muted-foreground">({a.id})</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}
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

            {/*
              Task #317: surface the Sprint 13B-2 / Task #303 structural-
              fabrication markers (round function offsets, frame-numbering
              gaps, missing PID anchor, hex region size, implausible
              function offsets / thread ids, region-vs-access mismatch).
              Reuses the same red-box visual treatment as STRIPPED_CRASH_TRACE
              above so reviewers learn the "fabricated trace" pattern at a
              glance. Renders whenever the Engine 2 block carries
              structuralMarkers, even if STRIPPED_CRASH_TRACE also fired —
              the two flags surface different evidence (placeholder symbols
              vs. internally-inconsistent values) and reviewers benefit from
              seeing both.
            */}
            {crashTrace?.hasStructuralFabrication &&
              (crashTrace.structuralMarkers?.length ?? 0) > 0 && (
                <div
                  className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 space-y-2"
                  data-testid="structural-fabrication-block"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 h-5 font-mono text-red-400 border-red-500/40"
                    >
                      STRUCTURAL_FABRICATION
                    </Badge>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {(() => {
                        const p = crashTrace.structuralFabricationPenalty ?? 0;
                        if (p < 0) {
                          return `${traceKindLabel} downgraded (${p})`;
                        }
                        return `${traceKindLabel} fabrication tells (penalty subsumed by stripped-trace)`;
                      })()}
                    </span>
                  </div>
                  <p className="text-[11px] text-red-300/90 leading-relaxed">
                    {crashTrace.structuralMarkers!.length} structural marker
                    {crashTrace.structuralMarkers!.length === 1 ? "" : "s"} fired
                    against this {traceKindLabel}; real sanitizer output never
                    hits this combination.
                  </p>
                  <ul className="space-y-1.5">
                    {crashTrace.structuralMarkers!.map((m) => {
                      // Task #451: a marker is clickable only when both the
                      // detector recorded a `range` (older fixtures and
                      // legacy persisted reports may not) and the parent
                      // page wired an `onStructuralMarkerClick` handler.
                      // Otherwise we render the same `<li>` as before so
                      // the existing Task #317 visual treatment and tests
                      // continue to pass unchanged.
                      const clickable =
                        m.range != null && onStructuralMarkerClick != null;
                      const body = (
                        <>
                          <div className="flex items-baseline gap-1.5 flex-wrap">
                            <span className="text-red-400/90 font-semibold">
                              {STRUCTURAL_MARKER_LABELS[m.id] ?? m.id}
                            </span>
                            <span className="text-muted-foreground">
                              ({m.id})
                            </span>
                            {clickable && (
                              <span className="text-[10px] font-normal text-red-300/70 uppercase tracking-wide">
                                line {m.range!.line}
                              </span>
                            )}
                          </div>
                          <div className="text-foreground/80 leading-snug">
                            {m.description}
                          </div>
                        </>
                      );
                      // Task #611: `data-marker-id` lets the parent page
                      // (Evidence Signals card) scroll/flash the matching
                      // bullet here. The flash class is applied to the
                      // wrapping `<li>` so both the clickable-button row
                      // and the legacy plain bullet share the visual.
                      const isFlashing = flashMarkerId === m.id;
                      const flashClasses =
                        "bg-yellow-400/30 ring-1 ring-yellow-400/60 -mx-1 px-1";
                      if (clickable) {
                        return (
                          <li
                            key={m.id}
                            data-marker-id={m.id}
                            data-testid={`structural-marker-${m.id}-row`}
                            className={cn(
                              "text-[11px] font-mono space-y-0.5 rounded-sm transition-colors duration-300",
                              isFlashing && flashClasses,
                            )}
                          >
                            <button
                              type="button"
                              data-testid={`structural-marker-${m.id}`}
                              data-marker-line={m.range!.line}
                              onClick={() =>
                                onStructuralMarkerClick!(m.range!.line)
                              }
                              className="w-full text-left rounded-sm space-y-0.5 px-1 -mx-1 py-0.5 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400/60 transition-colors cursor-pointer"
                              title={`Jump to line ${m.range!.line} in the report`}
                            >
                              {body}
                            </button>
                          </li>
                        );
                      }
                      return (
                        <li
                          key={m.id}
                          data-marker-id={m.id}
                          data-testid={`structural-marker-${m.id}-row`}
                          className={cn(
                            "text-[11px] font-mono space-y-0.5 rounded-sm transition-colors duration-300",
                            isFlashing && flashClasses,
                          )}
                        >
                          {body}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

            {/*
              Sprint 12 / Task 104: mirror the FAKE_RAW_HTTP block from the
              printable markdown export inside the live panel UI. Reviewers
              should see why a REQUEST_SMUGGLING report's smuggling-gold hits
              were revoked without having to dig into the generic Triggered
              Indicators table.
            */}
            {rawHttp?.isFake && (
              <div
                className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 space-y-2"
                data-testid="fake-raw-http-block"
              >
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-5 font-mono text-red-400 border-red-500/40"
                  >
                    FAKE_RAW_HTTP
                  </Badge>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    raw HTTP downgraded ({rawHttp.penalty})
                  </span>
                </div>
                {rawHttp.reason && (
                  <p className="text-[11px] text-red-300/90 leading-relaxed">
                    {rawHttp.reason}
                  </p>
                )}
                <div className="flex flex-wrap gap-3 text-[11px] font-mono text-muted-foreground">
                  <span>requests: {rawHttp.requestsAnalyzed}</span>
                  <span className="text-green-400/80">
                    headers: {Math.max(0, rawHttp.totalHeaders - rawHttp.placeholderHeaders)}/{rawHttp.totalHeaders} good
                  </span>
                  <span className="text-red-400/80">placeholder: {rawHttp.placeholderHeaders}</span>
                  <span className={rawHttp.crlfPresent ? "text-green-400/80" : "text-red-400/80"}>
                    CRLF: {rawHttp.crlfPresent ? "yes" : "no"}
                  </span>
                  <span className="text-red-400/80">
                    TE/CL conflicts: {rawHttp.teClConflicts} (broken {rawHttp.teClBroken})
                  </span>
                </div>
                {/*
                  Task #450 — surface the per-signal request-side
                  fabrication tells (placeholder headers / broken TE-CL
                  conflict / missing CRLF / no real header values / fake
                  credential token / placeholder body / prose
                  placeholder payload) under a plain-English headline
                  followed by the signal id and the engine's exact
                  description string. Mirrors the STRUCTURAL_FABRICATION
                  layout introduced by Task #317 so the two red-box
                  blocks teach the same shape. `signals` is optional on
                  AvriEngine2RawHttp (legacy persisted reports won't
                  carry it) so we default to an empty list and skip the
                  list when empty.
                */}
                {(rawHttp.signals ?? []).length > 0 && (
                  <ul className="space-y-1.5">
                    {rawHttp.signals!.map((s) => (
                      <li
                        key={s.id}
                        className="text-[11px] font-mono space-y-0.5"
                      >
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-red-400/90 font-semibold">
                            {RAW_HTTP_SIGNAL_LABELS[s.id] ?? s.id}
                          </span>
                          <span className="text-muted-foreground">
                            ({s.id})
                          </span>
                        </div>
                        <div className="text-foreground/80 leading-snug">
                          {s.description}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {/*
                  Sprint 13B-3: response-side plausibility sub-block. Surfaces
                  WHY a fabricated `HTTP/1.1 200 OK` block was rejected so
                  reviewers can see the four marker counters at a glance.
                */}
                {rawHttp.response?.isFake && (
                  <div className="rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 h-5 font-mono text-red-400 border-red-500/40"
                      >
                        FAKE_RAW_HTTP_RESPONSE
                      </Badge>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {rawHttp.response.responsesFlagged}/{rawHttp.response.responsesAnalyzed} response block(s) flagged
                      </span>
                    </div>
                    {rawHttp.response.reason && (
                      <p className="text-[11px] text-red-300/90 leading-relaxed">
                        {rawHttp.response.reason}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3 text-[11px] font-mono text-muted-foreground">
                      <span className={rawHttp.response.responsesMissingDate > 0 ? "text-red-400/80" : ""}>
                        missing Date: {rawHttp.response.responsesMissingDate}
                      </span>
                      <span className={rawHttp.response.responsesMissingServer > 0 ? "text-red-400/80" : ""}>
                        missing Server: {rawHttp.response.responsesMissingServer}
                      </span>
                      <span className={rawHttp.response.responsesWithSuspiciousJsonBody > 0 ? "text-red-400/80" : ""}>
                        suspicious JSON: {rawHttp.response.responsesWithSuspiciousJsonBody}
                      </span>
                      <span className={rawHttp.response.responsesMissingIncidentals > 0 ? "text-red-400/80" : ""}>
                        no incidentals: {rawHttp.response.responsesMissingIncidentals}
                      </span>
                    </div>
                    {/*
                      Task #450 — response-side per-signal fabrication
                      tells, mirroring the request-side layout above and
                      the STRUCTURAL_FABRICATION block. Each entry shows
                      the plain-English headline, the signal id, and the
                      engine's description string. `signals` is optional
                      on `AvriEngine2RawHttpResponse` (legacy persisted
                      reports won't carry it) so we default to an empty
                      list and skip the list when empty.
                    */}
                    {(rawHttp.response.signals ?? []).length > 0 && (
                      <ul className="space-y-1.5">
                        {rawHttp.response.signals!.map((s) => (
                          <li
                            key={s.id}
                            className="text-[11px] font-mono space-y-0.5"
                          >
                            <div className="flex items-baseline gap-1.5 flex-wrap">
                              <span className="text-red-400/90 font-semibold">
                                {RAW_HTTP_SIGNAL_LABELS[s.id] ?? s.id}
                              </span>
                              <span className="text-muted-foreground">
                                ({s.id})
                              </span>
                            </div>
                            <div className="text-foreground/80 leading-snug">
                              {s.description}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {/*
                      Task #447: surface the response-class revoked gold
                      signal id(s) inside the FAKE_RAW_HTTP_RESPONSE
                      sub-block so a reviewer can tell which revocations
                      came from the fabricated response (vs. the request
                      side, which is shown by the parent "Gold Signals
                      Revoked" list below). Wording mirrors the printable
                      triage report's "Response gold signals revoked"
                      sub-bullet so the panel and the offline MD/PDF
                      export stay in lock-step. `revokedGoldHits` is
                      optional on `AvriEngine2RawHttpResponse` (legacy
                      persisted reports won't carry it) so we default to
                      an empty list and skip the line when empty.
                    */}
                    {(rawHttp.response.revokedGoldHits ?? []).length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                          Response gold signals revoked
                        </div>
                        <ul className="space-y-0.5">
                          {rawHttp.response.revokedGoldHits!.map((r) => (
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
                {rawHttp.revokedGoldHits.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                      Gold Signals Revoked
                    </div>
                    <ul className="space-y-0.5">
                      {rawHttp.revokedGoldHits.map((r) => (
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

        {/*
          Task #428 — surface the Task #300 AI self-disclosure detector
          output (e.g. "prepared using an AI security assistant") inline in
          the AVRI rubric block. Reviewers previously could only see the
          deduction in the engine note; now each matched phrase, its
          detector id, and the applied penalty render alongside the other
          out-of-cap penalty rows. Lives OUTSIDE the FLAT/non-FLAT ternary
          so a FLAT report (no specific CWE family detected) that openly
          attributes itself to an AI assistant still surfaces the evidence;
          the detector runs against the whole body irrespective of family.
          Renders only when `aiSelfDisclosure?.detected` is true so
          legitimate reports stay uncluttered.
        */}
        {aiSelfDisclosure?.detected && (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 space-y-2"
            data-testid="ai-self-disclosure-block"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-5 font-mono text-amber-400 border-amber-500/40"
              >
                AI_SELF_DISCLOSURE
              </Badge>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                AI self-disclosure penalty ({aiSelfDisclosure.penalty})
              </span>
            </div>
            <p className="text-[11px] text-amber-300/90 leading-relaxed">
              {aiSelfDisclosure.matches.length} phrase
              {aiSelfDisclosure.matches.length === 1 ? "" : "s"} openly
              attributing this report to an AI assistant fired against the
              body. The penalty is bounded — see the engine note for the
              applied amount.
            </p>
            <ul className="space-y-1.5">
              {aiSelfDisclosure.matches.map((m, i) => (
                <li
                  key={`${m.id}-${i}`}
                  className="text-[11px] font-mono space-y-0.5"
                >
                  <div className="text-foreground/80 leading-snug">
                    “{m.excerpt}”
                  </div>
                  <div className="text-muted-foreground">({m.id})</div>
                </li>
              ))}
            </ul>
          </div>
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

// Task #209 — observation-only audit panel that surfaces (1) whether the
// LLM substance gate fired or was cost-skipped (and which side of the
// borderline drove the skip), and (2) whether the validity-fusion
// disagreement floor (Math.min when |heuristic - llm| > 30) was applied.
// Pure read-only display: clicking these stats has no side effects, and
// the underlying scoring rules are unchanged by this audit pass.
function AuditTelemetrySection({ audit }: { audit: AuditTelemetryBlock }) {
  const { llmGating, validityFusion } = audit;

  // Plain-English summary of the cost-gate decision so reviewers don't
  // have to memorize the LlmGateReason enum or recompute thresholds.
  const gateSummary = (() => {
    const cg = llmGating.costGuard;
    // Task #442 — composite is now the primary gate signal. Render it
    // verbatim when present; the legacy heuristic-only branches stay for
    // pre-composite reports.
    const composite = llmGating.compositeScoreUsed;
    switch (llmGating.reason) {
      case "fired_borderline":
        return `Fired (heuristic ${llmGating.heuristicScore} in borderline band ${cg.low}–${cg.high})`;
      case "fired_borderline_and_low_confidence":
        return `Fired (heuristic ${llmGating.heuristicScore} in borderline ${cg.low}–${cg.high} AND low confidence ${llmGating.confidenceUsed.toFixed(2)} < ${cg.confidence})`;
      case "fired_borderline_composite":
        return `Fired (composite ${composite ?? "?"} in borderline band ${cg.low}–${cg.high} — substance ambiguous, LLM second opinion warranted)`;
      case "fired_low_confidence":
        return `Fired (low confidence ${llmGating.confidenceUsed.toFixed(2)} < ${cg.confidence})`;
      case "skipped_above_borderline":
        return `Skipped (heuristic ${llmGating.heuristicScore} above ${cg.high} — clearly slop)`;
      case "skipped_below_borderline":
        return `Skipped (heuristic ${llmGating.heuristicScore} below ${cg.low} — clearly clean)`;
      case "skipped_above_borderline_composite":
        return `Skipped (composite ${composite ?? "?"} above ${cg.high} — clearly valid, no LLM call needed)`;
      case "skipped_below_borderline_composite":
        return `Skipped (composite ${composite ?? "?"} below ${cg.low} — clearly slop, cost guard)`;
      case "skipped_composite_borderline_heuristic_confirms_slop":
        return `Skipped (composite ${composite ?? "?"} in borderline ${cg.low}–${cg.high} but heuristic ${llmGating.heuristicScore} ≥ ${cg.high} confirms slop)`;
      case "skipped_high_confidence_outside_borderline":
        return `Skipped (heuristic ${llmGating.heuristicScore} outside ${cg.low}–${cg.high} with high confidence)`;
      case "skipped_unavailable":
        return llmGating.llmAvailable
          ? "Skipped (degraded analysis — LLM not invoked)"
          : "Skipped (LLM provider unavailable)";
      default:
        return `${llmGating.shouldCall ? "Fired" : "Skipped"} (${llmGating.reason})`;
    }
  })();
  const userOverride = llmGating.userSkipped
    ? " · user opted out"
    : llmGating.shouldCall && !llmGating.actuallyFired
      ? " · LLM call did not return"
      : "";

  // Validity-fusion floor summary — only meaningful when both signals were
  // present. When only the heuristic ran, render a neutral note instead of
  // a misleading "blend used" line.
  const floorSummary = (() => {
    const v = validityFusion;
    if (v.llmRaw === null) {
      return `LLM-substance not present — validity = heuristic ${v.heuristic} (no blending, no floor)`;
    }
    if (v.conservativeFloorApplied) {
      const winner =
        v.higherSide === "heuristic"
          ? "heuristic"
          : v.higherSide === "llm"
            ? "LLM"
            : "either side (tied)";
      return `Lower-of fallback (Δ = ${v.delta?.toFixed(0) ?? "?"} > ${v.disagreementThreshold}; heuristic ${v.heuristic}, LLM ${v.llmRaw} → used ${v.finalApplied}, ${winner} was higher)`;
    }
    return `Blend used (Δ = ${v.delta?.toFixed(0) ?? "0"} ≤ ${v.disagreementThreshold}; heuristic ${v.heuristic}, LLM ${v.llmRaw} → blended ${v.blended ?? "—"})`;
  })();

  // Task #445 — annotate which numbers in this panel are deterministic
  // ("stable") and which depend on a single LLM draw ("variable across
  // runs"). The LLM gate decision and the heuristic side of the validity
  // fusion are computed from the report text alone, so re-rendering the
  // panel for the same report always produces the same gate verdict and
  // the same `heuristic` value. The `llmRaw` / `blended` / `finalApplied`
  // values, the `Δ` between heuristic and LLM, and the floor verdict
  // itself depend on this report's single LLM call (gpt-5-nano is
  // non-deterministic on borderline scores). The fixture-battery audit
  // at /api/test/run?withLlm=1&runs=N (Task #445) is what reviewers
  // should consult to see the across-run distribution of those
  // variable numbers — this per-report panel only shows one draw.
  const stabilityNote = validityFusion.llmRaw === null
    ? "LLM gate + heuristic numbers are stable across re-renders (no LLM draw)."
    : "LLM gate + heuristic numbers are stable across re-renders. LLM-derived numbers (Δ, llmRaw, blended, finalApplied, and the floor verdict) come from a single LLM draw and may differ between runs on borderline scores.";

  return (
    <section className="space-y-2" data-testid="audit-telemetry-section">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Score Audit (observation-only)
      </div>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-2 text-[11px] font-mono">
          <Badge
            variant="outline"
            className={`text-[10px] px-1.5 py-0 h-5 font-mono ${llmGating.actuallyFired ? "text-green-400 border-green-500/40" : "text-muted-foreground border-muted-foreground/30"}`}
          >
            LLM gate
          </Badge>
          <span className="text-foreground/90">{gateSummary}{userOverride}</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-2 text-[11px] font-mono">
          <Badge
            variant="outline"
            className={`text-[10px] px-1.5 py-0 h-5 font-mono ${validityFusion.conservativeFloorApplied ? "text-orange-400 border-orange-500/40" : "text-muted-foreground border-muted-foreground/30"}`}
          >
            Validity floor
          </Badge>
          <span className="text-foreground/90">{floorSummary}</span>
        </div>
        <p
          className="text-[10px] text-muted-foreground leading-snug pt-0.5"
          data-testid="audit-telemetry-stability-note"
        >
          {stabilityNote}
        </p>
      </div>
    </section>
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

// Mirrors `signalBreakdown.goldSignalBonus` from
// `artifacts/api-server/src/lib/engines/engines.ts`. Section is hidden when
// no categories fired (bonus=0 / empty signals).
type GoldSignalBonusBlock = {
  bonus?: number;
  rawSum?: number;
  cap?: number;
  signals?: Array<{ id: string; weight: number }>;
};

function readGoldSignalBonus(engines: EngineResult[]): GoldSignalBonusBlock | null {
  const e2 = engines.find((e) => /Technical Substance/i.test(e.engine));
  const sb = (e2?.signalBreakdown ?? {}) as Record<string, unknown>;
  const gb = sb.goldSignalBonus as GoldSignalBonusBlock | undefined;
  if (!gb) return null;
  const signals = Array.isArray(gb.signals) ? gb.signals : [];
  const bonus = gb.bonus ?? 0;
  // Gracefully omit when no bonus was applied (no categories fired).
  if (signals.length === 0 || bonus <= 0) return null;
  return gb;
}

function GoldSignalBonusSection({ engines }: { engines: EngineResult[] }) {
  const gb = readGoldSignalBonus(engines);
  if (!gb) return null;
  const bonus = gb.bonus ?? 0;
  const rawSum = gb.rawSum ?? bonus;
  const cap = gb.cap ?? bonus;
  const capped = rawSum > cap;
  const signals = gb.signals ?? [];
  return (
    <>
      <Separator className="bg-border/30" />
      <section className="space-y-2" data-testid="gold-signal-bonus-section">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Strong-Evidence Bonus (Gold Categories)
        </div>
        <div className="flex flex-wrap items-baseline gap-3 text-[11px] font-mono">
          <span>
            applied: <span className="font-bold text-green-400/90">+{bonus}</span>
          </span>
          {capped ? (
            <span className="text-orange-400/90">
              raw +{rawSum} capped at +{cap}
            </span>
          ) : (
            <span className="text-muted-foreground">
              raw +{rawSum} (under cap +{cap})
            </span>
          )}
          <span className="text-muted-foreground">
            {signals.length} categor{signals.length === 1 ? "y" : "ies"} fired
          </span>
        </div>
        <ul className="space-y-0.5">
          {signals.map((s) => {
            const label = GOLD_SIGNAL_LABELS[s.id];
            return (
              <li
                key={s.id}
                className="text-[11px] font-mono text-green-400/90 flex items-baseline gap-1 flex-wrap"
              >
                <span>+{s.weight}</span>
                <span className="text-foreground/80">{s.id}</span>
                {label && (
                  <span className="text-muted-foreground font-sans">
                    — {label}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Strong-evidence categories (real crash traces, raw HTTP, payload
          classes, etc.) each contribute a small per-category bonus to Engine
          2&apos;s substance score; the sum is capped so a single report with
          several payload classes can&apos;t dominate.
        </p>
      </section>
    </>
  );
}

const DEFAULT_PUBLIC_URL = "https://vulnrap.com";

function buildAvriDocsLink(): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : DEFAULT_PUBLIC_URL;
  const base = origin.replace(/\/+$/, "");
  return `${base}/changelog#avri-family-rubric`;
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

  // Task 190: render the AVRI Family Rubric via the shared helper in
  // `@workspace/avri-rubric` so this export and the server-side
  // `/reports/:id/triage-report` endpoint stay in lock-step. See that
  // package for the canonical formatting and snapshot test.
  const e2EngineForAvri = data.engines?.engines?.find((e) => /Technical Substance/i.test(e.engine));
  const e2Avri = (e2EngineForAvri?.signalBreakdown?.avri ?? null) as AvriEngine2Block | null;
  const avriComposite = (data.avri ?? null) as AvriCompositeBlock | null;
  const avriOverrides = data.composite?.overridesApplied ?? data.trace?.composite?.overridesApplied ?? [];
  lines.push(
    ...buildAvriRubricMarkdown({
      composite: avriComposite,
      engine2: e2Avri,
      overridesApplied: avriOverrides,
      docsLink: buildAvriDocsLink(),
    }),
  );

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

  // Mirror the panel's Strong-Evidence Bonus section in the markdown export
  // so triage threads stay self-contained.
  const goldBonus = readGoldSignalBonus(engines);
  if (goldBonus) {
    const bonus = goldBonus.bonus ?? 0;
    const rawSum = goldBonus.rawSum ?? bonus;
    const cap = goldBonus.cap ?? bonus;
    const signals = goldBonus.signals ?? [];
    const capNote = rawSum > cap
      ? `raw +${rawSum} capped at +${cap}`
      : `raw +${rawSum} (under cap +${cap})`;
    lines.push("## Strong-Evidence Bonus (Gold Categories)");
    lines.push(
      `- Applied: **+${bonus}** — ${capNote}; ${signals.length} categor${signals.length === 1 ? "y" : "ies"} fired`,
    );
    for (const s of signals) {
      const label = GOLD_SIGNAL_LABELS[s.id];
      const labelSuffix = label ? ` — ${label}` : "";
      lines.push(`  - +${s.weight} \`${s.id}\`${labelSuffix}`);
    }
    lines.push("");
  }

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

  // Task #209 — observation-only audit telemetry block in the markdown
  // export so reviewers can paste a single summary into a triage thread.
  // Mirrors the panel's "Score Audit" section line-for-line.
  if (data.auditTelemetry) {
    const { llmGating, validityFusion } = data.auditTelemetry;
    lines.push("## Score Audit (observation-only)");
    // Task #442 — surface the composite signal that drove the gate when
    // present so reviewers can see at a glance which path (composite-driven
    // vs legacy heuristic-only) was used.
    const compositeStr =
      typeof llmGating.compositeScoreUsed === "number"
        ? `, composite ${llmGating.compositeScoreUsed}`
        : ", composite n/a";
    lines.push(
      `- LLM gate: **${llmGating.actuallyFired ? "fired" : "skipped"}** — \`${llmGating.reason}\` ` +
        `(heuristic ${llmGating.heuristicScore}${compositeStr}, confidence ${llmGating.confidenceUsed.toFixed(2)}, ` +
        `cost guard ${llmGating.costGuard.low}–${llmGating.costGuard.high})` +
        (llmGating.userSkipped ? " · user opted out" : "") +
        (llmGating.shouldCall && !llmGating.actuallyFired ? " · LLM call did not return" : ""),
    );
    if (validityFusion.llmRaw === null) {
      lines.push(
        `- Validity floor: **n/a** — LLM-substance not present; validity = heuristic ${validityFusion.heuristic}`,
      );
    } else if (validityFusion.conservativeFloorApplied) {
      lines.push(
        `- Validity floor: **lower-of fallback applied** (Δ = ${validityFusion.delta?.toFixed(0) ?? "?"} > ${validityFusion.disagreementThreshold}; ` +
          `heuristic ${validityFusion.heuristic}, LLM ${validityFusion.llmRaw} → used ${validityFusion.finalApplied}; ` +
          `${validityFusion.higherSide ?? "n/a"} was higher)`,
      );
    } else {
      lines.push(
        `- Validity floor: **blend used** (Δ = ${validityFusion.delta?.toFixed(0) ?? "0"} ≤ ${validityFusion.disagreementThreshold}; ` +
          `heuristic ${validityFusion.heuristic}, LLM ${validityFusion.llmRaw} → blended ${validityFusion.blended ?? "—"})`,
      );
    }
    // Task #445 — flag which numbers above are stable across re-runs
    // and which depend on this report's single LLM draw, so triage
    // threads quoting this block don't treat the floor verdict as a
    // deterministic finding.
    if (validityFusion.llmRaw === null) {
      lines.push(
        "- Stability: LLM gate decision and `heuristic` are stable across re-runs (no LLM draw on this report).",
      );
    } else {
      lines.push(
        "- Stability: LLM gate decision and `heuristic` are stable across re-runs. " +
          "`llmRaw`, `Δ`, `blended`, `finalApplied`, and the floor verdict come from a single LLM draw " +
          "and may differ between runs on borderline scores. For across-run distribution, see " +
          "`/api/test/run?withLlm=1&runs=N` (Task #445) `auditTelemetry.validityFusion.perRunFloorFireCount` and `variance`.",
      );
    }
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

/**
 * Task #644 — Cross-AI-agent fingerprint section. Renders the heuristic
 * detector's verdict (one of GPT-4 / Claude / Gemini / Cursor agent /
 * Replit agent / Human / Unknown) plus the rules that voted, the per-
 * candidate raw scores, and the lightweight stylometric features. Always
 * framed as a "likely fingerprint" — never a hard attribution claim — and
 * collapses to a low-key "Unknown" pill when the body is too short or
 * generic to score.
 */
function AgentFingerprintSection({
  fingerprint,
}: {
  fingerprint: NonNullable<DiagnosticsResponse["agentFingerprint"]>;
}) {
  const isUnknown = fingerprint.likelyAgent === "unknown";
  const pct = Math.round(fingerprint.confidence * 100);
  const AGENT_LABEL: Record<string, string> = {
    gpt4: "GPT-4 / ChatGPT",
    claude: "Claude",
    gemini: "Gemini",
    "cursor-agent": "Cursor agent",
    "replit-agent": "Replit agent",
    human: "Human",
  };
  const tone = isUnknown
    ? "text-muted-foreground border-muted-foreground/30"
    : fingerprint.likelyAgent === "human"
    ? "text-green-400 border-green-500/40"
    : "text-purple-400 border-purple-500/40";

  // Sort the raw per-candidate scores high → low so the runner-up sits
  // right under the winner for at-a-glance disambiguation.
  const sortedScores = Object.entries(fingerprint.scores)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <section className="space-y-2" data-testid="agent-fingerprint-section">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Likely AI-Agent Fingerprint
        </div>
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-4 font-mono normal-case text-muted-foreground border-muted-foreground/30"
        >
          Heuristic · not attribution
        </Badge>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={cn("text-[11px] px-2 py-0.5 font-mono", tone)}>
          {fingerprint.likelyAgentLabel}
        </Badge>
        {!isUnknown && (
          <span className="text-[11px] font-mono text-muted-foreground">
            confidence {pct}%
          </span>
        )}
      </div>
      {isUnknown && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Not enough stylistic evidence in the report body to point to a specific
          agent. Short or generic prose collapses to <span className="font-mono">Unknown</span> by design.
        </p>
      )}
      {sortedScores.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {sortedScores.map(([agent, score]) => (
            <div
              key={agent}
              className="flex items-center justify-between rounded-md border border-border/40 bg-muted/10 px-2 py-1"
            >
              <span className="text-[11px] truncate">{AGENT_LABEL[agent] ?? agent}</span>
              <span className="text-[11px] font-mono text-muted-foreground ml-2">
                {score}
              </span>
            </div>
          ))}
        </div>
      )}
      {fingerprint.matches.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Rules that fired
          </div>
          <ul className="space-y-0.5">
            {fingerprint.matches.map((m) => (
              <li key={m.id} className="text-[11px] font-mono text-muted-foreground leading-snug">
                · <span className="text-foreground">+{m.weight}</span> {m.description}
                {m.excerpt && (
                  <span className="text-muted-foreground/80"> — “{m.excerpt}”</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
        <Stat label="Words" value={`${fingerprint.features.wordCount}`} />
        <Stat
          label="Avg sentence"
          value={fingerprint.features.avgSentenceLen.toFixed(1)}
          sub="words"
        />
        <Stat label="Em-dashes" value={`${fingerprint.features.emDashCount}`} />
        <Stat label="Bold headers" value={`${fingerprint.features.boldHeaderCount}`} />
        <Stat label="Bullets" value={`${fingerprint.features.bulletCount}`} />
        <Stat label="Sentences" value={`${fingerprint.features.sentenceCount}`} />
      </div>
    </section>
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
