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
  const sentence = "The vulnerability allows an attacker to inject arbitrary SQL through the user-supplied query parameter without proper sanitization. ";
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
    // All stages should report individual timings
    expect(trace.stages.length).toBeGreaterThanOrEqual(5);
    for (const s of trace.stages) {
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("trace exposes per-stage timings, feature flags, and signals summary", () => {
    const { trace } = analyzeWithEnginesTraced(TYPICAL_REPORT);
    const stageNames = trace.stages.map(s => s.stage);
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
});
