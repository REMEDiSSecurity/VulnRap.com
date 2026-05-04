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
//
// Task #979 — phrase rules moved to data/agent-fingerprint-rules.json so
// reviewers can append new rules through
// POST /feedback/calibration/agent-fingerprint-rules without a code
// change + redeploy. The in-code defaults serve as fallback when the
// JSON file is missing/empty/corrupt.

import { readFileSync, existsSync } from "fs";
import { atomicWriteJsonFileSync } from "./atomic-write";
import path from "path";
import { fileURLToPath } from "url";

export type AgentLabel =
  | "gpt4"
  | "claude"
  | "gemini"
  | "cursor-agent"
  | "replit-agent"
  | "human"
  | "unknown";

const VALID_AGENTS_LIST = [
  "gpt4",
  "claude",
  "gemini",
  "cursor-agent",
  "replit-agent",
  "human",
] as const;

const VALID_AGENTS: Set<string> = new Set<string>(VALID_AGENTS_LIST);

export interface AgentFingerprintMatch {
  /** Stable id for the rule that fired. */
  id: string;
  /** Human-readable description for the diagnostics panel. */
  description: string;
  /** Points the rule contributed to its agent's score. */
  weight: number;
  /** First excerpt from the report that matched (lowercased, capped). */
  excerpt?: string;
  /** Reviewer who added this rule (undefined for built-in defaults). */
  addedBy?: string;
  /** ISO 8601 timestamp the rule was added. */
  addedAt?: string;
  /** Free-text justification supplied by the reviewer. */
  rationale?: string;
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
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
}

export interface AgentFingerprintRule {
  id: string;
  agent: Exclude<AgentLabel, "unknown">;
  pattern: string;
  flags?: string;
  weight: number;
  description: string;
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  editedBy?: string;
  editedAt?: string;
}

