import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DiagnosticsPanel } from "./diagnostics-panel";

const REPORT_ID = 4242;

const SAMPLE_DIAGNOSTICS = {
  reportId: REPORT_ID,
  correlationId: "corr-test-1234",
  durationMs: 187,
  composite: {
    score: 73,
    label: "LIKELY_AI",
    overridesApplied: ["claim-evidence-mismatch"],
  },
  legacyMapping: {
    slopScore: 27,
    displayMode: "legacy",
    note: "Legacy slop score derived from the new composite for backward compatibility.",
  },
  featureFlags: {
    VULNRAP_USE_NEW_COMPOSITE: true,
  },
  trace: {
    correlationId: "corr-test-1234",
    totalDurationMs: 187,
    stages: [
      { stage: "ingest", durationMs: 12 },
      { stage: "engine-1-perplexity", durationMs: 84 },
      { stage: "composite", durationMs: 41 },
    ],
    enginesUsed: ["perplexity", "completeness"],
    composite: {
      overallScore: 73,
      label: "LIKELY_AI",
      overridesApplied: ["claim-evidence-mismatch"],
      warnings: [],
    },
    signalsSummary: {
      wordCount: 421,
      codeBlockCount: 2,
      realUrlCount: 1,
      completenessScore: 0.62,
      claimEvidenceRatio: 0.4,
      claimedCwes: ["CWE-79"],
    },
    featureFlags: { VULNRAP_USE_NEW_COMPOSITE: true },
    notes: [],
  },
  engines: {
    engines: [
      {
        engine: "perplexity",
        score: 70,
        verdict: "RED" as const,
        confidence: "HIGH" as const,
        signalBreakdown: {
          perplexity: {
            bigramEntropy: 7.213,
            functionWordRate: 42.1,
            syntaxValidityScore: 0.93,
            combinedScore: 71.2,
            rawEngine1Score: 68,
            rawEngine1Verdict: "RED",
          },
        },
      },
    ],
    compositeBreakdown: {
      weightedSum: 146,
      totalWeight: 2,
      beforeOverride: 73,
      afterOverride: 73,
    },
    warnings: [],
    engineCount: 1,
  },
};

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiagnosticsPanel reportId={REPORT_ID} />
    </QueryClientProvider>,
  );
}

