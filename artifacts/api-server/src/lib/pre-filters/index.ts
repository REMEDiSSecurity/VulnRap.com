// Task #1327 — orchestrator. Runs the five rule families and decides
// whether to quarantine based on summed severity. A single weak signal
// (e.g. extortion_deadline at severity 1) won't quarantine; the
// threshold is a total severity of 3 across all fires.

import { evaluateCveValidation } from "./cve-validation";
import { evaluateExtortionBec } from "./extortion-bec";
import { evaluateGovernmentImpersonation } from "./government-impersonation";
import { evaluatePaymentFirst } from "./payment-first";
import { evaluatePromptInjectionCanary } from "./prompt-injection-canary";
import {
  extractSenderDomain,
  type EscalateTo,
  type PreFilterResult,
  type RuleFire,
  type RuleInput,
} from "./types";

export interface RunPreFiltersOptions {
  rawText: string;
  senderDomain?: string | null;
  now?: Date;
}

const QUARANTINE_SEVERITY_THRESHOLD = 3;

const RULE_FAMILY_TO_ROUTE: Record<
  string,
  { escalateTo: EscalateTo; cap: number; priority: number }
> = {
  prompt_injection_canary: { escalateTo: "ai_security", cap: 0.0, priority: 3 },
  extortion: { escalateTo: "legal_ir_soc", cap: 0.0, priority: 3 },
  bec: { escalateTo: "legal_ir_soc", cap: 0.0, priority: 3 },
  government_impersonation: { escalateTo: "legal_ir_soc", cap: 0.0, priority: 3 },
  cve_validation: { escalateTo: "psirt_triage", cap: 0.2, priority: 1 },
  payment_first: { escalateTo: "psirt_triage", cap: 0.2, priority: 1 },
  sales_pitch: { escalateTo: "psirt_triage", cap: 0.2, priority: 1 },
};

export function runPreFilters(opts: RunPreFiltersOptions): PreFilterResult {
  const started = Date.now();
  const senderDomain =
    opts.senderDomain ?? extractSenderDomain(opts.rawText);
  const input: RuleInput = { rawText: opts.rawText, senderDomain };

  const fires: RuleFire[] = [
    ...evaluatePromptInjectionCanary(input),
    ...evaluateExtortionBec(input),
    ...evaluateGovernmentImpersonation(input),
    ...evaluateCveValidation(input, opts.now),
    ...evaluatePaymentFirst(input),
  ];

  const totalSeverity = fires.reduce((s, f) => s + f.severity, 0);
  const flags = Array.from(new Set(fires.map((f) => f.flag)));
  const shouldQuarantine =
    fires.length > 0 && totalSeverity >= QUARANTINE_SEVERITY_THRESHOLD;

  let escalateTo: EscalateTo | null = null;
  let suggestedRealnessCap: number | null = null;
  if (shouldQuarantine) {
    let best = RULE_FAMILY_TO_ROUTE.payment_first;
    for (const fire of fires) {
      const route = RULE_FAMILY_TO_ROUTE[fire.rule];
      if (route && route.priority > best.priority) best = route;
    }
    escalateTo = best.escalateTo;
    suggestedRealnessCap = best.cap;
  }

  return {
    flags,
    fires,
    shouldQuarantine,
    escalateTo,
    suggestedRealnessCap,
    totalSeverity,
    durationMs: Date.now() - started,
  };
}

export type { PreFilterResult, RuleFire, EscalateTo } from "./types";
