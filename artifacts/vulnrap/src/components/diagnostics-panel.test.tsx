import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DiagnosticsPanel,
  buildMarkdownSummary,
  type DiagnosticsResponse,
} from "./diagnostics-panel";

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

  it("surfaces the FAKE_RAW_HTTP block in the printable markdown export with placeholder/CRLF/TE-CL counters", () => {
    const withRawHttp: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      avri: {
        family: "REQUEST_SMUGGLING",
        familyName: "HTTP request smuggling / desync",
        classification: {
          confidence: "HIGH" as const,
          reason: "matched member CWE-444",
          evidence: ["CWE-444"],
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
            triggeredIndicators: [
              {
                signal: "FAKE_RAW_HTTP",
                value: "1r/3g/4p",
                strength: "HIGH" as const,
                explanation:
                  "Fabricated raw HTTP request (no CRLFs, placeholder header values) (-18; revoked 2 smuggling gold signal(s))",
              },
            ],
            signalBreakdown: {
              avri: {
                family: "REQUEST_SMUGGLING",
                familyName: "HTTP request smuggling / desync",
                baseScore: 18,
                goldHitCount: 0,
                goldTotalCount: 6,
                goldHits: [],
                goldMisses: [],
                absencePenalty: 0,
                absencePenalties: [],
                contradictions: [],
                contradictionPenalty: 0,
                rawHttp: {
                  requestsAnalyzed: 1,
                  totalHeaders: 7,
                  placeholderHeaders: 4,
                  crlfPresent: false,
                  teClConflicts: 1,
                  teClBroken: 1,
                  isFake: true,
                  reason:
                    "Fabricated raw HTTP request (no CRLFs, placeholder header values)",
                  revokedGoldHits: [
                    { id: "raw_http_te_cl_conflict", points: 22 },
                    { id: "raw_http_request_with_headers", points: 14 },
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
    };

    const md = buildMarkdownSummary(withRawHttp);

    // Indicator row in the per-engine triggered-indicators table.
    expect(md).toContain("`FAKE_RAW_HTTP`");
    // Structural rawHttp block under the AVRI Family Rubric, alongside the
    // STRIPPED_CRASH_TRACE block, with the per-request counters spelled out.
    expect(md).toContain("Fake raw HTTP request (penalty -18)");
    expect(md).toContain("requests 1");
    expect(md).toContain("headers 3/7 good");
    expect(md).toContain("placeholder 4");
    expect(md).toContain("CRLF no");
    expect(md).toContain("TE/CL conflicts 1 (broken 1)");
    expect(md).toContain(
      "Smuggling gold signals revoked: raw_http_te_cl_conflict (−22), raw_http_request_with_headers (−14)",
    );
  });

  it("renders per-engine triggered indicators grouped by strength when the engine row is expanded", async () => {
    const withIndicators: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 22,
            verdict: "RED",
            confidence: "MEDIUM",
            triggeredIndicators: [
              {
                signal: "STRIPPED_CRASH_TRACE",
                value: true,
                strength: "HIGH",
                explanation: "Crash trace has 4/6 frames with placeholder symbols",
              },
              {
                signal: "ABSENCE_PENALTY",
                value: -8,
                strength: "MEDIUM",
                explanation: "Missing required gold signals",
              },
              {
                signal: "POC_MISMATCH",
                value: "url",
                strength: "LOW",
                explanation: "PoC URL did not match claim",
              },
            ],
            signalBreakdown: {},
          },
        ],
      },
    };
    fetchSpy.mockImplementationOnce(async () => new Response(
      JSON.stringify(withIndicators),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Per-Engine Scores/i)).toBeInTheDocument();
    });

    // Indicator count chip is rendered on the engine row
    expect(screen.getByText(/\(3 indicators\)/)).toBeInTheDocument();

    // Click the engine row to expand triggered indicators
    await user.click(screen.getByRole("button", { name: /Technical Substance Analyzer/i }));

    expect(screen.getAllByText(/Triggered Indicators/i).length).toBeGreaterThan(0);
    expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    expect(screen.getByText("ABSENCE_PENALTY")).toBeInTheDocument();
    expect(screen.getByText("POC_MISMATCH")).toBeInTheDocument();
    expect(
      screen.getByText(/Crash trace has 4\/6 frames with placeholder symbols/i),
    ).toBeInTheDocument();

    // Markdown export includes a Triggered Indicators subsection
    const md = buildMarkdownSummary(withIndicators);
    expect(md).toContain("### Triggered Indicators — Technical Substance Analyzer");
    expect(md).toContain("**HIGH**");
    expect(md).toContain("`STRIPPED_CRASH_TRACE`");
    expect(md).toContain("**MEDIUM**");
    expect(md).toContain("`ABSENCE_PENALTY`");
    expect(md).toContain("**LOW**");
    expect(md).toContain("`POC_MISMATCH`");
  });

  it("groups indicators with missing strength under UNSPECIFIED without duplicating them", async () => {
    // Backend types mark `strength` as required, but defensive UI/markdown
    // handling still puts malformed (missing/invalid) entries into a single
    // UNSPECIFIED bucket — never both LOW and UNSPECIFIED.
    // Indicator carries no `strength` field — backend types require it,
    // but the UI must still degrade gracefully and not double-render.
    const malformedIndicator = {
      signal: "MYSTERY_SIGNAL",
      value: 1,
      explanation: "Indicator with no strength field",
    };
    const withMalformed: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 22,
            verdict: "RED",
            confidence: "MEDIUM",
            triggeredIndicators: [malformedIndicator],
            signalBreakdown: {},
          },
        ],
      },
    };
    fetchSpy.mockImplementationOnce(async () => new Response(
      JSON.stringify(withMalformed),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Per-Engine Scores/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Technical Substance Analyzer/i }));

    // The signal renders exactly once (in the UNSPECIFIED group, not also in LOW)
    expect(screen.getAllByText("MYSTERY_SIGNAL")).toHaveLength(1);
    expect(screen.getByText("UNSPECIFIED")).toBeInTheDocument();
    expect(screen.queryByText("LOW")).not.toBeInTheDocument();

    // Markdown export must not duplicate the entry across LOW and UNSPECIFIED.
    const md = buildMarkdownSummary(withMalformed);
    const occurrences = md.split("`MYSTERY_SIGNAL`").length - 1;
    expect(occurrences).toBe(1);
    expect(md).toContain("**UNSPECIFIED**");
    expect(md).not.toContain("**LOW**");
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
