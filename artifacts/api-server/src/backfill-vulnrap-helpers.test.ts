// Task #193 — coverage for the bulk vulnrap backfill's hallucination
// reconstruction path. Locks in three guarantees:
//   1. Each per-signal snippet in HALLUCINATION_TRIGGER_SNIPPETS, when fed
//      through detectHallucinationSignals on its own, fires ONLY its named
//      signal (no cross-talk that would over-penalize a legacy report).
//   2. Joining every snippet still re-fires every signal exactly once (so
//      a report whose cached evidence cited all of them rebuilds the same
//      totalWeight tier the original analysis recorded).
//   3. Wiring the rebuilt trigger text into computeComposite drops a
//      previously-strong-CWE-fit fabricated report's composite by the
//      override amount the live analysis path would have applied.

import { describe, it, expect } from "vitest";
import {
  HALLUCINATION_TRIGGER_SNIPPETS,
  reconstructHallucinationTriggerText,
} from "./backfill-vulnrap-helpers";
import { detectHallucinationSignals } from "./lib/hallucination-detector";
import { computeComposite, type EngineResult } from "./lib/engines";
import type { EvidenceItem } from "@workspace/db";

const SIGNAL_NAMES = Object.keys(HALLUCINATION_TRIGGER_SNIPPETS);

function evidenceFor(...signalTypes: string[]): EvidenceItem[] {
  return signalTypes.map((t) => ({
    type: `hallucination_${t}`,
    description: `cached ${t} signal`,
    weight: 1,
  }));
}

function mk(
  engine: string,
  score: number,
  verdict: EngineResult["verdict"] = "GREY",
): EngineResult {
  return {
    engine,
    score,
    verdict,
    confidence: "MEDIUM",
    triggeredIndicators: [],
    signalBreakdown: {},
    note: "fixture",
  };
}

describe("reconstructHallucinationTriggerText — per-signal snippet purity", () => {
  for (const signalType of SIGNAL_NAMES) {
    it(`snippet for ${signalType} fires exactly that one detector signal`, () => {
      const snippet = HALLUCINATION_TRIGGER_SNIPPETS[signalType]!;
      const result = detectHallucinationSignals(snippet);
      const firedTypes = result.signals.map((s) => s.type).sort();
      expect(firedTypes).toEqual([signalType]);
    });
  }
});

describe("reconstructHallucinationTriggerText — combined fidelity", () => {
  it("returns '' when evidence is null/empty/has no hallucination_* entries", () => {
    expect(reconstructHallucinationTriggerText(null)).toBe("");
    expect(reconstructHallucinationTriggerText([])).toBe("");
    expect(
      reconstructHallucinationTriggerText([
        { type: "spectral_repetition", description: "x", weight: 3 },
        { type: "claim_unsupported", description: "y", weight: 2 },
      ]),
    ).toBe("");
  });

  it("re-fires every signal exactly once when all signals were cached", () => {
    const evidence = evidenceFor(...SIGNAL_NAMES);
    const text = reconstructHallucinationTriggerText(evidence);
    const result = detectHallucinationSignals(text);
    const firedTypes = result.signals.map((s) => s.type).sort();
    expect(firedTypes).toEqual([...SIGNAL_NAMES].sort());
  });

  it("dedupes repeated cached entries and ignores unknown signal types", () => {
    const evidence = evidenceFor(
      "fabricated_pid",
      "fabricated_pid",
      "this_signal_does_not_exist",
    );
    const text = reconstructHallucinationTriggerText(evidence);
    expect(text).toBe(HALLUCINATION_TRIGGER_SNIPPETS.fabricated_pid);
    const result = detectHallucinationSignals(text);
    expect(result.signals.map((s) => s.type)).toEqual(["fabricated_pid"]);
  });
});

describe("backfill reconstruction path drops composite for fabricated reports", () => {
  it("applies HALLUCINATION_FABRICATED_EVIDENCE on a strong-CWE-fit fixture", () => {
    // Same engine shape as hallucination-override.test.ts's "strong-CWE-fit
    // fabricated report" case so we lock in that the BACKFILL path produces
    // the same drop-into-LIKELY-INVALID outcome the LIVE path produces.
    const engines: EngineResult[] = [
      mk("AI Authorship Detector", 35, "YELLOW"),
      mk("Technical Substance Analyzer", 38, "YELLOW"),
      mk("CWE Coherence Checker", 78, "GREEN"),
    ];
    // Cache the same fabrication signals the live detector would have
    // emitted for the original fabricated nginx UAF fixture.
    const evidence = evidenceFor(
      "fabricated_stack_trace",
      "phantom_exploit_script",
      "fabricated_pid",
      "repeated_sentences",
    );
    const triggerText = reconstructHallucinationTriggerText(evidence);
    expect(triggerText.length).toBeGreaterThan(0);

    const before = computeComposite(engines).overallScore;
    const after = computeComposite(engines, triggerText);
    expect(
      after.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(true);
    expect(after.overallScore).toBeLessThan(before);
    // The cached signals total weight = 15 + 8 + 6 + 6 = 35, so the override
    // tier is the -25 "overwhelming fabrication" band.
    expect(before - after.overallScore).toBe(25);
  });

  it("does NOT apply the override when no hallucination signals were cached", () => {
    const engines: EngineResult[] = [
      mk("AI Authorship Detector", 30, "GREEN"),
      mk("Technical Substance Analyzer", 60, "YELLOW"),
      mk("CWE Coherence Checker", 70, "GREEN"),
    ];
    const triggerText = reconstructHallucinationTriggerText([]);
    expect(triggerText).toBe("");
    const r = computeComposite(
      engines,
      triggerText.length > 0 ? triggerText : undefined,
    );
    expect(
      r.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(false);
  });

  it("does NOT apply the override when only corroborating signals were cached (legit report)", () => {
    // Mirrors the live-path guard: incomplete_asan + fabricated_pid alone are
    // both corroborating-only signals, so a legit report that only cached
    // those (e.g. T1-AVRI-cve-2025-0725-curl) must NOT be penalized when
    // the backfill rescores it.
    const engines: EngineResult[] = [
      mk("AI Authorship Detector", 30, "GREEN"),
      mk("Technical Substance Analyzer", 60, "YELLOW"),
      mk("CWE Coherence Checker", 70, "GREEN"),
    ];
    const evidence = evidenceFor("incomplete_asan", "fabricated_pid");
    const triggerText = reconstructHallucinationTriggerText(evidence);
    const r = computeComposite(engines, triggerText);
    expect(
      r.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(false);
  });
});
