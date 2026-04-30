import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CompactionRollupsSparkline } from "./feedback-analytics";

// Task #405 — guard the tiny inline bar sparkline that replaces the
// comma-separated list of recent compaction `removed` counts on the
// archetype-history config block. The visual is intentionally minimal
// (no axes, no labels) so these tests assert structural properties
// rather than text content: degenerate-input gating, bar count, and
// the relative-height invariant that "the bars get taller when
// `removed` gets bigger".

const run = (at: string, removed: number) => ({ at, removed });

function getBars(container: HTMLElement): SVGRectElement[] {
  return Array.from(container.querySelectorAll("rect"));
}

describe("CompactionRollupsSparkline (Task #405)", () => {
  it("returns nothing when fewer than two runs are available", () => {
    const { container: empty } = render(<CompactionRollupsSparkline runs={[]} />);
    expect(empty.querySelector("svg")).toBeNull();

    const { container: single } = render(
      <CompactionRollupsSparkline runs={[run("2026-04-22T00:00:00Z", 5)]} />,
    );
    expect(single.querySelector("svg")).toBeNull();
  });

  it("renders one <rect> bar per run when at least two runs are present", () => {
    const runs = [
      run("2026-04-20T00:00:00Z", 0),
      run("2026-04-21T00:00:00Z", 14),
      run("2026-04-22T00:00:00Z", 0),
      run("2026-04-23T00:00:00Z", 8),
    ];
    const { container } = render(<CompactionRollupsSparkline runs={runs} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(getBars(container).length).toBe(runs.length);
  });

  it("scales bar height proportionally — bigger `removed` ⇒ taller bar", () => {
    const runs = [run("2026-04-20T00:00:00Z", 1), run("2026-04-21T00:00:00Z", 10)];
    const { container } = render(<CompactionRollupsSparkline runs={runs} />);
    const [a, b] = getBars(container);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const ha = parseFloat(a!.getAttribute("height") ?? "0");
    const hb = parseFloat(b!.getAttribute("height") ?? "0");
    expect(hb).toBeGreaterThan(ha);
  });

  it("renders a 1px floor for zero-valued runs so the slot is still visible", () => {
    // All-zero series — every bar collapses to the minimum tick height
    // rather than disappearing, so reviewers can still see the cadence.
    const runs = [
      run("2026-04-20T00:00:00Z", 0),
      run("2026-04-21T00:00:00Z", 0),
      run("2026-04-22T00:00:00Z", 0),
    ];
    const { container } = render(<CompactionRollupsSparkline runs={runs} />);
    const bars = getBars(container);
    expect(bars.length).toBe(runs.length);
    for (const r of bars) {
      expect(parseFloat(r.getAttribute("height") ?? "0")).toBe(1);
    }
  });

  it("keeps the tallest bar within the SVG's drawable area", () => {
    // Spike followed by zeros — the spike must not exceed the inner
    // height (H - 2 * PAD = 12 in the current geometry). We assert the
    // weaker invariant `<= viewBox height` so the test stays robust to
    // small geometry tweaks.
    const runs = [
      run("2026-04-20T00:00:00Z", 0),
      run("2026-04-21T00:00:00Z", 999),
    ];
    const { container } = render(<CompactionRollupsSparkline runs={runs} />);
    const svg = container.querySelector("svg")!;
    const vb = (svg.getAttribute("viewBox") ?? "0 0 0 0").split(" ").map(Number);
    const vbHeight = vb[3] ?? 0;
    const tallest = Math.max(
      ...getBars(container).map(r => parseFloat(r.getAttribute("height") ?? "0")),
    );
    expect(tallest).toBeGreaterThan(0);
    expect(tallest).toBeLessThanOrEqual(vbHeight);
  });
});
