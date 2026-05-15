// Task #1327 — prompt-injection canary.
//
// Wraps scanForPromptInjection and assigns a severity to each label so
// labels that are routinely *quoted* in legit prompt-injection bug
// reports (e.g. "ignore previous instructions") don't quarantine on
// their own, while system-token-spoof / verdict-coercion variants do.

import { scanForPromptInjection } from "../prompt-injection";
import { buildFire, type RuleFire, type RuleInput } from "./types";

const STRONG_LABELS = new Set([
  "system_token_spoof",
  "markdown_system_spoof",
  "xml_system_spoof",
  "jailbreak_mode",
  "instruction_override",
  "verdict_coercion",
  "json_verdict_spoof",
  "constant_output_coercion",
  "role_flip_act_as",
]);
const MEDIUM_LABELS = new Set([
  "role_flip_you_are_now",
  "role_flip_pretend",
  "role_flip_from_now_on",
  "multilingual_es",
  "multilingual_fr",
  "multilingual_de",
  "multilingual_zh",
  "bracket_role_spoof",
  "html_comment_injection",
  "comment_injection",
  // Common quoted-in-report labels — sev 2 so they can quarantine when
  // paired with one other signal but never on their own (avoids FP on
  // real prompt-injection bug reports that quote the attack verbatim).
  "ignore_previous_instructions",
  "disregard_previous",
  "forget_everything",
]);

function severityFor(label: string): 1 | 2 | 3 {
  if (STRONG_LABELS.has(label)) return 3;
  if (MEDIUM_LABELS.has(label)) return 2;
  return 1;
}

export function evaluatePromptInjectionCanary(input: RuleInput): RuleFire[] {
  const verdict = scanForPromptInjection(input.rawText);
  if (!verdict.detected) return [];
  const fires: RuleFire[] = [];
  for (let i = 0; i < verdict.labels.length; i++) {
    const label = verdict.labels[i];
    const match = verdict.matches[i] ?? "";
    fires.push(
      buildFire("prompt_injection_canary", label, match, severityFor(label)),
    );
  }
  return fires;
}