const DEFAULT_RULES: PhraseRule[] = [
  {
    id: "gpt4_certainly_opening",
    agent: "gpt4",
    weight: 5,
    description: 'Pleasantry opener ("Certainly!")',
    pattern: /(^|[\n.!?]\s+)certainly[!,.](?:\s|$)/i,
  },
  {
    id: "gpt4_of_course",
    agent: "gpt4",
    weight: 4,
    description: '"Of course!" opener',
    pattern: /(^|[\n.!?]\s+)of course[!,.](?:\s|$)/i,
  },
  {
    id: "gpt4_id_be_happy",
    agent: "gpt4",
    weight: 5,
    description: '"I\'d be happy to" / "I would be happy to"',
    pattern: /\bi(?:'d| would)\s+be\s+happy\s+to\b/i,
  },
  {
    id: "gpt4_lets_dive_into",
    agent: "gpt4",
    weight: 4,
    description: '"Let\'s dive into"',
    pattern: /\blet'?s\s+dive\s+(?:in|into)\b/i,
  },
  {
    id: "gpt4_in_conclusion",
    agent: "gpt4",
    weight: 3,
    description: '"In conclusion,"',
    pattern: /(^|[\n.!?]\s+)in conclusion[,:]/i,
  },
  {
    id: "gpt4_to_summarize",
    agent: "gpt4",
    weight: 2,
    description: '"To summarize,"',
    pattern: /(^|[\n.!?]\s+)to summarize[,:]/i,
  },
  {
    id: "gpt4_remember_that",
    agent: "gpt4",
    weight: 2,
    description: '"Remember that" sermon tell',
    pattern: /\bremember\s+that\b/i,
  },
  {
    id: "claude_ill_help",
    agent: "claude",
    weight: 4,
    description: '"I\'ll help" opener',
    pattern:
      /\bi'?ll\s+help\s+(?:you\s+)?(?:with|understand|investigate|analy[sz]e|walk)\b/i,
  },
  {
    id: "claude_heres_what",
    agent: "claude",
    weight: 4,
    description: "\"Here's what I found / I'll do\"",
    pattern:
      /\bhere'?s\s+what\s+i(?:'?ll|'?ve|\s+(?:found|did|see|noticed))\b/i,
  },
  {
    id: "claude_i_notice",
    agent: "claude",
    weight: 3,
    description: '"I notice" observation tell',
    pattern: /\bi\s+notice\s+(?:that|a|the|some)\b/i,
  },
  {
    id: "claude_walk_you_through",
    agent: "claude",
    weight: 5,
    description: '"Let me walk you through"',
    pattern: /\blet\s+me\s+walk\s+you\s+through\b/i,
  },
  {
    id: "claude_worth_noting",
    agent: "claude",
    weight: 3,
    description: '"It\'s worth noting"',
    pattern: /\bit'?s\s+worth\s+noting\b/i,
  },
  {
    id: "claude_to_be_clear",
    agent: "claude",
    weight: 2,
    description: '"To be clear," qualifier',
    pattern: /(^|[\n.!?]\s+)to be clear[,:]/i,
  },
  {
    id: "claude_thoughtful_hedging",
    agent: "claude",
    weight: 2,
    description: '"It seems" / "appears to be" hedging cluster',
    pattern: /\b(?:it\s+(?:seems|appears)|appears\s+to\s+be)\b/i,
  },
  {
    id: "gemini_of_course_here_is",
    agent: "gemini",
    weight: 6,
    description: '"Of course. Here is" / "Sure! Here\'s"',
    pattern: /(^|[\n.!?]\s+)(?:of course\.\s+here\s+is|sure[!,.]\s+here'?s)\b/i,
  },
  {
    id: "gemini_crucially",
    agent: "gemini",
    weight: 4,
    description: '"Crucially," sentence starter',
    pattern: /(^|[\n.!?]\s+)crucially[,:]/i,
  },
  {
    id: "gemini_important_bold",
    agent: "gemini",
    weight: 4,
    description: "Bold callouts like **Important:** / **Note:**",
    pattern: /\*\*(?:important|note|warning|caution|key takeaway)\*\*\s*[:.]/i,
  },
  {
    id: "gemini_paramount",
    agent: "gemini",
    weight: 3,
    description: '"It is paramount" / "of paramount importance"',
    pattern: /\b(?:it\s+is\s+paramount|of\s+paramount\s+importance)\b/i,
  },
  {
    id: "gemini_i_can_certainly",
    agent: "gemini",
    weight: 3,
    description: '"I can certainly help"',
    pattern: /\bi\s+can\s+certainly\s+(?:help|assist|provide)\b/i,
  },
  {
    id: "gemini_robust_solution",
    agent: "gemini",
    weight: 2,
    description: '"robust solution" / "comprehensive overview"',
    pattern:
      /\b(?:robust\s+solution|comprehensive\s+overview|thorough\s+analysis)\b/i,
  },
  {
    id: "cursor_ive_edited",
    agent: "cursor-agent",
    weight: 5,
    description: '"I\'ve edited / added / updated" code-action narration',
    pattern:
      /\bi'?ve\s+(?:edited|added|updated|created|modified|refactored|fixed)\b/i,
  },
  {
    id: "cursor_let_me_check_file",
    agent: "cursor-agent",
    weight: 4,
    description: '"Let me check the file / function"',
    pattern:
      /\blet\s+me\s+(?:check|read|look\s+at|inspect)\s+(?:the\s+)?(?:file|function|code|implementation)\b/i,
  },
  {
    id: "cursor_now_ill",
    agent: "cursor-agent",
    weight: 3,
    description: '"Now I\'ll" code-action narration',
    pattern:
      /(^|[\n.!?]\s+)now i'?ll\s+(?:add|edit|update|create|fix|run|check)\b/i,
  },
  {
    id: "cursor_inline_file_paths",
    agent: "cursor-agent",
    weight: 3,
    description: "Three or more inline `path/to/file.ext` references",
    pattern:
      /`[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|md|json|yaml|yml|toml)`/g,
  },
  {
    id: "cursor_the_diff",
    agent: "cursor-agent",
    weight: 2,
    description: '"the diff" / "the patch" code-tool framing',
    pattern: /\bthe\s+(?:diff|patch|change\s+set)\b/i,
  },
  {
    id: "cursor_apply_patch",
    agent: "cursor-agent",
    weight: 3,
    description: '"apply_patch" / "edit_file" tool tell',
    pattern: /\b(?:apply_patch|edit_file|search_replace)\b/i,
  },
  {
    id: "replit_ive_created",
    agent: "replit-agent",
    weight: 4,
    description: '"I\'ve created / set up" project-action narration',
    pattern: /\bi'?ve\s+(?:created|set\s+up|configured|installed|deployed)\b/i,
  },
  {
    id: "replit_workflow",
    agent: "replit-agent",
    weight: 5,
    description: 'References to "the workflow" / Replit workflows',
    pattern: /\bthe\s+workflow\b/i,
  },
  {
    id: "replit_run_button",
    agent: "replit-agent",
    weight: 5,
    description: '"Run button" / "the Run button"',
    pattern: /\bthe\s+run\s+button\b/i,
  },
  {
    id: "replit_repl",
    agent: "replit-agent",
    weight: 4,
    description: '"Repl" / "this Repl" reference',
    pattern: /\b(?:this\s+|your\s+|the\s+)?repl\b(?!\.it)/i,
  },
  {
    id: "replit_preview_pane",
    agent: "replit-agent",
    weight: 4,
    description: '"the preview pane" / "webview"',
    pattern: /\bthe\s+(?:preview\s+pane|webview)\b/i,
  },
  {
    id: "replit_checkpoint",
    agent: "replit-agent",
    weight: 3,
    description: '"checkpoint" reference',
    pattern: /\bcheckpoint(?:s|ed)?\b/i,
  },
  {
    id: "replit_secrets_pane",
    agent: "replit-agent",
    weight: 3,
    description: '"the Secrets pane" / "environment secrets"',
    pattern: /\bthe\s+secrets\s+(?:pane|tab|tool)\b/i,
  },
  {
    id: "human_contractions_dense",
    agent: "human",
    weight: 2,
    description: "Three or more informal contractions in close succession",
    pattern:
      /\b(?:don't|won't|can't|isn't|doesn't|didn't|i'm|i've|i'll|we're|they're|that's|gonna|wanna|kinda|sorta|y'all)\b/gi,
  },
  {
    id: "human_informal_abbr",
    agent: "human",
    weight: 4,
    description: "Informal abbreviations (btw / fwiw / iirc / imo / tldr)",
    pattern:
      /\b(?:btw|fwiw|iirc|imo|imho|tldr|tl;dr|ymmv|afaict|idk|ngl|wrt)\b/i,
  },
  {
    id: "human_commit_hash",
    agent: "human",
    weight: 5,
    description: "Commit hash / PR reference",
    pattern:
      /\b(?:commit\s+[0-9a-f]{7,40}|(?:pull\s+request|pr|mr)\s*#?\d+|[0-9a-f]{8,40}\.\.[0-9a-f]{8,40})\b/i,
  },
  {
    id: "human_named_researcher",
    agent: "human",
    weight: 4,
    description: "Named-researcher credit line",
    pattern:
      /\b(?:reported\s+by|discovered\s+by|found\s+by|credited?\s+to)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/,
  },
  {
    id: "human_swearing",
    agent: "human",
    weight: 3,
    description: "Mild profanity (no AI agent uses it)",
    pattern: /\b(?:wtf|damn|crap|sucks|annoying\s+as\s+hell|wtaf)\b/i,
  },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_PATHS = [
  path.resolve(__dirname, "../../../data/agent-fingerprint-rules.json"),
  path.resolve(process.cwd(), "data/agent-fingerprint-rules.json"),
  path.resolve(
    process.cwd(),
    "artifacts/api-server/data/agent-fingerprint-rules.json",
  ),
];

const ID_PATTERN = /^[a-z0-9_]{1,64}$/i;
const PATTERN_MAX_LEN = 500;
const FLAGS_PATTERN = /^[gimsuy]{0,7}$/;
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 10;

interface RulesFile {
  _meta?: unknown;
  rules: Array<Record<string, unknown>>;
}

interface CacheState {
  compiled: PhraseRule[];
  persisted: AgentFingerprintRule[];
}

let CACHED: CacheState | null = null;
let RESOLVED_PATH: string | null = null;

function resolvePath(): string {
  if (RESOLVED_PATH) return RESOLVED_PATH;
  const override = process.env.AGENT_FINGERPRINT_RULES_PATH;
  if (override && override.trim().length > 0) {
    RESOLVED_PATH = path.resolve(override);
    return RESOLVED_PATH;
  }
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) {
      RESOLVED_PATH = p;
      return p;
    }
  }
  RESOLVED_PATH = CANDIDATE_PATHS[0];
  return RESOLVED_PATH;
}

function trimOrUndefined(x: unknown, max: number): string | undefined {
  if (typeof x !== "string") return undefined;
  const v = x.trim();
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function isIsoTimestamp(x: unknown): x is string {
  return typeof x === "string" && !Number.isNaN(Date.parse(x));
}

function coerceRule(entry: unknown): AgentFingerprintRule | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id)) return null;
  if (typeof obj.agent !== "string" || !VALID_AGENTS.has(obj.agent)) return null;
  if (typeof obj.pattern !== "string") return null;
  if (obj.pattern.length === 0 || obj.pattern.length > PATTERN_MAX_LEN)
    return null;
  if (typeof obj.weight !== "number" || obj.weight < WEIGHT_MIN || obj.weight > WEIGHT_MAX)
    return null;
  if (typeof obj.description !== "string" || obj.description.trim().length === 0)
    return null;
  let flags: string | undefined;
  if (obj.flags !== undefined && obj.flags !== null) {
    if (typeof obj.flags !== "string" || !FLAGS_PATTERN.test(obj.flags))
      return null;
    if (obj.flags.length > 0) flags = obj.flags;
  }
  try {
    new RegExp(obj.pattern, flags ?? "i");
  } catch {
    return null;
  }
  const out: AgentFingerprintRule = {
    id: obj.id,
    agent: obj.agent as Exclude<AgentLabel, "unknown">,
    pattern: obj.pattern,
    weight: obj.weight,
    description: obj.description.trim(),
  };
  if (flags !== undefined) out.flags = flags;
  const addedBy = trimOrUndefined(obj.addedBy, 200);
  if (addedBy) out.addedBy = addedBy;
  if (isIsoTimestamp(obj.addedAt)) out.addedAt = obj.addedAt;
  const rationale = trimOrUndefined(obj.rationale, 500);
  if (rationale) out.rationale = rationale;
  const editedBy = trimOrUndefined(obj.editedBy, 200);
  if (editedBy) out.editedBy = editedBy;
  if (isIsoTimestamp(obj.editedAt)) out.editedAt = obj.editedAt;
  return out;
}

function compileRule(rule: AgentFingerprintRule): PhraseRule {
  const flags = rule.flags ?? "i";
  return {
    id: rule.id,
    agent: rule.agent,
    pattern: new RegExp(rule.pattern, flags),
    weight: rule.weight,
    description: rule.description,
    addedBy: rule.addedBy,
    addedAt: rule.addedAt,
    rationale: rule.rationale,
  };
}

function load(): CacheState {
  if (CACHED) return CACHED;
  const p = resolvePath();
  let persisted: AgentFingerprintRule[] = [];
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as RulesFile;
      if (Array.isArray(raw.rules)) {
        persisted = raw.rules
          .map(coerceRule)
          .filter((m): m is AgentFingerprintRule => m !== null);
      }
    } catch {
      // Fall through — corrupt JSON file never disables the detector.
    }
  }
  const seen = new Set<string>();
  const deduped: AgentFingerprintRule[] = [];
  for (const r of persisted) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      deduped.push(r);
    }
  }
  const reviewerCompiled = deduped.map(compileRule);
  const compiled = [
    ...DEFAULT_RULES,
    ...reviewerCompiled.filter((r) => !DEFAULT_RULES.some((d) => d.id === r.id)),
  ];
  CACHED = { compiled, persisted: deduped };
  return CACHED;
}

