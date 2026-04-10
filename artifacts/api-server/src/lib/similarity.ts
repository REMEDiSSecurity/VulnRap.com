import crypto from "crypto";

const SHINGLE_SIZE = 5;
const NUM_HASHES = 128;
const LARGE_PRIME = 2147483647;

function getShingles(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const words = normalized.split(" ");
  const shingles = new Set<string>();

  if (words.length < SHINGLE_SIZE) {
    shingles.add(words.join(" "));
    return shingles;
  }

  for (let i = 0; i <= words.length - SHINGLE_SIZE; i++) {
    shingles.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return shingles;
}

function hashShingle(shingle: string): number {
  const hash = crypto.createHash("md5").update(shingle).digest();
  return hash.readUInt32BE(0);
}

const hashCoefficients: Array<{ a: number; b: number }> = [];
for (let i = 0; i < NUM_HASHES; i++) {
  hashCoefficients.push({
    a: Math.floor(Math.random() * (LARGE_PRIME - 1)) + 1,
    b: Math.floor(Math.random() * (LARGE_PRIME - 1)) + 1,
  });
}

export function computeMinHash(text: string): number[] {
  const shingles = getShingles(text);
  const shingleHashes = Array.from(shingles).map(hashShingle);

  if (shingleHashes.length === 0) {
    return new Array(NUM_HASHES).fill(0);
  }

  const signature: number[] = new Array(NUM_HASHES).fill(Infinity);

  for (const shingleHash of shingleHashes) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const { a, b } = hashCoefficients[i];
      const hashVal = ((a * shingleHash + b) % LARGE_PRIME) >>> 0;
      if (hashVal < signature[i]) {
        signature[i] = hashVal;
      }
    }
  }

  return signature;
}

export function computeSimhash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens = normalized.split(" ");
  const hashBits = 64;
  const v = new Array(hashBits).fill(0);

  for (const token of tokens) {
    const hash = crypto.createHash("sha256").update(token).digest();
    for (let i = 0; i < hashBits; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      const bit = (hash[byteIndex] >> bitIndex) & 1;
      v[i] += bit === 1 ? 1 : -1;
    }
  }

  let result = "";
  for (let i = 0; i < hashBits; i++) {
    result += v[i] >= 0 ? "1" : "0";
  }
  return result;
}

export function computeContentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function jaccardSimilarity(sig1: number[], sig2: number[]): number {
  if (sig1.length !== sig2.length || sig1.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) {
      matches++;
    }
  }
  return matches / sig1.length;
}

export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return hash1.length;

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }
  return distance;
}

export function simhashSimilarity(hash1: string, hash2: string): number {
  const distance = hammingDistance(hash1, hash2);
  return 1 - distance / Math.max(hash1.length, 1);
}

export interface SimilarityResult {
  reportId: number;
  similarity: number;
  matchType: string;
}

export function findSimilarReports(
  newMinHash: number[],
  newSimhash: string,
  existingReports: Array<{ id: number; minhashSignature: number[]; simhash: string }>,
  topN: number = 10,
  threshold: number = 0.15,
): SimilarityResult[] {
  const results: SimilarityResult[] = [];

  for (const report of existingReports) {
    const jaccardSim = jaccardSimilarity(newMinHash, report.minhashSignature);
    const simhashSim = simhashSimilarity(newSimhash, report.simhash);

    const combinedSim = Math.max(jaccardSim, simhashSim);

    if (combinedSim >= threshold) {
      let matchType = "semantic";
      if (jaccardSim >= 0.8) {
        matchType = "near-duplicate";
      } else if (jaccardSim >= 0.5) {
        matchType = "high-similarity";
      } else if (simhashSim >= 0.8) {
        matchType = "structural";
      }

      results.push({
        reportId: report.id,
        similarity: Math.round(combinedSim * 100),
        matchType,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topN);
}
