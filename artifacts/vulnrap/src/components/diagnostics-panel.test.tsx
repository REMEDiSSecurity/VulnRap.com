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
