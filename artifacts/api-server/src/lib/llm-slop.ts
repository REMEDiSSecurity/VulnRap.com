import OpenAI from "openai";
import { createHash } from "crypto";
import { logger } from "./logger";

export interface LLMTriageGuidance {
  reproSteps: string[];
  environment: string[];
  expectedBehavior: string;
  testingTips: string[];
  missingInfo: string[];
  dontMiss: string[];
  reporterFeedback: string;
}

export interface LLMReproRecipe {
  setupCommands: string[];
  pocScript: string | null;
  pocLanguage: string | null;
  expectedOutput: string | null;
  prerequisites: string[];
  cleanupCommands: string[];
}

export interface LLMSlopResult {
  llmSlopScore: number;
  llmFeedback: string[];
  llmBreakdown: LLMBreakdown | null;
  llmRedFlags: string[];
  llmTriageGuidance: LLMTriageGuidance | null;
  llmReproRecipe: LLMReproRecipe | null;
}

export interface LLMBreakdown {
  claimSpecificity: number;
  evidenceQuality: number;
  internalConsistency: number;
  hallucinationSignals: number;
  validityScore: number;
  redFlags: string[];
  greenFlags: string[];
  verdict: string;
}

const LLM_TIMEOUT_MS = 30_000;

const COST_GUARD_LOW = 25;
const COST_GUARD_HIGH = 60;
const COST_GUARD_CONFIDENCE = 0.5;

