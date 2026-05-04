import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import { EngineRadarSection } from "./results";

const useGetCohortBaselineMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetCohortBaseline: (params: unknown, opts: unknown) =>
    useGetCohortBaselineMock(params, opts),
  getGetCohortBaselineQueryKey: (params?: { cwe?: string }) =>
    ["/api/cohort/baseline", params ?? {}] as const,
}));

interface Engine {
  engine: string;
  score: number;
  verdict: "GREEN" | "YELLOW" | "RED" | "GREY";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  signalBreakdown?: Record<string, unknown>;
}

function makeVulnrap(engines: Engine[]) {
  return {
    compositeScore: 55,
    label: "NEEDS REVIEW",
    engines,
    overridesApplied: [],
  };
}

function baseEngines(avriBlock?: { rawAvriScore?: number }): Engine[] {
  return [
    {
      engine: "AI Authorship Detector",
      score: 72,
      verdict: "RED",
      confidence: "HIGH",
    },
    {
      engine: "Technical Substance Analyzer",
      score: 65,
      verdict: "YELLOW",
      confidence: "MEDIUM",
      ...(avriBlock
        ? { signalBreakdown: { avri: avriBlock } }
        : {}),
    },
    {
      engine: "CWE Coherence Checker",
      score: 80,
      verdict: "GREEN",
      confidence: "HIGH",
    },
  ];
}

function noCohort() {
  useGetCohortBaselineMock.mockReset();
  useGetCohortBaselineMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
}

function withCohortMedians() {
  useGetCohortBaselineMock.mockReset();
  useGetCohortBaselineMock.mockReturnValue({
    data: {
      cwe: null,
      windowDays: 7,
      totalReports: 100,
      median: 50,
      engineMedians: {
        engine1: 60,
        engine2: 55,
        engine3: 70,
        avri: 50,
        quality: 65,
      },
    },
    isLoading: false,
    isError: false,
  });
}

function renderSection(
  vulnrap: ReturnType<typeof makeVulnrap>,
  qualityScore: number | undefined = 78,
  cwe?: string,
) {
  return render(
    <MemoryRouter>
      <EngineRadarSection
        vulnrap={vulnrap}
        qualityScore={qualityScore}
        cwe={cwe}
      />
    </MemoryRouter>,
  );
}

describe("EngineRadarSection (Task #939)", () => {
  it("renders all five axis labels in the correct order", () => {
    noCohort();
    renderSection(makeVulnrap(baseEngines({ rawAvriScore: 58 })));

    for (const label of ["Engine 1", "Engine 2", "Engine 3", "AVRI", "Quality"]) {
      expect(screen.getAllByText(label, { exact: true }).length).toBeGreaterThanOrEqual(1);
    }

    const ariaLabel = screen.getByRole("img").getAttribute("aria-label")!;
    expect(ariaLabel).toMatch(
      /Engine 1 \d+, Engine 2 \d+, Engine 3 \d+, AVRI \d+, Quality \d+/,
    );
  });

  it("inverts Engine 1 score: plotted value = 100 − rawScore", () => {
    noCohort();
    const engines = baseEngines({ rawAvriScore: 58 });
    const e1Raw = engines[0].score;
    const expected = 100 - e1Raw;

    renderSection(makeVulnrap(engines), 78);

    const ariaLabel = screen
      .getByRole("img")
      .getAttribute("aria-label");
    expect(ariaLabel).toContain(`Engine 1 ${expected}`);
  });

  it("uses signalBreakdown.avri.rawAvriScore when present", () => {
    noCohort();
    const avriRaw = 43;
    const engines = baseEngines({ rawAvriScore: avriRaw });
    renderSection(makeVulnrap(engines), 78);

    const ariaLabel = screen
      .getByRole("img")
      .getAttribute("aria-label");
    expect(ariaLabel).toContain(`AVRI ${avriRaw}`);
  });

  it("falls back to Engine 2 overall score when AVRI block is absent", () => {
    noCohort();
    const engines = baseEngines();
    const e2Score = engines[1].score;
    renderSection(makeVulnrap(engines), 78);

    const ariaLabel = screen
      .getByRole("img")
      .getAttribute("aria-label");
    expect(ariaLabel).toContain(`AVRI ${e2Score}`);
  });

  it("toggling cohort overlay adds a second polygon to the SVG", async () => {
    withCohortMedians();
    const user = userEvent.setup();
    renderSection(makeVulnrap(baseEngines({ rawAvriScore: 58 })), 78);

    const svg = screen.getByRole("img");
    const polygonsBefore = svg.querySelectorAll("polygon");
    const countBefore = polygonsBefore.length;

    const toggle = screen.getByTestId("toggle-cohort-overlay");
    const checkbox = toggle.querySelector("input[type='checkbox']")!;
    await user.click(checkbox);

    const polygonsAfter = svg.querySelectorAll("polygon");
    expect(polygonsAfter.length).toBe(countBefore + 1);
  });

  it("shows 'No cohort baseline yet' when cohort medians are unavailable", () => {
    noCohort();
    renderSection(makeVulnrap(baseEngines({ rawAvriScore: 58 })), 78);

    expect(screen.getByTestId("cohort-overlay-unavailable")).toBeTruthy();
    expect(
      screen.getByTestId("cohort-overlay-unavailable").textContent,
    ).toMatch(/No cohort baseline yet/);
  });
});
