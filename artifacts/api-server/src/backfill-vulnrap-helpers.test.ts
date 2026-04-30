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
  parseArgs,
  chooseConcurrencyGuard,
  buildBackfillRescoreAuditEntry,
  appendRescoreHistory,
  CliExit,
  type BackfillRescoreAuditEntry,
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

describe("parseArgs (rescore flags)", () => {
  const argv = (...flags: string[]) => ["node", "backfill-vulnrap.mjs", ...flags];

  it("defaults rescore=false and onlyWithCachedHallucination=false", () => {
    const opts = parseArgs(argv());
    expect(opts.rescore).toBe(false);
    expect(opts.onlyWithCachedHallucination).toBe(false);
    // Existing defaults stay unchanged so scheduled jobs keep their behavior.
    expect(opts.dryRun).toBe(false);
    expect(opts.limit).toBeNull();
    expect(opts.batchSize).toBe(50);
  });

  it("--rescore and --only-with-cached-hallucination flip independently", () => {
    expect(parseArgs(argv("--rescore")).rescore).toBe(true);
    expect(parseArgs(argv("--rescore")).onlyWithCachedHallucination).toBe(false);
    expect(parseArgs(argv("--only-with-cached-hallucination")).rescore).toBe(false);
    expect(
      parseArgs(argv("--only-with-cached-hallucination")).onlyWithCachedHallucination,
    ).toBe(true);
  });

  it("accepts both new flags alongside dry-run / limit", () => {
    const opts = parseArgs(
      argv("--dry-run", "--rescore", "--only-with-cached-hallucination", "--limit=25"),
    );
    expect(opts).toEqual({
      dryRun: true,
      limit: 25,
      batchSize: 50,
      rescore: true,
      onlyWithCachedHallucination: true,
    });
  });

  it("--help throws CliExit(0) and unknown flags throw CliExit(2)", () => {
    expect(() => parseArgs(argv("--help"))).toThrow(CliExit);
    try {
      parseArgs(argv("--help"));
    } catch (e) {
      expect((e as CliExit).code).toBe(0);
      expect((e as CliExit).message).toContain("--rescore");
      expect((e as CliExit).message).toContain("--only-with-cached-hallucination");
    }

    try {
      parseArgs(argv("--no-such-flag"));
      throw new Error("expected CliExit");
    } catch (e) {
      expect(e).toBeInstanceOf(CliExit);
      expect((e as CliExit).code).toBe(2);
    }
  });
});

describe("buildBackfillRescoreAuditEntry (Task #389)", () => {
  it("captures every prior + new field with the fixed source tag", () => {
    const entry = buildBackfillRescoreAuditEntry({
      mode: "engine",
      priorCompositeScore: 47,
      priorCompositeLabel: "NEEDS REVIEW",
      priorCorrelationId: "corr-prev-123",
      newCompositeScore: 22,
      newCompositeLabel: "LIKELY INVALID",
      newCorrelationId: "corr-new-456",
      now: new Date("2026-04-30T12:34:56.000Z"),
    });
    expect(entry).toEqual({
      source: "backfill-rescore",
      mode: "engine",
      rescoredAt: "2026-04-30T12:34:56.000Z",
      priorCompositeScore: 47,
      priorCompositeLabel: "NEEDS REVIEW",
      priorCorrelationId: "corr-prev-123",
      newCompositeScore: 22,
      newCompositeLabel: "LIKELY INVALID",
      newCorrelationId: "corr-new-456",
    });
  });

  it("preserves null prior label / correlation id (legacy already-scored rows)", () => {
    const entry = buildBackfillRescoreAuditEntry({
      mode: "reconstruction",
      priorCompositeScore: 51,
      priorCompositeLabel: null,
      priorCorrelationId: null,
      newCompositeScore: 60,
      newCompositeLabel: "REASONABLE",
      newCorrelationId: "recon-abc-def",
      now: new Date("2026-04-30T00:00:00.000Z"),
    });
    expect(entry.priorCompositeLabel).toBeNull();
    expect(entry.priorCorrelationId).toBeNull();
    expect(entry.mode).toBe("reconstruction");
    expect(entry.source).toBe("backfill-rescore");
  });

  it("defaults rescoredAt to now() when no clock is injected", () => {
    const before = Date.now();
    const entry = buildBackfillRescoreAuditEntry({
      mode: "engine",
      priorCompositeScore: 50,
      priorCompositeLabel: "NEEDS REVIEW",
      priorCorrelationId: "p",
      newCompositeScore: 50,
      newCompositeLabel: "NEEDS REVIEW",
      newCorrelationId: "n",
    });
    const ts = Date.parse(entry.rescoredAt);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1);
  });
});

