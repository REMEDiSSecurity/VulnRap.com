import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AbPresetComparison } from "./ab-preset-comparison";
import type { BreakdownData, HumanIndicatorData } from "@/lib/settings";

interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

const LOW = 20;
const HIGH = 75;

const BASE_EVIDENCE: EvidenceItem[] = [
  { type: "template_match", description: "Boilerplate intro", weight: 3 },
  { type: "llm_watermark", description: "GPT-style phrasing", weight: 5 },
  { type: "factual_error", description: "Wrong CVE year", weight: 2 },
  { type: "low_signal", description: "Minor flag", weight: 0.5 },
];

const BASE_BREAKDOWN: BreakdownData = {
  linguistic: 40,
  factual: 30,
  template: 20,
  llm: 50,
};

const BASE_HUMAN: HumanIndicatorData[] = [];

function renderExpanded(overrides: {
  canonicalScore?: number;
  breakdown?: BreakdownData | undefined;
  humanIndicators?: HumanIndicatorData[];
  evidence?: EvidenceItem[];
  thresholdLow?: number;
  thresholdHigh?: number;
} = {}) {
  const breakdown = "breakdown" in overrides ? overrides.breakdown : BASE_BREAKDOWN;
  const result = render(
    <AbPresetComparison
      canonicalScore={overrides.canonicalScore ?? 60}
      breakdown={breakdown}
      humanIndicators={overrides.humanIndicators ?? BASE_HUMAN}
      evidence={overrides.evidence ?? BASE_EVIDENCE}
      thresholdLow={overrides.thresholdLow ?? LOW}
      thresholdHigh={overrides.thresholdHigh ?? HIGH}
    />,
  );
  fireEvent.click(screen.getByText("Compare Presets"));
  return result;
}

