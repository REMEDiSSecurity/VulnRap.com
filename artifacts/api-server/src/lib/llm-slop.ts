import OpenAI from "openai";
import { logger } from "./logger";

export interface LLMSlopResult {
  llmSlopScore: number;
  llmFeedback: string[];
}

const LLM_TIMEOUT_MS = 20_000;

function buildClient(): OpenAI | null {
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

export function isLLMAvailable(): boolean {
  return !!(
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY
  );
}

const SYSTEM_PROMPT = `You are a vulnerability report quality analyst. Your job is to evaluate whether a given vulnerability report appears to be AI-generated "slop" or a genuine human-written research finding.

Score the report from 0 to 100, where:
- 0–14: Probably Legit — reads like genuine human research
- 15–29: Mildly Suspicious — mostly human but has some AI-like patterns
- 30–49: Questionable — noticeable AI-generation signals
- 50–69: Highly Suspicious — multiple strong AI-generation indicators
- 70–100: Pure Slop — overwhelmingly AI-generated markers

Focus on SEMANTIC signals that regex cannot catch:
1. Technical specificity — Are version numbers, endpoints, payloads, and system details real and consistent, or vague and generic?
2. Internal coherence — Does the PoC actually demonstrate the claimed vulnerability? Do the reproduction steps logically follow from the described issue?
3. Genericity — Could this report describe ANY application, or is it clearly tied to a specific target with concrete observations?
4. Narrative credibility — Does it read like someone who actually found and verified this issue, or like an AI hallucinating a plausible-sounding report structure?

Respond ONLY with a valid JSON object — no preamble, no markdown, no explanation outside the JSON:
{
  "score": <integer 0-100>,
  "observations": [
    "<specific observation 1>",
    "<specific observation 2>",
    "<specific observation 3>"
  ]
}

Rules:
- observations array must have exactly 2–4 items
- Each observation must be a concrete, actionable sentence about THIS specific report
- Do not use generic statements. Reference actual content from the report.
- Do not mention that you are an AI or that you are analyzing the report`;

export async function analyzeSlopWithLLM(
  text: string
): Promise<LLMSlopResult | null> {
  const client = buildClient();
  if (!client) return null;

  const truncatedText =
    text.length > 6000 ? text.slice(0, 6000) + "\n\n[truncated for analysis]" : text;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: "gpt-5-nano",
        max_completion_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze this vulnerability report:\n\n---\n${truncatedText}\n---`,
          },
        ],
      },
      { signal: controller.signal }
    );

    const raw = response.choices[0]?.message?.content?.trim() ?? "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn("LLM slop: no JSON found in response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      score: number;
      observations: string[];
    };

    const score = Math.min(100, Math.max(0, Math.round(Number(parsed.score))));
    const observations = Array.isArray(parsed.observations)
      ? parsed.observations
          .filter((o) => typeof o === "string" && o.trim().length > 0)
          .slice(0, 4)
      : [];

    if (observations.length === 0) {
      logger.warn("LLM slop: empty observations");
      return null;
    }

    return { llmSlopScore: score, llmFeedback: observations };
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

export function blendSlopScores(
  heuristicScore: number,
  llmScore: number
): number {
  return Math.min(100, Math.max(0, Math.round(heuristicScore * 0.4 + llmScore * 0.6)));
}

export function getSlopTier(score: number): string {
  if (score >= 70) return "Pure Slop";
  if (score >= 50) return "Highly Suspicious";
  if (score >= 30) return "Questionable";
  if (score >= 15) return "Mildly Suspicious";
  return "Probably Legit";
}
