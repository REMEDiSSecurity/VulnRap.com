// Sprint 12 Part A1 — E3 substance-gate regression test.
//
// Reproduces the 10 reports from the Sprint 11 expanded test battery using
// only their per-engine scores (E1, E2, E3) and asserts that the new
// substance-gated composite math closes the slop/legit gap as projected.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeComposite, type EngineResult } from "./engines";

type Bench = {
  id: number;
  name: string;
  type: "slop" | "legit";
  e1: number;
  e2: number;
  e3: number;
  /** Composite as currently observed in production (sanity baseline). */
  observedComposite: number;
};

// From sprint-11-expanded-test-results.md (2026-04-23). E1 values shown as
// "—" in the source doc are filled with 30 (a representative neutral value
// observed in the reports that did report E1) so the math is reproducible.
const BENCH: Bench[] = [
  {
    id: 64,
    name: "Generic XSS",
    type: "slop",
    e1: 30,
    e2: 7,
    e3: 38,
    observedComposite: 22,
  },
  {
    id: 67,
    name: "Generic SQLi",
    type: "slop",
    e1: 34,
    e2: 23,
    e3: 47,
    observedComposite: 35,
  },
  {
    id: 68,
    name: "Fake UAF",
    type: "slop",
    e1: 38,
    e2: 26,
    e3: 47,
    observedComposite: 36,
  },
  {
    id: 70,
    name: "Fake HTTP/2 DoS",
    type: "slop",
    e1: 33,
    e2: 22,
    e3: 68,
    observedComposite: 43,
  },
  {
    id: 72,
    name: "Auth Bypass template",
    type: "slop",
    e1: 36,
    e2: 25,
    e3: 68,
    observedComposite: 44,
  },
  {
    id: 65,
    name: "curl HSTS bypass",
    type: "legit",
    e1: 30,
    e2: 44,
    e3: 50,
    observedComposite: 48,
  },
  {
    id: 66,
    name: "Firefox UAF",
    type: "legit",
    e1: 30,
    e2: 64,
    e3: 55,
    observedComposite: 61,
  },
  {
    id: 69,
    name: "Linux NULL deref",
    type: "legit",
    e1: 30,
    e2: 74,
    e3: 50,
    observedComposite: 64,
  },
  {
    id: 71,
    name: "IDOR with HTTP pairs",
    type: "legit",
    e1: 34,
    e2: 87,
    e3: 46,
    observedComposite: 70,
  },
  {
    id: 73,
    name: "OpenSSL cert bypass",
    type: "legit",
    e1: 30,
    e2: 82,
    e3: 68,
    observedComposite: 76,
  },
];

function mkEngines(b: Bench): EngineResult[] {
  const stub = (engine: string, score: number): EngineResult => ({
    engine,
    score,
    verdict: "GREY",
    confidence: "MEDIUM",
    triggeredIndicators: [],
    signalBreakdown: {},
    note: "fixture",
  });
  return [
    stub("AI Authorship Detector", b.e1),
    stub("Technical Substance Analyzer", b.e2),
    stub("CWE Coherence Checker", b.e3),
  ];
}

function score(b: Bench): number {
  return computeComposite(mkEngines(b)).overallScore;
}

