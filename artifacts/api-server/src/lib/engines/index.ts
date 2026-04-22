// Sprint 9 Phase 1: 3-engine VirusTotal-style consensus scorer.
// Public surface used by the API server pipeline.

import { logger } from "../logger";
import { extractSignals } from "./extractors";
import { runEngine1, runEngine2, runEngine3, computeComposite, type CompositeResult } from "./engines";
export { computeComposite } from "./engines";
import { computePerplexity, type PerplexityResult } from "./perplexity";
import type { PipelineTrace, PipelineStageTiming } from "@workspace/db";
import crypto from "crypto";
import { runAvriComposite, type AvriCompositeResult } from "./avri";

export type { EngineResult, CompositeResult, Verdict, Confidence, TriggeredIndicator } from "./engines";
export type { ExtractedSignals, CodeBlock } from "./extractors";
export type { PipelineTrace, PipelineStageTiming } from "@workspace/db";
export type { PerplexityResult } from "./perplexity";
export { CWE_FINGERPRINTS, HIGH_REJECTION_CWES } from "./cwe-fingerprints";
export { computePerplexity } from "./perplexity";
export type { AvriCompositeResult } from "./avri";
export * as avri from "./avri";

export interface AnalyzeWithEnginesOptions {
  claimedCwes?: string[];
  reportId?: number;
  reportTitle?: string;
  /** When true, returns the trace alongside the composite. */
  includeTrace?: boolean;
  /** AVRI: pre-computed velocity penalty (≤0) from the route layer. */
  velocityPenalty?: number;
  /** AVRI: pre-computed template-fingerprint penalty (≤0) from the route layer. */
  templatePenalty?: number;
}

export interface AnalyzeWithEnginesTracedResult {
  composite: CompositeResult;
  trace: PipelineTrace;
  perplexity: PerplexityResult;
  /** Present when the AVRI feature flag is enabled. */
  avri?: AvriCompositeResult["avri"];
}

const FEATURE_USE_NEW_COMPOSITE = (): boolean =>
  (process.env.VULNRAP_USE_NEW_COMPOSITE ?? "true").toLowerCase() !== "false";

const FEATURE_USE_AVRI = (): boolean =>
  (process.env.VULNRAP_USE_AVRI ?? "false").toLowerCase() === "true";

export function isNewCompositeEnabled(): boolean {
  return FEATURE_USE_NEW_COMPOSITE();
}

export function isAvriEnabled(): boolean {
  return FEATURE_USE_AVRI();
}

/** Map composite (0..100, higher=better) to legacy slop score (0..100, higher=worse). */
export function compositeToLegacySlopScore(compositeScore: number): number {
  return Math.max(0, Math.min(100, 100 - compositeScore));
}

export function analyzeWithEngines(
  text: string,
  opts: AnalyzeWithEnginesOptions = {},
): CompositeResult {
  return analyzeWithEnginesTraced(text, opts).composite;
}

