import { describe, it, expect } from "vitest";
import { parseSections, findSectionMatches } from "./section-parser.js";

describe("parseSections", () => {
  it("parses markdown headers into sections", () => {
    const text = `# Summary
This is the summary.

## Steps to Reproduce
1. Do this
2. Do that

## Impact
Critical severity.`;

    const result = parseSections(text);
    expect(result.sections.length).toBeGreaterThanOrEqual(3);

    const titles = result.sections.map(s => s.title);
    expect(titles).toContain("Summary");
    expect(titles).toContain("Steps to Reproduce");
    expect(titles).toContain("Impact");
  });

  it("assigns high weight to vulnerability-related sections", () => {
    const text = `## Vulnerability
SQL injection found.

## Impact
Data breach possible.

## Proof of Concept
Payload here.`;

    const result = parseSections(text);
    const vulnSection = result.sections.find(s => s.title === "Vulnerability");
    const impactSection = result.sections.find(s => s.title === "Impact");
    const pocSection = result.sections.find(s => s.title === "Proof of Concept");

    expect(vulnSection?.weight).toBe(3);
    expect(impactSection?.weight).toBe(3);
    expect(pocSection?.weight).toBe(3);
  });

  it("assigns medium weight to environment sections", () => {
    const text = `## Environment
Ubuntu 22.04, nginx 1.24

## Timeline
Discovered 2024-01-15`;

    const result = parseSections(text);
    const envSection = result.sections.find(s => s.title === "Environment");
    expect(envSection?.weight).toBe(2);
  });

  it("assigns low weight to unknown sections", () => {
    const text = `## Appendix
Additional notes here.`;

    const result = parseSections(text);
    expect(result.sections[0]?.weight).toBe(1);
  });

  it("generates hashes for each section", () => {
    const text = `## Summary
Some content here.

## Details
More content.`;

    const result = parseSections(text);
    expect(Object.keys(result.sectionHashes).length).toBeGreaterThanOrEqual(2);
    for (const hash of Object.values(result.sectionHashes)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("handles text with no headers", () => {
    const text = "This is just a plain text report with no markdown headers at all.";
    const result = parseSections(text);
    expect(result.sections.length).toBeGreaterThanOrEqual(1);
  });

  it("captures pre-header content", () => {
    const text = `Some introductory text before any headers.

## Details
The actual details.`;

    const result = parseSections(text);
    expect(result.sections.length).toBe(2);
    const first = result.sections[0];
    expect(first.content).toContain("introductory");
  });

  it("produces consistent hashes for identical content", () => {
    const text = "## Summary\nSame content.";
    const r1 = parseSections(text);
    const r2 = parseSections(text);
    expect(r1.sectionHashes).toEqual(r2.sectionHashes);
  });
});

describe("findSectionMatches", () => {
  it("finds matching sections between two reports", () => {
    const report1 = `## Vulnerability
Buffer overflow in libpng.

## Impact
Remote code execution.`;

    const report2 = `## Vulnerability
Buffer overflow in libpng.

## Impact
Denial of service only.`;

    const analysis1 = parseSections(report1);
    const analysis2 = parseSections(report2);

    const matches = findSectionMatches(
      analysis1.sectionHashes,
      [{ id: 1, sectionHashes: analysis2.sectionHashes }],
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].matchedReportId).toBe(1);
  });
});
