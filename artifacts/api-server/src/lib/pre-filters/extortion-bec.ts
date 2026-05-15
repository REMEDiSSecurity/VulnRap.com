// Task #1327 — extortion + BEC pre-filter.

import { buildFire, type RuleFire, type RuleInput } from "./types";

interface Pattern {
  pattern: RegExp;
  flag: string;
  rule: string;
  severity: 1 | 2 | 3;
}

const PATTERNS: Pattern[] = [
  {
    rule: "extortion",
    flag: "crypto_wallet_address",
    pattern:
      /\b(?:bc1[0-9a-z]{8,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|4[0-9A-B][1-9A-HJ-NP-Za-km-z]{93,})\b/,
    severity: 3,
  },
  {
    rule: "extortion",
    flag: "extortion_deadline",
    pattern:
      /\b(?:within\s+)?(?:24|36|48|72)\s*(?:hours?|hrs?|h)\b|\bdeadline:\s*\d{1,2}\s*days?\b/i,
    severity: 1,
  },
  {
    rule: "extortion",
    flag: "no_law_enforcement",
    pattern:
      /\bdo\s+not\s+(?:contact|inform|notify|involve|loop\s+in)\s+(?:law\s+enforcement|the\s+police|the\s+fbi|authorities|your\s+communications\s+team)\b/i,
    severity: 2,
  },
  {
    rule: "extortion",
    flag: "we_have_your_data",
    pattern:
      /\bwe\s+(?:have|already\s+(?:have|exfiltrated|downloaded)|possess|(?:have\s+)?(?:downloaded|exfiltrated|encrypted|stolen|copied))\s+(?:\w+\s+){0,3}?(?:your|access\s+to\s+your)\b/i,
    severity: 2,
  },
  {
    rule: "extortion",
    flag: "pay_or_leak",
    pattern:
      /\b(?:pay|payment|transfer|wire|send)\s+(?:\$|usd|eur|btc|xmr|bitcoin|monero|\d)[^.\n]{0,40}\b(?:before|or\s+(?:we|i)\s+(?:will\s+)?(?:publish|leak|disclose|release|sell|notify))/i,
    severity: 3,
  },
  {
    rule: "extortion",
    flag: "leak_site_threat",
    pattern:
      /\b(?:publish|leak|post|dump\s+goes)\s+(?:on|to)?\s*(?:our\s+|a\s+|the\s+)?(?:leak\s+sites?|breach\s+forums?|dark\s+web|data[-\s]leak\s+sites?)\b/i,
    severity: 2,
  },
  {
    rule: "extortion",
    flag: "partnership_fee_demand",
    pattern:
      /\bone[-\s]time\s+(?:partnership|consulting|advisory|engagement)\s+fee\b/i,
    severity: 3,
  },
  {
    rule: "bec",
    flag: "bec_urgency",
    pattern:
      /\b(?:urgent|asap|immediately)[^.\n]{0,40}\b(?:wire\s+transfer|payment|funds|whitelist|approve|verify)\b/i,
    severity: 1,
  },
  {
    rule: "bec",
    flag: "coffee_shop_pretext",
    pattern:
      /\bworking\s+from\s+(?:a\s+)?(?:coffee\s+shop|cafe|airport|hotel\s+wifi)\b/i,
    severity: 2,
  },
  {
    rule: "bec",
    flag: "iphone_executive_signature",
    pattern: /\b(?:sent|from)\s+(?:from\s+)?my\s+iphone\b/i,
    severity: 2,
  },
  {
    rule: "bec",
    flag: "whitelist_request",
    pattern: /\bplease\s+(?:immediately\s+)?whitelist\b/i,
    severity: 2,
  },
  {
    rule: "bec",
    flag: "credential_reverify_link",
    pattern:
      /\bre[-\s]?verify\s+your\s+(?:program\s+)?credentials?\b|\bcompliance\s+review[^.\n]{0,60}\bsign\s+in\b/i,
    severity: 3,
  },
];

export function evaluateExtortionBec(input: RuleInput): RuleFire[] {
  const text = input.rawText;
  const fires: RuleFire[] = [];
  const seen = new Set<string>();
  for (const { pattern, flag, rule, severity } of PATTERNS) {
    const m = text.match(pattern);
    if (m && !seen.has(flag)) {
      seen.add(flag);
      fires.push(buildFire(rule, flag, m[0], severity));
    }
  }
  return fires;
}