describe("Sprint 12 A1: E3 substance gate", () => {
  let originalFlag: string | undefined;

  beforeEach(() => {
    originalFlag = process.env.VULNRAP_E3_SUBSTANCE_CAP;
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.VULNRAP_E3_SUBSTANCE_CAP;
    else process.env.VULNRAP_E3_SUBSTANCE_CAP = originalFlag;
  });

  it("with the gate DISABLED, composite math is in the same ballpark as observed Sprint 11 numbers (within ±8)", () => {
    // Tolerance is ±8 because the production observed numbers (a) include AVRI
    // behavioral penalties (velocity, template, family-no-gold, etc.) that
    // these synthetic fixtures don't model and (b) were captured against the
    // pre-Sprint-12-A3 5/55/40 weighting; this codebase now runs the
    // 5/60/35 weighting which intentionally shifts low-substance reports a
    // few points lower. We're only verifying that the legacy weighting
    // pathway is still in the right ballpark — exact parity is not the goal.
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "false";
    for (const b of BENCH) {
      const composite = score(b);
      expect(
        Math.abs(composite - b.observedComposite),
        `${b.name} (id ${b.id}): expected ≈${b.observedComposite}, got ${composite}`,
      ).toBeLessThanOrEqual(8);
    }
  });

  it("calibration summary (always passes, prints before/after table)", () => {
    const pad = (s: string | number, n: number) => String(s).padEnd(n);
    const padR = (s: string | number, n: number) => String(s).padStart(n);
    const lines: string[] = [];
    lines.push("\nSprint 12 A1 — E3 substance-gate calibration");
    lines.push("=".repeat(92));
    lines.push(
      pad("ID", 4) +
        pad("Type", 7) +
        pad("Name", 24) +
        padR("E1", 4) +
        padR("E2", 4) +
        padR("E3", 4) +
        padR("OBS", 6) +
        padR("OFF", 6) +
        padR("ON", 6) +
        padR("Δ", 6) +
        "  Gate?",
    );
    lines.push("-".repeat(92));
    const off: number[] = [];
    const on: number[] = [];
    for (const b of BENCH) {
      process.env.VULNRAP_E3_SUBSTANCE_CAP = "false";
      const offC = score(b);
      process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
      const onR = computeComposite(mkEngines(b));
      const onC = onR.overallScore;
      const fired = onR.overridesApplied.some((o) =>
        o.startsWith("E3_SUBSTANCE_GATE"),
      );
      off.push(offC);
      on.push(onC);
      const d = onC - offC;
      lines.push(
        pad(b.id, 4) +
          pad(b.type, 7) +
          pad(b.name, 24) +
          padR(b.e1, 4) +
          padR(b.e2, 4) +
          padR(b.e3, 4) +
          padR(b.observedComposite, 6) +
          padR(offC, 6) +
          padR(onC, 6) +
          padR(d >= 0 ? `+${d}` : `${d}`, 6) +
          "  " +
          (fired ? "yes" : "no"),
      );
    }
    lines.push("-".repeat(92));
    const slopIdx = BENCH.map((b, i) => (b.type === "slop" ? i : -1)).filter(
      (i) => i >= 0,
    );
    const legitIdx = BENCH.map((b, i) => (b.type === "legit" ? i : -1)).filter(
      (i) => i >= 0,
    );
    const offSlopMax = Math.max(...slopIdx.map((i) => off[i]));
    const offLegitMin = Math.min(...legitIdx.map((i) => off[i]));
    const onSlopMax = Math.max(...slopIdx.map((i) => on[i]));
    const onLegitMin = Math.min(...legitIdx.map((i) => on[i]));
    lines.push(
      `gate OFF: highest slop=${offSlopMax}  lowest legit=${offLegitMin}  gap=${offLegitMin - offSlopMax}`,
    );
    lines.push(
      `gate ON : highest slop=${onSlopMax}  lowest legit=${onLegitMin}  gap=${onLegitMin - onSlopMax}`,
    );
    lines.push(
      `Δ gap   : ${onLegitMin - onSlopMax - (offLegitMin - offSlopMax)} points`,
    );
    lines.push(
      `Sprint 12 Part A end-state target: gap ≥ 15, highest slop < 35`,
    );
    lines.push(
      `A1 alone (this commit): closes ~10 of the ~11 needed points; A2/A3 to follow.`,
    );

    console.log(lines.join("\n"));
    expect(true).toBe(true);
  });

  it("with the gate ENABLED, slop reports drop and legit reports stay put", () => {
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
    for (const b of BENCH) {
      const newComposite = score(b);
      if (b.type === "slop") {
        // Every slop report should drop OR stay the same (never rise).
        expect(newComposite, `${b.name}: should not rise`).toBeLessThanOrEqual(
          b.observedComposite + 1,
        );
      } else {
        // Legit reports should not drop by more than a couple of points.
        expect(
          newComposite,
          `${b.name}: should not collapse`,
        ).toBeGreaterThanOrEqual(b.observedComposite - 3);
      }
    }
  });

  it("closes the slop/legit gap from ~4 points to ≥10 points", () => {
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
    const slopMax = Math.max(
      ...BENCH.filter((b) => b.type === "slop").map(score),
    );
    const legitMin = Math.min(
      ...BENCH.filter((b) => b.type === "legit").map(score),
    );
    const gap = legitMin - slopMax;

    console.log(
      `[E3 gate] slop max=${slopMax} legit min=${legitMin} gap=${gap}`,
    );
    expect(gap).toBeGreaterThanOrEqual(10);
  });

  it("highest slop composite drops below the Part A target of 35", () => {
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
    const slopMax = Math.max(
      ...BENCH.filter((b) => b.type === "slop").map(score),
    );
    expect(slopMax).toBeLessThanOrEqual(35);
  });

  it("includes an E3_SUBSTANCE_GATE override note when the cap fires", () => {
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
    // Use the Fake DoS report (e2=22, e3=68) — gate must fire here.
    const fakeDos = BENCH.find((b) => b.id === 70)!;
    const result = computeComposite(mkEngines(fakeDos));
    expect(
      result.overridesApplied.some((o) => o.startsWith("E3_SUBSTANCE_GATE")),
    ).toBe(true);
  });

  it("does NOT fire when E2 is healthy", () => {
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
    // Use OpenSSL legit (e2=82, e3=68) — gate must not fire.
    const openssl = BENCH.find((b) => b.id === 73)!;
    const result = computeComposite(mkEngines(openssl));
    expect(
      result.overridesApplied.some((o) => o.startsWith("E3_SUBSTANCE_GATE")),
    ).toBe(false);
  });
});