function persist(rules: AgentFingerprintRule[]): void {
  const p = resolvePath();
  const body: RulesFile = {
    _meta: {
      description:
        "Cross-AI-agent fingerprint phrase rules. Loaded by lib/agent-fingerprint.ts at startup with the in-code defaults as fallback. Each entry compiles to a RegExp matched against the report body. Reviewers can append new rules through POST /feedback/calibration/agent-fingerprint-rules without a redeploy.",
    },
    rules: rules as unknown as Array<Record<string, unknown>>,
  };
  atomicWriteJsonFileSync(p, body);
}

export function getAgentFingerprintRules(): AgentFingerprintRule[] {
  return load().persisted.map((r) => ({ ...r }));
}

export interface AddAgentFingerprintRuleOptions {
  reviewer?: string;
  rationale?: string;
  now?: string;
}

export interface AddAgentFingerprintRuleResult {
  added: boolean;
  rule: AgentFingerprintRule;
  total: number;
}

export function addAgentFingerprintRule(
  rawId: unknown,
  rawAgent: unknown,
  rawPattern: unknown,
  rawFlags: unknown,
  rawWeight: unknown,
  rawDescription: unknown,
  options: AddAgentFingerprintRuleOptions = {},
): AddAgentFingerprintRuleResult {
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new Error("id must be a non-empty string.");
  }
  const id = rawId.trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must be 1-64 characters of [A-Za-z0-9_].");
  }
  if (typeof rawAgent !== "string" || !VALID_AGENTS.has(rawAgent)) {
    throw new Error(
      `agent must be one of: ${VALID_AGENTS_LIST.join(", ")}.`,
    );
  }
  const agent = rawAgent as Exclude<AgentLabel, "unknown">;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) {
    throw new Error("pattern must be a non-empty string.");
  }
  if (rawPattern.length > PATTERN_MAX_LEN) {
    throw new Error(`pattern must be at most ${PATTERN_MAX_LEN} characters.`);
  }
  let flags: string | undefined;
  if (rawFlags !== undefined && rawFlags !== null) {
    if (typeof rawFlags !== "string" || !FLAGS_PATTERN.test(rawFlags)) {
      throw new Error(
        "flags must contain only regex flag characters [gimsuy].",
      );
    }
    if (rawFlags.length > 0) flags = rawFlags;
  }
  try {
    new RegExp(rawPattern, flags ?? "i");
  } catch (e) {
    throw new Error(
      `pattern is not a valid regular expression: ${(e as Error).message}`,
    );
  }
  if (typeof rawWeight !== "number" || !Number.isFinite(rawWeight)) {
    throw new Error("weight must be a finite number.");
  }
  const weight = Math.round(rawWeight);
  if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    throw new Error(`weight must be between ${WEIGHT_MIN} and ${WEIGHT_MAX}.`);
  }
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    throw new Error("description must be a non-empty string.");
  }
  const description = rawDescription.trim().slice(0, 200);
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const rationale = trimOrUndefined(options.rationale, 500);
  if (rationale && rationale.length < 3) {
    throw new Error("rationale must be at least 3 characters when provided.");
  }
  const { persisted: current } = load();
  const builtIn = DEFAULT_RULES.find((r) => r.id === id);
  if (builtIn) {
    throw new Error(`id "${id}" conflicts with a built-in rule.`);
  }
  const existing = current.find((r) => r.id === id);
  if (existing) {
    return { added: false, rule: { ...existing }, total: current.length };
  }
  const addedAt = isIsoTimestamp(options.now)
    ? options.now
    : new Date().toISOString();
  const rule: AgentFingerprintRule = {
    id,
    agent,
    pattern: rawPattern,
    weight,
    description,
  };
  if (flags !== undefined) rule.flags = flags;
  if (reviewer) rule.addedBy = reviewer;
  rule.addedAt = addedAt;
  if (rationale) rule.rationale = rationale;
  const next = [...current, rule];
  persist(next);
  CACHED = null;
  return { added: true, rule: { ...rule }, total: next.length };
}

