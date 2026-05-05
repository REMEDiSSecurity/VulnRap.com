import { logger } from "./logger";

export interface PromptInjectionVerdict {
  detected: boolean;
  labels: string[];
  matches: string[];
}

interface PromptInjectionPattern {
  pattern: RegExp;
  label: string;
}

const PATTERNS: PromptInjectionPattern[] = [
  {
    pattern:
      /ignore\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instruction|prompt|rule|message|directive|context|system\s+message)s?/i,
    label: "ignore_previous_instructions",
  },
  {
    pattern:
      /disregard\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instruction|prompt|rule)s?/i,
    label: "disregard_previous",
  },
  {
    pattern:
      /forget\s+(?:everything|all\s+(?:previous|prior)|what\s+(?:i|you)\s+(?:said|wrote)|your\s+(?:instructions|guidelines|training))/i,
    label: "forget_everything",
  },
  {
    pattern:
      /(?:new|updated|revised|override|override:|the\s+real|actual)\s+(?:instructions?|prompt|rules?|directives?)\s*[:\-]/i,
    label: "instruction_override",
  },
  {
    pattern: /you\s+are\s+(?:now|actually|in\s+fact)\s+(?:a|an)\s+\w+/i,
    label: "role_flip_you_are_now",
  },
  {
    pattern:
      /(?:act|behave|respond|pretend\s+to\s+act)\s+as\s+(?:if\s+you\s+(?:are|were)|a|an)\s+/i,
    label: "role_flip_act_as",
  },
  {
    pattern: /pretend\s+(?:to\s+be|you\s+(?:are|were))\s+/i,
    label: "role_flip_pretend",
  },
  {
    pattern: /from\s+now\s+on(?:,|\s+you)\s+/i,
    label: "role_flip_from_now_on",
  },
  {
    pattern: /<\|?\s*(?:system|im_start|start_of_turn)\s*\|?>/i,
    label: "system_token_spoof",
  },
  {
    pattern: /\[\s*(?:SYSTEM|INST|ASSISTANT|USER)\s*\]/i,
    label: "bracket_role_spoof",
  },
  { pattern: /^\s*(?:###?|---)\s*system\b/im, label: "markdown_system_spoof" },
  { pattern: /<system>[\s\S]*?<\/system>/i, label: "xml_system_spoof" },
  {
    pattern:
      /(?:return|output|emit|respond\s+with|set|assign)\s+(?:the\s+)?(?:slop[_\s-]?score|score|verdict|tier|grade|rating)\s*(?:=|:|to|as|of)\s*[\d"'a-z]/i,
    label: "verdict_coercion",
  },
  {
    pattern:
      /\{\s*["']?(?:score|verdict|tier|slop)["']?\s*:\s*["']?(?:0|100|GREEN|VALID|STRONG|LIKELY[_\s]VALID)["']?/i,
    label: "json_verdict_spoof",
  },
  {
    pattern:
      /(?:always|just|simply|only)\s+(?:return|output|reply\s+with|respond\s+with)\s+["'`]?(?:0|100|GREEN|VALID|safe|legitimate)/i,
    label: "constant_output_coercion",
  },
  {
    pattern: /\b(?:DAN|developer|dev|jailbreak|god|admin|root)\s+mode\b/i,
    label: "jailbreak_mode",
  },
  { pattern: /\bdo\s+anything\s+now\b/i, label: "dan_phrase" },
  {
    pattern:
      /(?:\/\/|\/\*|#|<!--)\s*(?:SYSTEM|INSTRUCTION|PROMPT|ASSISTANT)\s*[:\-]/i,
    label: "comment_injection",
  },
  {
    pattern:
      /<!--[\s\S]*?(?:ignore|disregard|forget|return\s+slop|score\s*=\s*0)[\s\S]*?-->/i,
    label: "html_comment_injection",
  },
  {
    pattern:
      /ignor(?:ez|e)\s+(?:les|toutes\s+les)\s+instructions?\s+pr[ée]c[ée]dentes/i,
    label: "multilingual_fr_ignore",
  },
  {
    pattern: /ignor[ae]\s+(?:las|todas\s+las)\s+instrucciones\s+anteriores/i,
    label: "multilingual_es_ignore",
  },
  {
    pattern:
      /ignorier(?:e|en\s+sie)\s+(?:alle\s+)?(?:vorherigen|vorigen)\s+anweisungen/i,
    label: "multilingual_de_ignore",
  },
  {
    pattern: /忽略(?:之前|以前|上面|所有)(?:的)?(?:指令|指示|提示)/,
    label: "multilingual_zh_ignore",
  },
  {
    pattern: /(?:以前の|前の|これまでの)(?:指示|命令|プロンプト)を無視/,
    label: "multilingual_ja_ignore",
  },
  {
    pattern:
      /игнорируй(?:те)?\s+(?:все\s+)?(?:предыдущие|прежние)\s+инструкции/i,
    label: "multilingual_ru_ignore",
  },
];

export function scanForPromptInjection(text: string): PromptInjectionVerdict {
  const labels: string[] = [];
  const matches: string[] = [];
  const seenLabels = new Set<string>();

  for (const { pattern, label } of PATTERNS) {
    const m = text.match(pattern);
    if (m && !seenLabels.has(label)) {
      seenLabels.add(label);
      const matched = m[0].slice(0, 120);
      labels.push(label);
      matches.push(matched);
    }
  }

  const detected = labels.length > 0;

  if (detected) {
    logger.warn(
      { labels, matchCount: labels.length },
      "[PROMPT-INJECTION] injection patterns detected in submitted report",
    );
  }

  return { detected, labels, matches };
}

/**
 * Task #975 — Neutralize prompt-injection spans before passing the report
 * text to the LLM substance scorer. Each `match` returned by
 * `scanForPromptInjection` is a literal substring of the input text
 * (capped at 120 chars by the scanner). We replace every occurrence of
 * each matched literal with `[REDACTED-INJECTION]` so the scorer sees a
 * neutralized stub instead of the coercive phrasing. The heuristic /
 * engine pipeline still operates on the unredacted text so content-quality
 * scoring is unchanged.
 *
 * Returned shape: `{ text, redactedSpanCount }`. When no spans were
 * matched the original text is returned verbatim and the count is 0.
 */
export const PROMPT_INJECTION_PLACEHOLDER = "[REDACTED-INJECTION]";

export function redactPromptInjection(
  text: string,
  matches: readonly string[],
): { text: string; redactedSpanCount: number } {
  if (!matches.length) return { text, redactedSpanCount: 0 };
  // De-duplicate to avoid double-counting when the scanner returns the
  // same literal under multiple labels, and sort by length descending so
  // a longer literal that contains a shorter one is replaced first
  // (prevents the placeholder from leaking into the longer match).
  const unique = Array.from(new Set(matches.filter((m) => m.length > 0))).sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  let count = 0;
  for (const literal of unique) {
    const before = out;
    out = out.split(literal).join(PROMPT_INJECTION_PLACEHOLDER);
    if (out !== before) count += 1;
  }
  return { text: out, redactedSpanCount: count };
}
