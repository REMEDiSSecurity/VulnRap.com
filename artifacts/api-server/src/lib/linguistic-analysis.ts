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

interface SycophraticPattern {
  pattern: RegExp;
  weight: number;
  type: string;
}

const SYCOPHANTIC_PHRASES: SycophraticPattern[] = [
  { pattern: /I\s+(?:sincerely\s+)?apologize\s+for/i, weight: 10, type: "ai_apology" },
  { pattern: /I\s+hope\s+this\s+(?:helps|message\s+finds)/i, weight: 12, type: "ai_pleasantry" },
  { pattern: /(?:Certainly|Absolutely)!\s+(?:Let\s+me|I'll)/i, weight: 15, type: "ai_eager_response" },
  { pattern: /Thank\s+you\s+for\s+your\s+(?:dedication|time|attention)/i, weight: 8, type: "ai_gratitude" },
  { pattern: /(?:best|kind)\s+regards,?\s*\n\s*Security\s+Researcher/i, weight: 10, type: "ai_sign_off" },
  { pattern: /I\s+(?:would\s+be|am)\s+happy\s+to\s+provide/i, weight: 8, type: "ai_offer" },
  { pattern: /upon\s+further\s+(?:analysis|investigation|review)/i, weight: 8, type: "ai_hedge" },
  { pattern: /my\s+(?:advanced|sophisticated)\s+(?:security\s+)?tools/i, weight: 12, type: "ai_self_aggrandize" },
  { pattern: /maintain\s+a\s+(?:better|good)\s+relationship/i, weight: 10, type: "ai_relationship" },
  { pattern: /(?:Dear|Hello)\s+Security\s+Team/i, weight: 6, type: "ai_formal_greeting" },
  { pattern: /as\s+(?:a\s+)?(?:senior|experienced)\s+(?:security|penetration)/i, weight: 8, type: "ai_credential_claim" },
  { pattern: /during\s+my\s+(?:routine|comprehensive|thorough)\s+(?:security\s+)?(?:research|audit|assessment)/i, weight: 10, type: "ai_routine_claim" },
  { pattern: /(?:As\s+per|According\s+to)\s+CWE-\d+/i, weight: 5, type: "ai_cwe_textbook" },
  { pattern: /represents?\s+a\s+significant\s+security\s+(?:debt|risk|concern)/i, weight: 5, type: "ai_boilerplate" },
  { pattern: /widely\s+known\s+in\s+the\s+security\s+community/i, weight: 6, type: "ai_appeal_authority" },
  { pattern: /please\s+(?:don't\s+hesitate|feel\s+free)\s+to\s+(?:reach\s+out|contact)/i, weight: 6, type: "ai_closing" },
  { pattern: /this\s+(?:could|can)\s+(?:potentially\s+)?(?:lead\s+to|result\s+in|allow|enable)\s+(?:unauthorized|complete|full)/i, weight: 8, type: "ai_impact_inflation" },
  { pattern: /an?\s+(?:malicious\s+)?attacker\s+(?:could|can|may)\s+(?:potentially\s+)?(?:exploit|leverage|abuse|take\s+advantage)/i, weight: 7, type: "ai_attacker_could" },
  { pattern: /(?:I|we)\s+(?:strongly\s+)?recommend\s+(?:implementing|adopting|using)/i, weight: 6, type: "ai_recommend" },
  { pattern: /it\s+is\s+(?:highly\s+)?(?:recommended|advised|suggested)\s+(?:to|that)/i, weight: 7, type: "ai_passive_recommend" },
  { pattern: /(?:ensure|make\s+sure)\s+that\s+(?:all|proper|adequate|appropriate)/i, weight: 6, type: "ai_ensure_proper" },
  { pattern: /(?:critical|significant|severe)\s+(?:security\s+)?(?:vulnerability|flaw|weakness|issue)/i, weight: 4, type: "ai_severity_inflation" },
  { pattern: /(?:compromise|impact)\s+the\s+(?:entire|whole|complete)\s+(?:system|application|infrastructure)/i, weight: 7, type: "ai_total_compromise" },
  { pattern: /with\s+over\s+\d+\s+years?\s+of\s+experience/i, weight: 8, type: "ai_years_experience" },
  { pattern: /i\s+(?:have\s+)?discovered\s+a\s+critical/i, weight: 5, type: "ai_discovered_critical" },
  { pattern: /using\s+(?:industry-leading|advanced|comprehensive|cutting-edge)\s+(?:tools|methodologies|techniques)/i, weight: 10, type: "ai_industry_tools" },
  { pattern: /i\s+look\s+forward\s+to\s+hearing\s+from/i, weight: 8, type: "ai_look_forward" },
  { pattern: /i\s+am\s+a\s+(?:certified|professional)\s+(?:security|penetration|ethical)/i, weight: 8, type: "ai_certified_claim" },
  { pattern: /during\s+(?:a\s+)?(?:recent\s+)?(?:security\s+)?(?:engagement|assessment|penetration\s+test)/i, weight: 6, type: "ai_engagement_claim" },
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
      /vulnerability\s+type\s*:/i,
      /severity\s*:/i,
      /impact\s*:/i,
      /steps\s+to\s+reproduce\s*:/i,
      /remediation\s*:/i,
      /recommendation\s*:/i,
      /proof\s+of\s+concept\s*:/i,
      /affected\s+(?:url|component|endpoint)\s*:/i,
      /attack\s+vector\s*:/i,
      /privileges\s+required\s*:/i,
    ],
    minMatches: 3,
    weight: 8,
  },
  {
    name: "formal_letter",
    patterns: [
      /dear\s+(?:security\s+team|sir\/madam|team|vulnerability\s+team)/i,
      /(?:best|kind)\s+regards/i,
      /i\s+hope\s+this\s+(?:message|report|finding)\s+finds\s+you/i,
      /thank\s+you\s+for\s+your\s+time\s+and\s+attention/i,
      /i\s+look\s+forward\s+to\s+hearing/i,
    ],
    minMatches: 2,
    weight: 14,
  },
  {
    name: "full_template_headers",
    patterns: [
      /vulnerability\s+type\s*:/i,
      /severity\s*:/i,
      /cvss\s+score\s*:/i,
      /description\s*:/i,
      /impact\s*:/i,
      /remediation\s*:/i,
    ],
    minMatches: 5,
    weight: 15,
  },
  {
    name: "generic_sqli_template",
    patterns: [
      /(?:sql\s+injection|sqli)/i,
      /['"]?\s*OR\s+['"]?1['"]?\s*=\s*['"]?1/i,
      /(?:expected\s+behavior|actual\s+behavior)\s*:/i,
    ],
    minMatches: 3,
    weight: 14,
  },
  {
    name: "generic_remediation",
    patterns: [
      /(?:it\s+is\s+(?:recommended|advised)|we\s+recommend|the\s+(?:fix|solution|remediation)\s+is)\s+to/i,
      /(?:implement|ensure|enforce)\s+(?:proper|adequate|robust)\s+(?:input\s+validation|authentication|authorization|sanitization)/i,
    ],
    weight: 7,
  },
  {
    name: "executive_summary_template",
    patterns: [
      /executive\s+summary\s*:/i,
      /detailed\s+description\s*:/i,
    ],
    requiredCount: 2,
    weight: 10,
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

  let sycophraticWeight = 0;
  let sycophraticCount = 0;
  for (const sp of SYCOPHANTIC_PHRASES) {
    const matches = text.match(sp.pattern);
    if (matches) {
      sycophraticCount++;
      sycophraticWeight += sp.weight;
      evidence.push({
        type: sp.type,
        description: `AI-characteristic phrase detected: "${matches[0]}"`,
        weight: sp.weight,
        matched: matches[0],
      });
    }
  }

  const COMPOUND_MULTIPLIERS = [1.0, 1.0, 1.3, 1.7, 2.2, 2.5, 2.8, 3.0];
  const multiplier = sycophraticCount < COMPOUND_MULTIPLIERS.length
    ? COMPOUND_MULTIPLIERS[sycophraticCount] : 3.0;
  const compoundedSycophratic = Math.round(sycophraticWeight * multiplier);

  totalWeight += compoundedSycophratic;

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
  let totalWeight = 0;

  for (const template of SLOP_TEMPLATES) {
    let matchCount = 0;
    for (const pattern of template.patterns) {
      if (pattern.test(text)) {
        matchCount++;
      }
    }

    const needed = template.requiredCount || template.minMatches || 1;
    if (matchCount >= needed) {
      totalWeight += template.weight;
      evidence.push({
        type: "template_match",
        description: `Matches "${template.name.replace(/_/g, " ")}" slop template pattern`,
        weight: template.weight,
        matched: template.name,
      });
    }
  }

  const score = Math.min(100, Math.round(totalWeight * 5));
  return { score, evidence };
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