export interface EditAgentFingerprintRuleOptions {
  reviewer?: string;
  rationale?: string;
  now?: string;
}

export interface EditAgentFingerprintRuleResult {
  edited: boolean;
  rule: AgentFingerprintRule;
  total: number;
}

export function editAgentFingerprintRule(
  rawId: unknown,
  rawAgent: unknown,
  rawPattern: unknown,
  rawFlags: unknown,
  rawWeight: unknown,
  rawDescription: unknown,
  options: EditAgentFingerprintRuleOptions = {},
): EditAgentFingerprintRuleResult {
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new Error("id must be a non-empty string.");
  }
  const id = rawId.trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must be 1-64 characters of [A-Za-z0-9_].");
  }
  if (typeof rawAgent !== "string" || !VALID_AGENTS.has(rawAgent)) {
    throw new Error(
      `agent must be one of: ${VALID_AGENTS_LIST.join(", ")}.`,
    );
  }
  const agent = rawAgent as Exclude<AgentLabel, "unknown">;
  if (typeof rawPattern !== "string" || rawPattern.length === 0) {
    throw new Error("pattern must be a non-empty string.");
  }
  if (rawPattern.length > PATTERN_MAX_LEN) {
    throw new Error(`pattern must be at most ${PATTERN_MAX_LEN} characters.`);
  }
  let flags: string | undefined;
  if (rawFlags !== undefined && rawFlags !== null) {
    if (typeof rawFlags !== "string" || !FLAGS_PATTERN.test(rawFlags)) {
      throw new Error(
        "flags must contain only regex flag characters [gimsuy].",
      );
    }
    if (rawFlags.length > 0) flags = rawFlags;
  }
  try {
    new RegExp(rawPattern, flags ?? "i");
  } catch (e) {
    throw new Error(
      `pattern is not a valid regular expression: ${(e as Error).message}`,
    );
  }
  if (typeof rawWeight !== "number" || !Number.isFinite(rawWeight)) {
    throw new Error("weight must be a finite number.");
  }
  const weight = Math.round(rawWeight);
  if (weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    throw new Error(`weight must be between ${WEIGHT_MIN} and ${WEIGHT_MAX}.`);
  }
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    throw new Error("description must be a non-empty string.");
  }
  const description = rawDescription.trim().slice(0, 200);
  const reviewer = trimOrUndefined(options.reviewer, 200);
  let rationaleUpdate: string | null | undefined;
  if (options.rationale === undefined) {
    rationaleUpdate = undefined;
  } else if (typeof options.rationale !== "string") {
    throw new Error("rationale must be a string when provided.");
  } else {
    const r = options.rationale.trim();
    if (r.length === 0) {
      rationaleUpdate = null;
    } else if (r.length < 3) {
      throw new Error("rationale must be at least 3 characters when provided.");
    } else {
      rationaleUpdate = r.length > 500 ? r.slice(0, 500) : r;
    }
  }
  const { persisted: current } = load();
  const idx = current.findIndex((r) => r.id === id);
  if (idx === -1) {
    return {
      edited: false,
      rule: { id, agent, pattern: rawPattern, weight, description, ...(flags ? { flags } : {}) },
      total: current.length,
    };
  }
  const prior = current[idx];
  const editedAt = isIsoTimestamp(options.now)
    ? options.now
    : new Date().toISOString();
  const updated: AgentFingerprintRule = {
    id,
    agent,
    pattern: rawPattern,
    weight,
    description,
  };
  if (flags !== undefined) updated.flags = flags;
  if (prior.addedBy) updated.addedBy = prior.addedBy;
  if (prior.addedAt) updated.addedAt = prior.addedAt;
  if (rationaleUpdate === undefined) {
    if (prior.rationale) updated.rationale = prior.rationale;
  } else if (rationaleUpdate !== null) {
    updated.rationale = rationaleUpdate;
  }
  if (reviewer) updated.editedBy = reviewer;
  updated.editedAt = editedAt;
  const next = [...current];
  next[idx] = updated;
  persist(next);
  CACHED = null;
  return { edited: true, rule: { ...updated }, total: next.length };
}