describe("AbPresetComparison", () => {
  beforeEach(() => {
    localStorage.removeItem("vulnrap_ab_presets");
  });

  it("renders collapsed by default and expands on click", () => {
    render(
      <AbPresetComparison
        canonicalScore={60}
        breakdown={BASE_BREAKDOWN}
        humanIndicators={BASE_HUMAN}
        evidence={BASE_EVIDENCE}
        thresholdLow={LOW}
        thresholdHigh={HIGH}
      />,
    );
    expect(screen.getByTestId("ab-preset-comparison")).toBeTruthy();
    expect(screen.queryByTestId("select-preset-a")).toBeNull();

    fireEvent.click(screen.getByText("Compare Presets"));
    expect(screen.getByTestId("select-preset-a")).toBeTruthy();
    expect(screen.getByTestId("select-preset-b")).toBeTruthy();
  });

  it("defaults to Lenient (A) vs Strict (B)", () => {
    renderExpanded();
    const selectA = screen.getByTestId("select-preset-a") as HTMLSelectElement;
    const selectB = screen.getByTestId("select-preset-b") as HTMLSelectElement;
    expect(selectA.value).toBe("lenient");
    expect(selectB.value).toBe("strict");
  });

  it("shows distinct scores for each preset", () => {
    renderExpanded({ canonicalScore: 60 });
    const scores = screen.getAllByText("/ 100");
    expect(scores.length).toBe(2);
  });

  describe("score/tier outcomes per preset", () => {
    it("balanced preset returns the canonical score unchanged", () => {
      renderExpanded({ canonicalScore: 50 });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "balanced" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "balanced" },
      });
      const scoreEls = screen.getAllByText("50");
      expect(scoreEls.length).toBeGreaterThanOrEqual(2);
    });

    it("without breakdown, lenient score is lower than or equal to balanced", () => {
      renderExpanded({ canonicalScore: 60, breakdown: undefined });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "balanced" },
      });
      const lenientScore = Number(screen.getByTestId("preset-score-a").textContent);
      const balancedScore = Number(screen.getByTestId("preset-score-b").textContent);
      expect(lenientScore).toBeLessThanOrEqual(balancedScore);
    });

    it("without breakdown, strict score is higher than or equal to balanced", () => {
      renderExpanded({ canonicalScore: 60, breakdown: undefined });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "balanced" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "strict" },
      });
      const balancedScore = Number(screen.getByTestId("preset-score-a").textContent);
      const strictScore = Number(screen.getByTestId("preset-score-b").textContent);
      expect(strictScore).toBeGreaterThanOrEqual(balancedScore);
    });

    it("without breakdown data, lenient simply scales the canonical score by 0.7", () => {
      renderExpanded({
        canonicalScore: 60,
        breakdown: undefined,
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      expect(screen.getByTestId("preset-score-a").textContent).toBe("42");
    });

    it("without breakdown data, strict simply scales the canonical score by 1.5", () => {
      renderExpanded({
        canonicalScore: 60,
        breakdown: undefined,
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "strict" },
      });
      expect(screen.getByTestId("preset-score-b").textContent).toBe("90");
    });
  });

  describe("tier divergence callout", () => {
    it("shows the divergence callout when preset A and B produce different tiers", () => {
      renderExpanded({
        canonicalScore: 60,
        breakdown: undefined,
        thresholdLow: 20,
        thresholdHigh: 75,
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "strict" },
      });
      expect(screen.getByTestId("tier-divergence-callout")).toBeTruthy();
      expect(
        screen.getByTestId("tier-divergence-callout").textContent,
      ).toMatch(/Tier diverges/);
    });

    it("hides the divergence callout when both presets produce the same tier", () => {
      renderExpanded({
        canonicalScore: 10,
        breakdown: undefined,
        thresholdLow: 20,
        thresholdHigh: 75,
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "balanced" },
      });
      expect(screen.queryByTestId("tier-divergence-callout")).toBeNull();
    });

    it("hides the divergence callout when both presets are identical", () => {
      renderExpanded({ canonicalScore: 60 });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "balanced" },
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "balanced" },
      });
      expect(screen.queryByTestId("tier-divergence-callout")).toBeNull();
    });
  });

  describe("top-signals filtering", () => {
    it("lenient preset (×0.7) filters out signals with weight < ~1.43", () => {
      renderExpanded({
        evidence: [
          { type: "strong_signal", description: "High weight", weight: 5 },
          { type: "medium_signal", description: "Med weight", weight: 2 },
          { type: "weak_signal", description: "Low weight", weight: 1 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      const card = screen.getByTestId("preset-card-a");
      expect(card.textContent).toContain("strong signal");
      expect(card.textContent).toContain("medium signal");
      expect(card.textContent).not.toContain("weak signal");
    });

    it("balanced preset (×1.0) filters out signals with weight < 1", () => {
      renderExpanded({
        evidence: [
          { type: "strong_signal", description: "High weight", weight: 5 },
          { type: "borderline", description: "Exactly 1", weight: 1 },
          { type: "sub_threshold", description: "Below 1", weight: 0.5 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "balanced" },
      });
      const card = screen.getByTestId("preset-card-a");
      expect(card.textContent).toContain("strong signal");
      expect(card.textContent).toContain("borderline");
      expect(card.textContent).not.toContain("sub threshold");
    });

    it("strict preset (×1.5) allows weaker signals through the filter", () => {
      renderExpanded({
        evidence: [
          { type: "strong_signal", description: "High weight", weight: 5 },
          { type: "medium_signal", description: "Med weight", weight: 1 },
          { type: "weak_signal", description: "Low weight", weight: 0.5 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-b"), {
        target: { value: "strict" },
      });
      const card = screen.getByTestId("preset-card-b");
      expect(card.textContent).toContain("strong signal");
      expect(card.textContent).toContain("medium signal");
      expect(card.textContent).not.toContain("weak signal");
    });

    it("caps top signals at 3 even when more pass the filter", () => {
      renderExpanded({
        evidence: [
          { type: "sig_a", description: "A", weight: 10 },
          { type: "sig_b", description: "B", weight: 8 },
          { type: "sig_c", description: "C", weight: 6 },
          { type: "sig_d", description: "D", weight: 4 },
          { type: "sig_e", description: "E", weight: 2 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "strict" },
      });
      const card = screen.getByTestId("preset-card-a");
      const bullets = card.querySelectorAll("li");
      expect(bullets.length).toBe(3);
    });

    it("shows 'No signals fire' when all evidence is below the filter threshold", () => {
      renderExpanded({
        evidence: [
          { type: "tiny", description: "Very weak", weight: 0.1 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "lenient" },
      });
      const card = screen.getByTestId("preset-card-a");
      expect(card.textContent).toContain("No signals fire under this preset");
    });

    it("sorts top signals by weight descending", () => {
      renderExpanded({
        evidence: [
          { type: "low_w", description: "Low", weight: 2 },
          { type: "high_w", description: "High", weight: 10 },
          { type: "mid_w", description: "Mid", weight: 5 },
        ],
      });
      fireEvent.change(screen.getByTestId("select-preset-a"), {
        target: { value: "balanced" },
      });
      const card = screen.getByTestId("preset-card-a");
      const items = card.querySelectorAll("li");
      const weights = Array.from(items).map((li) => {
        const match = li.textContent?.match(/\((\d+)\)/);
        return match ? Number(match[1]) : 0;
      });
      expect(weights).toEqual([10, 5, 2]);
    });
  });
});
