// Sprint 9 v3: Lightweight n-gram perplexity uplift for Engine 1.
// We do NOT ship a full LM. Instead we measure two cheap proxies that correlate
// with AI-generated text:
//   1. Bigram entropy (Shannon) — AI text tends to repeat the same bigrams.
//   2. Function-word ratio drift — AI text overuses connective scaffolding
//      ("furthermore", "additionally", "however", "moreover", "thus", etc.).
// Returns a 0..100 score where higher = more AI-like.

const FUNCTION_WORDS = new Set([
  "furthermore", "additionally", "moreover", "however", "thus", "therefore",
  "consequently", "subsequently", "accordingly", "nevertheless", "nonetheless",
  "specifically", "particularly", "essentially", "fundamentally", "ultimately",
  "importantly", "notably", "indeed", "hence", "whereas",
]);

export interface PerplexityResult {
  bigramEntropy: number;       // 0..~14 bits; lower = more repetitive
  functionWordRate: number;    // per 1k tokens
  syntaxValidityScore: number; // 0..1; 1 = code blocks parse cleanly
  combinedScore: number;       // 0..100; higher = more AI-like
}

export function computePerplexity(text: string, codeBlocks: { lang: string | null; body: string }[] = []): PerplexityResult {
  const tokens = (text.toLowerCase().match(/\b[a-z][a-z']+\b/g) ?? []).slice(0, 8000);
  if (tokens.length < 20) {
    return { bigramEntropy: 6, functionWordRate: 0, syntaxValidityScore: 1, combinedScore: 30 };
  }

  // Bigram counts
  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const bg = tokens[i] + " " + tokens[i + 1];
    bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
  }
  const totalBigrams = tokens.length - 1;
  let entropy = 0;
  for (const c of bigramCounts.values()) {
    const p = c / totalBigrams;
    entropy -= p * Math.log2(p);
  }

  // Function word density
  let fwHits = 0;
  for (const t of tokens) if (FUNCTION_WORDS.has(t)) fwHits++;
  const functionWordRate = (fwHits / tokens.length) * 1000;

  // Syntax validity: balanced delimiters in code blocks. Cheap and language-agnostic.
  const syntaxValidityScore = computeSyntaxValidity(codeBlocks);

  // Calibrated thresholds (from H1 10K AI-vs-human spot checks):
  //   AI bigram entropy mean ~ 9.2 bits, human ~ 10.6 bits over similar length
  //   AI function-word rate mean ~ 11/k, human ~ 4/k
  // Lower entropy => higher AI score; higher fw rate => higher AI score.
  const entropyAiness = Math.max(0, Math.min(100, ((10.6 - entropy) / (10.6 - 9.0)) * 100));
  const fwAiness = Math.max(0, Math.min(100, ((functionWordRate - 4) / (12 - 4)) * 100));
  const syntaxPenalty = (1 - syntaxValidityScore) * 40; // bad code blocks are AI-tell

  const combinedScore = Math.max(0, Math.min(100,
    entropyAiness * 0.5 + fwAiness * 0.4 + syntaxPenalty * 0.1
  ));

  return { bigramEntropy: entropy, functionWordRate, syntaxValidityScore, combinedScore };
}

function computeSyntaxValidity(codeBlocks: { lang: string | null; body: string }[]): number {
  if (codeBlocks.length === 0) return 1;
  let totalScore = 0;
  for (const cb of codeBlocks) {
    const body = cb.body;
    if (body.length < 5) { totalScore += 0.5; continue; }
    const opens = (body.match(/[\(\[\{]/g) ?? []).length;
    const closes = (body.match(/[\)\]\}]/g) ?? []).length;
    const balance = opens === 0 && closes === 0 ? 1 :
      1 - Math.min(1, Math.abs(opens - closes) / Math.max(opens, closes, 1));
    // Has identifiers / not just prose
    const hasCodeShape = /[;{}=]|\bdef\b|\bfunction\b|\bclass\b|\breturn\b|\bif\b|\bfor\b|\bimport\b|\b#include\b|\$\s/.test(body);
    totalScore += balance * 0.7 + (hasCodeShape ? 0.3 : 0);
  }
  return totalScore / codeBlocks.length;
}
