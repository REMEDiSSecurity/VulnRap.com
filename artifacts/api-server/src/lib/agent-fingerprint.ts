// Cross-AI-agent fingerprint detector (Task #644).
//
// Different AI agents leave different stylistic fingerprints in the prose
// they produce. This detector classifies which agent (or "human") most
// likely wrote a report body. It is INTENTIONALLY a "likely fingerprint"
// signal — we never hard-claim attribution. The output is one of seven
// labels plus a 0..1 confidence, and is surfaced as an evidence signal
// on the diagnostics panel.
//
// The signals are all cheap regex / counting heuristics so this can run
// inline in the /reports/:id/diagnostics handler without any LLM call:
//
//   - GPT-4 / ChatGPT: pleasantry openings ("Certainly!", "Of course!"),
//     "I'd be happy to", em-dash–heavy prose, bold-led list items
//     ("**Summary:**"), "let's dive into", "in conclusion".
//   - Claude:           "I'll help", "Here's what I found", "I notice",
//     long em-dash clauses, "It's worth noting", "Let me walk you
//     through", measured / verbose paragraphs.
//   - Gemini:           "Of course. Here is", "Sure! Here's a", "Crucially,",
//     "**Important:**", aggressive bulleting, "It is paramount".
//   - Cursor agent:     "I've added", "I'll edit", "Let me check the
//     file", "Now I'll", inline file paths in backticks, "the diff",
//     code-first phrasing.
//   - Replit agent:     "I've created", references to "Replit", "the
//     workflow", "the Run button", "Repl", "the preview pane",
//     "checkpoint".
//   - Human:            contractions, informal abbreviations (btw, iirc,
//     imo), commit hashes, "fwiw", typos / lowercase sentence starts,
//     named-researcher credit lines.
//
// The detector returns the per-agent raw scores so a future caller (or
// the diagnostics-panel UI) can render the runner-up as an
// "ambiguous" disambiguation. When no agent's score clears a small
// minimum, the verdict is "unknown" (avoiding overclaiming on short or
// generic prose).

export type AgentLabel =
  | "gpt4"
  | "claude"
  | "gemini"
  | "cursor-agent"
  | "replit-agent"
  | "human"
  | "unknown";

export interface AgentFingerprintMatch {
  /** Stable id for the rule that fired. */
  id: string;
  /** Human-readable description for the diagnostics panel. */
  description: string;
  /** Points the rule contributed to its agent's score. */
  weight: number;
  /** First excerpt from the report that matched (lowercased, capped). */
  excerpt?: string;
}

export interface AgentFingerprintResult {
  likelyAgent: AgentLabel;
  /** 0..1 confidence in the top label. */
  confidence: number;
  /** Raw points per candidate label (for tie-break / runner-up display). */
  scores: Record<Exclude<AgentLabel, "unknown">, number>;
  /** All rules that fired, grouped by the agent they voted for. */
  matches: AgentFingerprintMatch[];
  /** Lightweight stylometric features used to inform the verdict. */
  features: {
    wordCount: number;
    sentenceCount: number;
    avgSentenceLen: number;
    emDashCount: number;
    boldHeaderCount: number;
    bulletCount: number;
  };
}

interface PhraseRule {
  id: string;
  agent: Exclude<AgentLabel, "unknown">;
  pattern: RegExp;
  weight: number;
  description: string;
}

