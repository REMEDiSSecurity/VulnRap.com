// Task #48 — composite-level fabricated-evidence penalty regression test.
//
// `detectHallucinationSignals` already flags fabricated stack traces, round/
// sequential addresses, phantom functions, fabricated PIDs, and empty
// responsible-disclosure boilerplate. Until task #48 those signals only fed
// score-fusion's heuristic path; the 3-engine composite never saw them, so a
// fabricated report could ride Engine 3's strong-fit floor (68/78) up into
// the 50s. This test locks the new tiered composite override in:
//
//   totalWeight  ≥ 12  →  -10
//   totalWeight  ≥ 20  →  -15
//   totalWeight  ≥ 30  →  -25
//
// And verifies that:
//   * the override is recorded in `overridesApplied`
//   * a benign legit report (no hallucination signals) is unaffected
//   * `computeComposite` without `text` is a no-op for the new override

import { describe, it, expect } from "vitest";
import { computeComposite, type EngineResult } from "./engines";

function mk(
  engine: string,
  score: number,
  verdict: EngineResult["verdict"] = "GREY",
): EngineResult {
  return {
    engine,
    score,
    verdict,
    confidence: "MEDIUM",
    triggeredIndicators: [],
    signalBreakdown: {},
    note: "fixture",
  };
}

const baselineEngines = (): EngineResult[] => [
  mk("AI Authorship Detector", 30, "GREEN"),
  mk("Technical Substance Analyzer", 60, "YELLOW"),
  mk("CWE Coherence Checker", 70, "GREEN"),
];