describe("appendRescoreHistory (Task #389)", () => {
  const sampleEntry = (overrides: Partial<BackfillRescoreAuditEntry> = {}): BackfillRescoreAuditEntry => ({
    source: "backfill-rescore",
    mode: "engine",
    rescoredAt: "2026-04-30T01:02:03.000Z",
    priorCompositeScore: 50,
    priorCompositeLabel: "NEEDS REVIEW",
    priorCorrelationId: "corr-old",
    newCompositeScore: 70,
    newCompositeLabel: "REASONABLE",
    newCorrelationId: "corr-new",
    ...overrides,
  });

  it("starts a fresh history when the prior blob has no rescoreHistory", () => {
    const entry = sampleEntry();
    expect(appendRescoreHistory(undefined, entry)).toEqual([entry]);
    expect(appendRescoreHistory(null, entry)).toEqual([entry]);
    expect(appendRescoreHistory({ engines: [], engineCount: 3 }, entry)).toEqual([entry]);
  });

  it("preserves prior valid entries in chronological order (oldest first, new last)", () => {
    const existing = sampleEntry({
      rescoredAt: "2026-04-01T00:00:00.000Z",
      newCompositeScore: 60,
      newCorrelationId: "corr-mid",
    });
    const fresh = sampleEntry({
      rescoredAt: "2026-04-30T00:00:00.000Z",
      priorCompositeScore: 60,
      priorCorrelationId: "corr-mid",
      newCompositeScore: 75,
      newCorrelationId: "corr-newest",
    });
    const result = appendRescoreHistory({ rescoreHistory: [existing] }, fresh);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(existing);
    expect(result[1]).toEqual(fresh);
  });

  it("drops malformed historical entries but keeps valid ones", () => {
    const valid = sampleEntry();
    const malformed = [
      null,
      "not an object",
      { source: "manual-override" }, // wrong source
      { source: "backfill-rescore", mode: "weird" }, // bad mode
      { source: "backfill-rescore", mode: "engine", rescoredAt: 123 }, // non-string ts
    ];
    const fresh = sampleEntry({ newCorrelationId: "corr-fresh" });
    const result = appendRescoreHistory(
      { rescoreHistory: [...malformed, valid] as unknown[] },
      fresh,
    );
    expect(result).toEqual([valid, fresh]);
  });

  it("treats a non-array rescoreHistory as missing without throwing", () => {
    const entry = sampleEntry();
    expect(appendRescoreHistory({ rescoreHistory: "oops" }, entry)).toEqual([entry]);
    expect(appendRescoreHistory({ rescoreHistory: { 0: entry } }, entry)).toEqual([entry]);
  });
});

describe("chooseConcurrencyGuard", () => {
  it("returns isNullComposite when the row was never scored", () => {
    expect(chooseConcurrencyGuard(null, null)).toEqual({ kind: "isNullComposite" });
    // Even if a stale correlation id happens to be present, the score
    // being NULL is the source of truth: keep the original NULL-only
    // guard so we don't clobber a concurrent first-time write.
    expect(chooseConcurrencyGuard(null, "stale-id")).toEqual({ kind: "isNullComposite" });
  });

  it("pins to the captured correlation id when both score and id are present", () => {
    expect(chooseConcurrencyGuard(72, "corr-abc")).toEqual({
      kind: "matchCorrelationId",
      correlationId: "corr-abc",
    });
  });

  it("falls back to score+null-correlation guard when correlation id is missing", () => {
    // Without this fallback `eq(corrId, null)` evaluates to NULL in SQL
    // and the row is silently skipped — defeating the rescore for
    // already-scored legacy rows that never had a correlation id.
    expect(chooseConcurrencyGuard(58, null)).toEqual({
      kind: "isNullCorrelationAndScore",
      compositeScore: 58,
    });
  });
});
