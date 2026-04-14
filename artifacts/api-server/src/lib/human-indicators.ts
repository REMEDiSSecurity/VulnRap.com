export interface HumanIndicator {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

export interface HumanIndicatorResult {
  indicators: HumanIndicator[];
  totalReduction: number;
}

const INFORMAL_ABBREVIATIONS = [
  "btw", "fwiw", "iirc", "afaik", "imo", "imho", "tbh", "fyi",
  "tldr", "tl;dr", "ymmv", "afaict", "idk", "ngl", "iiuc",
  "wrt", "w/", "w/o", "gonna", "wanna", "gotta", "kinda", "sorta",
];

const CONTRACTION_PATTERN = /\b(?:don't|won't|can't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|doesn't|didn't|couldn't|wouldn't|shouldn't|it's|i'm|i've|i'll|we're|we've|they're|they've|that's|there's|here's|what's|who's|let's|ain't|y'all|he's|she's|you're|you've|you'll|we'll|they'll|might've|should've|would've|could've|must've|who've|who'll|that'll)\b/gi;

const COMMIT_PR_PATTERN = /(?:commit\s+[0-9a-f]{7,40}|(?:pull\s+request|pr|merge\s+request|mr)\s*#?\d+|[0-9a-f]{7,40}(?:\s*\.{2,3}\s*[0-9a-f]{7,40})?|github\.com\/[\w\-]+\/[\w\-.]+\/(?:commit|pull|issues)\/[\w\d]+)/gi;

const PATCHED_VERSION_PATTERN = /(?:(?:fixed|patched|resolved|backported)\s+(?:in|by|as\s+of|starting\s+from)\s+(?:v(?:ersion)?\s*)?\d+\.\d+|(?:v(?:ersion)?\s*)?\d+\.\d+(?:\.\d+)?\s+(?:fixes|patches|resolves|addresses)\s+this)/gi;

const NAMED_RESEARCHER_PATTERN = /\b(?:reported\s+by|discovered\s+by|found\s+by|credited?\s+to|researcher[:\s]+|author[:\s]+)\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g;

const AI_PLEASANTRIES = [
  /dear\s+(?:security\s+team|sir\/madam|team|vulnerability\s+team|security\s+researcher)/i,
  /(?:best\s+regards|kind\s+regards|sincerely|respectfully\s+submitted|warm\s+regards)/i,
  /(?:i\s+hope\s+this\s+(?:finds\s+you\s+well|message\s+finds|email\s+finds|report\s+finds))/i,
  /(?:thank\s+you\s+for\s+(?:your\s+time|taking\s+the\s+time|reading|considering|your\s+attention))/i,
  /(?:i\s+would\s+(?:like\s+to|be\s+happy\s+to)\s+(?:report|inform|notify|discuss))/i,
];

export function detectHumanIndicators(text: string): HumanIndicatorResult {
  const indicators: HumanIndicator[] = [];
  const lowerText = text.toLowerCase();
  const words = text.split(/\s+/);
  const wordCount = words.length;

  const contractionMatches = text.match(CONTRACTION_PATTERN);
  const contractionCount = contractionMatches ? contractionMatches.length : 0;
  if (contractionCount >= 2) {
    indicators.push({
      type: "human_contractions",
      description: `${contractionCount} contractions detected (${contractionMatches!.slice(0, 3).join(", ")}${contractionCount > 3 ? "..." : ""}) — natural writing style`,
      weight: -5,
      matched: contractionMatches!.slice(0, 3).join(", "),
    });
  }

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  if (sentences.length >= 3) {
    const avgSentenceLength = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length;
    if (avgSentenceLength <= 15 && wordCount >= 50) {
      indicators.push({
        type: "human_terse_style",
        description: `Terse, direct writing style (avg ${avgSentenceLength.toFixed(1)} words/sentence) — characteristic of experienced practitioners`,
        weight: -4,
      });
    }
  }

  const foundAbbreviations: string[] = [];
  for (const abbr of INFORMAL_ABBREVIATIONS) {
    const abbrPattern = new RegExp(`\\b${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (abbrPattern.test(lowerText)) {
      foundAbbreviations.push(abbr);
    }
  }
  if (foundAbbreviations.length >= 1) {
    indicators.push({
      type: "human_informal_language",
      description: `Informal abbreviation${foundAbbreviations.length > 1 ? "s" : ""} detected (${foundAbbreviations.slice(0, 3).join(", ")}) — AI models rarely use these in formal reports`,
      weight: -4,
      matched: foundAbbreviations.slice(0, 3).join(", "),
    });
  }

  const researcherMatches = text.match(NAMED_RESEARCHER_PATTERN);
  if (researcherMatches && researcherMatches.length >= 1) {
    indicators.push({
      type: "human_named_researcher",
      description: `Named researcher credited (${researcherMatches[0].trim().slice(0, 60)}) — AI reports rarely attribute discoveries to specific individuals`,
      weight: -3,
      matched: researcherMatches[0].trim().slice(0, 60),
    });
  }

  const commitMatches = text.match(COMMIT_PR_PATTERN);
  if (commitMatches && commitMatches.length >= 1) {
    indicators.push({
      type: "human_commit_refs",
      description: `Real commit/PR reference${commitMatches.length > 1 ? "s" : ""} detected (${commitMatches.slice(0, 2).join(", ").slice(0, 80)}) — indicates actual repository research`,
      weight: -6,
      matched: commitMatches[0].slice(0, 60),
    });
  }

  const patchedMatches = text.match(PATCHED_VERSION_PATTERN);
  if (patchedMatches && patchedMatches.length >= 1) {
    indicators.push({
      type: "human_patched_version",
      description: `Specific patched version reference (${patchedMatches[0].trim().slice(0, 60)}) — demonstrates knowledge of fix timeline`,
      weight: -3,
      matched: patchedMatches[0].trim().slice(0, 60),
    });
  }

  const preRedactedCount = (text.match(/\[REDACTED\]|\[REMOVED\]|\[CENSORED\]|\[MASKED\]|\[HIDDEN\]/gi) || []).length;
  if (preRedactedCount > 0) {
    indicators.push({
      type: "human_pre_redaction",
      description: `Reporter pre-redacted ${preRedactedCount} sensitive value(s) before submission — indicates awareness of operational security`,
      weight: -5 * Math.min(preRedactedCount, 3),
      matched: `${preRedactedCount} placeholder(s)`,
    });
  }

  let hasPleasantries = false;
  for (const pattern of AI_PLEASANTRIES) {
    if (pattern.test(text)) {
      hasPleasantries = true;
      break;
    }
  }
  if (!hasPleasantries && wordCount >= 100) {
    indicators.push({
      type: "human_no_pleasantries",
      description: "No AI-style pleasantries or formulaic openers/closers — advisory-format writing",
      weight: -3,
    });
  }

  const baseReduction = indicators.reduce((sum, ind) => sum + ind.weight, 0);

  const compoundMultipliers = [1.0, 1.0, 1.3, 1.7, 2.2, 2.5, 2.8];
  const multiplier = indicators.length < compoundMultipliers.length
    ? compoundMultipliers[indicators.length]
    : 3.0;

  const totalReduction = Math.round(baseReduction * multiplier);

  return {
    indicators,
    totalReduction,
  };
}