export interface RemoveAgentFingerprintRuleResult {
  removed: boolean;
  rule?: AgentFingerprintRule;
  total: number;
}

export function removeAgentFingerprintRule(
  rawId: unknown,
): RemoveAgentFingerprintRuleResult {
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new Error("id must be a non-empty string.");
  }
  const id = rawId.trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error("id must be 1-64 characters of [A-Za-z0-9_].");
  }
  const { persisted: current } = load();
  const idx = current.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { removed: false, total: current.length };
  }
  const removed = current[idx];
  const next = current.filter((_, i) => i !== idx);
  persist(next);
  CACHED = null;
  return { removed: true, rule: { ...removed }, total: next.length };
}

export function __resetAgentFingerprintRulesForTests(): void {
  CACHED = null;
  RESOLVED_PATH = null;
}

const MAX_RULES_PER_AGENT = 6;
const STYLO_MAX_POINTS = 4;
const MIN_TOP_SCORE_FOR_LABEL = 5;
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
  const boldHeaderCount = (text.match(/\*\*[^*\n]{1,40}\*\*\s*[:.\n]/g) ?? [])
    .length;
  const bulletCount = (text.match(/(^|\n)\s*(?:[-*•]\s+|\d+\.\s+)/g) ?? [])
    .length;
  return {
    wordCount,
    sentenceCount,
    avgSentenceLen,
    emDashCount,
    boldHeaderCount,
    bulletCount,
  };
}

