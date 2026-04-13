import { describe, it, expect } from "vitest";
import { analyzeSloppiness } from "./sloppiness.js";

describe("analyzeSloppiness", () => {
  it("flags very short reports", () => {
    const result = analyzeSloppiness("XSS found on login page.");
    expect(result.qualityScore).toBeLessThan(80);
    expect(result.qualityFeedback.some(f => f.includes("short"))).toBe(true);
  });

  it("flags AI phrases at threshold 1", () => {
    const result = analyzeSloppiness("It is important to note that the vulnerability exists in the login form. The impact is severe because version 1.0 has no input validation.");
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.slopSignals.length).toBeGreaterThan(0);
  });

  it("flags 3+ AI phrases heavily", () => {
    const text = "It is important to note that this vulnerability delve into the core architecture. In the realm of cybersecurity, this represents a significant risk. A comprehensive analysis reveals multifaceted implications.";
    const result = analyzeSloppiness(text);
    expect(result.score).toBeGreaterThanOrEqual(15);
  });

  it("flags 5+ AI phrases as strong slop signal", () => {
    const text = "It is important to note the implications. Delve into the details. In the realm of security. Comprehensive analysis required. Multifaceted approach. Tapestry of vulnerabilities. Paramount importance. Robust security needed. Meticulous examination. Holistic approach recommended. Proactive measures.";
    const result = analyzeSloppiness(text);
    expect(result.score).toBeGreaterThanOrEqual(30);
  });

  it("penalizes missing version info", () => {
    const result = analyzeSloppiness("The application has a SQL injection vulnerability in the login form. An attacker can bypass authentication by injecting malicious SQL into the username field.");
    expect(result.qualityFeedback.some(f => f.includes("version"))).toBe(true);
  });

  it("penalizes missing repro steps", () => {
    const result = analyzeSloppiness("SQL injection in login form version 1.0. Component: auth-module. CWE-89 remote attack.");
    expect(result.qualityFeedback.some(f => f.includes("reproduction") || f.includes("Reproduction"))).toBe(true);
  });

  it("gives clean tier to well-structured reports", () => {
    const text = `## Vulnerability
SQL injection in login endpoint v2.3.1

## Component
endpoint: /api/v1/auth/login

## Steps to Reproduce
1. Navigate to login page
2. Enter \`' OR 1=1 --\` in username field
3. Submit the form

## Impact
Remote authentication bypass. Severity: high. CWE-89.

## Expected Behavior
Should reject malformed input.

## Observed Behavior
However, the query returns all users and grants admin access.

\`\`\`sql
SELECT * FROM users WHERE username = '' OR 1=1 --'
\`\`\``;
    const result = analyzeSloppiness(text);
    expect(result.tier).toBe("Clean");
    expect(result.qualityScore).toBeGreaterThanOrEqual(80);
  });

  it("flags unusually long reports", () => {
    const text = "This is a sentence with enough words to pad the report above the five thousand word threshold when repeated many times over and over again. ".repeat(250);
    const result = analyzeSloppiness(text);
    expect(result.slopSignals.some(s => s.toLowerCase().includes("long"))).toBe(true);
  });

  it("flags low vocabulary diversity", () => {
    const words = "the vulnerability the vulnerability the attack the attack the server the server ";
    const text = words.repeat(20);
    const result = analyzeSloppiness(text);
    expect(result.slopSignals.some(s => s.includes("repetitive"))).toBe(true);
  });

  it("returns score between 0 and 100", () => {
    const result = analyzeSloppiness("Test report.");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(100);
  });
});
