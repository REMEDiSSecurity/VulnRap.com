import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  MAX_TRIAGE_ENGINE_INDICATORS,
  TriageEngineCard,
  VULNRAP_VERDICT_COLOR,
  type VulnrapEngineResultPanel,
} from "./triage-engine-card";

function makeEngine(
  overrides: Partial<VulnrapEngineResultPanel> = {},
): VulnrapEngineResultPanel {
  return {
    engine: "Technical Substance",
    score: 72,
    verdict: "GREEN",
    confidence: "HIGH",
    ...overrides,
  };
}

describe("TriageEngineCard", () => {
  describe("verdict colouring", () => {
    it.each([
      ["RED", "text-red-400 border-red-500/40"],
      ["YELLOW", "text-yellow-400 border-yellow-500/40"],
      ["GREEN", "text-green-400 border-green-500/40"],
    ] as const)("applies the %s verdict colour to the verdict badge", (verdict, expectedClass) => {
      render(<TriageEngineCard engine={makeEngine({ verdict })} />);
      const badge = screen.getByTestId("triage-engine-verdict");
      expect(badge).toHaveTextContent(verdict);
      for (const cls of expectedClass.split(" ")) {
        expect(badge).toHaveClass(cls);
      }
    });

    it("falls back to muted styling for the GREY verdict", () => {
      render(<TriageEngineCard engine={makeEngine({ verdict: "GREY" })} />);
      const badge = screen.getByTestId("triage-engine-verdict");
      expect(badge).toHaveTextContent("GREY");
      expect(badge).toHaveClass("text-muted-foreground");
    });

    it("drives the progress indicator class from VULNRAP_VERDICT_COLOR", () => {
      const { container } = render(
        <TriageEngineCard engine={makeEngine({ verdict: "RED", score: 12 })} />,
      );
      const indicator = container.querySelector(`.${VULNRAP_VERDICT_COLOR.RED}`);
      expect(indicator).not.toBeNull();
      expect(indicator).toHaveClass(VULNRAP_VERDICT_COLOR.RED);
    });
  });

  describe("note rendering", () => {
    it("renders the engine note when provided", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({ note: "Heuristic: 3 strong indicators of validity." })}
        />,
      );
      expect(screen.getByTestId("triage-engine-note")).toHaveTextContent(
        "Heuristic: 3 strong indicators of validity.",
      );
    });

    it("omits the note paragraph entirely when no note is supplied", () => {
      render(<TriageEngineCard engine={makeEngine({ note: undefined })} />);
      expect(screen.queryByTestId("triage-engine-note")).not.toBeInTheDocument();
    });

    it("treats an empty-string note as absent", () => {
      render(<TriageEngineCard engine={makeEngine({ note: "" })} />);
      expect(screen.queryByTestId("triage-engine-note")).not.toBeInTheDocument();
    });
  });

  describe("indicator list slicing", () => {
    it("renders nothing when the indicator list is missing or empty", () => {
      const { rerender } = render(
        <TriageEngineCard engine={makeEngine({ triggeredIndicators: [] })} />,
      );
      expect(screen.queryByTestId("triage-engine-indicators")).not.toBeInTheDocument();

      rerender(<TriageEngineCard engine={makeEngine({ triggeredIndicators: undefined })} />);
      expect(screen.queryByTestId("triage-engine-indicators")).not.toBeInTheDocument();
    });

    it("renders all indicators when the list is at or below the cap", () => {
      const indicators = Array.from({ length: MAX_TRIAGE_ENGINE_INDICATORS }, (_, i) => ({
        signal: `SIG_${i}`,
        explanation: `Explanation #${i}`,
        strength: "MEDIUM" as const,
      }));
      render(<TriageEngineCard engine={makeEngine({ triggeredIndicators: indicators })} />);
      const list = screen.getByTestId("triage-engine-indicators");
      for (const ind of indicators) {
        expect(list).toHaveTextContent(ind.signal);
        expect(list).toHaveTextContent(ind.explanation);
      }
    });

    it("slices the indicator list at MAX_TRIAGE_ENGINE_INDICATORS and drops the overflow", () => {
      const indicators = Array.from(
        { length: MAX_TRIAGE_ENGINE_INDICATORS + 3 },
        (_, i) => ({
          signal: `SIG_${i}`,
          explanation: `Explanation #${i}`,
          strength: "LOW" as const,
        }),
      );
      render(<TriageEngineCard engine={makeEngine({ triggeredIndicators: indicators })} />);
      const list = screen.getByTestId("triage-engine-indicators");
      for (let i = 0; i < MAX_TRIAGE_ENGINE_INDICATORS; i++) {
        expect(list).toHaveTextContent(`SIG_${i}`);
      }
      for (let i = MAX_TRIAGE_ENGINE_INDICATORS; i < indicators.length; i++) {
        expect(list).not.toHaveTextContent(`SIG_${i}`);
      }
    });

    it("colours the indicator badge by strength", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({
            triggeredIndicators: [
              { signal: "STRONG_HIT", explanation: "high signal", strength: "HIGH" },
              { signal: "MEDIUM_HIT", explanation: "medium signal", strength: "MEDIUM" },
              { signal: "WEAK_HIT", explanation: "low signal", strength: "LOW" },
            ],
          })}
        />,
      );
      expect(screen.getByText("STRONG_HIT")).toHaveClass("text-red-400", "border-red-500/40");
      expect(screen.getByText("MEDIUM_HIT")).toHaveClass("text-yellow-400", "border-yellow-500/40");
      expect(screen.getByText("WEAK_HIT")).toHaveClass("text-muted-foreground");
    });
  });

  describe("soft-citation badge", () => {
    it("renders the legacy `signalBreakdown.softCitation` shape", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({
            engine: "Heuristic",
            signalBreakdown: {
              softCitation: { name: "XSS", inferredCwe: "CWE-79" },
            },
          })}
        />,
      );
      const badge = screen.getByTestId("badge-soft-citation-legacy");
      expect(badge).toHaveTextContent("Soft citation: XSS → CWE-79");
      expect(screen.queryByTestId("badge-soft-citation-avri")).not.toBeInTheDocument();
    });

    it("renders the AVRI `signalBreakdown.avri.softCitation` shape", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({
            engine: "AVRI",
            signalBreakdown: {
              avri: { softCitation: { name: "Open Redirect", inferredCwe: "CWE-601" } },
            },
          })}
        />,
      );
      const badge = screen.getByTestId("badge-soft-citation-avri");
      expect(badge).toHaveTextContent("Soft citation: Open Redirect → CWE-601");
      expect(screen.queryByTestId("badge-soft-citation-legacy")).not.toBeInTheDocument();
    });

    it("prefers the AVRI citation when both shapes are present", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({
            engine: "AVRI",
            signalBreakdown: {
              softCitation: { name: "Legacy Pick", inferredCwe: "CWE-000" },
              avri: { softCitation: { name: "XXE", inferredCwe: "CWE-611" } },
            },
          })}
        />,
      );
      const avri = screen.getByTestId("badge-soft-citation-avri");
      expect(avri).toHaveTextContent("Soft citation: XXE → CWE-611");
      expect(avri).not.toHaveTextContent("Legacy Pick");
      expect(screen.queryByTestId("badge-soft-citation-legacy")).not.toBeInTheDocument();
    });

    it("renders no badge when neither shape is populated", () => {
      render(<TriageEngineCard engine={makeEngine({ signalBreakdown: {} })} />);
      expect(screen.queryByTestId("badge-soft-citation-legacy")).not.toBeInTheDocument();
      expect(screen.queryByTestId("badge-soft-citation-avri")).not.toBeInTheDocument();
    });

    it("ignores partial soft-citation shapes that are missing the inferred CWE", () => {
      render(
        <TriageEngineCard
          engine={makeEngine({
            signalBreakdown: {
              softCitation: { name: "XSS" },
              avri: { softCitation: { inferredCwe: "CWE-79" } },
            },
          })}
        />,
      );
      expect(screen.queryByTestId("badge-soft-citation-legacy")).not.toBeInTheDocument();
      expect(screen.queryByTestId("badge-soft-citation-avri")).not.toBeInTheDocument();
    });
  });
});
