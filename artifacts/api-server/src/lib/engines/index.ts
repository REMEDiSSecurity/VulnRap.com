// Sprint 9 Phase 1: 3-engine VirusTotal-style consensus scorer.
// Public surface used by the API server pipeline.

import { logger } from "../logger";
import { extractSignals } from "./extractors";
import { runEngine1, runEngine2, runEngine3, computeComposite, type CompositeResult } from "./engines";
import crypto from "crypto";

export type { EngineResult, CompositeResult, Verdict, Confidence, TriggeredIndicator } from "./engines";
export type { ExtractedSignals, CodeBlock } from "./extractors";
export { CWE_FINGERPRINTS, HIGH_REJECTION_CWES } from "./cwe-fingerprints";

export interface AnalyzeWithEnginesOptions {
  claimedCwes?: string[];
  reportId?: number;
  reportTitle?: string;
}

export function analyzeWithEngines(
  text: string,
  opts: AnalyzeWithEnginesOptions = {},
): CompositeResult {
  const correlationId = crypto.randomUUID();
  const start = Date.now();

  const signals = extractSignals(text, opts.claimedCwes);
  const e1 = runEngine1(signals);
  const e2 = runEngine2(signals);
  const e3 = runEngine3(signals, text);
  const composite = computeComposite([e1, e2, e3]);

  // Log a single trace line (analysis_traces table is out-of-scope for Phase 1).
  logger.info(
    {
      correlationId,
      reportId: opts.reportId,
      reportTitle: opts.reportTitle,
      durationMs: Date.now() - start,
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
    },
    "vulnrap.engines.composite",
  );

  return composite;
}
