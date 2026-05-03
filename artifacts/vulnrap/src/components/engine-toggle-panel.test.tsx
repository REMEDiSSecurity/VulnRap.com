import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { refuseEngines, ALL_ENGINES_ON } from "@/lib/engine-fusion";
import { EngineTogglePanel } from "./engine-toggle-panel";

const BREAKDOWN = { linguistic: 80, factual: 60, template: 40, llm: 20 };

describe("EngineTogglePanel", () => {
  it("renders four engine checkboxes when all engines are available", () => {
    render(<EngineTogglePanel breakdown={BREAKDOWN} canonicalScore={55} />);
    expect(screen.getByTestId("engine-toggle-linguistic")).toBeInTheDocument();
    expect(screen.getByTestId("engine-toggle-factual")).toBeInTheDocument();
    expect(screen.getByTestId("engine-toggle-template")).toBeInTheDocument();
    expect(screen.getByTestId("engine-toggle-llm")).toBeInTheDocument();
  });

  it("disables the LLM checkbox when llm score is null", () => {
    render(
      <EngineTogglePanel
        breakdown={{ linguistic: 80, factual: 60, template: 40, llm: null }}
        canonicalScore={55}
      />,
    );
    const llm = screen.getByTestId("engine-toggle-llm") as HTMLInputElement;
    expect(llm).toBeDisabled();
    expect(llm.checked).toBe(false);
  });

  it("recomputes the fused score when an engine is toggled off (delta vs all-on baseline)", async () => {
    render(<EngineTogglePanel breakdown={BREAKDOWN} canonicalScore={55} />);
    // All-on baseline: 80*.30 + 60*.30 + 40*.15 + 20*.25 = 53
    // Disable LLM: (80*.30 + 60*.30 + 40*.15) / 0.75 = 64 -> delta +11 vs 53
    await userEvent.click(screen.getByTestId("engine-toggle-llm"));
    const recalc = screen.getByTestId("engine-toggle-recalc-score");
    expect(recalc.textContent).toContain("64");
    expect(recalc.textContent).toContain("+11");
    expect(recalc.textContent).toContain("vs all-on");
  });

  it("matches the shared refuseEngines helper output", () => {
    const baseline = refuseEngines(BREAKDOWN, ALL_ENGINES_ON);
    expect(baseline.score).toBe(53);
  });

  it("renders one stacked contribution segment per enabled engine", async () => {
    render(<EngineTogglePanel breakdown={BREAKDOWN} canonicalScore={55} />);
    const stack = screen.getByTestId("engine-contribution-stack");
    expect(
      within(stack).getByTestId("engine-contribution-segment-linguistic"),
    ).toBeInTheDocument();
    expect(
      within(stack).getByTestId("engine-contribution-segment-llm"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("engine-toggle-llm"));
    expect(
      within(stack).queryByTestId("engine-contribution-segment-llm"),
    ).not.toBeInTheDocument();
  });

  it("shows a reset button only when at least one engine is disabled", async () => {
    render(<EngineTogglePanel breakdown={BREAKDOWN} canonicalScore={55} />);
    expect(screen.queryByTestId("engine-toggle-reset")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("engine-toggle-template"));
    const reset = screen.getByTestId("engine-toggle-reset");
    await userEvent.click(reset);
    expect(screen.queryByTestId("engine-toggle-reset")).not.toBeInTheDocument();
    const tmpl = screen.getByTestId(
      "engine-toggle-template",
    ) as HTMLInputElement;
    expect(tmpl.checked).toBe(true);
  });
});
