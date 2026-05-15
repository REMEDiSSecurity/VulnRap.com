// Task #1327 — REMEDiS L1 deterministic pre-filters: shared types.
//
// Each fire carries a `severity` (1=weak, 2=medium, 3=strong). The
// orchestrator quarantines only when the summed severity reaches a
// threshold (default 3), so a single low-severity signal — e.g.
// "patch within 48 hours" appearing in a legit advisory — cannot
// quarantine a real report on its own.

import { createHash } from "node:crypto";

export type EscalateTo = "ai_security" | "legal_ir_soc" | "psirt_triage";

export interface RuleFire {
  rule: string;
  flag: string;
  match: string;
  spanHash: string;
  severity: 1 | 2 | 3;
}

export interface RuleInput {
  rawText: string;
  senderDomain: string | null;
}

export interface PreFilterResult {
  flags: string[];
  fires: RuleFire[];
  shouldQuarantine: boolean;
  escalateTo: EscalateTo | null;
  suggestedRealnessCap: number | null;
  totalSeverity: number;
  durationMs: number;
}

const MATCH_PREVIEW_CAP = 160;

export function buildFire(
  rule: string,
  flag: string,
  match: string,
  severity: 1 | 2 | 3,
): RuleFire {
  const trimmed =
    match.length > MATCH_PREVIEW_CAP ? match.slice(0, MATCH_PREVIEW_CAP) : match;
  const spanHash = createHash("sha256").update(match).digest("hex").slice(0, 16);
  return { rule, flag, match: trimmed, spanHash, severity };
}

const SENDER_RE =
  /^\s*From:\s*[^<\n]*<?([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/im;

export function extractSenderDomain(rawText: string): string | null {
  const m = rawText.match(SENDER_RE);
  if (!m) return null;
  return m[2].toLowerCase();
}
