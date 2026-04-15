interface SlopAnalysis {
  score: number;
  qualityScore: number;
  slopSignals: string[];
  qualityFeedback: string[];
  feedback: string[];
  tier: string;
}

const AI_PHRASES = [
  "it is important to note",
  "it's worth noting",
  "it should be noted",
  "in conclusion",
  "as an ai",
  "as a language model",
  "i'd be happy to",
  "certainly!",
  "absolutely!",
  "here's a comprehensive",
  "it's crucial to",
  "this vulnerability allows an attacker to",
  "this is a critical vulnerability",
  "delve into",
  "tapestry",
  "multifaceted",
  "paramount",
  "in the realm of",
  "landscape of",
  "leveraging this vulnerability",
  "in today's digital landscape",
  "represents a significant",
  "comprehensive analysis",
  "thoroughly examined",
  "meticulous",
  "it bears mentioning",
  "the implications of this",
  "holistic approach",
  "robust security",
  "proactive measures",
];

const STRUCTURE_PATTERNS = {
  hasVersion: /(?:version|v)\s*[0-9]+\.[0-9]+/i,
  hasComponent: /(?:component|package|library|module|function|endpoint|file|class)\s*[:=\-]\s*\S+/i,
  hasReproSteps: /(?:step[s]?\s*(?:to\s*)?reproduce|reproduction|poc|proof\s*of\s*concept|how\s*to\s*reproduce)/i,
  hasCodeBlock: /```[\s\S]*?```|`[^`]+`/,
  hasAttackVector: /(?:attack\s*vector|cvss|cwe-?\d+|cve-?\d{4}-?\d+|remote|local|network|adjacent)/i,
  hasImpact: /(?:impact|severity|consequence|risk|damage|confidentiality|integrity|availability)/i,
  hasPreconditions: /(?:precondition|prerequisite|requirement|assumes|requires|must\s*be|needs\s*to\s*be)/i,
  hasExpectedBehavior: /(?:expected\s*(?:behavior|behaviour|result)|should\s*(?:return|respond|show|display))/i,
  hasObservedBehavior: /(?:observed|actual|instead|but\s*(?:it|the)|however|unexpectedly)/i,
  hasHttpDetails: /(?:GET|POST|PUT|DELETE|PATCH|HTTP\/|status\s*code|header|cookie|request|response)\s/,
  hasSpecificPath: /(?:\/[\w\-\.\/]+\.\w{1,5}|\/api\/|\/src\/|\/lib\/|\/bin\/)/,
};

export function analyzeSloppiness(text: string): SlopAnalysis {
  const slopSignals: string[] = [];
  const qualityFeedback: string[] = [];
  let slopPoints = 0;
  let qualityPenalty = 0;

  const lowerText = text.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  if (wordCount < 30) {
    qualityPenalty += 25;
    qualityFeedback.push("Report is extremely short — less than 30 words. Meaningful vulnerability reports need detail.");
  } else if (wordCount < 100) {
    qualityPenalty += 10;
    qualityFeedback.push("Report is quite short. Consider adding more technical detail.");
  }

  if (wordCount > 5000) {
    slopPoints += 10;
    slopSignals.push("Report is unusually long. AI-generated reports tend to be verbose — concise reports with evidence are more credible.");
  }

  let aiPhraseCount = 0;
  const foundPhrases: string[] = [];
  for (const phrase of AI_PHRASES) {
    if (lowerText.includes(phrase)) {
      aiPhraseCount++;
      foundPhrases.push(phrase);
    }
  }

  if (aiPhraseCount >= 5) {
    slopPoints += 30;
    slopSignals.push(`Contains ${aiPhraseCount} common AI-generated phrases. This strongly suggests automated generation.`);
  } else if (aiPhraseCount >= 3) {
    slopPoints += 15;
    slopSignals.push(`Contains ${aiPhraseCount} phrases commonly seen in AI-generated text: "${foundPhrases.slice(0, 3).join('", "')}".`);
  } else if (aiPhraseCount >= 1) {
    slopPoints += 5;
    slopSignals.push(`Contains phrasing occasionally seen in AI output: "${foundPhrases[0]}".`);
  }

  if (!STRUCTURE_PATTERNS.hasVersion.test(text)) {
    qualityPenalty += 8;
    qualityFeedback.push("Missing specific software version. Reports without version info cannot be triaged effectively.");
  }

  if (!STRUCTURE_PATTERNS.hasComponent.test(text) && !STRUCTURE_PATTERNS.hasSpecificPath.test(text)) {
    qualityPenalty += 8;
    qualityFeedback.push("Missing affected component or file path. Specify the exact module, function, or endpoint.");
  }

  if (!STRUCTURE_PATTERNS.hasReproSteps.test(text)) {
    qualityPenalty += 10;
    qualityFeedback.push("No reproduction steps found. Include step-by-step instructions to recreate the issue.");
  }

  if (!STRUCTURE_PATTERNS.hasCodeBlock.test(text)) {
    qualityPenalty += 5;
    qualityFeedback.push("No code blocks or inline code detected. Include PoC code, commands, or payloads.");
  }

  if (!STRUCTURE_PATTERNS.hasAttackVector.test(text)) {
    qualityPenalty += 5;
    qualityFeedback.push("Missing attack vector classification (network, local, etc.) or CVE/CWE reference.");
  }

  if (!STRUCTURE_PATTERNS.hasImpact.test(text)) {
    qualityPenalty += 5;
    qualityFeedback.push("Missing impact assessment. Describe the severity and consequences of exploitation.");
  }

  if (!STRUCTURE_PATTERNS.hasExpectedBehavior.test(text) && !STRUCTURE_PATTERNS.hasObservedBehavior.test(text)) {
    qualityPenalty += 5;
    qualityFeedback.push("Missing expected vs. observed behavior comparison.");
  }

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 5) {
    const avgLength = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length;
    if (avgLength > 30) {
      slopPoints += 8;
      slopSignals.push("Sentences are unusually long on average — characteristic of AI-generated prose. Real reports tend to be terse and technical.");
    }
  }

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  if (paragraphs.length === 1 && wordCount > 200) {
    qualityPenalty += 5;
    qualityFeedback.push("Single wall of text — consider structuring with headers, lists, or paragraphs.");
  }

  const uniqueWords = new Set(lowerText.split(/\s+/));
  const uniqueRatio = uniqueWords.size / Math.max(wordCount, 1);
  if (uniqueRatio < 0.3 && wordCount > 100) {
    slopPoints += 10;
    slopSignals.push("Very repetitive language detected — low vocabulary diversity.");
  }

  const slopScore = Math.min(100, Math.max(0, slopPoints));
  const qualityScore = Math.min(100, Math.max(0, 100 - qualityPenalty));

  const allFeedback = [...slopSignals, ...qualityFeedback];

  let tier: string;
  if (slopScore >= 80) {
    tier = "Slop";
  } else if (slopScore >= 60) {
    tier = "Likely Slop";
  } else if (slopScore >= 40) {
    tier = "Questionable";
  } else if (slopScore >= 20) {
    tier = "Likely Human";
  } else {
    tier = "Clean";
  }

  if (allFeedback.length === 0) {
    allFeedback.push("Report appears well-structured with specific technical details. Nice work.");
  }

  return {
    score: slopScore,
    qualityScore,
    slopSignals,
    qualityFeedback,
    feedback: allFeedback,
    tier,
  };
}