export function detectAgentFingerprint(
  text: string | null | undefined,
): AgentFingerprintResult {
  const empty: AgentFingerprintResult = {
    likelyAgent: "unknown",
    confidence: 0,
    scores: {
      gpt4: 0,
      claude: 0,
      gemini: 0,
      "cursor-agent": 0,
      "replit-agent": 0,
      human: 0,
    },
    matches: [],
    features: {
      wordCount: 0,
      sentenceCount: 0,
      avgSentenceLen: 0,
      emDashCount: 0,
      boldHeaderCount: 0,
      bulletCount: 0,
    },
  };
  if (!text || typeof text !== "string") return empty;

  const { compiled: RULES } = load();

  const features = styloFeatures(text);
  const scores: Record<Exclude<AgentLabel, "unknown">, number> = {
    gpt4: 0,
    claude: 0,
    gemini: 0,
    "cursor-agent": 0,
    "replit-agent": 0,
    human: 0,
  };
  const perAgentRuleCount: Record<string, number> = {};
  const matches: AgentFingerprintMatch[] = [];

  for (const rule of RULES) {
    perAgentRuleCount[rule.agent] = perAgentRuleCount[rule.agent] ?? 0;
    if (perAgentRuleCount[rule.agent] >= MAX_RULES_PER_AGENT) continue;

    if (rule.pattern.global) {
      const all = text.match(rule.pattern);
      const count = all ? all.length : 0;
      if (count >= 3) {
        const w = rule.weight;
        scores[rule.agent] += w;
        perAgentRuleCount[rule.agent]++;
        const m: AgentFingerprintMatch = {
          id: rule.id,
          description: `${rule.description} (${count}×)`,
          weight: w,
          excerpt: all && all[0] ? excerpt(all[0]) : undefined,
        };
        if (rule.addedBy) m.addedBy = rule.addedBy;
        if (rule.addedAt) m.addedAt = rule.addedAt;
        if (rule.rationale) m.rationale = rule.rationale;
        matches.push(m);
      }
    } else {
      const m = text.match(rule.pattern);
      if (m && m[0]) {
        scores[rule.agent] += rule.weight;
        perAgentRuleCount[rule.agent]++;
        const match: AgentFingerprintMatch = {
          id: rule.id,
          description: rule.description,
          weight: rule.weight,
          excerpt: excerpt(m[0]),
        };
        if (rule.addedBy) match.addedBy = rule.addedBy;
        if (rule.addedAt) match.addedAt = rule.addedAt;
        if (rule.rationale) match.rationale = rule.rationale;
        matches.push(match);
      }
    }
  }

  const stylo = Math.min(
    STYLO_MAX_POINTS,
    Math.round(features.emDashCount / 4) +
      Math.round(features.boldHeaderCount / 3),
  );
  if (stylo > 0 && features.wordCount >= 60) {
    scores.gpt4 += Math.ceil(stylo / 2);
    scores.gemini += Math.floor(stylo / 2);
    matches.push({
      id: "stylo_emdash_bold_density",
      description: `Em-dash + bold-header density (${features.emDashCount} em-dashes, ${features.boldHeaderCount} bold headers)`,
      weight: stylo,
    });
  }
  if (features.avgSentenceLen >= 24 && features.wordCount >= 80) {
    scores.claude += 2;
    matches.push({
      id: "stylo_long_sentences",
      description: `Long mean sentence length (${features.avgSentenceLen.toFixed(1)} words)`,
      weight: 2,
    });
  }
  if (features.bulletCount >= 6 && features.wordCount >= 80) {
    scores.gemini += 2;
    matches.push({
      id: "stylo_bullet_heavy",
      description: `Bullet-heavy formatting (${features.bulletCount} bullets / numbered items)`,
      weight: 2,
    });
  }

  let topAgent: Exclude<AgentLabel, "unknown"> = "gpt4";
  let topScore = -1;
  let runnerUp = 0;
  for (const k of Object.keys(scores) as Array<
    Exclude<AgentLabel, "unknown">
  >) {
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

  const margin = topScore === 0 ? 0 : (topScore - runnerUp) / topScore;
  const magnitude = Math.min(1, topScore / 18);
  const confidence = Math.min(0.95, 0.5 * margin + 0.5 * magnitude);

  return {
    likelyAgent: topAgent,
    confidence: Number(confidence.toFixed(3)),
    scores,
    matches,
    features,
  };
}

export const AGENT_DISPLAY_LABEL: Record<AgentLabel, string> = {
  gpt4: "GPT-4 / ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  "cursor-agent": "Cursor agent",
  "replit-agent": "Replit agent",
  human: "Human",
  unknown: "Unknown",
};
