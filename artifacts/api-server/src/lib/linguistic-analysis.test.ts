import { describe, it, expect } from "vitest";
import { analyzeLinguistic } from "./linguistic-analysis.js";

describe("analyzeLinguistic", () => {
  it("detects AI phrases and returns elevated lexical score", () => {
    const text = "It is important to note that this vulnerability delve into the core architecture. In the realm of cybersecurity, this represents a significant security risk. The implications of this are multifaceted and require a holistic approach to remediation. Comprehensive analysis of the tapestry of attack vectors reveals paramount concerns.";
    const result = analyzeLinguistic(text);
    expect(result.lexicalScore).toBeGreaterThan(20);
    expect(result.evidence.some(e => e.type === "ai_phrase")).toBe(true);
  });

  it("returns low score for clean technical report", () => {
    const text = `Buffer overflow in png_read_row() at libpng 1.6.39.

The function doesn't validate rowbytes against the allocated buffer when processing
IHDR chunks with width exceeding 2^30. Integer overflow in the multiplication causes
a small heap buffer to be allocated while subsequent row reads write past the end.

Reproducer:
\`\`\`
./pngtest malformed.png
\`\`\`

Crash at png_read_row+0x1a4, ASAN reports heap-buffer-overflow.
Affects versions 1.6.37 through 1.6.39. Fixed in 1.6.40.`;
    const result = analyzeLinguistic(text);
    expect(result.score).toBeLessThan(30);
  });

  it("detects template/boilerplate patterns", () => {
    const text = "Dear Security Team,\n\nI would like to report a critical vulnerability that I discovered during my security research. This vulnerability allows an attacker to execute arbitrary code on the target system. The impact is severe as it could lead to complete system compromise.\n\nBest regards,\nSecurity Researcher";
    const result = analyzeLinguistic(text);
    expect(result.templateScore).toBeGreaterThan(0);
  });

  it("detects sentence uniformity (statistical signal)", () => {
    const text = Array(20).fill("This vulnerability represents a significant security concern that requires immediate attention from the development team.").join(" ");
    const result = analyzeLinguistic(text);
    expect(result.statisticalScore).toBeGreaterThan(0);
  });

  it("returns score clamped between 0 and 100", () => {
    const extreme = "As an AI language model, I'd be happy to delve into this comprehensive analysis. It is important to note the multifaceted tapestry of paramount implications in the realm of robust security. ".repeat(5);
    const result = analyzeLinguistic(extreme);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("provides evidence items with types and weights", () => {
    const text = "It is important to note that delve into the realm of cybersecurity reveals paramount concerns about robust security and holistic approach.";
    const result = analyzeLinguistic(text);
    expect(result.evidence.length).toBeGreaterThan(0);
    for (const e of result.evidence) {
      expect(e).toHaveProperty("type");
      expect(e).toHaveProperty("description");
      expect(e).toHaveProperty("weight");
    }
  });
});
