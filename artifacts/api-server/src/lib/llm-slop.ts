import OpenAI from "openai";
import { createHash } from "crypto";
import { logger } from "./logger";

export interface LLMSlopResult {
  llmSlopScore: number;
  llmFeedback: string[];
  llmBreakdown: LLMBreakdown | null;
  llmRedFlags: string[];
}

export interface LLMBreakdown {
  specificity: number;
  originality: number;
  voice: number;
  coherence: number;
  hallucination: number;
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
  heuristicScore: number,
  confidence: number,
): boolean {
  if (!isLLMAvailable()) return false;
  if (confidence < COST_GUARD_CONFIDENCE) return true;
  if (heuristicScore >= COST_GUARD_LOW && heuristicScore <= COST_GUARD_HIGH) return true;
  return false;
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

const SYSTEM_PROMPT = `You are a PSIRT triage analyst scoring vulnerability reports for AI-generated "slop." Evaluate five dimensions and return structured JSON.

## Scoring Dimensions (each 0-100, where 100 = most suspicious/AI-like)

1. **specificity** (weight 0.15): Are technical details concrete and verifiable? Score HIGH if vague placeholders ("the endpoint", "a recent version"), generic descriptions. Score LOW if exact versions, paths, parameters, error messages.

2. **originality** (weight 0.25): Does this read like original research or template-stuffed AI output? Score HIGH if it follows rigid vulnerability template patterns, uses boilerplate remediation, could be copy-pasted to any target. Score LOW if observations are specific to this target, contain unique findings.

3. **voice** (weight 0.20): Does the writing voice sound human? Score HIGH if overly formal, no contractions, uniform sentence length, AI buzzwords ("delve", "paramount", "multifaceted", "comprehensive analysis"). Score LOW if natural/informal, variable sentence structure, domain-specific jargon used correctly.

4. **coherence** (weight 0.15): Is the vulnerability description internally consistent? Score HIGH if the claimed vuln class doesn't match the evidence, PoC doesn't demonstrate the claim, or attack flow is idealized without real-world testing artifacts. Score LOW if claims match evidence, PoC is relevant.

5. **hallucination** (weight 0.25): Are there signs of fabricated technical details? Score HIGH if function names seem invented, CVE IDs look wrong, severity claims lack evidence, generic code snippets that wouldn't actually work. Score LOW if technical details appear real and verifiable.

## Response Format
Respond ONLY with valid JSON:
{
  "specificity": <0-100>,
  "originality": <0-100>,
  "voice": <0-100>,
  "coherence": <0-100>,
  "hallucination": <0-100>,
  "red_flags": ["<specific red flag from THIS report>", ...],
  "reasoning": "<2-3 sentence summary of your assessment>"
}

Rules:
- red_flags: 0-4 items, each a concrete observation referencing actual content
- reasoning: concise, references specific parts of the report
- Do not mention that you are an AI`;

export async function analyzeSlopWithLLM(
  text: string
): Promise<LLMSlopResult | null> {
  const client = buildClient();
  if (!client) {
    logger.info("LLM slop: no API key configured, skipping LLM analysis");
    return null;
  }

  const truncatedText =
    text.length > 4000 ? text.slice(0, 4000) + "\n\n[truncated for analysis]" : text;

  const cached = getCachedResult(truncatedText);
  if (cached) {
    logger.info("LLM slop: returning cached result");
    return cached;
  }

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
        max_completion_tokens: 600,
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
      specificity?: number;
      originality?: number;
      voice?: number;
      coherence?: number;
      hallucination?: number;
      red_flags?: string[];
      reasoning?: string;
      score?: number;
      observations?: string[];
    };

    const hasNewFormat = parsed.specificity !== undefined ||
      parsed.originality !== undefined ||
      parsed.voice !== undefined;

    let breakdown: LLMBreakdown;
    let weightedScore: number;

    if (hasNewFormat) {
      breakdown = {
        specificity: clamp(parsed.specificity ?? 50),
        originality: clamp(parsed.originality ?? 50),
        voice: clamp(parsed.voice ?? 50),
        coherence: clamp(parsed.coherence ?? 50),
        hallucination: clamp(parsed.hallucination ?? 50),
      };

      weightedScore = Math.round(
        breakdown.specificity * 0.15 +
        breakdown.originality * 0.25 +
        breakdown.voice * 0.20 +
        breakdown.coherence * 0.15 +
        breakdown.hallucination * 0.25
      );
    } else if (typeof parsed.score === "number") {
      const legacyScore = clamp(parsed.score);
      breakdown = {
        specificity: legacyScore,
        originality: legacyScore,
        voice: legacyScore,
        coherence: legacyScore,
        hallucination: legacyScore,
      };
      weightedScore = legacyScore;
      logger.info({ legacyScore }, "LLM slop: used legacy score format");
    } else {
      logger.warn("LLM slop: response missing both new and legacy fields");
      return null;
    }

    const redFlags = Array.isArray(parsed.red_flags)
      ? parsed.red_flags.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 4)
      : [];

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
      feedback.push(`LLM analysis complete: weighted score ${weightedScore}/100`);
    }

    logger.info({ weightedScore, breakdown, elapsedMs }, "LLM slop: analysis complete");

    const result: LLMSlopResult = {
      llmSlopScore: clamp(weightedScore),
      llmFeedback: feedback,
      llmBreakdown: breakdown,
      llmRedFlags: redFlags,
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

function clamp(val: number): number {
  return Math.min(100, Math.max(0, Math.round(Number(val) || 0)));
}