export function analyzeWithEnginesTraced(
  text: string,
  opts: AnalyzeWithEnginesOptions = {},
): AnalyzeWithEnginesTracedResult {
  const correlationId = crypto.randomUUID();
  const stages: PipelineStageTiming[] = [];
  const startedAt = Date.now();

  const stage = <T>(name: string, fn: () => T): T => {
    const s = Date.now();
    const out = fn();
    const e = Date.now();
    stages.push({ stage: name, startedAt: s, endedAt: e, durationMs: e - s });
    return out;
  };

  // AVRI path — gated by VULNRAP_USE_AVRI. Returns a CompositeResult-shaped
  // object so the existing trace/persistence layer doesn't need to know about
  // AVRI specifically; the AVRI metadata is surfaced via the optional `avri`
  // field on the traced result.
  if (FEATURE_USE_AVRI()) {
    const signals = stage("extract_signals", () => extractSignals(text, opts.claimedCwes));
    const perplexity = stage("perplexity", () => computePerplexity(text, signals.codeBlocks));
    const avriComposite = stage("avri_composite", () =>
      runAvriComposite(text, {
        claimedCwes: opts.claimedCwes,
        velocityPenalty: opts.velocityPenalty,
        templatePenalty: opts.templatePenalty,
      }),
    );
    const totalDurationMs = Date.now() - startedAt;
    const trace: PipelineTrace = {
      correlationId,
      reportId: opts.reportId ?? null,
      totalDurationMs,
      stages,
      enginesUsed: avriComposite.engineResults.map((r) => r.engine),
      composite: {
        overallScore: avriComposite.overallScore,
        label: avriComposite.label,
        overridesApplied: avriComposite.overridesApplied,
        warnings: avriComposite.warnings,
      },
      signalsSummary: {
        wordCount: signals.wordCount,
        codeBlockCount: signals.codeBlockCount,
        realUrlCount: signals.realUrlCount,
        completenessScore: signals.completenessScore,
        claimEvidenceRatio: Number(signals.claimEvidenceRatio.toFixed(2)),
        claimedCwes: signals.claimedCwes,
      },
      featureFlags: {
        VULNRAP_USE_NEW_COMPOSITE: FEATURE_USE_NEW_COMPOSITE(),
        VULNRAP_USE_AVRI: true,
      },
      notes: [
        `AVRI family=${avriComposite.avri.family} (${avriComposite.avri.classification.confidence})`,
        `AVRI gold-hit-count=${avriComposite.avri.goldHitCount}`,
      ],
    };
    logger.info(
      {
        correlationId,
        reportId: opts.reportId,
        durationMs: totalDurationMs,
        composite: avriComposite.overallScore,
        label: avriComposite.label,
        avriFamily: avriComposite.avri.family,
        avriClassConfidence: avriComposite.avri.classification.confidence,
        goldHitCount: avriComposite.avri.goldHitCount,
        velocityPenalty: avriComposite.avri.velocityPenalty,
        templatePenalty: avriComposite.avri.templatePenalty,
        overridesApplied: avriComposite.overridesApplied,
      },
      "vulnrap.engines.avri_composite",
    );
    return { composite: avriComposite, trace, perplexity, avri: avriComposite.avri };
  }

  const signals = stage("extract_signals", () => extractSignals(text, opts.claimedCwes));
  const perplexity = stage("perplexity", () => computePerplexity(text, signals.codeBlocks));
  const e1Raw = stage("engine1_ai_authorship", () => runEngine1(signals));
  // Blend perplexity into Engine 1 score (60% original, 40% perplexity-derived)
  // since the original engine relies on coarse uniformity heuristics. The verdict
  // MUST be re-derived from the blended score so composite override rules
  // (CONVERGENT_NEGATIVE / DIVERGENT_HIGH_VARIANCE etc.) operate on the same
  // signal that diagnostics surfaces. Engine 1 verdict thresholds: ≤25 GREEN, ≤74 YELLOW, else RED.
  const blendedScore = Math.round(e1Raw.score * 0.6 + perplexity.combinedScore * 0.4);
  const blendedVerdict: typeof e1Raw.verdict =
    blendedScore <= 25 ? "GREEN" : blendedScore <= 74 ? "YELLOW" : "RED";
  const e1 = {
    ...e1Raw,
    score: blendedScore,
    verdict: blendedVerdict,
    signalBreakdown: {
      ...e1Raw.signalBreakdown,
      perplexity: {
        bigramEntropy: Number(perplexity.bigramEntropy.toFixed(3)),
        functionWordRate: Number(perplexity.functionWordRate.toFixed(2)),
        syntaxValidityScore: Number(perplexity.syntaxValidityScore.toFixed(2)),
        combinedScore: Number(perplexity.combinedScore.toFixed(1)),
        rawEngine1Score: e1Raw.score,
        rawEngine1Verdict: e1Raw.verdict,
      },
    },
  };
  const e2 = stage("engine2_substance", () => runEngine2(signals));
  const e3 = stage("engine3_cwe_coherence", () => runEngine3(signals, text));
  const composite = stage("composite", () => computeComposite([e1, e2, e3]));

  const totalDurationMs = Date.now() - startedAt;

  const trace: PipelineTrace = {
    correlationId,
    reportId: opts.reportId ?? null,
    totalDurationMs,
    stages,
    enginesUsed: composite.engineResults.map(r => r.engine),
    composite: {
      overallScore: composite.overallScore,
      label: composite.label,
      overridesApplied: composite.overridesApplied,
      warnings: composite.warnings,
    },
    signalsSummary: {
      wordCount: signals.wordCount,
      codeBlockCount: signals.codeBlockCount,
      realUrlCount: signals.realUrlCount,
      completenessScore: signals.completenessScore,
      claimEvidenceRatio: Number(signals.claimEvidenceRatio.toFixed(2)),
      claimedCwes: signals.claimedCwes,
    },
    featureFlags: {
      VULNRAP_USE_NEW_COMPOSITE: FEATURE_USE_NEW_COMPOSITE(),
    },
    notes: [],
  };

  logger.info(
    {
      correlationId,
      reportId: opts.reportId,
      reportTitle: opts.reportTitle,
      durationMs: totalDurationMs,
      stages: stages.map(s => `${s.stage}:${s.durationMs}ms`).join("|"),
      composite: composite.overallScore,
      label: composite.label,
      engines: composite.engineResults.map(r => ({
        engine: r.engine,
        score: r.score,
        verdict: r.verdict,
        confidence: r.confidence,
      })),
      overridesApplied: composite.overridesApplied,
      claimedCwes: signals.claimedCwes,
      claimEvidenceRatio: Number(signals.claimEvidenceRatio.toFixed(2)),
      perplexity: {
        entropy: Number(perplexity.bigramEntropy.toFixed(3)),
        fwRate: Number(perplexity.functionWordRate.toFixed(2)),
        ai: Number(perplexity.combinedScore.toFixed(1)),
      },
    },
    "vulnrap.engines.composite",
  );

  return { composite, trace, perplexity };
}