describe("Task #48: hallucination composite override", () => {
  it("does NOT fire when text is omitted (backward-compatible)", () => {
    const r = computeComposite(baselineEngines());
    expect(
      r.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(false);
  });

  it("does NOT fire on a clean text with no hallucination signals", () => {
    const cleanText = `
# Stored XSS in user profile bio

The user profile bio at /users/edit allows storing JavaScript via the
"about" textarea. The form does not encode \`<\`/\`>\` characters.

Steps:
1. Visit /users/edit
2. Set bio to: <script>alert(document.domain)</script>
3. Save and view profile.

Patch:
\`\`\`diff
- output(bio)
+ output(escapeHtml(bio))
\`\`\`
`;
    const before = computeComposite(baselineEngines()).overallScore;
    const after = computeComposite(baselineEngines(), cleanText);
    expect(
      after.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(false);
    expect(after.overallScore).toBe(before);
  });

  it("applies a -10 penalty when totalWeight is in the 12–19 band", () => {
    // Two moderate signals: phantom_exploit_script (8) + empty_disclosure
    // boilerplate (5) = totalWeight 13.
    const text = `
# Authentication bypass in some-app

This was reported under responsible disclosure. The exploit is in
attack.py (not attached for safety).
`;
    const before = computeComposite(baselineEngines()).overallScore;
    const after = computeComposite(baselineEngines(), text);
    const note = after.overridesApplied.find((o) =>
      o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/moderate fabrication/i);
    expect(before - after.overallScore).toBe(10);
  });

  it("applies a -15 penalty when totalWeight is in the 20–29 band", () => {
    // round addresses (10) + phantom_exploit_script (8) + repeated_sentences (6)
    // = totalWeight 24 (well into the 20s tier).
    const text = `
# Buffer overflow in libfoo

Crash at 0x10000000 in libfoo. Also crashes at 0x20000000, 0x30000000,
0x40000000.

Working PoC available in exploit.py (private).

Severity: Critical and high impact.
Severity: Critical and high impact.
Severity: Critical and high impact.
`;
    const before = computeComposite(baselineEngines()).overallScore;
    const after = computeComposite(baselineEngines(), text);
    const note = after.overridesApplied.find((o) =>
      o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/strong fabrication/i);
    expect(before - after.overallScore).toBe(15);
  });

  it("applies a -25 penalty when totalWeight is in the 30+ band", () => {
    // Stack-frame repetition (15) + round addresses (10) + repeated sentences (6)
    // + phantom_exploit_script (8) = totalWeight 39.
    const text = `
# Use-after-free in nginx

Confirmed gdb backtrace:
#0 0xdeadbeefdead in process_frame
#1 0xdeadbeefdead in process_frame
#2 0xdeadbeefdead in process_frame
#3 0xdeadbeefdead in process_frame
#4 0xdeadbeefdead in process_frame

Memory corruption at 0x10000000, 0x20000000, 0x30000000, 0x40000000.

Working PoC in exploit.py (private). Working PoC in exploit.py (private).
Working PoC in exploit.py (private). Working PoC in exploit.py (private).
`;
    const before = computeComposite(baselineEngines()).overallScore;
    const after = computeComposite(baselineEngines(), text);
    const note = after.overridesApplied.find((o) =>
      o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
    );
    expect(note).toBeDefined();
    expect(note).toMatch(/overwhelming fabrication/i);
    expect(before - after.overallScore).toBe(25);
  });

  it("pushes a strong-CWE-fit fabricated report from the 50s into LIKELY-INVALID territory", () => {
    // Reproduces the failure the task description calls out: Engine 3 hits
    // its 78-point perfect-fit floor and Engine 2 sits in the high 30s, so
    // without the new override the composite lands in the low 50s — well
    // above LIKELY INVALID. The hallucination penalty must drag it back
    // under 35.
    const engines: EngineResult[] = [
      mk("AI Authorship Detector", 35, "YELLOW"),
      mk("Technical Substance Analyzer", 38, "YELLOW"),
      mk("CWE Coherence Checker", 78, "GREEN"),
    ];
    const fabricatedText = `
# Use-after-free in nginx mod_http_v3 (CVE-2026-00001)

Confirmed gdb backtrace:
#0 0xdeadbeefdead in process_frame
#1 0xdeadbeefdead in process_frame
#2 0xdeadbeefdead in process_frame
#3 0xdeadbeefdead in process_frame
#4 0xdeadbeefdead in process_frame
#5 0xdeadbeefdead in process_frame

PID 11111 was killed. Working PoC in exploit.py (private).
Working PoC in exploit.py (private). Working PoC in exploit.py (private).
`;
    const before = computeComposite(engines).overallScore;
    const after = computeComposite(engines, fabricatedText);
    expect(before).toBeGreaterThanOrEqual(45);
    expect(after.overallScore).toBeLessThanOrEqual(35);
    expect(
      after.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(true);
  });

  it("does NOT fire on a legit truncated ASan excerpt that uses the textbook PID 12345", () => {
    // Mirrors the T1-AVRI-cve-2025-0725-curl fixture pattern: a legit
    // report that excerpts an ASan line without the SUMMARY block AND
    // happens to use the textbook PID `12345`. As of v3.8.0 (Task #192)
    // detectHallucinationSignals tightens both rules at the source —
    // `incomplete_asan` is suppressed by the `==N==ERROR: AddressSanitizer:`
    // header, and `fabricated_pid` only fires when the magic PID is paired
    // with another fabrication signal (or a second magic PID). Neither
    // signal fires here, so the composite override must abstain.
    const text = `
# Heap-buffer-overflow in libcurl gzip decoding

Repro under ASan:
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80

Patch validates the inflate() return size before client_write.
`;
    const r = computeComposite(baselineEngines(), text);
    expect(
      r.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(false);
  });

  it("co-fires algebraically with the existing CONVERGENT_NEGATIVE override", () => {
    const engines: EngineResult[] = [
      mk("AI Authorship Detector", 90, "RED"),
      mk("Technical Substance Analyzer", 15, "RED"),
      mk("CWE Coherence Checker", 40, "YELLOW"),
    ];
    const fabricatedText = `
Crashes at 0x10000000, 0x20000000, 0x30000000, 0x40000000, 0x50000000.
Working PoC in exploit.py (private). Working PoC in exploit.py (private).
Working PoC in exploit.py (private).
`;
    const r = computeComposite(engines, fabricatedText);
    expect(
      r.overridesApplied.some((o) => o.startsWith("CONVERGENT_NEGATIVE")),
    ).toBe(true);
    expect(
      r.overridesApplied.some((o) =>
        o.startsWith("HALLUCINATION_FABRICATED_EVIDENCE"),
      ),
    ).toBe(true);
  });
});
