// Task #717 — coverage for the inline signal heatmap renderer.
//
// Asserts that the heatmap prefers engine-supplied character ranges over
// the heuristic `matched`-substring fallback, that overlapping signals
// stack instead of overwriting one another, that the legend lists every
// firing signal exactly once, and that hovering a span surfaces the
// firing signal id + description.

import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  SignalHeatmapRenderer,
  type HeatmapEvidenceItem,
  type HeatmapHumanIndicator,
} from "./signal-heatmap-renderer";

const TYPE_LABELS: Record<string, string> = {
  hallucination_structural_fabrication: "Fabricated Structure",
  ai_phrase: "AI Phrase Detected",
  human_contractions: "Human Signal: Contractions",
};

describe("SignalHeatmapRenderer", () => {
  it("tints exactly the engine-supplied character range for structural-fabrication markers", () => {
    const text = "intro text FAKE_REGISTERS more stuff after";
    const start = text.indexOf("FAKE_REGISTERS");
    const end = start + "FAKE_REGISTERS".length;
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "hallucination_structural_fabrication",
        description: "Fabricated register dump",
        weight: 30,
        context: {
          markers: [
            {
              id: "fake_registers",
              description: "fabricated register dump",
              range: { start, end, line: 1 },
            },
          ],
        },
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={[]}
        typeLabels={TYPE_LABELS}
      />,
    );
    const pre = screen.getByTestId("heatmap-pre");
    const tinted = Array.from(
      pre.querySelectorAll<HTMLElement>("[data-signal-types]"),
    );
    // Exactly one tinted cell, covering exactly the marker's [start, end).
    expect(tinted).toHaveLength(1);
    expect(tinted[0].getAttribute("data-start")).toBe(String(start));
    expect(tinted[0].getAttribute("data-end")).toBe(String(end));
    expect(tinted[0].getAttribute("data-source")).toBe("range");
    expect(tinted[0].getAttribute("data-signal-types")).toBe(
      "hallucination_structural_fabrication",
    );
    expect(tinted[0].textContent).toBe("FAKE_REGISTERS");
  });

  it("renders one cell per range when an evidence row carries multiple markers (no 3-match cap)", () => {
    // Repeat a fabrication tell five times so we can prove every engine
    // range is rendered — the matched-text fallback caps at 3, the
    // range-backed path must not.
    const segment = "STACK ";
    const text = segment.repeat(5).trim();
    const ranges = Array.from({ length: 5 }, (_, i) => {
      const s = i * segment.length;
      return { start: s, end: s + "STACK".length, line: 1 };
    });
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "hallucination_structural_fabrication",
        description: "Repeating stack frames",
        weight: 25,
        context: {
          markers: ranges.map((r, i) => ({
            id: `repeating_stack_${i}`,
            description: "repeating stack frame",
            range: r,
          })),
        },
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={[]}
        typeLabels={TYPE_LABELS}
      />,
    );
    const tinted = Array.from(
      screen
        .getByTestId("heatmap-pre")
        .querySelectorAll<HTMLElement>("[data-source='range']"),
    );
    expect(tinted).toHaveLength(5);
  });

  it("falls back to matched-text search when an evidence row has no engine ranges", () => {
    const text = "the report uses certainly to sound confident";
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "ai_phrase",
        description: "Hedging AI phrase",
        weight: 4,
        matched: "certainly",
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={[]}
        typeLabels={TYPE_LABELS}
      />,
    );
    const tinted = Array.from(
      screen
        .getByTestId("heatmap-pre")
        .querySelectorAll<HTMLElement>("[data-signal-types]"),
    );
    expect(tinted).toHaveLength(1);
    expect(tinted[0].getAttribute("data-source")).toBe("match");
    expect(tinted[0].textContent).toBe("certainly");
  });

  it("stacks overlapping signals into a single cell exposing both signal types", () => {
    // A range-backed structural marker covers the whole "shellcode" word;
    // a separate ai_phrase signal's matched text also lands on the same
    // word — the cell must list both signals on the same span.
    const text = "see shellcode here";
    const start = text.indexOf("shellcode");
    const end = start + "shellcode".length;
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "hallucination_structural_fabrication",
        description: "Suspect shellcode block",
        weight: 30,
        context: {
          markers: [
            {
              id: "fake_shellcode",
              description: "fabricated shellcode",
              range: { start, end, line: 1 },
            },
          ],
        },
      },
      {
        type: "ai_phrase",
        description: "AI buzzword",
        weight: 3,
        matched: "shellcode",
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={[]}
        typeLabels={TYPE_LABELS}
      />,
    );
    const stacked = screen
      .getByTestId("heatmap-pre")
      .querySelector<HTMLElement>(
        "[data-signal-types*='hallucination_structural_fabrication']",
      );
    expect(stacked).not.toBeNull();
    const types = stacked!.getAttribute("data-signal-types")!.split(",");
    expect(types).toContain("hallucination_structural_fabrication");
    expect(types).toContain("ai_phrase");
  });

  it("renders matched-text fallback for a row that lacks ranges even when another row of the same type has them", () => {
    // Two rows share the same `type` ("hallucination_structural_fabrication"):
    // one has an engine range, the other only has `matched`. The fallback
    // is gated per row, not per type, so both must render.
    const text = "first FAKE_REGISTERS then later REPEAT_FRAME tail";
    const start = text.indexOf("FAKE_REGISTERS");
    const end = start + "FAKE_REGISTERS".length;
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "hallucination_structural_fabrication",
        description: "Fabricated registers",
        weight: 30,
        context: {
          markers: [
            {
              id: "fake_registers",
              description: "fabricated register dump",
              range: { start, end, line: 1 },
            },
          ],
        },
      },
      {
        type: "hallucination_structural_fabrication",
        description: "Repeating frame tell",
        weight: 25,
        matched: "REPEAT_FRAME",
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={[]}
        typeLabels={TYPE_LABELS}
      />,
    );
    const tinted = Array.from(
      screen
        .getByTestId("heatmap-pre")
        .querySelectorAll<HTMLElement>("[data-signal-types]"),
    );
    const sources = tinted.map((el) => el.getAttribute("data-source"));
    expect(sources).toContain("range");
    expect(sources).toContain("match");
    const matchSpan = tinted.find(
      (el) => el.getAttribute("data-source") === "match",
    );
    expect(matchSpan?.textContent).toBe("REPEAT_FRAME");
  });

  it("lists every firing signal in the legend exactly once and surfaces marker id + description on hover", () => {
    const text = "alpha beta gamma";
    const evidence: HeatmapEvidenceItem[] = [
      {
        type: "hallucination_structural_fabrication",
        description: "Structural tell",
        weight: 30,
        context: {
          markers: [
            {
              id: "fake_registers",
              description: "fabricated register dump",
              range: { start: 0, end: 5, line: 1 },
            },
          ],
        },
      },
      {
        type: "ai_phrase",
        description: "AI phrase",
        weight: 4,
        matched: "gamma",
      },
    ];
    const human: HeatmapHumanIndicator[] = [
      {
        type: "human_contractions",
        description: "Contraction usage",
        weight: -3,
        matched: "beta",
      },
    ];
    render(
      <SignalHeatmapRenderer
        text={text}
        evidence={evidence}
        humanIndicators={human}
        typeLabels={TYPE_LABELS}
      />,
    );
    expect(
      screen.getByTestId("heatmap-legend-hallucination_structural_fabrication"),
    ).toBeTruthy();
    expect(screen.getByTestId("heatmap-legend-ai_phrase")).toBeTruthy();
    expect(
      screen.getByTestId("heatmap-legend-human_contractions"),
    ).toBeTruthy();

    const fakeSpan = screen
      .getByTestId("heatmap-pre")
      .querySelector<HTMLElement>(
        "[data-signal-types='hallucination_structural_fabrication']",
      );
    expect(fakeSpan).not.toBeNull();
    fireEvent.mouseEnter(fakeSpan!);
    const hoverCard = screen.getByTestId("heatmap-hover-card");
    expect(hoverCard.textContent).toContain("fake_registers");
    expect(hoverCard.textContent).toContain("fabricated register dump");
  });
});
