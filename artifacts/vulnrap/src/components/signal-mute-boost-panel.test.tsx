import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SignalMuteBoostPanel,
  parseSignalAdjustments,
  serializeSignalAdjustments,
  applySignalAdjustments,
  type SignalAdjustments,
} from "./signal-mute-boost-panel";

describe("signal-mute-boost-panel helpers", () => {
  it("parses URL string into adjustments map", () => {
    expect(
      parseSignalAdjustments("ai_phrase:mute,template_match:boost"),
    ).toEqual({
      ai_phrase: "mute",
      template_match: "boost",
    });
  });

  it("ignores unknown modes and malformed pieces", () => {
    expect(
      parseSignalAdjustments("ai_phrase:weird,broken,template_match:boost,"),
    ).toEqual({
      template_match: "boost",
    });
  });

  it("returns empty map for null/empty input", () => {
    expect(parseSignalAdjustments(null)).toEqual({});
    expect(parseSignalAdjustments("")).toEqual({});
  });

  it("serializes adjustments map to a stable string", () => {
    const out = serializeSignalAdjustments({
      ai_phrase: "mute",
      template_match: "boost",
    });
    expect(out.split(",").sort()).toEqual([
      "ai_phrase:mute",
      "template_match:boost",
    ]);
  });

  it("serializes empty map to empty string", () => {
    expect(serializeSignalAdjustments({})).toBe("");
  });

  it("applies signal adjustments: mute subtracts weight, boost adds weight", () => {
    const evidence = [
      { type: "ai_phrase", weight: 10 },
      { type: "template_match", weight: 5 },
      { type: "future_cve", weight: 8 },
    ];
    // Mute removes 10 from baseline; boost adds 5 (doubles 5 → +5 delta).
    expect(
      applySignalAdjustments(60, evidence, {
        ai_phrase: "mute",
        template_match: "boost",
      }),
    ).toBe(55);
  });

  it("aggregates duplicate signal types when applying adjustments", () => {
    const evidence = [
      { type: "ai_phrase", weight: 4 },
      { type: "ai_phrase", weight: 6 },
    ];
    // Both rows muted → -10
    expect(applySignalAdjustments(50, evidence, { ai_phrase: "mute" })).toBe(
      40,
    );
    // Both rows boosted → +10
    expect(applySignalAdjustments(50, evidence, { ai_phrase: "boost" })).toBe(
      60,
    );
  });

  it("clamps adjusted score to [0, 100]", () => {
    const evidence = [{ type: "x", weight: 200 }];
    expect(applySignalAdjustments(50, evidence, { x: "mute" })).toBe(0);
    expect(applySignalAdjustments(50, evidence, { x: "boost" })).toBe(100);
  });

  it("returns baseline when no overrides", () => {
    expect(applySignalAdjustments(42, [{ type: "a", weight: 5 }], {})).toBe(42);
  });
});

describe("SignalMuteBoostPanel", () => {
  const evidence = [
    { type: "ai_phrase", weight: 10 },
    { type: "template_match", weight: 5 },
  ];

  it("renders one row per unique signal type, ordered by weight desc", () => {
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{}}
        onChange={vi.fn()}
        baselineScore={50}
        adjustedScore={50}
      />,
    );
    expect(
      screen.getByTestId("signal-mute-boost-row-ai_phrase"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("signal-mute-boost-row-template_match"),
    ).toBeInTheDocument();
  });

  it("renders human-readable labels when provided", () => {
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{}}
        onChange={vi.fn()}
        baselineScore={50}
        adjustedScore={50}
        signalLabels={{ ai_phrase: "AI Phrase Detected" }}
      />,
    );
    expect(screen.getByText("AI Phrase Detected")).toBeInTheDocument();
  });

  it("emits the correct adjustments when a mute toggle is clicked", () => {
    const onChange = vi.fn();
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{}}
        onChange={onChange}
        baselineScore={50}
        adjustedScore={50}
      />,
    );
    fireEvent.click(screen.getByTestId("signal-mute-boost-ai_phrase-mute"));
    expect(onChange).toHaveBeenCalledWith({ ai_phrase: "mute" });
  });

  it("removes the entry from adjustments when normal is selected", () => {
    const onChange = vi.fn();
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{ ai_phrase: "mute", template_match: "boost" }}
        onChange={onChange}
        baselineScore={50}
        adjustedScore={45}
      />,
    );
    fireEvent.click(screen.getByTestId("signal-mute-boost-ai_phrase-normal"));
    expect(onChange).toHaveBeenCalledWith({ template_match: "boost" });
  });

  it("renders a Reset button only when overrides exist; reset clears all", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{}}
        onChange={onChange}
        baselineScore={50}
        adjustedScore={50}
      />,
    );
    expect(screen.queryByTestId("signal-mute-boost-reset")).toBeNull();

    rerender(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{ ai_phrase: "boost" }}
        onChange={onChange}
        baselineScore={50}
        adjustedScore={60}
      />,
    );
    fireEvent.click(screen.getByTestId("signal-mute-boost-reset"));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("shows a baseline → adjusted delta when overrides are active", () => {
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={{ ai_phrase: "mute" }}
        onChange={vi.fn()}
        baselineScore={50}
        adjustedScore={40}
      />,
    );
    const delta = screen.getByTestId("signal-mute-boost-delta");
    expect(delta.textContent).toContain("50");
    expect(delta.textContent).toContain("40");
    expect(delta.textContent).toContain("-10");
  });

  it("aria-pressed reflects current mode for each toggle button", () => {
    const adj: SignalAdjustments = { ai_phrase: "boost" };
    render(
      <SignalMuteBoostPanel
        evidence={evidence}
        adjustments={adj}
        onChange={vi.fn()}
        baselineScore={50}
        adjustedScore={60}
      />,
    );
    expect(
      screen
        .getByTestId("signal-mute-boost-ai_phrase-boost")
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("signal-mute-boost-ai_phrase-normal")
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("signal-mute-boost-ai_phrase-mute")
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("renders nothing when no evidence is provided", () => {
    const { container } = render(
      <SignalMuteBoostPanel
        evidence={[]}
        adjustments={{}}
        onChange={vi.fn()}
        baselineScore={50}
        adjustedScore={50}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
