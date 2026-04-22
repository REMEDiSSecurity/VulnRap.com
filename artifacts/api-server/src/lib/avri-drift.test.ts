import { describe, it, expect } from "vitest";
import { __testing } from "./avri-drift";

const { isoWeekStart, bucketForLabel, summarizePerFamily } = __testing;

describe("avri-drift helpers", () => {
  it("isoWeekStart returns the UTC Monday for any day in the week", () => {
    // 2026-04-22 is a Wednesday → Monday is 2026-04-20.
    expect(isoWeekStart(new Date("2026-04-22T18:00:00Z"))).toBe("2026-04-20");
    // Sunday rolls *back* to the prior Monday, not forward.
    expect(isoWeekStart(new Date("2026-04-26T01:00:00Z"))).toBe("2026-04-20");
    // Monday returns itself.
    expect(isoWeekStart(new Date("2026-04-20T00:00:00Z"))).toBe("2026-04-20");
  });

  it("bucketForLabel maps composite labels to triage-equivalent buckets", () => {
    expect(bucketForLabel("STRONG")).toBe("T1");
    expect(bucketForLabel("PROMISING")).toBe("T1");
    expect(bucketForLabel("LIKELY INVALID")).toBe("T3");
    expect(bucketForLabel("HIGH RISK")).toBe("T3");
    expect(bucketForLabel("REASONABLE")).toBe("NEUTRAL");
    expect(bucketForLabel("NEEDS REVIEW")).toBe("NEUTRAL");
    expect(bucketForLabel(null)).toBe("NEUTRAL");
  });

  it("summarizePerFamily groups composites by family and returns sorted, rounded means", () => {
    const out = summarizePerFamily([
      { family: "INJECTION", composite: 80 },
      { family: "INJECTION", composite: 70 },
      { family: "MEMORY_CORRUPTION", composite: 60 },
    ]);
    expect(out).toEqual([
      { family: "INJECTION", count: 2, mean: 75 },
      { family: "MEMORY_CORRUPTION", count: 1, mean: 60 },
    ]);
  });
});
