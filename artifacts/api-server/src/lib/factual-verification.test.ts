import { describe, it, expect } from "vitest";
import { analyzeFactual } from "./factual-verification.js";

describe("analyzeFactual", () => {
  it("detects placeholder domains", () => {
    const text = "The vulnerability was found at https://example.com/api/v1/users where an attacker can inject SQL commands into the search parameter.";
    const result = analyzeFactual(text);
    expect(result.placeholderScore).toBeGreaterThan(0);
    expect(result.evidence.some(e => e.type === "placeholder_domain" || e.description.toLowerCase().includes("placeholder"))).toBe(true);
  });

  it("detects severity inflation", () => {
    const text = "CRITICAL: CVSS score: 10.0 — This vulnerability allows remote code execution on the server. The impact is catastrophic and affects all users globally. No exploit code provided.";
    const result = analyzeFactual(text);
    expect(result.severityInflationScore).toBeGreaterThan(0);
  });

  it("detects future CVE IDs", () => {
    const text = "This is tracked as CVE-2099-12345. The vulnerability affects all versions prior to 2.0.";
    const result = analyzeFactual(text);
    expect(result.evidence.some(e => e.type === "future_cve")).toBe(true);
  });

  it("returns low score for factually grounded report", () => {
    const text = `CVE-2023-44487 (HTTP/2 Rapid Reset) affects nginx versions prior to 1.25.3.

CVSS 7.5 (High). The attack vector is network-based and requires no authentication.

The vulnerability exists in the HTTP/2 protocol handling where a client can send
RST_STREAM frames immediately after opening streams, causing excessive server resource
consumption. This is a denial-of-service condition.

Tested against nginx 1.24.0 on Ubuntu 22.04 with h2load.`;
    const result = analyzeFactual(text);
    expect(result.score).toBeLessThan(30);
  });

  it("detects fabricated ASan output", () => {
    const text = `ASan detected a buffer overflow:
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x6060606060606060
READ of size 8 at 0x6060606060606060 thread T0
    #0 0x5555555555555 in vulnerable_function /src/main.c:42
    #1 0x5555555555555 in vulnerable_function /src/main.c:42
    #2 0x5555555555555 in vulnerable_function /src/main.c:42`;
    const result = analyzeFactual(text);
    expect(result.fabricatedOutputScore).toBeGreaterThan(0);
  });

  it("returns scores between 0 and 100", () => {
    const result = analyzeFactual("Simple report text.");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.severityInflationScore).toBeGreaterThanOrEqual(0);
    expect(result.placeholderScore).toBeGreaterThanOrEqual(0);
    expect(result.fabricatedOutputScore).toBeGreaterThanOrEqual(0);
  });
});
