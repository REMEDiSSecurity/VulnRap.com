import { describe, it, expect } from "vitest";
import {
  computeMinHash,
  computeLSHBuckets,
  computeSimhash,
  computeContentHash,
  jaccardSimilarity,
  hammingDistance,
  simhashSimilarity,
} from "./similarity.js";

describe("computeMinHash", () => {
  it("returns a fixed-length signature", () => {
    const sig = computeMinHash("This is a test vulnerability report with enough words for shingles.");
    expect(sig.length).toBe(128);
    expect(sig.every(v => typeof v === "number")).toBe(true);
  });

  it("returns identical signatures for identical text", () => {
    const text = "Identical vulnerability report content for testing purposes.";
    const sig1 = computeMinHash(text);
    const sig2 = computeMinHash(text);
    expect(sig1).toEqual(sig2);
  });

  it("returns similar signatures for similar text", () => {
    const text1 = "SQL injection vulnerability found in the login endpoint of the web application version 2.0";
    const text2 = "SQL injection vulnerability found in the login endpoint of the web application version 2.1";
    const sig1 = computeMinHash(text1);
    const sig2 = computeMinHash(text2);
    const similarity = jaccardSimilarity(sig1, sig2);
    expect(similarity).toBeGreaterThan(0.3);
  });

  it("returns different signatures for unrelated text", () => {
    const sig1 = computeMinHash("SQL injection in the login form allows authentication bypass via malformed input.");
    const sig2 = computeMinHash("The weather forecast predicts sunshine and warm temperatures for the weekend.");
    const similarity = jaccardSimilarity(sig1, sig2);
    expect(similarity).toBeLessThan(0.3);
  });

  it("handles empty/short text", () => {
    const sig = computeMinHash("hi");
    expect(sig.length).toBe(128);
  });
});

describe("computeLSHBuckets", () => {
  it("returns 16 bands", () => {
    const sig = computeMinHash("Test text for LSH bucket generation.");
    const buckets = computeLSHBuckets(sig);
    expect(buckets.length).toBe(16);
    expect(buckets.every(b => b.startsWith("b"))).toBe(true);
  });

  it("returns identical buckets for identical signatures", () => {
    const sig = computeMinHash("Identical text for bucket comparison.");
    const b1 = computeLSHBuckets(sig);
    const b2 = computeLSHBuckets(sig);
    expect(b1).toEqual(b2);
  });
});

describe("computeSimhash", () => {
  it("returns a 64-bit binary string", () => {
    const hash = computeSimhash("Test vulnerability report content.");
    expect(hash.length).toBe(64);
    expect(hash).toMatch(/^[01]+$/);
  });

  it("produces consistent hashes", () => {
    const text = "Consistent hash test report.";
    expect(computeSimhash(text)).toBe(computeSimhash(text));
  });
});

describe("computeContentHash", () => {
  it("returns a SHA-256 hex digest", () => {
    const hash = computeContentHash("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const text = "same content";
    expect(computeContentHash(text)).toBe(computeContentHash(text));
  });

  it("differs for different content", () => {
    expect(computeContentHash("a")).not.toBe(computeContentHash("b"));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical signatures", () => {
    const sig = [1, 2, 3, 4, 5];
    expect(jaccardSimilarity(sig, sig)).toBe(1);
  });

  it("returns 0 for completely different signatures", () => {
    expect(jaccardSimilarity([1, 2, 3], [4, 5, 6])).toBe(0);
  });

  it("returns 0 for empty arrays", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(jaccardSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns correct partial similarity", () => {
    expect(jaccardSimilarity([1, 2, 3, 4], [1, 2, 5, 6])).toBe(0.5);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(hammingDistance("1010", "1010")).toBe(0);
  });

  it("counts bit differences", () => {
    expect(hammingDistance("1010", "1001")).toBe(2);
  });

  it("handles mismatched lengths", () => {
    expect(hammingDistance("10", "1010")).toBe(2);
  });
});

describe("simhashSimilarity", () => {
  it("returns 1 for identical hashes", () => {
    expect(simhashSimilarity("1010", "1010")).toBe(1);
  });

  it("returns values between 0 and 1", () => {
    const sim = simhashSimilarity("10101010", "10100101");
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });
});