describe("DiagnosticsPanel smoke test", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes(`/api/reports/${REPORT_ID}/diagnostics`)) {
        return new Response(JSON.stringify(SAMPLE_DIAGNOSTICS), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders composite, legacy slop mapping, feature flag, and stage timing once expanded", async () => {
    const user = userEvent.setup();
    renderWithClient();

    // Collapsed by default — diagnostics body is hidden
    expect(screen.queryByText(/Composite Breakdown/i)).not.toBeInTheDocument();

    // Expand the panel
    await user.click(screen.getByRole("button", { name: /show/i }));

    // Wait for the diagnostics fetch to settle
    await waitFor(() => {
      expect(screen.getByText(/Composite Breakdown/i)).toBeInTheDocument();
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining(`/api/reports/${REPORT_ID}/diagnostics`),
    );

    // Composite score
    expect(screen.getByText("Composite")).toBeInTheDocument();
    expect(screen.getByText("73")).toBeInTheDocument();
    expect(screen.getByText("LIKELY_AI")).toBeInTheDocument();

    // Legacy slop-score mapping block
    const legacyHeadings = screen.getAllByText(/Legacy Slop-Score Mapping/i);
    expect(legacyHeadings.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Legacy Slop Score")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByText("legacy")).toBeInTheDocument();

    // Feature-flag indicator
    expect(screen.getByText("VULNRAP_USE_NEW_COMPOSITE")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();

    // At least one pipeline stage timing rendered
    expect(screen.getAllByText(/Pipeline Timings/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("ingest")).toBeInTheDocument();
    expect(screen.getByText("12 ms")).toBeInTheDocument();
    expect(screen.getByText(/total 187 ms/i)).toBeInTheDocument();

    // Correlation id surfaced for triage
    expect(screen.getByText(/correlation: corr-test-1234/i)).toBeInTheDocument();
  });

  it("renders the AVRI family rubric section with gold hits, misses, absence penalties, and overrides", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(
      JSON.stringify({
        ...SAMPLE_DIAGNOSTICS,
        composite: {
          ...SAMPLE_DIAGNOSTICS.composite,
          overridesApplied: [
            "AVRI_NO_GOLD_SIGNALS: zero gold signals for Memory corruption / unsafe C",
            "AVRI_VELOCITY: same-day submission velocity penalty (-10)",
          ],
        },
        avri: {
          family: "MEMORY_CORRUPTION",
          familyName: "Memory corruption / unsafe C",
          classification: {
            confidence: "HIGH" as const,
            reason: "matched member CWE-787",
            evidence: ["CWE-787"],
            technology: null,
          },
          goldHitCount: 1,
          velocityPenalty: -10,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 42,
        },
        engines: {
          ...SAMPLE_DIAGNOSTICS.engines,
          engines: [
            {
              engine: "Technical Substance Analyzer",
              score: 38,
              verdict: "RED" as const,
              confidence: "MEDIUM" as const,
              signalBreakdown: {
                avri: {
                  family: "MEMORY_CORRUPTION",
                  familyName: "Memory corruption / unsafe C",
                  baseScore: 22,
                  goldHitCount: 1,
                  goldTotalCount: 8,
                  goldHits: [
                    { id: "asan_or_sanitizer", description: "AddressSanitizer crash output", points: 22 },
                  ],
                  goldMisses: [
                    { id: "valgrind", description: "Valgrind error trace", points: 18 },
                  ],
                  absencePenalty: -8,
                  absencePenalties: [
                    { id: "no_size_or_offset", description: "No explicit byte/size/offset value", points: 5 },
                  ],
                  contradictions: [],
                  contradictionPenalty: 0,
                  rawAvriScore: 14,
                  legacyScore: 50,
                  blendedScore: 38,
                },
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/AVRI Family Rubric/i)).toBeInTheDocument();
    });

    // Family + classification confidence
    expect(screen.getAllByText(/Memory corruption \/ unsafe C/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/class:\s*HIGH/i)).toBeInTheDocument();
    expect(screen.getByText(/matched member CWE-787/i)).toBeInTheDocument();

    // Gold hits/misses descriptions
    expect(screen.getByText(/Gold Signals Found/i)).toBeInTheDocument();
    expect(screen.getByText(/AddressSanitizer crash output/i)).toBeInTheDocument();
    expect(screen.getByText(/Expected Signals Missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Valgrind error trace/i)).toBeInTheDocument();

    // Absence penalty surfaced with description
    expect(screen.getByText(/Absence Penalties Applied/i)).toBeInTheDocument();
    expect(screen.getByText(/No explicit byte\/size\/offset value/i)).toBeInTheDocument();

    // Composite-level AVRI overrides surfaced
    expect(screen.getByText(/AVRI Composite Overrides/i)).toBeInTheDocument();
    expect(screen.getByText(/No gold signals for family/i)).toBeInTheDocument();
    expect(screen.getByText(/Submission-velocity penalty/i)).toBeInTheDocument();
  });

  it("renders the STRIPPED_CRASH_TRACE block with reason, frame counts, and revoked trace gold signals", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(
      JSON.stringify({
        ...SAMPLE_DIAGNOSTICS,
        avri: {
          family: "MEMORY_CORRUPTION",
          familyName: "Memory corruption / unsafe C",
          classification: {
            confidence: "HIGH" as const,
            reason: "matched member CWE-787",
            evidence: ["CWE-787"],
            technology: null,
          },
          goldHitCount: 0,
          velocityPenalty: 0,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 18,
        },
        engines: {
          ...SAMPLE_DIAGNOSTICS.engines,
          engines: [
            {
              engine: "Technical Substance Analyzer",
              score: 22,
              verdict: "RED" as const,
              confidence: "MEDIUM" as const,
              signalBreakdown: {
                avri: {
                  family: "MEMORY_CORRUPTION",
                  familyName: "Memory corruption / unsafe C",
                  baseScore: 18,
                  goldHitCount: 0,
                  goldTotalCount: 8,
                  goldHits: [],
                  goldMisses: [],
                  absencePenalty: 0,
                  absencePenalties: [],
                  contradictions: [],
                  contradictionPenalty: 0,
                  crashTrace: {
                    framesAnalyzed: 6,
                    goodFrames: 1,
                    placeholderFrames: 4,
                    isStripped: true,
                    reason: "Crash trace has 4/6 frames with placeholder symbols/offsets",
                    revokedGoldHits: [
                      { id: "asan_or_sanitizer", points: 22 },
                      { id: "stack_trace_with_offset", points: 14 },
                    ],
                    penalty: -18,
                  },
                  rawAvriScore: 0,
                  legacyScore: 30,
                  blendedScore: 22,
                },
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    });

    expect(screen.getByText(/crash trace downgraded \(-18\)/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Crash trace has 4\/6 frames with placeholder symbols\/offsets/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/frames:\s*6/i)).toBeInTheDocument();
    expect(screen.getByText(/good:\s*1/i)).toBeInTheDocument();
    expect(screen.getByText(/placeholder:\s*4/i)).toBeInTheDocument();

    expect(screen.getByText(/Trace Gold Signals Revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/asan_or_sanitizer/)).toBeInTheDocument();
    expect(screen.getByText(/stack_trace_with_offset/)).toBeInTheDocument();
  });

  it("renders the STRIPPED_CRASH_TRACE block with race-trace wording for RACE_CONCURRENCY reports", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(
      JSON.stringify({
        ...SAMPLE_DIAGNOSTICS,
        avri: {
          family: "RACE_CONCURRENCY",
          familyName: "Concurrency / data race",
          classification: {
            confidence: "HIGH" as const,
            reason: "matched member CWE-362",
            evidence: ["CWE-362"],
            technology: null,
          },
          goldHitCount: 0,
          velocityPenalty: 0,
          templatePenalty: 0,
          rawCompositeBeforeBehavioralPenalties: 18,
        },
        engines: {
          ...SAMPLE_DIAGNOSTICS.engines,
          engines: [
            {
              engine: "Technical Substance Analyzer",
              score: 22,
              verdict: "RED" as const,
              confidence: "MEDIUM" as const,
              signalBreakdown: {
                avri: {
                  family: "RACE_CONCURRENCY",
                  familyName: "Concurrency / data race",
                  baseScore: 18,
                  goldHitCount: 0,
                  goldTotalCount: 6,
                  goldHits: [],
                  goldMisses: [],
                  absencePenalty: 0,
                  absencePenalties: [],
                  contradictions: [],
                  contradictionPenalty: 0,
                  crashTrace: {
                    framesAnalyzed: 5,
                    goodFrames: 1,
                    placeholderFrames: 3,
                    isStripped: true,
                    reason: "TSan trace has 3/5 frames with placeholder symbols/offsets",
                    revokedGoldHits: [
                      { id: "tsan_or_helgrind_header", points: 22 },
                    ],
                    penalty: -18,
                  },
                  rawAvriScore: 0,
                  legacyScore: 30,
                  blendedScore: 22,
                },
              },
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    });

    // Wording reads naturally for a race report (not "crash trace")
    expect(screen.getByText(/race trace downgraded \(-18\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/crash trace downgraded/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/TSan trace has 3\/5 frames with placeholder symbols\/offsets/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/tsan_or_helgrind_header/)).toBeInTheDocument();
  });

  it("surfaces an error message when the diagnostics endpoint fails", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("boom", { status: 500 }));
    const user = userEvent.setup();
    renderWithClient();

    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Failed to load diagnostics: HTTP 500/i)).toBeInTheDocument();
    });
  });
});
