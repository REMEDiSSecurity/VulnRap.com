export interface LinguisticResult {
  score: number;
  lexicalScore: number;
  statisticalScore: number;
  templateScore: number;
  evidence: LinguisticEvidence[];
}

export interface LinguisticEvidence {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

interface WeightedPhrase {
  phrase: string;
  weight: number;
}

const AI_PHRASES: WeightedPhrase[] = [
  { phrase: "it is important to note", weight: 6 },
  { phrase: "it's worth noting", weight: 5 },
  { phrase: "it should be noted", weight: 5 },
  { phrase: "it bears mentioning", weight: 7 },
  { phrase: "in conclusion", weight: 4 },
  { phrase: "as an ai", weight: 10 },
  { phrase: "as a language model", weight: 10 },
  { phrase: "i'd be happy to", weight: 9 },
  { phrase: "certainly!", weight: 5 },
  { phrase: "absolutely!", weight: 5 },
  { phrase: "here's a comprehensive", weight: 7 },
  { phrase: "it's crucial to", weight: 5 },
  { phrase: "delve into", weight: 8 },
  { phrase: "delve deeper", weight: 8 },
  { phrase: "deep dive", weight: 4 },
  { phrase: "tapestry", weight: 7 },
  { phrase: "multifaceted", weight: 6 },
  { phrase: "paramount", weight: 6 },
  { phrase: "in the realm of", weight: 7 },
  { phrase: "landscape of", weight: 5 },
  { phrase: "in today's digital landscape", weight: 8 },
  { phrase: "represents a significant", weight: 5 },
  { phrase: "comprehensive analysis", weight: 5 },
  { phrase: "thoroughly examined", weight: 5 },
  { phrase: "meticulous", weight: 5 },
  { phrase: "the implications of this", weight: 5 },
  { phrase: "holistic approach", weight: 6 },
  { phrase: "robust security", weight: 4 },
  { phrase: "proactive measures", weight: 5 },
  { phrase: "leveraging this vulnerability", weight: 6 },
  { phrase: "this vulnerability allows an attacker to", weight: 4 },
  { phrase: "this is a critical vulnerability", weight: 4 },
  { phrase: "underscores the importance", weight: 7 },
  { phrase: "cannot be overstated", weight: 7 },
  { phrase: "pivotal role", weight: 6 },
  { phrase: "game changer", weight: 5 },
  { phrase: "at the end of the day", weight: 4 },
  { phrase: "furthermore", weight: 3 },
  { phrase: "moreover", weight: 3 },
  { phrase: "in light of", weight: 4 },
  { phrase: "it is worth mentioning", weight: 6 },
  { phrase: "navigating the complexities", weight: 8 },
  { phrase: "a nuanced understanding", weight: 7 },
  { phrase: "foster a culture of", weight: 8 },
  { phrase: "shed light on", weight: 5 },
  { phrase: "spearhead", weight: 5 },
  { phrase: "pave the way", weight: 5 },
  { phrase: "strike the right balance", weight: 6 },
  { phrase: "elevate the discourse", weight: 8 },
  { phrase: "resonate with", weight: 5 },
  { phrase: "venture into", weight: 5 },
  { phrase: "embark on", weight: 5 },
];

const SLOP_TEMPLATES = [
  {
    name: "dear_security_team",
    patterns: [
      /dear\s+(?:security\s+team|sir\/madam|team|vulnerability\s+team)/i,
      /i\s+(?:am\s+writing|would\s+like)\s+to\s+(?:report|inform|notify|bring\s+to\s+your\s+attention)/i,
    ],
    weight: 12,
  },
  {
    name: "dependency_dump",
    patterns: [
      /(?:outdated|vulnerable)\s+dependenc(?:y|ies)/i,
      /npm\s+audit|snyk|dependabot/i,
    ],
    requiredCount: 2,
    weight: 10,
  },
  {
    name: "owasp_padding",
    patterns: [
      /owasp\s+top\s+(?:10|ten)/i,
      /(?:according\s+to|as\s+per|based\s+on)\s+owasp/i,
    ],
    weight: 8,
  },
  {
    name: "audit_checklist",
    patterns: [
      /security\s+(?:audit|assessment|review)\s+(?:report|findings)/i,
      /(?:finding|issue)\s+#?\d+\s*[:\.]/i,
    ],
    requiredCount: 2,
    weight: 8,
  },
  {
    name: "bounty_template",
    patterns: [
      /(?:vulnerability\s+type|severity|impact|steps\s+to\s+reproduce|remediation|recommendation)\s*[:]/i,
    ],
    minMatches: 3,
    weight: 6,
  },
  {
    name: "generic_remediation",
    patterns: [
      /(?:it\s+is\s+(?:recommended|advised)|we\s+recommend|the\s+(?:fix|solution|remediation)\s+is)\s+to/i,
      /(?:implement|ensure|enforce)\s+(?:proper|adequate|robust)\s+(?:input\s+validation|authentication|authorization|sanitization)/i,
    ],
    weight: 7,
  },
];

function analyzeLexicalMarkers(text: string): { score: number; evidence: LinguisticEvidence[] } {
  const lowerText = text.toLowerCase();
  const evidence: LinguisticEvidence[] = [];
  let totalWeight = 0;

  for (const { phrase, weight } of AI_PHRASES) {
    const idx = lowerText.indexOf(phrase);
    if (idx !== -1) {
      totalWeight += weight;
      evidence.push({
        type: "ai_phrase",
        description: `AI-characteristic phrase detected`,
        weight,
        matched: phrase,
      });
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzeStatisticalFeatures(text: string): { score: number; evidence: LinguisticEvidence[] } {
  const evidence: LinguisticEvidence[] = [];
  const featureScores: { score: number; weight: number }[] = [];

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length >= 5) {
    const lengths = sentences.map(s => s.trim().split(/\s+/).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, l) => a + (l - mean) ** 2, 0) / lengths.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;

    if (cv < 0.25) {
      const uniformScore = Math.round(Math.min(100, (0.25 - cv) * 400));
      featureScores.push({ score: uniformScore, weight: 0.15 });
      evidence.push({
        type: "sentence_uniformity",
        description: `Unusually uniform sentence lengths (CV=${cv.toFixed(2)}) — AI text tends to produce regular-length sentences`,
        weight: Math.round(uniformScore / 10),
      });
    } else {
      featureScores.push({ score: 0, weight: 0.15 });
    }

    let cvScore: number;
    if (cv < 0.3) cvScore = 70;
    else if (cv < 0.5) cvScore = 45;
    else if (cv < 0.7) cvScore = 15;
    else cvScore = 5;
    featureScores.push({ score: cvScore, weight: 0.20 });
    if (cvScore >= 40) {
      evidence.push({
        type: "low_sentence_cv",
        description: `Low sentence length variation (CV=${cv.toFixed(2)}) — human text has burstier sentence lengths`,
        weight: Math.round(cvScore / 10),
      });
    }
  }

  const passivePatterns = [
    /\b(?:is|are|was|were|been|being)\s+(?:\w+ed|known|found|seen|given|made|done|shown|taken|used)\b/gi,
    /\b(?:has|have|had)\s+been\s+\w+ed\b/gi,
  ];
  const wordCount = text.split(/\s+/).length;
  let passiveCount = 0;
  for (const pattern of passivePatterns) {
    const matches = text.match(pattern);
    passiveCount += matches ? matches.length : 0;
  }
  const passiveRatio = wordCount > 0 ? passiveCount / (wordCount / 20) : 0;
  if (passiveRatio > 0.3) {
    const passiveScore = Math.round(Math.min(100, (passiveRatio - 0.3) * 143));
    featureScores.push({ score: passiveScore, weight: 0.15 });
    evidence.push({
      type: "passive_voice",
      description: `High passive voice usage (${(passiveRatio * 100).toFixed(0)}% of clauses) — AI-generated text overuses passive constructions`,
      weight: Math.round(passiveScore / 10),
    });
  } else {
    featureScores.push({ score: 0, weight: 0.15 });
  }

  const contractionPatterns = /\b(?:don't|won't|can't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|doesn't|didn't|couldn't|wouldn't|shouldn't|it's|i'm|i've|i'll|we're|we've|they're|they've|that's|there's|here's|what's|who's|let's|ain't)\b/gi;
  const contractionMatches = text.match(contractionPatterns);
  const contractionCount = contractionMatches ? contractionMatches.length : 0;
  const formalWords = text.match(/\b(?:cannot|will not|do not|is not|are not|was not|were not|has not|have not|does not|did not|could not|would not|should not|it is|I am|I have|I will|we are|we have|they are|they have|that is|there is|here is|what is|who is|let us)\b/gi);
  const formalCount = formalWords ? formalWords.length : 0;

  if (wordCount > 100 && contractionCount === 0 && formalCount >= 3) {
    const formalityScore = Math.min(100, formalCount * 15);
    featureScores.push({ score: formalityScore, weight: 0.15 });
    evidence.push({
      type: "no_contractions",
      description: `Zero contractions with ${formalCount} formal expansions — AI models avoid contractions in formal text`,
      weight: Math.round(formalityScore / 10),
    });
  } else {
    featureScores.push({ score: 0, weight: 0.15 });
  }

  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length >= 50) {
    const bigrams: Map<string, number> = new Map();
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`;
      bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    const total = words.length - 1;
    let entropy = 0;
    for (const count of bigrams.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    const maxEntropy = Math.log2(total);
    const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 1;

    if (normalizedEntropy < 0.85) {
      const entropyScore = Math.round(Math.min(100, (0.85 - normalizedEntropy) * 300));
      featureScores.push({ score: entropyScore, weight: 0.10 });
      evidence.push({
        type: "low_entropy",
        description: `Low bigram entropy (${normalizedEntropy.toFixed(2)}) — repetitive phrasing patterns typical of AI generation`,
        weight: Math.round(entropyScore / 10),
      });
    } else {
      featureScores.push({ score: 0, weight: 0.10 });
    }

    let bigramEntropyScore: number;
    if (normalizedEntropy < 0.88) bigramEntropyScore = 60;
    else if (normalizedEntropy < 0.92) bigramEntropyScore = 35;
    else if (normalizedEntropy < 0.95) bigramEntropyScore = 15;
    else bigramEntropyScore = 5;
    featureScores.push({ score: bigramEntropyScore, weight: 0.20 });
    if (bigramEntropyScore >= 30) {
      evidence.push({
        type: "bigram_entropy_low",
        description: `Bigram entropy ${normalizedEntropy.toFixed(3)} falls in AI-typical range — human text has higher lexical diversity`,
        weight: Math.round(bigramEntropyScore / 10),
      });
    }
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (const { score, weight } of featureScores) {
    weightedSum += score * weight;
    totalWeight += weight;
  }
  const avgScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return { score: avgScore, evidence };
}

function analyzeTemplates(text: string): { score: number; evidence: LinguisticEvidence[] } {
  const evidence: LinguisticEvidence[] = [];
  let maxScore = 0;

  for (const template of SLOP_TEMPLATES) {
    let matchCount = 0;
    for (const pattern of template.patterns) {
      if (pattern.test(text)) {
        matchCount++;
      }
    }

    const needed = template.requiredCount || template.minMatches || 1;
    if (matchCount >= needed) {
      const templateScore = Math.min(100, template.weight * 10);
      maxScore = Math.max(maxScore, templateScore);
      evidence.push({
        type: "template_match",
        description: `Matches "${template.name.replace(/_/g, " ")}" slop template pattern`,
        weight: template.weight,
        matched: template.name,
      });
    }
  }

  return { score: maxScore, evidence };
}

export function analyzeLinguistic(text: string): LinguisticResult {
  const lexical = analyzeLexicalMarkers(text);
  const statistical = analyzeStatisticalFeatures(text);
  const templates = analyzeTemplates(text);

  const combinedScore = Math.min(100, Math.round(
    lexical.score * 0.40 +
    statistical.score * 0.35 +
    templates.score * 0.25
  ));

  return {
    score: combinedScore,
    lexicalScore: lexical.score,
    statisticalScore: statistical.score,
    templateScore: templates.score,
    evidence: [...lexical.evidence, ...statistical.evidence, ...templates.evidence],
  };
}