const resultCache = new Map<string, { result: LLMSlopResult; ts: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_SIZE = 500;

function buildClient(): OpenAI | null {
  const aiIntegrationKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const aiIntegrationUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const legacyKey = process.env.OPENAI_API_KEY;
  const legacyUrl = process.env.OPENAI_BASE_URL;

  const apiKey = aiIntegrationKey || legacyKey;
  const baseURL = aiIntegrationUrl || legacyUrl;

  if (!apiKey) return null;

  const source = aiIntegrationKey ? "replit-ai-integrations" : "legacy-openai";
  logger.info({ source, hasBaseURL: !!baseURL }, "LLM slop: building client");

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

export function isLLMAvailable(): boolean {
  return !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY);
}

export function shouldCallLLM(
  _heuristicScore: number,
  _confidence: number,
): boolean {
  return isLLMAvailable();
}

function getCacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function getCachedResult(text: string): LLMSlopResult | null {
  const key = getCacheKey(text);
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedResult(text: string, result: LLMSlopResult): void {
  if (resultCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey) resultCache.delete(oldestKey);
  }
  resultCache.set(getCacheKey(text), { result, ts: Date.now() });
}

const SYSTEM_PROMPT = `You are a senior vulnerability triage analyst at a major software security program. Your job is NOT to detect if this was written by AI. Your job is to assess whether this report describes a REAL, REPRODUCIBLE vulnerability that could be acted upon.

You will evaluate the report on these four specific criteria:

1. CLAIM SPECIFICITY (0-25 points):
   - Does it name a specific project, version, file path, function, or endpoint?
   - Are the claims detailed enough to actually test or verify?
   - Are generic project names like "your application" used instead of real product names?
   - Score 0 if all claims are generic/vague.
   - Score 15 if some claims are specific (e.g., a function name or file path).
   - Score 25 if every claim is specific and verifiable (e.g., project name + version + file path).

2. EVIDENCE QUALITY (0-25 points):
   - Does it include actual code snippets, HTTP requests, stack traces, or tool output?
   - Could this evidence be VERIFIED by checking the actual codebase or running the test yourself?
   - Is the evidence specific and reproducible, or generic boilerplate?
   - Score 0 if no evidence or only text descriptions.
   - Score 12 if generic evidence (e.g., "' OR '1'='1' --" without target context).
   - Score 25 if evidence is specific and directly verifiable (e.g., actual HTTP request with real endpoints, real file paths).

3. INTERNAL CONSISTENCY (0-25 points):
   - Do the vulnerability type, affected component, and impact align logically?
   - Does the PoC actually match the vulnerability description?
   - Are version numbers, function names, and file paths consistent throughout?
   - Do claims about exploitability match the described vulnerability?
   - Score 0 for major contradictions (e.g., "memory leak in HTTP/3" then PoC shows SQL injection).
   - Score 12 for minor inconsistencies.
   - Score 25 for perfect logical consistency.

4. HALLUCINATION SIGNALS (0-25 points):
   - Does it reference functions/files that might not exist in the named project?
   - Are memory addresses suspiciously patterned (e.g., 0x00007ffff7a43210 repeating in stack trace)?
   - Do stack traces show identical frames repeated (real crashes vary)?
   - Are PID/TID values suspiciously simple (e.g., ==12345==)?
   - Does it claim vulnerability in a version that has since been patched?
   - Score 0 if clear hallucinations (fabricated function names, impossible stack traces, etc.).
   - Score 12 if minor red flags (e.g., suspiciously round memory address, but plausible).
   - Score 25 if no red flags.

CRITICAL RULES FOR YOUR SCORING:
- A well-structured report format is NOT evidence of hallucination.
- Named researchers, CVE IDs, commit SHAs, HTTP requests, and advisory URLs are POSITIVE signals.
- Terse, direct writing style is characteristic of experienced security researchers — do NOT penalize for brevity.
- DO NOT penalize reports for being well-organized or following a template.
- DO penalize reports that are vague, generic, or make unverifiable claims.
- DO penalize reports with obvious hallucinations (functions that don't exist, impossible stack traces, contradictions).

CALIBRATION EXAMPLES:

CALIBRATION EXAMPLE 1 (Score ~15 — Clear Slop):
Title: Critical Buffer Overflow in the_function_that_does_not_exist()
Description: I found a critical buffer overflow in the_function_that_does_not_exist() at lib/fake.c:999. This function has a strcpy() call that can be exploited. A simple curl request causes it to crash.
Analysis:
- Claim Specificity: 10 (names a function and file, but both appear fabricated)
- Evidence Quality: 2 (no actual PoC, just claims)
- Internal Consistency: 5 (the vulnerability type doesn't match the description)
- Hallucination Signals: 0 (obvious red flags: nonexistent function and file)
→ validityScore = 17 (clearly unreliable)

CALIBRATION EXAMPLE 2 (Score ~50 — Genuinely Uncertain):
Title: Possible Integer Overflow in Image Processing
Description: While fuzzing image processing code, I found that large width/height values might cause integer overflow. The exact impact is unclear but could potentially lead to buffer issues.
Analysis:
- Claim Specificity: 10 (names "image processing code" but no specific file)
- Evidence Quality: 12 (describes fuzzing but no actual PoC code)
- Internal Consistency: 12 (logically sound but vague)
- Hallucination Signals: 18 (no obvious red flags, but unverified)
→ validityScore = 52 (could be real, but hard to verify)

CALIBRATION EXAMPLE 3 (Score ~85 — Clearly Legitimate):
Title: Broken Access Control in OpenWebUI Tool Valves (CVE-2026-34222)
Description: The Tool Valves endpoint does not restrict read access. A low-privileged "Member" user can access valve data by using their auth token + guessing Tool IDs from concatenated names. Root cause: Missing admin permission check on the Tool Valves route. Fixed in v0.8.11 at commit f949d17.
Evidence: https://github.com/open-webui/open-webui/commit/f949d17
Analysis:
- Claim Specificity: 25 (specific endpoint, version, commit, CVE ID)
- Evidence Quality: 25 (actual code change with fix, verifiable)
- Internal Consistency: 25 (perfectly consistent)
- Hallucination Signals: 25 (no red flags; all claims are verifiable)
→ validityScore = 100 (clearly legitimate)

## Triage Guidance
Also produce actionable triage guidance for the PSIRT team receiving this report:
- **repro_steps**: 2-5 concrete steps a triager should follow to reproduce this specific vulnerability (not generic steps — reference details from the report)
- **environment**: 2-4 environment requirements for reproduction (OS, software version, configuration, prerequisites, hardware notes if relevant)
- **expected_behavior**: 1-2 sentences describing what the triager should observe if the vulnerability is real
- **testing_tips**: 1-3 specific testing tips relevant to this vulnerability type
- **missing_info**: 1-4 specific pieces of information missing from the report that would be needed for reproduction
- **dont_miss**: 1-3 warnings about things a triager might overlook when evaluating this report
- **reporter_feedback**: 2-3 sentences assessing the reporter's likely expertise/intent, clarity of writing, and actionability of the report

## Response Format
Return a JSON object in this exact format:
{
  "claimSpecificity": <0-25>,
  "evidenceQuality": <0-25>,
  "internalConsistency": <0-25>,
  "hallucinationSignals": <0-25>,
  "validityScore": <0-100>,
  "red_flags": ["list of specific concerns if any"],
  "green_flags": ["list of positive indicators"],
  "verdict": "LIKELY_VALID" | "UNCERTAIN" | "LIKELY_FABRICATED",
  "reasoning": "<2-3 sentence summary>",
  "triage_guidance": {
    "repro_steps": ["<step 1>", "<step 2>", ...],
    "environment": ["<env requirement 1>", ...],
    "expected_behavior": "<what should happen if the vuln is real>",
    "testing_tips": ["<tip 1>", ...],
    "missing_info": ["<missing item 1>", ...],
    "dont_miss": ["<warning 1>", ...],
    "reporter_feedback": "<2-3 sentence assessment>"
  },
  "reproduction_recipe": {
    "setup_commands": ["<shell command 1>", "<shell command 2>", ...],
    "poc_script": "<the PoC as a single runnable script, with comments>",
    "poc_language": "<bash|python|ruby|go|java|curl|http>",
    "expected_output": "<1-2 sentences: what output confirms the vuln is real>",
    "prerequisites": ["<prerequisite 1>", ...],
    "cleanup_commands": ["<teardown command 1>", ...]
  }
}

Rules:
- red_flags: 0-4 items, each a concrete observation referencing actual content
- green_flags: 0-4 items, each a concrete positive observation
- reasoning: concise, references specific parts of the report
- triage_guidance: always present, reference specifics from the report, not generic advice
- reproduction_recipe: always present. setup_commands should be concrete shell commands to install and run the target at the claimed version. poc_script should be a complete, runnable script (not pseudocode) based on the report's claims. If the report lacks enough detail for a runnable PoC, produce your best approximation with TODO comments marking what the triager needs to fill in. poc_language should match the script language. prerequisites lists required tools/SDKs. cleanup_commands lists any teardown needed (kill processes, remove containers, etc.)
- Do not mention that you are an AI`;

async function analyzeSlopWithLLMOnce(
  client: OpenAI,
  truncatedText: string,
): Promise<LLMSlopResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const startMs = Date.now();
    logger.info({ model, textLength: truncatedText.length }, "LLM slop: sending request");

    const response = await client.chat.completions.create(
      {
        model,
        temperature: 0.1,
        max_completion_tokens: 2500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Score this vulnerability report for AI-generated slop:\n\n---\n${truncatedText}\n---`,
          },
        ],
      },
      { signal: controller.signal }
    );

    const elapsedMs = Date.now() - startMs;
    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    logger.info({ rawLength: raw.length, elapsedMs }, "LLM slop: received response");

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw: raw.slice(0, 200) }, "LLM slop: no JSON found in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      claimSpecificity?: number;
      evidenceQuality?: number;
      internalConsistency?: number;
      hallucinationSignals?: number;
      validityScore?: number;
      red_flags?: string[];
      green_flags?: string[];
      verdict?: string;
      reasoning?: string;
      score?: number;
      observations?: string[];
      specificity?: number;
      originality?: number;
      voice?: number;
      coherence?: number;
      hallucination?: number;
      triage_guidance?: {
        repro_steps?: string[];
        environment?: string[];
        expected_behavior?: string;
        testing_tips?: string[];
        missing_info?: string[];
        dont_miss?: string[];
        reporter_feedback?: string;
      };
      reproduction_recipe?: {
        setup_commands?: string[];
        poc_script?: string;
        poc_language?: string;
        expected_output?: string;
        prerequisites?: string[];
        cleanup_commands?: string[];
      };
    };

    const hasV2Format = parsed.claimSpecificity !== undefined ||
      parsed.evidenceQuality !== undefined ||
      parsed.internalConsistency !== undefined ||
      parsed.hallucinationSignals !== undefined;

    const hasV1Format = parsed.specificity !== undefined ||
      parsed.originality !== undefined ||
      parsed.voice !== undefined;

    let breakdown: LLMBreakdown;
    let weightedScore: number;

    if (hasV2Format) {
      const cs = clamp25(parsed.claimSpecificity ?? 12);
      const eq = clamp25(parsed.evidenceQuality ?? 12);
      const ic = clamp25(parsed.internalConsistency ?? 12);
      const hs = clamp25(parsed.hallucinationSignals ?? 12);
      const vs = typeof parsed.validityScore === "number"
        ? clamp(parsed.validityScore)
        : clamp(Math.round((cs + eq + ic + hs) * 100 / 100));

      breakdown = {
        claimSpecificity: cs,
        evidenceQuality: eq,
        internalConsistency: ic,
        hallucinationSignals: hs,
        validityScore: vs,
        redFlags: Array.isArray(parsed.red_flags)
          ? parsed.red_flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 4)
          : [],
        greenFlags: Array.isArray(parsed.green_flags)
          ? parsed.green_flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 4)
          : [],
        verdict: typeof parsed.verdict === "string" ? parsed.verdict : "UNCERTAIN",
      };

      weightedScore = 100 - vs;
    } else if (hasV1Format) {
      const spec = clamp(parsed.specificity ?? 50);
      const orig = clamp(parsed.originality ?? 50);
      const voice = clamp(parsed.voice ?? 50);
      const coh = clamp(parsed.coherence ?? 50);
      const hall = clamp(parsed.hallucination ?? 50);

      const v1SlopScore = Math.round(
        spec * 0.15 + orig * 0.25 + voice * 0.20 + coh * 0.15 + hall * 0.25
      );
      const mappedValidity = 100 - v1SlopScore;

      breakdown = {
        claimSpecificity: Math.round((100 - spec) * 25 / 100),
        evidenceQuality: Math.round((100 - orig) * 25 / 100),
        internalConsistency: Math.round((100 - coh) * 25 / 100),
        hallucinationSignals: Math.round((100 - hall) * 25 / 100),
        validityScore: mappedValidity,
        redFlags: Array.isArray(parsed.red_flags)
          ? parsed.red_flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 4)
          : [],
        greenFlags: [],
        verdict: mappedValidity >= 70 ? "LIKELY_VALID" : mappedValidity >= 40 ? "UNCERTAIN" : "LIKELY_FABRICATED",
      };

      weightedScore = v1SlopScore;
      logger.info({ v1SlopScore, mappedValidity }, "LLM slop: mapped V1 format to V2");
    } else if (typeof parsed.score === "number") {
      const legacyScore = clamp(parsed.score);
      const mappedValidity = 100 - legacyScore;
      breakdown = {
        claimSpecificity: Math.round(mappedValidity * 25 / 100),
        evidenceQuality: Math.round(mappedValidity * 25 / 100),
        internalConsistency: Math.round(mappedValidity * 25 / 100),
        hallucinationSignals: Math.round(mappedValidity * 25 / 100),
        validityScore: mappedValidity,
        redFlags: [],
        greenFlags: [],
        verdict: "UNCERTAIN",
      };
      weightedScore = legacyScore;
      logger.info({ legacyScore }, "LLM slop: used legacy score format");
    } else {
      logger.warn("LLM slop: response missing all known fields");
      return null;
    }

    const redFlags = breakdown.redFlags;

    const feedback: string[] = [];
    if (typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0) {
      feedback.push(parsed.reasoning.trim());
    }
    if (Array.isArray(parsed.observations)) {
      for (const obs of parsed.observations) {
        if (typeof obs === "string" && obs.trim().length > 0) {
          feedback.push(obs.trim());
        }
      }
    }
    for (const flag of redFlags) {
      feedback.push(flag);
    }

    if (feedback.length === 0) {
      feedback.push(`LLM analysis complete: validity ${breakdown.validityScore}/100 (${breakdown.verdict})`);
    }

    let llmTriageGuidance: LLMTriageGuidance | null = null;
    if (parsed.triage_guidance) {
      const tg = parsed.triage_guidance;
      const reproSteps = Array.isArray(tg.repro_steps)
        ? tg.repro_steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 5)
        : [];
      const missingInfo = Array.isArray(tg.missing_info)
        ? tg.missing_info.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 4)
        : [];
      const dontMiss = Array.isArray(tg.dont_miss)
        ? tg.dont_miss.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 3)
        : [];
      const reporterFeedback = typeof tg.reporter_feedback === "string" ? tg.reporter_feedback.trim() : "";

      const environment = Array.isArray(tg.environment)
        ? tg.environment.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 4)
        : [];
      const expectedBehavior = typeof tg.expected_behavior === "string" ? tg.expected_behavior.trim() : "";
      const testingTips = Array.isArray(tg.testing_tips)
        ? tg.testing_tips.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 3)
        : [];

      if (reproSteps.length > 0 || missingInfo.length > 0 || dontMiss.length > 0 || reporterFeedback.length > 0 || environment.length > 0 || expectedBehavior.length > 0 || testingTips.length > 0) {
        llmTriageGuidance = { reproSteps, environment, expectedBehavior, testingTips, missingInfo, dontMiss, reporterFeedback };
      }
    }

    let llmReproRecipe: LLMReproRecipe | null = null;
    if (parsed.reproduction_recipe) {
      const rr = parsed.reproduction_recipe;
      const setupCommands = Array.isArray(rr.setup_commands)
        ? rr.setup_commands.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 15)
        : [];
      const pocScript = typeof rr.poc_script === "string" && rr.poc_script.trim().length > 0 ? rr.poc_script.trim() : null;
      const pocLanguage = typeof rr.poc_language === "string" ? rr.poc_language.trim().toLowerCase() : null;
      const expectedOutput = typeof rr.expected_output === "string" && rr.expected_output.trim().length > 0 ? rr.expected_output.trim() : null;
      const prerequisites = Array.isArray(rr.prerequisites)
        ? rr.prerequisites.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 8)
        : [];
      const cleanupCommands = Array.isArray(rr.cleanup_commands)
        ? rr.cleanup_commands.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 5)
        : [];

      if (setupCommands.length > 0 || pocScript) {
        llmReproRecipe = { setupCommands, pocScript, pocLanguage, expectedOutput, prerequisites, cleanupCommands };
      }
    }

    logger.info({ weightedScore, validity: breakdown.validityScore, verdict: breakdown.verdict, hasTriageGuidance: !!llmTriageGuidance, hasReproRecipe: !!llmReproRecipe, elapsedMs }, "LLM slop: analysis complete");

    const result: LLMSlopResult = {
      llmSlopScore: clamp(weightedScore),
      llmFeedback: feedback,
      llmBreakdown: breakdown,
      llmRedFlags: redFlags,
      llmTriageGuidance,
      llmReproRecipe,
    };

    setCachedResult(truncatedText, result);

    return result;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn("LLM slop: timed out");
    } else {
      logger.warn({ err }, "LLM slop: analysis failed");
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeSlopWithLLM(
  text: string
): Promise<LLMSlopResult | null> {
  const client = buildClient();
  if (!client) {
    logger.info("LLM slop: no API key configured, skipping LLM analysis");
    return null;
  }

  const truncatedText =
    text.length > 6000 ? text.slice(0, 6000) + "\n\n[truncated for analysis]" : text;

  const cached = getCachedResult(truncatedText);
  if (cached) {
    logger.info("LLM slop: returning cached result");
    return cached;
  }

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await analyzeSlopWithLLMOnce(client, truncatedText);
    if (result) return result;

    if (attempt < MAX_RETRIES) {
      const delayMs = 1000 * Math.pow(2, attempt);
      logger.info({ attempt: attempt + 1, delayMs }, "LLM slop: retrying after failure");
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  logger.warn("LLM slop: all retry attempts exhausted");
  return null;
}

function clamp(val: number): number {
  return Math.min(100, Math.max(0, Math.round(Number(val) || 0)));
}

function clamp25(val: number): number {
  return Math.min(25, Math.max(0, Math.round(Number(val) || 0)));
}
