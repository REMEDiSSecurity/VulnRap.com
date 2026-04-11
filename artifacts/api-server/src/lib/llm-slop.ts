import OpenAI from "openai";
import { logger } from "./logger";

export interface LLMSlopResult {
  llmSlopScore: number;
  llmFeedback: string[];
}

const LLM_TIMEOUT_MS = 20_000;

function buildClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;

  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

export function isLLMAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

const SYSTEM_PROMPT = `You are a PSIRT (Product Security Incident Response Team) triage analyst evaluating incoming vulnerability reports. Your job is to score how likely a report is AI-generated "slop" vs. genuine human security research — helping triage teams decide where to invest limited review time.

Score the report from 0 to 100, where:
- 0–14: Probably Legit — reads like genuine human research with verifiable details
- 15–29: Mildly Suspicious — mostly credible but has minor AI-like patterns
- 30–49: Questionable — noticeable AI-generation signals; needs closer triage review
- 50–69: Highly Suspicious — multiple strong AI-generation indicators; likely wastes triage time
- 70–100: Pure Slop — overwhelmingly AI-generated; safe to deprioritize

Evaluate these PSIRT-specific dimensions (semantic signals that regex cannot catch):

1. **Technical specificity** — Are version numbers, endpoints, payloads, and system details concrete and internally consistent? Or are they vague placeholders (e.g., "the API endpoint", "a recent version")? Real researchers cite exact versions, paths, and parameters.

2. **PoC validity** — Does the proof-of-concept actually demonstrate the claimed vulnerability class? A report claiming SQLi but showing only an XSS payload, or describing a generic attack without a working exploit, is a red flag. Check if reproduction steps would actually trigger the described behavior.

3. **Target specificity** — Could this report be copy-pasted against ANY application with minimal edits? Mass-submission slop uses templated language with slot-filled product names. Genuine reports contain observations specific to the target's actual behavior, error messages, or architecture.

4. **Narrative credibility** — Does the report read like someone who actually tested this? Look for signs of real interaction: specific error messages encountered, unexpected behaviors observed, iterative discovery. AI slop tends to describe idealized attack flows without the messy reality of actual testing.

5. **Template & mass-submission signals** — Does the report follow a rigid template structure identical to known AI-generated vulnerability reports? Look for: identical section ordering across all vuln types, placeholder-like descriptions, claims of "critical" severity without supporting evidence, and boilerplate remediation advice copied verbatim from OWASP/CWE descriptions.

Respond ONLY with a valid JSON object — no preamble, no markdown, no explanation outside the JSON:
{
  "score": <integer 0-100>,
  "observations": [
    "<specific observation about THIS report>",
    "<specific observation about THIS report>",
    "<specific observation about THIS report>"
  ]
}

Rules:
- observations array must have exactly 2–4 items
- Each observation must be a concrete, actionable sentence referencing actual content from this report
- Frame observations from a PSIRT triage perspective: "A triage analyst would notice..." or "This report [does/lacks]..."
- Do not use generic statements. Reference actual phrases, sections, or details (or their absence) from the report.
- Do not mention that you are an AI or that you are analyzing the report`;

export async function analyzeSlopWithLLM(
  text: string
): Promise<LLMSlopResult | null> {
  const client = buildClient();
  if (!client) return null;

  const truncatedText =
    text.length > 8000 ? text.slice(0, 8000) + "\n\n[truncated for analysis]" : text;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        max_completion_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `You are triaging this incoming vulnerability report. Score it for AI-generated slop:\n\n---\n${truncatedText}\n---`,
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
