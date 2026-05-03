import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DiagnosticsPanel,
  buildMarkdownSummary,
  loadDiagnosticsForExport,
  getDiagnosticsQueryKey,
  DIAGNOSTICS_STALE_TIME_MS,
  type DiagnosticsResponse,
  type AvriMarkerScrollTarget,
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

function renderWithClient(
  props: {
    onStructuralMarkerClick?: (line: number) => void;
    avriMarkerScrollTarget?: AvriMarkerScrollTarget | null;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DiagnosticsPanel
          reportId={REPORT_ID}
          onStructuralMarkerClick={props.onStructuralMarkerClick}
          avriMarkerScrollTarget={props.avriMarkerScrollTarget}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DiagnosticsPanel smoke test", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
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
    expect(
      screen.getAllByText(/Pipeline Timings/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("ingest")).toBeInTheDocument();
    expect(screen.getByText("12 ms")).toBeInTheDocument();
    expect(screen.getByText(/total 187 ms/i)).toBeInTheDocument();

    // Correlation id surfaced for triage
    expect(
      screen.getByText(/correlation: corr-test-1234/i),
    ).toBeInTheDocument();
  });

  // Task #624 — engine-version footer line.
  it("renders the engine-version footer when the diagnostics response includes engineVersions", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            engineVersions: {
              linguistic: "3.10.0",
              substance: "3.10.1",
              cwe: "3.10.0",
              avri: "3.11.0",
              fusion: "3.10.0",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    const footer = await screen.findByTestId("diagnostics-engine-versions");
    expect(footer.textContent).toMatch(/linguistic v3\.10\.0/);
    expect(footer.textContent).toMatch(/substance v3\.10\.1/);
    expect(footer.textContent).toMatch(/cwe v3\.10\.0/);
    expect(footer.textContent).toMatch(/avri v3\.11\.0/);
    expect(footer.textContent).toMatch(/fusion v3\.10\.0/);
  });

  it("hides the engine-version footer for legacy responses without engineVersions", async () => {
    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Composite Breakdown/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("diagnostics-engine-versions"),
    ).not.toBeInTheDocument();
  });

  it("renders the AVRI family rubric section with gold hits, misses, absence penalties, and overrides", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
                        {
                          id: "asan_or_sanitizer",
                          description: "AddressSanitizer crash output",
                          points: 22,
                        },
                      ],
                      goldMisses: [
                        {
                          id: "valgrind",
                          description: "Valgrind error trace",
                          points: 18,
                        },
                      ],
                      absencePenalty: -8,
                      absencePenalties: [
                        {
                          id: "no_size_or_offset",
                          description: "No explicit byte/size/offset value",
                          points: 5,
                        },
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/AVRI Family Rubric/i)).toBeInTheDocument();
    });

    // Family + classification confidence
    expect(
      screen.getAllByText(/Memory corruption \/ unsafe C/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/class:\s*HIGH/i)).toBeInTheDocument();
    expect(screen.getByText(/matched member CWE-787/i)).toBeInTheDocument();

    // Gold hits/misses descriptions
    expect(screen.getByText(/Gold Signals Found/i)).toBeInTheDocument();
    expect(
      screen.getByText(/AddressSanitizer crash output/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Expected Signals Missing/i)).toBeInTheDocument();
    expect(screen.getByText(/Valgrind error trace/i)).toBeInTheDocument();

    // Absence penalty surfaced with description
    expect(screen.getByText(/Absence Penalties Applied/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No explicit byte\/size\/offset value/i),
    ).toBeInTheDocument();

    // Composite-level AVRI overrides surfaced
    expect(screen.getByText(/AVRI Composite Overrides/i)).toBeInTheDocument();
    expect(screen.getByText(/No gold signals for family/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Submission-velocity penalty/i),
    ).toBeInTheDocument();

    // Task 374: AVRI Family Rubric heading carries a "Learn more"
    // link that resolves to the matching changelog anchor so the
    // in-app panel mirrors the markdown export's docs pointer.
    const rubricLinks = screen
      .getAllByRole("link", { name: /learn more/i })
      .filter(
        (a) => a.getAttribute("href") === "/changelog#avri-family-rubric",
      );
    expect(rubricLinks.length).toBeGreaterThan(0);
  });

  it("renders the STRIPPED_CRASH_TRACE block with reason, frame counts, and revoked trace gold signals", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
                        reason:
                          "Crash trace has 4/6 frames with placeholder symbols/offsets",
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/crash trace downgraded \(-18\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Crash trace has 4\/6 frames with placeholder symbols\/offsets/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/frames:\s*6/i)).toBeInTheDocument();
    expect(screen.getByText(/good:\s*1/i)).toBeInTheDocument();
    expect(screen.getByText(/placeholder:\s*4/i)).toBeInTheDocument();

    expect(screen.getByText(/Trace Gold Signals Revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/asan_or_sanitizer/)).toBeInTheDocument();
    expect(screen.getByText(/stack_trace_with_offset/)).toBeInTheDocument();
  });

  it("renders the STRIPPED_CRASH_TRACE block with race-trace wording for RACE_CONCURRENCY reports", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
                        reason:
                          "TSan trace has 3/5 frames with placeholder symbols/offsets",
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    });

    // Wording reads naturally for a race report (not "crash trace")
    expect(
      screen.getByText(/race trace downgraded \(-18\)/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/crash trace downgraded/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /TSan trace has 3\/5 frames with placeholder symbols\/offsets/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/tsan_or_helgrind_header/)).toBeInTheDocument();
  });

  it("renders the STRUCTURAL_FABRICATION block with each marker label, id, and offending excerpt (Task #317)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
              rawCompositeBeforeBehavioralPenalties: 28,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 28,
                  verdict: "RED" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "MEMORY_CORRUPTION",
                      familyName: "Memory corruption / unsafe C",
                      baseScore: 22,
                      goldHitCount: 0,
                      goldTotalCount: 8,
                      goldHits: [],
                      goldMisses: [],
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      // crashTrace is NOT stripped (good frames are present),
                      // but the Sprint 13B-2 / Task #303 detectors fired against
                      // the trace's structural envelope. The panel must surface
                      // the markers in their own block so reviewers can see why
                      // the report was downgraded.
                      crashTrace: {
                        framesAnalyzed: 6,
                        goodFrames: 5,
                        placeholderFrames: 0,
                        isStripped: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                        hasStructuralFabrication: true,
                        structuralFabricationPenalty: -12,
                        structuralMarkers: [
                          {
                            id: "round_function_offsets",
                            description:
                              "3 frames carry round/zero function offsets (0x0, 0x100, 0x1000); real offsets are non-zero and non-round",
                          },
                          {
                            id: "thread_id_inconsistency",
                            description:
                              "Trace references `thread T0`/`T1` but no `==<pid>==` header is present (real ASan/TSan output always anchors thread blocks to a PID)",
                          },
                        ],
                      },
                      rawAvriScore: 10,
                      legacyScore: 45,
                      blendedScore: 28,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRUCTURAL_FABRICATION")).toBeInTheDocument();
    });

    // The block reuses the stripped-trace red-box treatment so reviewers
    // learn the "fabricated trace" pattern at a glance.
    expect(screen.getByTestId("structural-fabrication-block")).toHaveClass(
      "border-red-500/40",
    );

    // Penalty surfaced in the header.
    expect(
      screen.getByText(/crash trace downgraded \(-12\)/i),
    ).toBeInTheDocument();

    // Each marker renders its plain-English label, the marker id, and the
    // description (which carries the offending excerpt inline). The block has
    // a stable testid so we can scope queries inside it.
    const block = screen.getByTestId("structural-fabrication-block");
    expect(
      within(block).getByText("Round/zero function offsets"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(round_function_offsets)"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(
        /3 frames carry round\/zero function offsets \(0x0, 0x100, 0x1000\)/i,
      ),
    ).toBeInTheDocument();

    expect(
      within(block).getByText("Thread block without `==<pid>==` anchor"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(thread_id_inconsistency)"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(
        /Trace references `thread T0`\/`T1` but no `==<pid>==` header is present/i,
      ),
    ).toBeInTheDocument();

    // STRIPPED_CRASH_TRACE block is NOT shown (isStripped=false), proving
    // the structural-fab block is independent.
    expect(screen.queryByText("STRIPPED_CRASH_TRACE")).not.toBeInTheDocument();
  });

  it("makes STRUCTURAL_FABRICATION markers clickable and invokes onStructuralMarkerClick with the line number when range is present (Task #451)", async () => {
    // Same shape as the Task #317 test but the markers carry a `range`
    // payload (start/end char offsets + 1-based line number into the
    // original report markdown). The diagnostics panel must:
    //   1. Render each marker as a `<button data-testid="structural-marker-${id}">`
    //      with `data-marker-line` reflecting `range.line`.
    //   2. Fire the `onStructuralMarkerClick` callback with that line
    //      number when the bullet is clicked, so the parent page can
    //      scroll its `<HighlightedReport>` panel to the offending line.
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
              rawCompositeBeforeBehavioralPenalties: 28,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 28,
                  verdict: "RED" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "MEMORY_CORRUPTION",
                      familyName: "Memory corruption / unsafe C",
                      baseScore: 22,
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
                        goodFrames: 5,
                        placeholderFrames: 0,
                        isStripped: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                        hasStructuralFabrication: true,
                        structuralFabricationPenalty: -12,
                        structuralMarkers: [
                          {
                            id: "round_function_offsets",
                            description:
                              "3 frames carry round/zero function offsets (0x0, 0x100, 0x1000)",
                            range: { start: 120, end: 140, line: 7 },
                          },
                          {
                            id: "thread_id_inconsistency",
                            description:
                              "Trace references `thread T0`/`T1` but no `==<pid>==` header is present",
                            range: { start: 250, end: 285, line: 14 },
                          },
                        ],
                      },
                      rawAvriScore: 10,
                      legacyScore: 45,
                      blendedScore: 28,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const onStructuralMarkerClick = vi.fn();
    const user = userEvent.setup();
    renderWithClient({ onStructuralMarkerClick });
    await user.click(screen.getByRole("button", { name: /show/i }));

    const roundBtn = await screen.findByTestId(
      "structural-marker-round_function_offsets",
    );
    const threadBtn = await screen.findByTestId(
      "structural-marker-thread_id_inconsistency",
    );

    // Both markers expose their target line via a data attribute (handy
    // for e2e tests that don't want to spy on the React handler).
    expect(roundBtn).toHaveAttribute("data-marker-line", "7");
    expect(threadBtn).toHaveAttribute("data-marker-line", "14");

    // The bullet must be a real <button> so it gets keyboard focus and
    // assistive tech announces it as actionable.
    expect(roundBtn.tagName).toBe("BUTTON");

    await user.click(roundBtn);
    expect(onStructuralMarkerClick).toHaveBeenCalledTimes(1);
    expect(onStructuralMarkerClick).toHaveBeenLastCalledWith(7);

    await user.click(threadBtn);
    expect(onStructuralMarkerClick).toHaveBeenCalledTimes(2);
    expect(onStructuralMarkerClick).toHaveBeenLastCalledWith(14);

    // Re-clicking the same marker still fires the callback so the parent
    // page can re-trigger its scroll+flash effect (the parent owns nonce
    // bumping; the panel just forwards every click).
    await user.click(roundBtn);
    expect(onStructuralMarkerClick).toHaveBeenCalledTimes(3);
    expect(onStructuralMarkerClick).toHaveBeenLastCalledWith(7);
  });

  it("renders STRUCTURAL_FABRICATION markers as plain <li> when no range is present, preserving the Task #317 layout", async () => {
    // Backward-compat for older persisted reports whose detectors ran
    // before Task #451 attached `range` to each marker. Without a range
    // we fall back to a plain `<li>` (no button, no data-testid) and the
    // `onStructuralMarkerClick` callback — even when wired — never
    // fires because there's nothing to click.
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 28,
                  verdict: "RED" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "MEMORY_CORRUPTION",
                      familyName: "Memory corruption / unsafe C",
                      baseScore: 22,
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
                        goodFrames: 5,
                        placeholderFrames: 0,
                        isStripped: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                        hasStructuralFabrication: true,
                        structuralFabricationPenalty: -12,
                        structuralMarkers: [
                          {
                            id: "round_function_offsets",
                            description:
                              "3 frames carry round/zero function offsets",
                          },
                        ],
                      },
                      rawAvriScore: 10,
                      legacyScore: 45,
                      blendedScore: 28,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const onStructuralMarkerClick = vi.fn();
    const user = userEvent.setup();
    renderWithClient({ onStructuralMarkerClick });
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("(round_function_offsets)")).toBeInTheDocument();
    });

    // No clickable button is rendered for the rangeless marker.
    expect(
      screen.queryByTestId("structural-marker-round_function_offsets"),
    ).not.toBeInTheDocument();
    expect(onStructuralMarkerClick).not.toHaveBeenCalled();
  });

  it("auto-expands, scrolls, and flashes the matching STRUCTURAL_FABRICATION marker when avriMarkerScrollTarget changes (Task #611)", async () => {
    // Closes the loop between the Evidence Signals card (which renders
    // marker bullets) and this diagnostics panel (which renders the
    // matching marker bullet inside the AVRI structural-fabrication
    // block). When the parent page bumps `avriMarkerScrollTarget`, the
    // panel must:
    //   1. Auto-expand if collapsed (so the AVRI block is mounted).
    //   2. Scroll the matching `<li data-marker-id="...">` into view.
    //   3. Flash the row briefly so the reviewer's eye lands on it.
    //   4. Re-fire on every nonce bump so re-clicking the same marker
    //      still works.
    fetchSpy.mockImplementation(
      async () =>
        new Response(
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
              rawCompositeBeforeBehavioralPenalties: 28,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 28,
                  verdict: "RED" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "MEMORY_CORRUPTION",
                      familyName: "Memory corruption / unsafe C",
                      baseScore: 22,
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
                        goodFrames: 5,
                        placeholderFrames: 0,
                        isStripped: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                        hasStructuralFabrication: true,
                        structuralFabricationPenalty: -12,
                        structuralMarkers: [
                          {
                            id: "round_function_offsets",
                            description:
                              "3 frames carry round/zero function offsets (0x0, 0x100, 0x1000)",
                            range: { start: 120, end: 140, line: 7 },
                          },
                          {
                            id: "implausible_thread_id",
                            description:
                              "Thread id `T9999` outside realistic kernel pid range",
                            range: { start: 250, end: 285, line: 14 },
                          },
                        ],
                      },
                      rawAvriScore: 10,
                      legacyScore: 45,
                      blendedScore: 28,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    // happy-dom doesn't implement scrollIntoView; spy on it so we can
    // verify the panel called it on the matching row.
    const scrollSpy = vi
      .spyOn(window.HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    // Start collapsed with no scroll target — proves auto-expand works.
    const { rerender } = renderWithClient();
    expect(screen.queryByText(/Composite Breakdown/i)).not.toBeInTheDocument();

    // Parent page bumps the scroll target (e.g. reviewer clicked the
    // `implausible_thread_id` bullet in the Evidence Signals card).
    rerender(
      <MemoryRouter>
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <DiagnosticsPanel
            reportId={REPORT_ID}
            avriMarkerScrollTarget={{ id: "implausible_thread_id", nonce: 1 }}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Panel auto-expands and the AVRI block renders once the fetch settles.
    const targetRow = await screen.findByTestId(
      "structural-marker-implausible_thread_id-row",
    );
    expect(targetRow).toHaveAttribute(
      "data-marker-id",
      "implausible_thread_id",
    );

    // The non-target marker is also rendered but should not flash.
    const otherRow = await screen.findByTestId(
      "structural-marker-round_function_offsets-row",
    );
    expect(otherRow.className).not.toMatch(/ring-yellow-400/);

    // Wait for the requestAnimationFrame-deferred scroll/flash to land.
    await waitFor(() => {
      expect(targetRow.className).toMatch(/ring-yellow-400/);
    });
    expect(scrollSpy).toHaveBeenCalled();

    scrollSpy.mockRestore();
  });

  it("renders STRUCTURAL_FABRICATION with subsumed-penalty wording when stripped-trace already fired (Task #317)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
                        framesAnalyzed: 6,
                        goodFrames: 1,
                        placeholderFrames: 4,
                        isStripped: true,
                        reason: "TSan trace has 4/6 frames placeholder",
                        revokedGoldHits: [],
                        penalty: -18,
                        hasStructuralFabrication: true,
                        // Penalty 0 — engine deliberately subsumes the
                        // structural-fab charge under stripped-trace so the
                        // report isn't double-charged for the same trace.
                        structuralFabricationPenalty: 0,
                        structuralMarkers: [
                          {
                            id: "frame_numbering_gaps",
                            description:
                              "Frame numbering jumps from #1 to #4; real sanitizer output is contiguous within a block",
                          },
                          {
                            id: "round_heap_region_size",
                            description:
                              'Heap "region size: 0x100" in hex; real ASan emits "<N>-byte region [0x..., 0x...)" in decimal',
                          },
                        ],
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("STRUCTURAL_FABRICATION")).toBeInTheDocument();
    });

    // Both blocks are visible: STRIPPED_CRASH_TRACE (with race-trace wording)
    // and STRUCTURAL_FABRICATION (penalty subsumed).
    expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    expect(
      screen.getByText(
        /race trace fabrication tells \(penalty subsumed by stripped-trace\)/i,
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/Frame-numbering gap inside a block/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Heap region size in hex \/ textbook power-of-two/i),
    ).toBeInTheDocument();
  });

  it("does not render the STRUCTURAL_FABRICATION block when hasStructuralFabrication is false (Task #317)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
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
              rawCompositeBeforeBehavioralPenalties: 28,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 60,
                  verdict: "GREEN" as const,
                  confidence: "HIGH" as const,
                  signalBreakdown: {
                    avri: {
                      family: "MEMORY_CORRUPTION",
                      familyName: "Memory corruption / unsafe C",
                      baseScore: 60,
                      goldHitCount: 2,
                      goldTotalCount: 8,
                      goldHits: [],
                      goldMisses: [],
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      crashTrace: {
                        framesAnalyzed: 6,
                        goodFrames: 6,
                        placeholderFrames: 0,
                        isStripped: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                        hasStructuralFabrication: false,
                        structuralFabricationPenalty: 0,
                        structuralMarkers: [],
                      },
                      rawAvriScore: 60,
                      legacyScore: 60,
                      blendedScore: 60,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/AVRI Family Rubric/i)).toBeInTheDocument();
    });

    expect(
      screen.queryByText("STRUCTURAL_FABRICATION"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("structural-fabrication-block"),
    ).not.toBeInTheDocument();
  });

  it("renders the FAKE_RAW_HTTP block with reason, request counters, and revoked smuggling gold signals", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/raw HTTP downgraded \(-18\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Fabricated raw HTTP request \(no CRLFs, placeholder header values\)/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/requests:\s*1/i)).toBeInTheDocument();
    expect(screen.getByText(/headers:\s*3\/7 good/i)).toBeInTheDocument();
    expect(screen.getByText(/placeholder:\s*4/i)).toBeInTheDocument();
    expect(screen.getByText(/CRLF:\s*no/i)).toBeInTheDocument();
    expect(
      screen.getByText(/TE\/CL conflicts:\s*1\s*\(broken\s*1\)/i),
    ).toBeInTheDocument();

    expect(screen.getByText(/Gold Signals Revoked/i)).toBeInTheDocument();
    expect(screen.getByText(/raw_http_te_cl_conflict/)).toBeInTheDocument();
    expect(
      screen.getByText(/raw_http_request_with_headers/),
    ).toBeInTheDocument();
  });

  // Task #447 — the FAKE_RAW_HTTP_RESPONSE sub-block must surface its own
  // "Response gold signals revoked" line so a reviewer can tell which
  // revocations came from the fabricated response (vs. the request side,
  // which is shown by the parent "Gold Signals Revoked" list). Wording
  // mirrors the printable triage report's sub-bullet so the panel and the
  // offline MD/PDF export stay in lock-step.
  it("renders a 'Response gold signals revoked' line inside the FAKE_RAW_HTTP_RESPONSE sub-block when rawHttp.response.revokedGoldHits is non-empty (Task #447)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "INJECTION",
              familyName: "Injection",
              classification: {
                confidence: "HIGH" as const,
                reason: "matched member CWE-79",
                evidence: ["CWE-79"],
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
                      family: "INJECTION",
                      familyName: "Injection",
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
                        totalHeaders: 4,
                        placeholderHeaders: 0,
                        crlfPresent: true,
                        teClConflicts: 0,
                        teClBroken: 0,
                        isFake: true,
                        reason:
                          "Fake raw HTTP response (fabricated `HTTP/1.1 200 OK` block missing Date/Server headers)",
                        revokedGoldHits: [
                          { id: "request_response_diff", points: 12 },
                        ],
                        penalty: -12,
                        response: {
                          responsesAnalyzed: 1,
                          responsesFlagged: 1,
                          totalHeaders: 2,
                          responsesMissingDate: 1,
                          responsesMissingServer: 1,
                          responsesWithSuspiciousJsonBody: 1,
                          responsesMissingIncidentals: 1,
                          isFake: true,
                          reason:
                            "Fabricated response: missing Date/Server, suspiciously clean JSON body, no incidental headers",
                          revokedGoldHits: [
                            { id: "request_response_diff", points: 12 },
                          ],
                        },
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP_RESPONSE")).toBeInTheDocument();
    });

    // Sub-block header for the response-side revoked gold signals.
    expect(
      screen.getByText(/Response gold signals revoked/i),
    ).toBeInTheDocument();
    // The response-class id and its negative-points value render under
    // the new sub-block. The id also appears in the parent OR-merged
    // "Gold Signals Revoked" list, so both occurrences must be present
    // (panel surfaces the request/response split *and* the merged view).
    const ids = screen.getAllByText(/request_response_diff/);
    expect(ids).toHaveLength(2);
    const points = screen.getAllByText(/^−12$/);
    expect(points).toHaveLength(2);
  });

  // Task #447 — guard against accidentally rendering the sub-block header
  // when the response sub-block is fake but `revokedGoldHits` is absent
  // (legacy persisted reports analyzed before the field shipped) or empty.
  it("does not render the 'Response gold signals revoked' line when rawHttp.response.revokedGoldHits is empty/absent (Task #447)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "INJECTION",
              familyName: "Injection",
              classification: {
                confidence: "HIGH" as const,
                reason: "matched member CWE-79",
                evidence: ["CWE-79"],
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
                      family: "INJECTION",
                      familyName: "Injection",
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
                        totalHeaders: 4,
                        placeholderHeaders: 0,
                        crlfPresent: true,
                        teClConflicts: 0,
                        teClBroken: 0,
                        isFake: true,
                        reason:
                          "Fake raw HTTP response (fabricated `HTTP/1.1 200 OK` block missing Date/Server headers)",
                        revokedGoldHits: [],
                        penalty: -12,
                        response: {
                          responsesAnalyzed: 1,
                          responsesFlagged: 1,
                          totalHeaders: 2,
                          responsesMissingDate: 1,
                          responsesMissingServer: 1,
                          responsesWithSuspiciousJsonBody: 1,
                          responsesMissingIncidentals: 1,
                          isFake: true,
                          reason: null,
                          // revokedGoldHits intentionally omitted to simulate
                          // a legacy persisted report.
                        },
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP_RESPONSE")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Response gold signals revoked/i),
    ).not.toBeInTheDocument();
  });

  // Task #450 — when the API persists a `rawHttp.signals` array, the panel
  // surfaces each request-side fabrication tell as a plain-English headline
  // (`RAW_HTTP_SIGNAL_LABELS[id]`), the signal id, and the engine's exact
  // description string. Mirrors the STRUCTURAL_FABRICATION marker block
  // introduced by Task #317 so reviewers learn the "fabricated raw HTTP"
  // pattern at a glance without scrolling for the underlying excerpts.
  it("renders the FAKE_RAW_HTTP block with each request-side signal label, id, and description (Task #450)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
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
                        revokedGoldHits: [],
                        penalty: -18,
                        signals: [
                          {
                            id: "placeholder_headers",
                            description:
                              "4 of 7 header values look like placeholders (e.g. `<token>`, `example.com`)",
                          },
                          {
                            id: "broken_te_cl_conflict",
                            description:
                              "Transfer-Encoding/Content-Length conflict declared in prose but the headers don't actually carry the conflicting values",
                          },
                          {
                            id: "missing_crlf",
                            description:
                              "Request bytes use LF-only line endings; real raw HTTP uses CRLF",
                          },
                        ],
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP")).toBeInTheDocument();
    });

    // Scope queries to the FAKE_RAW_HTTP block so we don't collide with
    // the parent counters table that also shows the raw byte stats.
    const block = screen.getByTestId("fake-raw-http-block");

    // Each signal renders its plain-English label, the id in parens, and
    // the engine's description string carrying the offending excerpt.
    expect(
      within(block).getByText("Placeholder header values"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(placeholder_headers)"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(/4 of 7 header values look like placeholders/i),
    ).toBeInTheDocument();

    expect(
      within(block).getByText(
        "Broken Transfer-Encoding/Content-Length conflict",
      ),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(broken_te_cl_conflict)"),
    ).toBeInTheDocument();

    expect(
      within(block).getByText("Missing CRLF line endings"),
    ).toBeInTheDocument();
    expect(within(block).getByText("(missing_crlf)")).toBeInTheDocument();
    expect(
      within(block).getByText(/Request bytes use LF-only line endings/i),
    ).toBeInTheDocument();
  });

  // Task #450 — response-side counterpart: per-signal tells inside the
  // FAKE_RAW_HTTP_RESPONSE sub-block. Same plain-English headline +
  // `(id)` + description shape as the request-side list above.
  it("renders the FAKE_RAW_HTTP_RESPONSE sub-block with each response-side signal label, id, and description (Task #450)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "INJECTION",
              familyName: "Injection",
              classification: {
                confidence: "HIGH" as const,
                reason: "matched member CWE-79",
                evidence: ["CWE-79"],
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
                      family: "INJECTION",
                      familyName: "Injection",
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
                        totalHeaders: 4,
                        placeholderHeaders: 0,
                        crlfPresent: true,
                        teClConflicts: 0,
                        teClBroken: 0,
                        isFake: true,
                        reason:
                          "Fake raw HTTP response (fabricated `HTTP/1.1 200 OK` block missing Date/Server headers)",
                        revokedGoldHits: [],
                        penalty: -12,
                        response: {
                          responsesAnalyzed: 1,
                          responsesFlagged: 1,
                          totalHeaders: 2,
                          responsesMissingDate: 1,
                          responsesMissingServer: 1,
                          responsesWithSuspiciousJsonBody: 1,
                          responsesMissingIncidentals: 1,
                          isFake: true,
                          reason: null,
                          signals: [
                            {
                              id: "missing_date_header",
                              description:
                                "Response is missing the Date header (real HTTP/1.1 responses always carry one)",
                            },
                            {
                              id: "suspicious_json_body",
                              description:
                                "JSON response body reads as a vulnerability narrative with no real-API incidentals",
                            },
                            {
                              id: "missing_incidental_headers",
                              description:
                                "Response carries no X-Request-Id / Content-Length / Cache-Control / Set-Cookie",
                            },
                          ],
                        },
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP_RESPONSE")).toBeInTheDocument();
    });

    expect(
      screen.getByText("Missing Date response header"),
    ).toBeInTheDocument();
    expect(screen.getByText("(missing_date_header)")).toBeInTheDocument();
    expect(
      screen.getByText(/Response is missing the Date header/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText("Suspiciously clean JSON response body"),
    ).toBeInTheDocument();
    expect(screen.getByText("(suspicious_json_body)")).toBeInTheDocument();
    expect(
      screen.getByText(
        /JSON response body reads as a vulnerability narrative/i,
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        "Missing incidental response headers (X-Request-Id / Content-Length / Cache-Control / Set-Cookie)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("(missing_incidental_headers)"),
    ).toBeInTheDocument();
  });

  // Task #450 — unknown signal ids (e.g. a future detector that the panel
  // hasn't shipped a label for yet) must fall back to displaying the raw
  // id as the headline so reviewers still see *something* they can grep
  // for, instead of an empty cell.
  it("falls back to the raw signal id when RAW_HTTP_SIGNAL_LABELS has no entry (Task #450)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
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
                        totalHeaders: 4,
                        placeholderHeaders: 0,
                        crlfPresent: false,
                        teClConflicts: 0,
                        teClBroken: 0,
                        isFake: true,
                        reason: "Fabricated raw HTTP request",
                        revokedGoldHits: [],
                        penalty: -12,
                        signals: [
                          {
                            id: "future_unknown_signal",
                            description: "Some future detector fired here",
                          },
                        ],
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
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("FAKE_RAW_HTTP")).toBeInTheDocument();
    });

    const block = screen.getByTestId("fake-raw-http-block");
    // Headline AND parenthesised id are both the raw id when no label
    // exists — see `RAW_HTTP_SIGNAL_LABELS[id] ?? id` in the panel.
    expect(within(block).getAllByText(/future_unknown_signal/)).toHaveLength(2);
    expect(
      within(block).getByText("Some future detector fired here"),
    ).toBeInTheDocument();
  });

  it("does not render the FAKE_RAW_HTTP block when rawHttp.isFake is false", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
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
              goldHitCount: 1,
              velocityPenalty: 0,
              templatePenalty: 0,
              rawCompositeBeforeBehavioralPenalties: 30,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 30,
                  verdict: "AMBER" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "REQUEST_SMUGGLING",
                      familyName: "HTTP request smuggling / desync",
                      baseScore: 30,
                      goldHitCount: 1,
                      goldTotalCount: 6,
                      goldHits: [
                        {
                          id: "raw_http_request_with_headers",
                          description: "Raw HTTP request bytes shown",
                          points: 14,
                        },
                      ],
                      goldMisses: [],
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      rawHttp: {
                        requestsAnalyzed: 1,
                        totalHeaders: 7,
                        placeholderHeaders: 0,
                        crlfPresent: true,
                        teClConflicts: 0,
                        teClBroken: 0,
                        isFake: false,
                        reason: null,
                        revokedGoldHits: [],
                        penalty: 0,
                      },
                      rawAvriScore: 30,
                      legacyScore: 30,
                      blendedScore: 30,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/AVRI Family Rubric/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("FAKE_RAW_HTTP")).not.toBeInTheDocument();
    expect(screen.queryByText(/raw HTTP downgraded/i)).not.toBeInTheDocument();
  });

  it("renders the AI_SELF_DISCLOSURE block listing each matched phrase, detector id, and applied penalty (Task #428)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "INJECTION",
              familyName: "Injection",
              classification: {
                confidence: "HIGH" as const,
                reason: "matched member CWE-79",
                evidence: ["CWE-79"],
                technology: null,
              },
              goldHitCount: 1,
              velocityPenalty: 0,
              templatePenalty: 0,
              rawCompositeBeforeBehavioralPenalties: 40,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 32,
                  verdict: "AMBER" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "INJECTION",
                      familyName: "Injection",
                      baseScore: 40,
                      goldHitCount: 1,
                      goldTotalCount: 6,
                      goldHits: [],
                      goldMisses: [],
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      // Task #300 detector output: two phrases fired, total
                      // bounded penalty -8 lands on the engine score.
                      aiSelfDisclosure: {
                        detected: true,
                        penalty: -8,
                        matches: [
                          {
                            id: "ai_assistant_attribution",
                            excerpt: "prepared using an AI security assistant",
                          },
                          {
                            id: "ai_generated_disclaimer",
                            excerpt: "this report was generated by ChatGPT",
                          },
                        ],
                      },
                      rawAvriScore: 32,
                      legacyScore: 40,
                      blendedScore: 32,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("AI_SELF_DISCLOSURE")).toBeInTheDocument();
    });

    // Block uses an amber treatment (bounded behavioural penalty, not a
    // fabrication tell) with a stable testid so we can scope queries.
    const block = screen.getByTestId("ai-self-disclosure-block");
    expect(block).toHaveClass("border-amber-500/40");

    // Penalty surfaced in the header.
    expect(
      within(block).getByText(/AI self-disclosure penalty \(-8\)/i),
    ).toBeInTheDocument();

    // Each matched phrase renders its excerpt and detector id.
    expect(
      within(block).getByText(/prepared using an AI security assistant/i),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(ai_assistant_attribution)"),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(/this report was generated by ChatGPT/i),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(ai_generated_disclaimer)"),
    ).toBeInTheDocument();
  });

  it("does not render the AI_SELF_DISCLOSURE block when aiSelfDisclosure.detected is false (Task #428)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "INJECTION",
              familyName: "Injection",
              classification: {
                confidence: "HIGH" as const,
                reason: "matched member CWE-79",
                evidence: ["CWE-79"],
                technology: null,
              },
              goldHitCount: 1,
              velocityPenalty: 0,
              templatePenalty: 0,
              rawCompositeBeforeBehavioralPenalties: 50,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 50,
                  verdict: "GREEN" as const,
                  confidence: "HIGH" as const,
                  signalBreakdown: {
                    avri: {
                      family: "INJECTION",
                      familyName: "Injection",
                      baseScore: 50,
                      goldHitCount: 1,
                      goldTotalCount: 6,
                      goldHits: [],
                      goldMisses: [],
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      // Detector ran but no phrase fired — block must stay
                      // hidden so legitimate reports don't carry a noisy row.
                      aiSelfDisclosure: {
                        detected: false,
                        penalty: 0,
                        matches: [],
                      },
                      rawAvriScore: 50,
                      legacyScore: 50,
                      blendedScore: 50,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/AVRI Family Rubric/i)).toBeInTheDocument();
    });

    expect(screen.queryByText("AI_SELF_DISCLOSURE")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("ai-self-disclosure-block"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/AI self-disclosure penalty/i),
    ).not.toBeInTheDocument();
  });

  // Task #428 — the AI self-disclosure detector runs against the whole
  // report body irrespective of family, so a FLAT-family report (no
  // specific CWE matched) that openly attributes itself to an AI assistant
  // must still surface the matched-phrase evidence. Pins that the block
  // lives outside the FLAT/non-FLAT branch in `AvriFamilySection`.
  it("renders the AI_SELF_DISCLOSURE block for FLAT-family reports too (Task #428)", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "FLAT",
              familyName: "FLAT",
              classification: {
                confidence: "LOW" as const,
                reason: "no specific CWE family detected",
                evidence: [],
                technology: null,
              },
              goldHitCount: 0,
              velocityPenalty: 0,
              templatePenalty: 0,
              rawCompositeBeforeBehavioralPenalties: 30,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 22,
                  verdict: "AMBER" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "FLAT",
                      familyName: "FLAT",
                      baseScore: 0,
                      goldHitCount: 0,
                      goldTotalCount: 0,
                      goldHits: [],
                      goldMisses: [],
                      // FLAT path uses absencePenalty only, no goldHits/Misses.
                      absencePenalty: 0,
                      absencePenalties: [],
                      contradictions: [],
                      contradictionPenalty: 0,
                      aiSelfDisclosure: {
                        detected: true,
                        penalty: -8,
                        matches: [
                          {
                            id: "ai_assistant_attribution",
                            excerpt: "prepared using an AI security assistant",
                          },
                        ],
                      },
                      rawAvriScore: 22,
                      legacyScore: 30,
                      blendedScore: 22,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText("AI_SELF_DISCLOSURE")).toBeInTheDocument();
    });

    // FLAT branch is also active (the "no specific CWE family" copy).
    expect(
      screen.getByText(
        /No specific CWE family detected — generic substance scoring used/i,
      ),
    ).toBeInTheDocument();

    // Block, header, excerpt, and detector id all render.
    const block = screen.getByTestId("ai-self-disclosure-block");
    expect(block).toHaveClass("border-amber-500/40");
    expect(
      within(block).getByText(/AI self-disclosure penalty \(-8\)/i),
    ).toBeInTheDocument();
    expect(
      within(block).getByText(/prepared using an AI security assistant/i),
    ).toBeInTheDocument();
    expect(
      within(block).getByText("(ai_assistant_attribution)"),
    ).toBeInTheDocument();
  });

  it("groups the FLAT hand-wavy phrase entries by category in the diagnostics panel", async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...SAMPLE_DIAGNOSTICS,
            avri: {
              family: "FLAT",
              familyName: "FLAT",
              classification: {
                confidence: "LOW" as const,
                reason: "no specific CWE family detected",
                evidence: [],
                technology: null,
              },
              goldHitCount: 0,
              velocityPenalty: 0,
              templatePenalty: 0,
              rawCompositeBeforeBehavioralPenalties: 30,
            },
            engines: {
              ...SAMPLE_DIAGNOSTICS.engines,
              engines: [
                {
                  engine: "Technical Substance Analyzer",
                  score: 30,
                  verdict: "RED" as const,
                  confidence: "MEDIUM" as const,
                  signalBreakdown: {
                    avri: {
                      family: "FLAT",
                      familyName: "FLAT",
                      baseScore: 50,
                      goldHitCount: 0,
                      goldTotalCount: 0,
                      goldHits: [],
                      goldMisses: [],
                      absencePenalty: -24,
                      absencePenalties: [
                        {
                          id: "flat_handwavy:do_not_have_a_reproducer",
                          description:
                            'Hand-wavy phrase: "do not have a reproducer"',
                          points: 6,
                          flatHandwavyCategory: "absence",
                        },
                        {
                          id: "flat_handwavy:private_poc",
                          description: 'Hand-wavy phrase: "private poc"',
                          points: 6,
                          flatHandwavyCategory: "absence",
                        },
                        {
                          id: "flat_handwavy:may_not_be_encrypted",
                          description:
                            'Hand-wavy phrase: "may not be encrypted"',
                          points: 6,
                          flatHandwavyCategory: "hedging",
                        },
                        {
                          id: "flat_handwavy:advanced_persistent_threats",
                          description:
                            'Hand-wavy phrase: "advanced persistent threats"',
                          points: 6,
                          flatHandwavyCategory: "buzzword",
                        },
                      ],
                      contradictions: [],
                      contradictionPenalty: 0,
                      rawAvriScore: 26,
                      legacyScore: 50,
                      blendedScore: 30,
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Hand-wavy Phrases Triggering Slop Haircut/i),
      ).toBeInTheDocument();
    });

    // Each themed group header is rendered with its phrase count + raw-point subtotal.
    const absenceHeader = screen.getByText(
      /Self-admitted absence of evidence/i,
    );
    expect(absenceHeader).toBeInTheDocument();
    expect(absenceHeader.parentElement?.textContent ?? "").toMatch(
      /2 phrases.*−12 raw/,
    );

    const hedgingHeader = screen.getByText(/Generic hedging/i);
    expect(hedgingHeader).toBeInTheDocument();
    expect(hedgingHeader.parentElement?.textContent ?? "").toMatch(
      /1 phrase.*−6 raw/,
    );

    const buzzwordHeader = screen.getByText(/Buzzword-soup framings/i);
    expect(buzzwordHeader).toBeInTheDocument();
    expect(buzzwordHeader.parentElement?.textContent ?? "").toMatch(
      /1 phrase.*−6 raw/,
    );

    // Phrases still render under their group, with the same per-hit weight.
    expect(screen.getByText(/"do not have a reproducer"/i)).toBeInTheDocument();
    expect(screen.getByText(/"may not be encrypted"/i)).toBeInTheDocument();
    expect(
      screen.getByText(/"advanced persistent threats"/i),
    ).toBeInTheDocument();

    // Task 111: each themed group ships a one-line legend describing what
    // the bucket signals about the report.
    expect(
      screen.getByText(
        /no runnable reproducer.*the bug is asserted, not observed/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/zero direct observation of the claimed behavior/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Marketing-style framings.*likely AI-generated prose/i),
    ).toBeInTheDocument();
  });

  it("groups FLAT hand-wavy absence penalties by theme in the printable markdown export", () => {
    // Task 110: mirror the on-screen Task 107 grouping in the markdown export.
    const withFlatHandwavy: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      avri: {
        family: "FLAT",
        familyName: "FLAT",
        classification: {
          confidence: "LOW" as const,
          reason: "no member CWE matched",
          evidence: [],
          technology: null,
        },
        goldHitCount: 0,
        velocityPenalty: 0,
        templatePenalty: 0,
        rawCompositeBeforeBehavioralPenalties: 30,
      },
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 30,
            verdict: "RED" as const,
            confidence: "MEDIUM" as const,
            signalBreakdown: {
              avri: {
                family: "FLAT",
                familyName: "FLAT",
                baseScore: 50,
                goldHitCount: 0,
                goldTotalCount: 0,
                goldHits: [],
                goldMisses: [],
                absencePenalty: -24,
                absencePenalties: [
                  {
                    id: "flat_handwavy:do_not_have_a_reproducer",
                    description: 'Hand-wavy phrase: "do not have a reproducer"',
                    points: 6,
                    flatHandwavyCategory: "absence",
                  },
                  {
                    id: "flat_handwavy:private_poc",
                    description: 'Hand-wavy phrase: "private poc"',
                    points: 6,
                    flatHandwavyCategory: "absence",
                  },
                  {
                    id: "flat_handwavy:may_not_be_encrypted",
                    description: 'Hand-wavy phrase: "may not be encrypted"',
                    points: 6,
                    flatHandwavyCategory: "hedging",
                  },
                  {
                    id: "flat_handwavy:advanced_persistent_threats",
                    description:
                      'Hand-wavy phrase: "advanced persistent threats"',
                    points: 6,
                    flatHandwavyCategory: "buzzword",
                  },
                ],
                contradictions: [],
                contradictionPenalty: 0,
                rawAvriScore: 26,
                legacyScore: 50,
                blendedScore: 30,
              },
            },
          },
        ],
      },
    };

    const md = buildMarkdownSummary(withFlatHandwavy);

    // Task 190: AVRI rubric now lives in @workspace/avri-rubric, which uses
    // bold-key formatting and adds a "(haircut N)" total to the absence
    // penalties header.
    expect(md).toMatch(
      /- \*\*Absence penalties applied\*\* \(haircut -?\d+\):/,
    );
    // Per-theme headers carry the same phrase count + raw subtotal as the on-screen panel.
    expect(md).toContain(
      "Self-admitted absence of evidence (2 phrases, −12 raw):",
    );
    expect(md).toContain(
      'Generic hedging ("may / appears") (1 phrase, −6 raw):',
    );
    expect(md).toContain("Buzzword-soup framings (1 phrase, −6 raw):");
    // Phrase rows still render under their theme bucket.
    expect(md).toContain(
      '−6 Hand-wavy phrase: "do not have a reproducer" (flat_handwavy:do_not_have_a_reproducer)',
    );
    expect(md).toContain(
      '−6 Hand-wavy phrase: "may not be encrypted" (flat_handwavy:may_not_be_encrypted)',
    );
    expect(md).toContain(
      '−6 Hand-wavy phrase: "advanced persistent threats" (flat_handwavy:advanced_persistent_threats)',
    );

    // Themed buckets render in the canonical absence → hedging → buzzword order.
    const absenceIdx = md.indexOf("Self-admitted absence of evidence");
    const hedgingIdx = md.indexOf("Generic hedging");
    const buzzwordIdx = md.indexOf("Buzzword-soup framings");
    expect(absenceIdx).toBeGreaterThan(-1);
    expect(hedgingIdx).toBeGreaterThan(absenceIdx);
    expect(buzzwordIdx).toBeGreaterThan(hedgingIdx);
  });

  it("emits the AVRI Family Rubric docs pointer in the printable markdown export", () => {
    const withAvri: DiagnosticsResponse = {
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
        goldHitCount: 1,
        velocityPenalty: 0,
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
                  {
                    id: "asan_or_sanitizer",
                    description: "AddressSanitizer crash output",
                    points: 22,
                  },
                ],
                goldMisses: [],
                absencePenalty: 0,
                absencePenalties: [],
                contradictions: [],
                contradictionPenalty: 0,
                rawAvriScore: 22,
                legacyScore: 50,
                blendedScore: 38,
              },
            },
          },
        ],
      },
    };

    const md = buildMarkdownSummary(withAvri);

    const expectedOrigin = window.location.origin.replace(/\/+$/, "");
    const expectedPointer = `_Learn more about the AVRI Family Rubric: ${expectedOrigin}/changelog#avri-family-rubric_`;
    expect(md).toContain(expectedPointer);

    const headingIdx = md.indexOf("## AVRI Family Rubric");
    const pointerIdx = md.indexOf(expectedPointer);
    const familyIdx = md.indexOf("- **Family**: Memory corruption / unsafe C");
    expect(headingIdx).toBeGreaterThan(-1);
    expect(pointerIdx).toBeGreaterThan(headingIdx);
    expect(familyIdx).toBeGreaterThan(pointerIdx);
  });

  it("keeps non-FLAT absence penalties as a flat list in the printable markdown export", () => {
    // Task 110: only FLAT entries carry a flatHandwavyCategory. Family-rubric
    // absence penalties (no category) keep the existing flat rendering.
    const withFamilyAbsence: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 40,
            verdict: "YELLOW" as const,
            confidence: "MEDIUM" as const,
            signalBreakdown: {
              avri: {
                family: "SQLI",
                familyName: "SQL Injection",
                baseScore: 60,
                goldHitCount: 1,
                goldTotalCount: 3,
                goldHits: [],
                goldMisses: [],
                absencePenalty: -10,
                absencePenalties: [
                  {
                    id: "sqli:missing_payload",
                    description: "No SQL payload included",
                    points: 5,
                  },
                  {
                    id: "sqli:missing_db_error",
                    description: "No database error excerpt cited",
                    points: 5,
                  },
                ],
                contradictions: [],
                contradictionPenalty: 0,
                rawAvriScore: 50,
                legacyScore: 60,
                blendedScore: 40,
              },
            },
          },
        ],
      },
    };

    const md = buildMarkdownSummary(withFamilyAbsence);

    // Task 190: bold-key absence header from @workspace/avri-rubric.
    expect(md).toMatch(
      /- \*\*Absence penalties applied\*\* \(haircut -?\d+\):/,
    );
    // No themed grouping headers for non-FLAT families.
    expect(md).not.toContain("Self-admitted absence of evidence");
    expect(md).not.toContain("Generic hedging");
    expect(md).not.toContain("Buzzword-soup framings");
    expect(md).toContain("−5 No SQL payload included (sqli:missing_payload)");
    expect(md).toContain(
      "−5 No database error excerpt cited (sqli:missing_db_error)",
    );
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
    // Task 190: now rendered with bold-key formatting from
    // @workspace/avri-rubric.
    expect(md).toContain("**Fake raw HTTP request** (penalty -18)");
    expect(md).toContain("requests 1");
    expect(md).toContain("headers 3/7 good");
    expect(md).toContain("placeholder 4");
    expect(md).toContain("CRLF no");
    expect(md).toContain("TE/CL conflicts 1 (broken 1)");
    expect(md).toContain(
      "Gold signals revoked: raw_http_te_cl_conflict (−22), raw_http_request_with_headers (−14)",
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
                explanation:
                  "Crash trace has 4/6 frames with placeholder symbols",
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
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(withIndicators), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Per-Engine Scores/i)).toBeInTheDocument();
    });

    // Indicator count chip is rendered on the engine row
    expect(screen.getByText(/\(3 indicators\)/)).toBeInTheDocument();

    // Click the engine row to expand triggered indicators
    await user.click(
      screen.getByRole("button", { name: /Technical Substance Analyzer/i }),
    );

    expect(screen.getAllByText(/Triggered Indicators/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("STRIPPED_CRASH_TRACE")).toBeInTheDocument();
    expect(screen.getByText("ABSENCE_PENALTY")).toBeInTheDocument();
    expect(screen.getByText("POC_MISMATCH")).toBeInTheDocument();
    expect(
      screen.getByText(/Crash trace has 4\/6 frames with placeholder symbols/i),
    ).toBeInTheDocument();

    // Markdown export includes a Triggered Indicators subsection
    const md = buildMarkdownSummary(withIndicators);
    expect(md).toContain(
      "### Triggered Indicators — Technical Substance Analyzer",
    );
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
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(withMalformed), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Per-Engine Scores/i)).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: /Technical Substance Analyzer/i }),
    );

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

  it("renders the Strong-Evidence Bonus section with each fired category, weight, and capped vs raw totals", async () => {
    const withGoldBonus: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 78,
            verdict: "GREEN" as const,
            confidence: "HIGH" as const,
            signalBreakdown: {
              goldSignalBonus: {
                bonus: 12,
                rawSum: 14,
                cap: 12,
                signals: [
                  { id: "real_crash_trace", weight: 5 },
                  { id: "sql_injection_payload", weight: 5 },
                  { id: "auth_token", weight: 3 },
                  { id: "code_diff", weight: 3 },
                ],
              },
            },
          },
        ],
      },
    };
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(withGoldBonus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Strong-Evidence Bonus/i)).toBeInTheDocument();
    });

    const section = screen.getByTestId("gold-signal-bonus-section");
    // Applied bonus
    expect(within(section).getByText(/applied:/i)).toBeInTheDocument();
    expect(within(section).getByText("+12")).toBeInTheDocument();
    // Capped vs raw — raw 14 capped at 12
    expect(
      within(section).getByText(/raw \+14 capped at \+12/i),
    ).toBeInTheDocument();
    // Number of categories that fired
    expect(
      within(section).getByText(/4 categories fired/i),
    ).toBeInTheDocument();
    // Each category id and weight
    expect(within(section).getByText("real_crash_trace")).toBeInTheDocument();
    expect(
      within(section).getByText("sql_injection_payload"),
    ).toBeInTheDocument();
    expect(within(section).getByText("auth_token")).toBeInTheDocument();
    expect(within(section).getByText("code_diff")).toBeInTheDocument();

    // Task #467 — each id is paired with its plain-English label so the
    // panel is self-documenting. Labels are sourced from
    // `GOLD_SIGNAL_LABELS` in `@workspace/avri-rubric` (re-exported by
    // the server-side gold-signals module).
    expect(
      within(section).getByText(/— Real ASan\/sanitizer crash trace/i),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/— SQL injection payload/i),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/— Authentication footprint/i),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/— Code diff hunk for the fix or repro/i),
    ).toBeInTheDocument();

    // Markdown export carries the same data so triage threads stay self-contained.
    const md = buildMarkdownSummary(withGoldBonus);
    expect(md).toContain("## Strong-Evidence Bonus (Gold Categories)");
    expect(md).toContain("**+12**");
    expect(md).toContain("raw +14 capped at +12");
    expect(md).toContain("`real_crash_trace`");
    expect(md).toContain("`sql_injection_payload`");
    // Task #467 — markdown rows include the same plain-English labels
    // as the panel so triage threads quoting this section stay
    // self-documenting.
    expect(md).toContain(
      "`real_crash_trace` — Real ASan/sanitizer crash trace",
    );
    expect(md).toContain("`auth_token` — Authentication footprint");
  });

  it("renders the Strong-Evidence Bonus with an under-cap raw total when no cap was hit", async () => {
    const underCap: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 65,
            verdict: "GREEN" as const,
            confidence: "MEDIUM" as const,
            signalBreakdown: {
              goldSignalBonus: {
                bonus: 5,
                rawSum: 5,
                cap: 12,
                signals: [{ id: "real_crash_trace", weight: 5 }],
              },
            },
          },
        ],
      },
    };
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(underCap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Strong-Evidence Bonus/i)).toBeInTheDocument();
    });

    const section = screen.getByTestId("gold-signal-bonus-section");
    // "+5" appears twice: once as the applied bonus, once as the per-signal weight.
    expect(within(section).getAllByText("+5")).toHaveLength(2);
    expect(
      within(section).getByText(/raw \+5 \(under cap \+12\)/i),
    ).toBeInTheDocument();
    expect(within(section).getByText(/1 category fired/i)).toBeInTheDocument();
    expect(within(section).getByText("real_crash_trace")).toBeInTheDocument();
  });

  it("omits the Strong-Evidence Bonus section when no categories fired", async () => {
    // Engine still emits a zero-bonus / empty-signals block when nothing
    // fires; the panel and markdown export must hide the section entirely.
    const noBonus: DiagnosticsResponse = {
      ...SAMPLE_DIAGNOSTICS,
      engines: {
        ...SAMPLE_DIAGNOSTICS.engines,
        engines: [
          {
            engine: "Technical Substance Analyzer",
            score: 40,
            verdict: "YELLOW" as const,
            confidence: "MEDIUM" as const,
            signalBreakdown: {
              goldSignalBonus: { bonus: 0, rawSum: 0, cap: 12, signals: [] },
            },
          },
        ],
      },
    };
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(noBonus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const user = userEvent.setup();
    renderWithClient();
    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(screen.getByText(/Per-Engine Scores/i)).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/Strong-Evidence Bonus/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("gold-signal-bonus-section"),
    ).not.toBeInTheDocument();

    const md = buildMarkdownSummary(noBonus);
    expect(md).not.toContain("Strong-Evidence Bonus");
  });

  it("surfaces an error message when the diagnostics endpoint fails", async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response("boom", { status: 500 }),
    );
    const user = userEvent.setup();
    renderWithClient();

    await user.click(screen.getByRole("button", { name: /show/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Failed to load diagnostics: HTTP 500/i),
      ).toBeInTheDocument();
    });
  });

  it("loadDiagnosticsForExport caches back-to-back exports (one fetch for JSON+TXT)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const first = await loadDiagnosticsForExport(client, REPORT_ID);
    const second = await loadDiagnosticsForExport(client, REPORT_ID);

    expect(first.reportId).toBe(REPORT_ID);
    expect(first.composite?.score).toBe(73);
    expect(second).toBe(first);

    const diagnosticsCalls = fetchSpy.mock.calls.filter(
      ([input]: [RequestInfo | URL, RequestInit?]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        return url.includes(`/api/reports/${REPORT_ID}/diagnostics`);
      },
    );
    expect(diagnosticsCalls).toHaveLength(1);

    const cached = client.getQueryData<DiagnosticsResponse>(
      getDiagnosticsQueryKey(REPORT_ID),
    );
    expect(cached).toBe(first);
    expect(DIAGNOSTICS_STALE_TIME_MS).toBeGreaterThan(0);
  });
});