const RULES: PhraseRule[] = [
  // GPT-4 / ChatGPT pleasantry & framing tells
  { id: "gpt4_certainly_opening", agent: "gpt4", weight: 5, description: "Pleasantry opener (\"Certainly!\")", pattern: /(^|[\n.!?]\s+)certainly[!,.](?:\s|$)/i },
  { id: "gpt4_of_course", agent: "gpt4", weight: 4, description: "\"Of course!\" opener", pattern: /(^|[\n.!?]\s+)of course[!,.](?:\s|$)/i },
  { id: "gpt4_id_be_happy", agent: "gpt4", weight: 5, description: "\"I'd be happy to\" / \"I would be happy to\"", pattern: /\bi(?:'d| would)\s+be\s+happy\s+to\b/i },
  { id: "gpt4_lets_dive_into", agent: "gpt4", weight: 4, description: "\"Let's dive into\"", pattern: /\blet'?s\s+dive\s+(?:in|into)\b/i },
  { id: "gpt4_in_conclusion", agent: "gpt4", weight: 3, description: "\"In conclusion,\"", pattern: /(^|[\n.!?]\s+)in conclusion[,:]/i },
  { id: "gpt4_to_summarize", agent: "gpt4", weight: 2, description: "\"To summarize,\"", pattern: /(^|[\n.!?]\s+)to summarize[,:]/i },
  { id: "gpt4_remember_that", agent: "gpt4", weight: 2, description: "\"Remember that\" sermon tell", pattern: /\bremember\s+that\b/i },

  // Claude tells
  { id: "claude_ill_help", agent: "claude", weight: 4, description: "\"I'll help\" opener", pattern: /\bi'?ll\s+help\s+(?:you\s+)?(?:with|understand|investigate|analy[sz]e|walk)\b/i },
  { id: "claude_heres_what", agent: "claude", weight: 4, description: "\"Here's what I found / I'll do\"", pattern: /\bhere'?s\s+what\s+i(?:'?ll|'?ve|\s+(?:found|did|see|noticed))\b/i },
  { id: "claude_i_notice", agent: "claude", weight: 3, description: "\"I notice\" observation tell", pattern: /\bi\s+notice\s+(?:that|a|the|some)\b/i },
  { id: "claude_walk_you_through", agent: "claude", weight: 5, description: "\"Let me walk you through\"", pattern: /\blet\s+me\s+walk\s+you\s+through\b/i },
  { id: "claude_worth_noting", agent: "claude", weight: 3, description: "\"It's worth noting\"", pattern: /\bit'?s\s+worth\s+noting\b/i },
  { id: "claude_to_be_clear", agent: "claude", weight: 2, description: "\"To be clear,\" qualifier", pattern: /(^|[\n.!?]\s+)to be clear[,:]/i },
  { id: "claude_thoughtful_hedging", agent: "claude", weight: 2, description: "\"It seems\" / \"appears to be\" hedging cluster", pattern: /\b(?:it\s+(?:seems|appears)|appears\s+to\s+be)\b/i },

  // Gemini tells
  { id: "gemini_of_course_here_is", agent: "gemini", weight: 6, description: "\"Of course. Here is\" / \"Sure! Here's\"", pattern: /(^|[\n.!?]\s+)(?:of course\.\s+here\s+is|sure[!,.]\s+here'?s)\b/i },
  { id: "gemini_crucially", agent: "gemini", weight: 4, description: "\"Crucially,\" sentence starter", pattern: /(^|[\n.!?]\s+)crucially[,:]/i },
  { id: "gemini_important_bold", agent: "gemini", weight: 4, description: "Bold callouts like **Important:** / **Note:**", pattern: /\*\*(?:important|note|warning|caution|key takeaway)\*\*\s*[:.]/i },
  { id: "gemini_paramount", agent: "gemini", weight: 3, description: "\"It is paramount\" / \"of paramount importance\"", pattern: /\b(?:it\s+is\s+paramount|of\s+paramount\s+importance)\b/i },
  { id: "gemini_i_can_certainly", agent: "gemini", weight: 3, description: "\"I can certainly help\"", pattern: /\bi\s+can\s+certainly\s+(?:help|assist|provide)\b/i },
  { id: "gemini_robust_solution", agent: "gemini", weight: 2, description: "\"robust solution\" / \"comprehensive overview\"", pattern: /\b(?:robust\s+solution|comprehensive\s+overview|thorough\s+analysis)\b/i },

  // Cursor agent tells
  { id: "cursor_ive_edited", agent: "cursor-agent", weight: 5, description: "\"I've edited / added / updated\" code-action narration", pattern: /\bi'?ve\s+(?:edited|added|updated|created|modified|refactored|fixed)\b/i },
  { id: "cursor_let_me_check_file", agent: "cursor-agent", weight: 4, description: "\"Let me check the file / function\"", pattern: /\blet\s+me\s+(?:check|read|look\s+at|inspect)\s+(?:the\s+)?(?:file|function|code|implementation)\b/i },
  { id: "cursor_now_ill", agent: "cursor-agent", weight: 3, description: "\"Now I'll\" code-action narration", pattern: /(^|[\n.!?]\s+)now i'?ll\s+(?:add|edit|update|create|fix|run|check)\b/i },
  { id: "cursor_inline_file_paths", agent: "cursor-agent", weight: 3, description: "Three or more inline `path/to/file.ext` references", pattern: /`[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|md|json|yaml|yml|toml)`/g },
  { id: "cursor_the_diff", agent: "cursor-agent", weight: 2, description: "\"the diff\" / \"the patch\" code-tool framing", pattern: /\bthe\s+(?:diff|patch|change\s+set)\b/i },
  { id: "cursor_apply_patch", agent: "cursor-agent", weight: 3, description: "\"apply_patch\" / \"edit_file\" tool tell", pattern: /\b(?:apply_patch|edit_file|search_replace)\b/i },

  // Replit agent tells
  { id: "replit_ive_created", agent: "replit-agent", weight: 4, description: "\"I've created / set up\" project-action narration", pattern: /\bi'?ve\s+(?:created|set\s+up|configured|installed|deployed)\b/i },
  { id: "replit_workflow", agent: "replit-agent", weight: 5, description: "References to \"the workflow\" / Replit workflows", pattern: /\bthe\s+workflow\b/i },
  { id: "replit_run_button", agent: "replit-agent", weight: 5, description: "\"Run button\" / \"the Run button\"", pattern: /\bthe\s+run\s+button\b/i },
  { id: "replit_repl", agent: "replit-agent", weight: 4, description: "\"Repl\" / \"this Repl\" reference", pattern: /\b(?:this\s+|your\s+|the\s+)?repl\b(?!\.it)/i },
  { id: "replit_preview_pane", agent: "replit-agent", weight: 4, description: "\"the preview pane\" / \"webview\"", pattern: /\bthe\s+(?:preview\s+pane|webview)\b/i },
  { id: "replit_checkpoint", agent: "replit-agent", weight: 3, description: "\"checkpoint\" reference", pattern: /\bcheckpoint(?:s|ed)?\b/i },
  { id: "replit_secrets_pane", agent: "replit-agent", weight: 3, description: "\"the Secrets pane\" / \"environment secrets\"", pattern: /\bthe\s+secrets\s+(?:pane|tab|tool)\b/i },

  // Human tells (mirroring + extending lib/human-indicators.ts so the
  // detector remains self-contained and so a "human" verdict here can
  // disagree with the broader human-indicators system without coupling
  // weights).
  { id: "human_contractions_dense", agent: "human", weight: 2, description: "Three or more informal contractions in close succession", pattern: /\b(?:don't|won't|can't|isn't|doesn't|didn't|i'm|i've|i'll|we're|they're|that's|gonna|wanna|kinda|sorta|y'all)\b/gi },
  { id: "human_informal_abbr", agent: "human", weight: 4, description: "Informal abbreviations (btw / fwiw / iirc / imo / tldr)", pattern: /\b(?:btw|fwiw|iirc|imo|imho|tldr|tl;dr|ymmv|afaict|idk|ngl|wrt)\b/i },
  { id: "human_commit_hash", agent: "human", weight: 5, description: "Commit hash / PR reference", pattern: /\b(?:commit\s+[0-9a-f]{7,40}|(?:pull\s+request|pr|mr)\s*#?\d+|[0-9a-f]{8,40}\.\.[0-9a-f]{8,40})\b/i },
  { id: "human_named_researcher", agent: "human", weight: 4, description: "Named-researcher credit line", pattern: /\b(?:reported\s+by|discovered\s+by|found\s+by|credited?\s+to)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/ },
  { id: "human_swearing", agent: "human", weight: 3, description: "Mild profanity (no AI agent uses it)", pattern: /\b(?:wtf|damn|crap|sucks|annoying\s+as\s+hell|wtaf)\b/i },
];

/** Cap on how many distinct rules of one agent can score. Keeps a single
 * over-represented phrase from running away with the verdict. */
const MAX_RULES_PER_AGENT = 6;
/** Stylometric tells contribute up to this many points (em-dash density,
 * bold-header density, etc.) so the verdict isn't purely phrase-driven. */
const STYLO_MAX_POINTS = 4;
/** Below this raw point total the verdict collapses to "unknown" — short
 * or generic prose shouldn't get a confident label. */
const MIN_TOP_SCORE_FOR_LABEL = 5;
/** Excerpts in the matches array are truncated to this many chars so the
 * diagnostics-panel response stays small. */
const EXCERPT_MAX_LEN = 80;

function excerpt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_LEN);
}

function styloFeatures(text: string): AgentFingerprintResult["features"] {
  const wordCount = (text.match(/\b\w+\b/g) ?? []).length;
  const sentences = text.split(/[.!?]+\s+/).filter((s) => s.trim().length > 0);
  const sentenceCount = sentences.length || 1;
  const avgSentenceLen = wordCount / sentenceCount;
  const emDashCount = (text.match(/—/g) ?? []).length;
  const boldHeaderCount = (text.match(/\*\*[^*\n]{1,40}\*\*\s*[:.\n]/g) ?? []).length;
  const bulletCount = (text.match(/(^|\n)\s*(?:[-*•]\s+|\d+\.\s+)/g) ?? []).length;
  return { wordCount, sentenceCount, avgSentenceLen, emDashCount, boldHeaderCount, bulletCount };
}

/**
 * Detect the most-likely AI agent (or human) that authored `text`.
 *
 * The function is pure and side-effect-free; callers may invoke it on
 * every diagnostics request without persisting anything. Designed for
 * texts up to ~50KB — every regex is anchored / non-catastrophic so
 * runtime stays linear in input length.
 */
export function detectAgentFingerprint(
  text: string | null | undefined,
): AgentFingerprintResult {
  const empty: AgentFingerprintResult = {
    likelyAgent: "unknown",
    confidence: 0,
    scores: { gpt4: 0, claude: 0, gemini: 0, "cursor-agent": 0, "replit-agent": 0, human: 0 },
    matches: [],
    features: { wordCount: 0, sentenceCount: 0, avgSentenceLen: 0, emDashCount: 0, boldHeaderCount: 0, bulletCount: 0 },
  };
  if (!text || typeof text !== "string") return empty;

  const features = styloFeatures(text);
  const scores: Record<Exclude<AgentLabel, "unknown">, number> = {
    gpt4: 0, claude: 0, gemini: 0, "cursor-agent": 0, "replit-agent": 0, human: 0,
  };
  const perAgentRuleCount: Record<string, number> = {};
  const matches: AgentFingerprintMatch[] = [];

  for (const rule of RULES) {
    perAgentRuleCount[rule.agent] = perAgentRuleCount[rule.agent] ?? 0;
    if (perAgentRuleCount[rule.agent] >= MAX_RULES_PER_AGENT) continue;

    if (rule.pattern.global) {
      const all = text.match(rule.pattern);
      const count = all ? all.length : 0;
      // Global rules only score when they fire enough to be a real signal
      // (3+ hits) — a single contraction or one inline path means nothing.
      if (count >= 3) {
        const w = rule.weight;
        scores[rule.agent] += w;
        perAgentRuleCount[rule.agent]++;
        matches.push({
          id: rule.id,
          description: `${rule.description} (${count}×)`,
          weight: w,
          excerpt: all && all[0] ? excerpt(all[0]) : undefined,
        });
      }
    } else {
      const m = text.match(rule.pattern);
      if (m && m[0]) {
        scores[rule.agent] += rule.weight;
        perAgentRuleCount[rule.agent]++;
        matches.push({
          id: rule.id,
          description: rule.description,
          weight: rule.weight,
          excerpt: excerpt(m[0]),
        });
      }
    }
  }

  // Stylometric tells — capped contribution per agent so they tilt close
  // calls without dominating phrase evidence.
  const stylo = Math.min(
    STYLO_MAX_POINTS,
    Math.round(features.emDashCount / 4) + Math.round(features.boldHeaderCount / 3),
  );
  if (stylo > 0 && features.wordCount >= 60) {
    // Em-dash + bold-header density tilts toward GPT-4 / Gemini formatting
    // habits. Split the points so neither runs away with it.
    scores.gpt4 += Math.ceil(stylo / 2);
    scores.gemini += Math.floor(stylo / 2);
    matches.push({
      id: "stylo_emdash_bold_density",
      description: `Em-dash + bold-header density (${features.emDashCount} em-dashes, ${features.boldHeaderCount} bold headers)`,
      weight: stylo,
    });
  }
  // Long mean sentence length is a Claude / GPT-4 tell over Gemini's
  // bullet-heavy short sentences.
  if (features.avgSentenceLen >= 24 && features.wordCount >= 80) {
    scores.claude += 2;
    matches.push({
      id: "stylo_long_sentences",
      description: `Long mean sentence length (${features.avgSentenceLen.toFixed(1)} words)`,
      weight: 2,
    });
  }
  // Aggressive bulleting tilts toward Gemini.
  if (features.bulletCount >= 6 && features.wordCount >= 80) {
    scores.gemini += 2;
    matches.push({
      id: "stylo_bullet_heavy",
      description: `Bullet-heavy formatting (${features.bulletCount} bullets / numbered items)`,
      weight: 2,
    });
  }

  // Pick the winner. If the top score is too low we report "unknown" so
  // the panel doesn't display an attribution we can't defend.
  let topAgent: Exclude<AgentLabel, "unknown"> = "gpt4";
  let topScore = -1;
  let runnerUp = 0;
  for (const k of Object.keys(scores) as Array<Exclude<AgentLabel, "unknown">>) {
    const v = scores[k];
    if (v > topScore) {
      runnerUp = topScore;
      topScore = v;
      topAgent = k;
    } else if (v > runnerUp) {
      runnerUp = v;
    }
  }
  if (topScore < MIN_TOP_SCORE_FOR_LABEL) {
    return { likelyAgent: "unknown", confidence: 0, scores, matches, features };
  }

  // Confidence: blend of (a) how dominant the top is over the runner-up
  // and (b) how big the top is in absolute terms. Capped at 0.95 — we
  // never claim certainty.
  const margin = topScore === 0 ? 0 : (topScore - runnerUp) / topScore;
  const magnitude = Math.min(1, topScore / 18);
  const confidence = Math.min(0.95, 0.5 * margin + 0.5 * magnitude);

  return { likelyAgent: topAgent, confidence: Number(confidence.toFixed(3)), scores, matches, features };
}

/** Friendly label for the diagnostics panel. */
export const AGENT_DISPLAY_LABEL: Record<AgentLabel, string> = {
  gpt4: "GPT-4 / ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  "cursor-agent": "Cursor agent",
  "replit-agent": "Replit agent",
  human: "Human",
  unknown: "Unknown",
};
