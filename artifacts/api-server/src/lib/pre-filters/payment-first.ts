// Task #1327 — payment-first / sales-pitch pre-filter.

import { buildFire, type RuleFire, type RuleInput } from "./types";

interface Spec {
  flag: string;
  pattern: RegExp;
  rule: "payment_first" | "sales_pitch";
  severity: 1 | 2 | 3;
}

const SPECS: Spec[] = [
  {
    flag: "bounty_demand_no_details",
    rule: "payment_first",
    severity: 2,
    pattern:
      /\b(?:please\s+)?(?:send|pay|transfer|wire|release)\s+(?:my\s+|the\s+)?(?:bounty|reward|payment)\s+(?:first|now|upfront|in\s+advance|before)/i,
  },
  {
    flag: "details_after_payment",
    rule: "payment_first",
    severity: 3,
    pattern:
      /\b(?:i\s+will|i'?ll)\s+(?:share|provide|disclose|reveal|send)\s+(?:the\s+)?(?:details|poc|proof|exploit|writeup)\s+(?:after|once)\s+(?:payment|bounty|reward|you\s+pay)/i,
  },
  {
    flag: "minimum_bounty_request",
    rule: "payment_first",
    severity: 2,
    pattern: /\bminimum\s+bounty\s+of\s+(?:\$|usd\s*)?\d/i,
  },
  {
    flag: "paypal_or_btc_for_details",
    rule: "payment_first",
    severity: 3,
    pattern:
      /\b(?:paypal|venmo|cash\s*app|zelle|btc|bitcoin)[^.\n]{0,40}\b(?:for|to\s+receive|to\s+get)\s+(?:the\s+)?(?:details|poc|report)/i,
  },
  {
    flag: "consulting_pitch",
    rule: "sales_pitch",
    severity: 2,
    pattern:
      /\b(?:we\s+offer|our\s+(?:firm|company|team)\s+(?:provides|offers))\s+[^.\n]{0,80}\b(?:penetration\s+testing|red\s+team|security\s+consulting|managed\s+detection|soc[-\s]?as[-\s]?a[-\s]?service|vCISO)\b/i,
  },
  {
    flag: "product_pitch",
    rule: "sales_pitch",
    severity: 1,
    pattern:
      /\b(?:our|my)\s+(?:scanner|tool|platform|product|saas|service)\s+(?:can|will|would)\s+(?:detect|find|prevent|stop|catch)\b/i,
  },
  {
    flag: "schedule_a_call",
    rule: "sales_pitch",
    severity: 1,
    pattern:
      /\b(?:schedule|book|set\s+up|available\s+for)\s+a\s+(?:call|meeting|demo|consultation|video\s+call)\b/i,
  },
  {
    flag: "vague_claims_no_details",
    rule: "sales_pitch",
    severity: 2,
    pattern:
      /\b(?:discuss|share|provide)\s+[^.\n]{0,80}\bbefore\s+(?:providing|sharing|disclosing)\s+(?:full\s+)?(?:technical\s+)?details\b/i,
  },
  {
    flag: "engagement_proposal",
    rule: "sales_pitch",
    severity: 2,
    pattern:
      /\b(?:engagement\s+proposal|statement\s+of\s+work|sow\s+attached|rate\s+card)\b/i,
  },
];

export function evaluatePaymentFirst(input: RuleInput): RuleFire[] {
  const text = input.rawText;
  const fires: RuleFire[] = [];
  const seen = new Set<string>();
  for (const { pattern, flag, rule, severity } of SPECS) {
    const m = text.match(pattern);
    if (m && !seen.has(flag)) {
      seen.add(flag);
      fires.push(buildFire(rule, flag, m[0], severity));
    }
  }
  return fires;
}
