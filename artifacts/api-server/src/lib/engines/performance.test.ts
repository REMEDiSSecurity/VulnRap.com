// Sprint 9 v3: Performance benchmark — composite must run in <500ms per report
// for the median typical-length input (≈800 words). Hard ceiling 1500ms for
// adversarial 8K-word inputs. Catches regressions from new heuristics.

import { describe, it, expect } from "vitest";
import { analyzeWithEnginesTraced } from "./index";

const TYPICAL_REPORT = `# SQL Injection in /api/users/search

## Summary
The user search endpoint at /api/users/search is vulnerable to SQL injection
through the \`q\` query parameter. The application concatenates the parameter
directly into a query without parameterization.

## Reproduction
1. Send the following request:
\`\`\`http
GET /api/users/search?q=admin' UNION SELECT username,password FROM users--
Host: target.example.org
\`\`\`

2. Observe the response leaks all rows from the users table.

## Impact
Full database read access. We confirmed extraction of password hashes
in src/auth/login.py:127 via this vector.

## PoC
\`\`\`python
import requests
r = requests.get("https://target.example.org/api/users/search",
                 params={"q": "x' UNION SELECT 1,2,3--"})
print(r.text[:500])
\`\`\`

## Remediation
Switch to parameterized queries via SQLAlchemy. Apply input validation
on \`q\` length (max 64 chars, alphanumeric + spaces).

CWE-89 (SQL Injection).
`.repeat(2);

function makeLargeReport(targetWords: number): string {
  const sentence =
    "The vulnerability allows an attacker to inject arbitrary SQL through the user-supplied query parameter without proper sanitization. ";
  const wordsPerSentence = sentence.trim().split(/\s+/).length;
  const need = Math.ceil(targetWords / wordsPerSentence);
  return TYPICAL_REPORT + "\n\n" + sentence.repeat(need);
}

describe("Sprint 9 v3 — Engine performance", () => {
  it("typical 800-word report completes in under 500ms", () => {
    const text = TYPICAL_REPORT;
    // Warm up
    analyzeWithEnginesTraced(text);

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      const { trace } = analyzeWithEnginesTraced(text);
      samples.push(trace.totalDurationMs);
      const _t = Date.now() - start;
      expect(_t).toBeGreaterThanOrEqual(0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(500);
  });

  it("large 8000-word report completes in under 1500ms", () => {
    const text = makeLargeReport(8000);
    analyzeWithEnginesTraced(text); // warm up
    const start = Date.now();
    const { trace } = analyzeWithEnginesTraced(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
    expect(trace.totalDurationMs).toBeLessThan(1500);
    // Default (AVRI) pipeline collapses Engine 1/2/3 + composite into a single
    // avri_composite stage, leaving 3 top-level stages. Legacy mode (forced
    // off below) reports the full 6-stage breakdown.
    expect(trace.stages.length).toBeGreaterThanOrEqual(3);
    for (const s of trace.stages) {
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("default (AVRI) trace exposes per-stage timings, feature flags, and signals summary", () => {
    const { trace } = analyzeWithEnginesTraced(TYPICAL_REPORT);
    const stageNames = trace.stages.map((s) => s.stage);
    expect(stageNames).toContain("extract_signals");
    expect(stageNames).toContain("perplexity");
    expect(stageNames).toContain("avri_composite");
    expect(trace.featureFlags.VULNRAP_USE_NEW_COMPOSITE).toBeDefined();
    expect(trace.featureFlags.VULNRAP_USE_AVRI).toBe(true);
    expect(trace.signalsSummary?.wordCount).toBeGreaterThan(0);
    expect(trace.correlationId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("legacy (AVRI off) trace exposes per-engine stage timings", () => {
    const { trace } = analyzeWithEnginesTraced(TYPICAL_REPORT, {
      forceAvri: false,
    });
    const stageNames = trace.stages.map((s) => s.stage);
    expect(stageNames).toContain("extract_signals");
    expect(stageNames).toContain("perplexity");
    expect(stageNames).toContain("engine1_ai_authorship");
    expect(stageNames).toContain("engine2_substance");
    expect(stageNames).toContain("engine3_cwe_coherence");
    expect(stageNames).toContain("composite");
    expect(trace.featureFlags.VULNRAP_USE_NEW_COMPOSITE).toBeDefined();
    expect(trace.signalsSummary?.wordCount).toBeGreaterThan(0);
    expect(trace.correlationId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  // Task #298: AVRI traces must persist the rawAvriScore vs legacyScore split
  // so the analysis_traces table can answer "how often does AVRI disagree with
  // legacy substance, and by how much?" before the 50/50 blend at
  // engine2-avri.ts:442 is re-tuned. The legacy path leaves avriBreakdown
  // undefined.
  it("AVRI trace persists rawAvriScore vs legacyScore breakdown", () => {
    const { trace, composite } = analyzeWithEnginesTraced(TYPICAL_REPORT);
    expect(trace.avriBreakdown).toBeDefined();
    const b = trace.avriBreakdown!;
    expect(typeof b.family).toBe("string");
    expect(b.family.length).toBeGreaterThan(0);
    expect(typeof b.rawAvriScore).toBe("number");
    expect(typeof b.legacyScore).toBe("number");
    expect(typeof b.blendedScore).toBe("number");
    expect(b.rawAvriScore).toBeGreaterThanOrEqual(0);
    expect(b.rawAvriScore).toBeLessThanOrEqual(100);
    expect(b.legacyScore).toBeGreaterThanOrEqual(0);
    expect(b.legacyScore).toBeLessThanOrEqual(100);
    expect(b.blendedScore).toBeGreaterThanOrEqual(0);
    expect(b.blendedScore).toBeLessThanOrEqual(100);
    // The substance engine on the composite must agree with the persisted
    // blended score — guards against a future engineResults shape change
    // silently desyncing the trace breakdown from the actual scoring.
    const substance = composite.engineResults.find(
      (r) => r.engine === "Technical Substance Analyzer",
    );
    expect(substance).toBeDefined();
    expect(substance!.score).toBe(b.blendedScore);
  });

  it("legacy (AVRI off) trace omits avriBreakdown", () => {
    const { trace } = analyzeWithEnginesTraced(TYPICAL_REPORT, {
      forceAvri: false,
    });
    expect(trace.avriBreakdown).toBeUndefined();
  });
});
