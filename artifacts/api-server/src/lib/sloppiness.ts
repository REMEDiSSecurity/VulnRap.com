interface SlopAnalysis {
  score: number;
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
  const feedback: string[] = [];
  let penaltyPoints = 0;
  const maxPoints = 100;

  const lowerText = text.toLowerCase();
  const wordCount = text.split(/\s+/).length;

  if (wordCount < 30) {
    penaltyPoints += 25;
    feedback.push("Report is extremely short — less than 30 words. Meaningful vulnerability reports need detail.");
  } else if (wordCount < 100) {
    penaltyPoints += 10;
    feedback.push("Report is quite short. Consider adding more technical detail.");
  }

  if (wordCount > 5000) {
    penaltyPoints += 10;
    feedback.push("Report is unusually long. AI-generated reports tend to be verbose — concise reports with evidence are more credible.");
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
    penaltyPoints += 30;
    feedback.push(`Contains ${aiPhraseCount} common AI-generated phrases. This strongly suggests automated generation.`);
  } else if (aiPhraseCount >= 3) {
    penaltyPoints += 15;
    feedback.push(`Contains ${aiPhraseCount} phrases commonly seen in AI-generated text: "${foundPhrases.slice(0, 3).join('", "')}".`);
  } else if (aiPhraseCount >= 1) {
    penaltyPoints += 5;
    feedback.push(`Contains phrasing occasionally seen in AI output: "${foundPhrases[0]}".`);
  }

  if (!STRUCTURE_PATTERNS.hasVersion.test(text)) {
    penaltyPoints += 8;
    feedback.push("Missing specific software version. Reports without version info cannot be triaged effectively.");
  }

  if (!STRUCTURE_PATTERNS.hasComponent.test(text) && !STRUCTURE_PATTERNS.hasSpecificPath.test(text)) {
    penaltyPoints += 8;
    feedback.push("Missing affected component or file path. Specify the exact module, function, or endpoint.");
  }

  if (!STRUCTURE_PATTERNS.hasReproSteps.test(text)) {
    penaltyPoints += 10;
    feedback.push("No reproduction steps found. Include step-by-step instructions to recreate the issue.");
  }

  if (!STRUCTURE_PATTERNS.hasCodeBlock.test(text)) {
    penaltyPoints += 5;
    feedback.push("No code blocks or inline code detected. Include PoC code, commands, or payloads.");
  }

  if (!STRUCTURE_PATTERNS.hasAttackVector.test(text)) {
    penaltyPoints += 5;
    feedback.push("Missing attack vector classification (network, local, etc.) or CVE/CWE reference.");
  }

  if (!STRUCTURE_PATTERNS.hasImpact.test(text)) {
    penaltyPoints += 5;
    feedback.push("Missing impact assessment. Describe the severity and consequences of exploitation.");
  }

  if (!STRUCTURE_PATTERNS.hasExpectedBehavior.test(text) && !STRUCTURE_PATTERNS.hasObservedBehavior.test(text)) {
    penaltyPoints += 5;
    feedback.push("Missing expected vs. observed behavior comparison.");
  }

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 5) {
    const avgLength = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length;
    if (avgLength > 30) {
      penaltyPoints += 8;
      feedback.push("Sentences are unusually long on average — characteristic of AI-generated prose. Real reports tend to be terse and technical.");
    }
  }

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  if (paragraphs.length === 1 && wordCount > 200) {
    penaltyPoints += 5;
    feedback.push("Single wall of text — consider structuring with headers, lists, or paragraphs.");
  }

  const uniqueWords = new Set(lowerText.split(/\s+/));
  const uniqueRatio = uniqueWords.size / Math.max(wordCount, 1);
  if (uniqueRatio < 0.3 && wordCount > 100) {
    penaltyPoints += 10;
    feedback.push("Very repetitive language detected — low vocabulary diversity.");
  }

  const score = Math.min(maxPoints, Math.max(0, penaltyPoints));

  let tier: string;
  if (score >= 70) {
    tier = "Pure Slop";
  } else if (score >= 50) {
    tier = "Highly Suspicious";
  } else if (score >= 30) {
    tier = "Questionable";
  } else if (score >= 15) {
    tier = "Mildly Suspicious";
  } else {
    tier = "Probably Legit";
  }

  if (feedback.length === 0) {
    feedback.push("Report appears well-structured with specific technical details. Nice work.");
  }

  return { score, feedback, tier };
}
