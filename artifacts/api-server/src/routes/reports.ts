import { Router, type IRouter } from "express";
import crypto from "crypto";
import multer from "multer";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { reportsTable, reportHashesTable, similarityResultsTable, reportStatsTable } from "@workspace/db";
import {
  GetReportParams,
  GetReportResponse,
  GetVerificationParams,
  GetVerificationResponse,
  CheckReportResponse,
  LookupByHashParams,
  LookupByHashResponse,
  GetReportFeedResponse,
  DeleteReportBody,
  DeleteReportResponse,
  CompareReportsParams,
  CompareReportsResponse,
} from "@workspace/api-zod";
import { computeMinHash, computeSimhash, computeContentHash, computeLSHBuckets, findSimilarReports } from "../lib/similarity";
import { analyzeSloppiness } from "../lib/sloppiness";
import { analyzeSlopWithLLM, shouldCallLLM, isLLMAvailable, type LLMSlopResult } from "../lib/llm-slop";
import { analyzeLinguistic } from "../lib/linguistic-analysis";
import { analyzeFactual } from "../lib/factual-verification";
import { fuseScores, recomputeSlopScoreWithoutLlm, type FusionResult, type EvidenceItem, type Quadrant, type Archetype, type AnalysisMode } from "../lib/score-fusion";
import { generateConfigImpactNotices, type ConfigImpactNotice } from "../lib/config-notices";
import { redactReport } from "../lib/redactor";
import { parseSections, findSectionMatches } from "../lib/section-parser";
import { sanitizeText, sanitizeForAnalysis, sanitizeFileName, detectBinaryContent } from "../lib/sanitize";
import { extractTextFromPdf } from "../lib/pdf";
import { logger } from "../lib/logger";
import { performActiveVerification, type VerificationResult } from "../lib/active-verification";
import { analyzeWithEngines, type CompositeResult as VulnrapComposite } from "../lib/engines";
import {
  generateTriageRecommendation,
  computeTemporalSignals,
  computeTemplateHash,
  detectRevision,
  type TriageRecommendation,
} from "../lib/triage-recommendation";
import {
  generateTriageAssistant,
  type TriageAssistantResult,
} from "../lib/triage-assistant";

function parseBoolParam(value: unknown): boolean {
  return value === "true" || value === true;
}

function safeBreakdown(bd: unknown): {
  linguistic: number; factual: number; template: number;
  llm: number | null; verification: number | null; quality: number;
  scoringConfigVersion?: string; spectral?: number; evidenceQuality?: number;
  hallucinationDetector?: number; claimSpecificity?: number; internalConsistency?: number;
} {
  const raw = (bd && typeof bd === "object" ? bd : {}) as Record<string, unknown>;
  return {
    linguistic: typeof raw.linguistic === "number" ? raw.linguistic : 0,
    factual: typeof raw.factual === "number" ? raw.factual : 0,
    template: typeof raw.template === "number" ? raw.template : 0,
    llm: typeof raw.llm === "number" ? raw.llm : null,
    verification: typeof raw.verification === "number" ? raw.verification : null,
    quality: typeof raw.quality === "number" ? raw.quality : 50,
    ...(typeof raw.scoringConfigVersion === "string" ? { scoringConfigVersion: raw.scoringConfigVersion } : {}),
    ...(typeof raw.spectral === "number" ? { spectral: raw.spectral } : {}),
    ...(typeof raw.evidenceQuality === "number" ? { evidenceQuality: raw.evidenceQuality } : {}),
    ...(typeof raw.hallucinationDetector === "number" ? { hallucinationDetector: raw.hallucinationDetector } : {}),
    ...(typeof raw.claimSpecificity === "number" ? { claimSpecificity: raw.claimSpecificity } : {}),
    ...(typeof raw.internalConsistency === "number" ? { internalConsistency: raw.internalConsistency } : {}),
    ...(raw.substanceScore != null ? { substanceScore: raw.substanceScore } : {}),
    ...(raw.coherenceScore != null ? { coherenceScore: raw.coherenceScore } : {}),
    ...(raw.pocValidity != null ? { pocValidity: raw.pocValidity } : {}),
    ...(raw.domainCoherence != null ? { domainCoherence: raw.domainCoherence } : {}),
  };
}

interface StageStatus {
  status: "ok" | "error";
  durationMs: number;
  error?: string;
}

interface CrashInfo {
  message: string;
  stage: string;
  inputLength: number;
}

interface AnalysisDiagnostics {
  inputStats: {
    charCount: number;
    lineCount: number;
    wordCount: number;
    maxLineLength: number;
    containsPlaceholders: boolean;
  };
  stages: Record<string, StageStatus>;
  parseWarnings: Array<{ type: string; detail: string }>;
  totalDurationMs: number;
  crashInfo: CrashInfo | null;
}

interface AnalysisResult extends FusionResult {
  feedback: string[];
  llmResult: Awaited<ReturnType<typeof analyzeSlopWithLLM>>;
  verification: VerificationResult | null;
  triageRecommendation: TriageRecommendation | null;
  triageAssistant: TriageAssistantResult | null;
  diagnostics: AnalysisDiagnostics;
}

async function runStage<T>(
  name: string,
  fn: () => T | Promise<T>,
  diagnostics: AnalysisDiagnostics,
): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await fn();
    diagnostics.stages[name] = { status: "ok", durationMs: Date.now() - start };
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.stages[name] = { status: "error", durationMs: Date.now() - start, error: msg };
    diagnostics.parseWarnings.push({ type: `stage_failed_${name}`, detail: `${name} stage threw: ${msg}` });
    logger.warn({ err, stage: name }, `Analysis stage ${name} failed`);
    return null;
  }
}

async function performAnalysis(originalText: string, redactedText: string, opts?: { skipLlm?: boolean }): Promise<AnalysisResult> {
  const pipelineStart = Date.now();

  const safeOriginal = sanitizeForAnalysis(originalText);
  const safeRedacted = sanitizeForAnalysis(redactedText);

  const lines = safeOriginal.split("\n");
  let maxLineLength = 0;
  for (const line of lines) {
    if (line.length > maxLineLength) maxLineLength = line.length;
  }

  const diagnostics: AnalysisDiagnostics = {
    inputStats: {
      charCount: safeOriginal.length,
      lineCount: lines.length,
      wordCount: (safeOriginal.match(/\b\w+\b/g) || []).length,
      maxLineLength,
      containsPlaceholders: /\[REDACTED\]|\[REMOVED\]|\[CENSORED\]/i.test(safeOriginal),
    },
    stages: {},
    parseWarnings: [],
    totalDurationMs: 0,
    crashInfo: null,
  };

  if (diagnostics.inputStats.maxLineLength > 10000) {
    diagnostics.parseWarnings.push({
      type: "extremely_long_lines",
      detail: `Longest line is ${diagnostics.inputStats.maxLineLength} chars — may cause regex backtracking.`,
    });
  }

  try {
    const userSkippedLlm = opts?.skipLlm === true;
    const llmAvailable = isLLMAvailable();
    const callLlm = !userSkippedLlm && llmAvailable;

    const llmPromise = callLlm
      ? runStage("llm_analysis", () => analyzeSlopWithLLM(safeRedacted), diagnostics)
      : Promise.resolve(null);

    const [heuristic, linguistic, factual, verification] = await Promise.all([
      runStage("heuristic_analysis", () => analyzeSloppiness(safeOriginal), diagnostics),
      runStage("linguistic_analysis", () => analyzeLinguistic(safeOriginal), diagnostics),
      runStage("factual_verification", () => analyzeFactual(safeOriginal), diagnostics),
      runStage("active_verification", () => performActiveVerification(safeRedacted), diagnostics),
    ]);

    const llmResult: LLMSlopResult | null = (await llmPromise) ?? null;

    if (!callLlm) {
      diagnostics.stages["llm_analysis"] = { status: "ok", durationMs: 0, error: userSkippedLlm ? "skipped_by_user" : "not_needed" };
    }

    const safeLinguistic = linguistic ?? { score: 0, lexicalScore: 0, statisticalScore: 0, templateScore: 0, evidence: [] };
    const safeFactual = factual ?? { score: 0, severityInflationScore: 0, placeholderScore: 0, fabricatedOutputScore: 0, evidence: [] };
    const safeQuality = heuristic?.qualityScore ?? 50;

    logger.info(
      { llmAvailable, callLlm, userSkippedLlm, llmSucceeded: !!llmResult },
      "LLM decision"
    );

    const fusion = await runStage("score_fusion", () =>
      fuseScores(safeLinguistic, safeFactual, llmResult, safeQuality, safeOriginal, undefined, verification),
      diagnostics,
    );

    const safeFusion = fusion ?? {
      slopScore: 50, qualityScore: safeQuality, confidence: 0.3,
      breakdown: { linguistic: 0, factual: 0, template: 0, llm: null, verification: null, quality: safeQuality },
      evidence: [], humanIndicators: [], slopTier: "Questionable",
      authenticityScore: 50, validityScore: 50, quadrant: "WEAK_HUMAN" as const,
      archetype: "REQUEST_DETAILS" as const, analysisMode: "heuristic_only" as const, confidenceNote: null,
      claims: null, substance: null,
    };

    let triageRecommendation: TriageRecommendation | null = null;
    const triageRecResult = await runStage("triage_recommendation", () => {
      const base = generateTriageRecommendation(
        safeFusion.slopScore, safeFusion.confidence, verification, safeFusion.evidence,
      );
      const temporalSignals = computeTemporalSignals(verification);
      return { ...base, temporalSignals, templateMatch: null, revision: null };
    }, diagnostics);
    triageRecommendation = triageRecResult;

    let triageAssistant: TriageAssistantResult | null = null;
    const triageAstResult = await runStage("triage_assistant", () =>
      generateTriageAssistant(
        safeOriginal, safeFusion.slopScore, safeFusion.confidence, safeFusion.evidence,
        verification, llmResult?.llmTriageGuidance ?? null, llmResult?.llmReproRecipe ?? null,
      ), diagnostics);
    triageAssistant = triageAstResult;

    diagnostics.totalDurationMs = Date.now() - pipelineStart;

    return {
      ...safeFusion,
      feedback: heuristic?.feedback ?? [],
      llmResult,
      verification,
      triageRecommendation,
      triageAssistant,
      diagnostics,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    logger.error(
      { err, inputLength: safeOriginal.length, inputPreview: safeOriginal.substring(0, 200), stages: diagnostics.stages },
      "=== ANALYSIS PIPELINE CRASH ==="
    );

    diagnostics.totalDurationMs = Date.now() - pipelineStart;
    diagnostics.crashInfo = {
      message: msg,
      stage: Object.entries(diagnostics.stages).find(([, v]) => v.status !== "ok" && v.status !== "error")?.[0] || "unknown",
      inputLength: safeOriginal.length,
    };

    return {
      slopScore: 30,
      qualityScore: 50,
      confidence: 0.3,
      breakdown: { linguistic: 0, factual: 0, template: 0, llm: null, verification: null, quality: 50 },
      evidence: [],
      humanIndicators: [],
      slopTier: "Likely Human" as const,
      authenticityScore: 0,
      validityScore: 0,
      quadrant: "WEAK_HUMAN" as const,
      archetype: "REQUEST_DETAILS" as const,
      analysisMode: "heuristic_only" as const,
      confidenceNote: "Analysis ran in degraded mode due to an internal error. Scores may be unreliable.",
      claims: null,
      substance: null,
      feedback: [],
      llmResult: null,
      verification: null,
      triageRecommendation: null,
      triageAssistant: null,
      diagnostics,
    };
  }
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_URL_SIZE = 5 * 1024 * 1024;
const URL_TIMEOUT_MS = 15_000;

const ALLOWED_URL_HOSTS = [
  "raw.githubusercontent.com",
  "github.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "gitlab.com",
  "pastebin.com",
  "dpaste.org",
  "hastebin.com",
  "paste.debian.net",
  "bpa.st",
];

function normalizeGitHubUrl(url: string): string {
  const ghBlobMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/
  );
  if (ghBlobMatch) {
    return `https://raw.githubusercontent.com/${ghBlobMatch[1]}/${ghBlobMatch[2]}`;
  }
  const gistMatch = url.match(
    /^https?:\/\/gist\.github\.com\/([^/]+\/[a-f0-9]+)\/?$/
  );
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/raw`;
  }
  return url;
}

async function fetchUrlContent(rawUrl: string): Promise<{ text: string; sourceUrl: string } | { error: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { error: "Invalid URL format." };
  }

  if (parsedUrl.protocol !== "https:") {
    return { error: "Only HTTPS URLs are accepted." };
  }

  const normalizedUrl = normalizeGitHubUrl(rawUrl);
  let normalizedHost: string;
  try {
    normalizedHost = new URL(normalizedUrl).hostname;
  } catch {
    return { error: "Failed to parse normalized URL." };
  }

  if (!ALLOWED_URL_HOSTS.includes(normalizedHost)) {
    return { error: `Unsupported host. Allowed sources: ${ALLOWED_URL_HOSTS.join(", ")}` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  const MAX_REDIRECTS = 5;

  try {
    let currentUrl = normalizedUrl;
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: { "User-Agent": "VulnRap/1.0 (report-fetcher)" },
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { error: "Redirect without Location header." };
        }
        const redirectUrl = new URL(location, currentUrl);
        if (redirectUrl.protocol !== "https:") {
          return { error: "Redirect to non-HTTPS URL blocked." };
        }
        if (!ALLOWED_URL_HOSTS.includes(redirectUrl.hostname)) {
          return { error: `Redirect to disallowed host (${redirectUrl.hostname}) blocked.` };
        }
        currentUrl = redirectUrl.toString();
        continue;
      }
      break;
    }

    if (!response || (response.status >= 300 && response.status < 400)) {
      return { error: "Too many redirects." };
    }

    if (!response.ok) {
      return { error: `Failed to fetch URL: HTTP ${response.status} ${response.statusText}` };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_URL_SIZE) {
      return { error: `Remote file too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB). Max 5MB for URL imports.` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return { error: "URL returned HTML instead of plain text. Use a raw/plain-text link (e.g. GitHub raw URL)." };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_URL_SIZE) {
      return { error: `Remote file too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Max 5MB for URL imports.` };
    }

    const text = new TextDecoder("utf-8").decode(buffer);
    return { text, sourceUrl: currentUrl };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "URL fetch timed out after 15 seconds." };
    }
    logger.error({ err }, "URL fetch failed");
    return { error: "Failed to fetch content from URL." };
  } finally {
    clearTimeout(timeout);
  }
}

const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const hasValidExt = ALLOWED_EXTENSIONS.some(e => ext.endsWith(e));

    if (!hasValidExt) {
      cb(new Error("Unsupported file type. Accepted formats: .txt, .md, .pdf"));
      return;
    }

    cb(null, true);
  },
});

const router: IRouter = Router();

router.post("/reports", (req, res, next): void => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds 5MB limit." });
        return;
      }
      res.status(400).json({ error: err.message || "Upload failed." });
      return;
    }
    next();
  });
});

router.post("/reports", async (req, res): Promise<void> => {
  const contentMode = (req.body.contentMode === "full" || req.body.contentMode === "similarity_only")
    ? req.body.contentMode
    : "full";
  const showInFeed = req.body.showInFeed === "true";
  const skipRedaction = parseBoolParam(req.body.skipRedaction);
  const skipLlm = parseBoolParam(req.body.skipLlm) || skipRedaction;

  let text: string;
  let safeFileName: string | null = null;
  let rawFileSize: number;

  const rawText = typeof req.body.rawText === "string" ? req.body.rawText : "";
  const reportUrl = typeof req.body.reportUrl === "string" ? req.body.reportUrl.trim() : "";

  if (req.file) {
    const fileName = req.file.originalname.toLowerCase();
    if (fileName.endsWith(".pdf") || req.file.mimetype === "application/pdf") {
      const pdfResult = await extractTextFromPdf(req.file.buffer);
      if (!pdfResult.success) {
        res.status(400).json({ error: pdfResult.error });
        return;
      }
      text = sanitizeText(pdfResult.text);
    } else {
      if (detectBinaryContent(req.file.buffer)) {
        res.status(400).json({ error: "File appears to contain binary content. Only plain text (.txt, .md) and PDF files are accepted." });
        return;
      }
      text = sanitizeText(req.file.buffer.toString("utf-8"));
    }
    safeFileName = req.file.originalname ? sanitizeFileName(req.file.originalname) : null;
    rawFileSize = req.file.size;
  } else if (reportUrl.length > 0) {
    const urlResult = await fetchUrlContent(reportUrl);
    if ("error" in urlResult) {
      res.status(400).json({ error: urlResult.error });
      return;
    }
    text = sanitizeText(urlResult.text);
    safeFileName = `linked-${new URL(urlResult.sourceUrl).pathname.split("/").pop() || "report"}.txt`;
    rawFileSize = Buffer.byteLength(urlResult.text, "utf-8");
  } else if (rawText.length > 0) {
    text = sanitizeText(rawText);
    safeFileName = "pasted-text.txt";
    rawFileSize = Buffer.byteLength(rawText, "utf-8");
    if (rawFileSize > MAX_FILE_SIZE) {
      res.status(413).json({ error: "Text exceeds 5MB limit." });
      return;
    }
  } else {
    res.status(400).json({ error: "No content provided. Upload a file, paste text, or provide a URL." });
    return;
  }

  if (text.length === 0) {
    res.status(400).json({ error: "Content is empty or contains no readable text." });
    return;
  }

  const redactionApplied = !skipRedaction;
  const { redactedText, summary: redactionSummary } = skipRedaction
    ? { redactedText: text, summary: { totalRedactions: 0, categories: {} } }
    : redactReport(text);

  const analysisText = redactedText;

  const contentHash = computeContentHash(analysisText);
  let simhash = "";
  let minhashSignature: number[] = [];
  let lshBuckets: string[] = [];
  let sections: ReturnType<typeof parseSections>["sections"] = [];
  let sectionHashes: Record<string, string> = {};
  let similarityMatches: ReturnType<typeof findSimilarReports> = [];
  let sectionMatches: ReturnType<typeof findSectionMatches> = [];

  try {
    simhash = computeSimhash(analysisText);
    minhashSignature = computeMinHash(analysisText);
    lshBuckets = computeLSHBuckets(minhashSignature);
    const parsed = parseSections(analysisText);
    sections = parsed.sections;
    sectionHashes = parsed.sectionHashes;

    const lshConditions = lshBuckets.map(bucket =>
      sql`${reportsTable.lshBuckets}::jsonb @> ${JSON.stringify([bucket])}::jsonb`
    );

    const candidateReports = lshConditions.length > 0
      ? await db
          .select({
            id: reportsTable.id,
            minhashSignature: reportsTable.minhashSignature,
            simhash: reportsTable.simhash,
            lshBuckets: reportsTable.lshBuckets,
            sectionHashes: reportsTable.sectionHashes,
          })
          .from(reportsTable)
          .where(or(...lshConditions))
          .limit(500)
      : [];

    similarityMatches = findSimilarReports(
      minhashSignature,
      simhash,
      lshBuckets,
      candidateReports as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
    );

    sectionMatches = findSectionMatches(
      sectionHashes,
      candidateReports as Array<{ id: number; sectionHashes: Record<string, string> }>,
    );
  } catch (simErr) {
    logger.error({ err: simErr, inputLength: analysisText.length }, "[SIMILARITY CRASH] Similarity/section analysis failed");
  }

  const llmUsed = !skipLlm && isLLMAvailable();
  const analysisResult = await performAnalysis(text, redactedText, { skipLlm });
  const { llmResult } = analysisResult;

  // Sprint 9 Phase 1: 3-engine consensus scorer (runs alongside legacy scoring).
  let vulnrapComposite: VulnrapComposite | null = null;
  try {
    vulnrapComposite = analyzeWithEngines(redactedText);
  } catch (engineErr) {
    logger.error({ err: engineErr }, "[VULNRAP] engines crashed; continuing without composite");
  }

  const deleteToken = crypto.randomBytes(32).toString("hex");
  const templateHash = computeTemplateHash(redactedText);

  let templateMatch: TriageRecommendation["templateMatch"] = null;
  try {
    const templateDuplicates = await db
      .select({ id: reportsTable.id })
      .from(reportsTable)
      .where(eq(reportsTable.templateHash, templateHash))
      .limit(10);
    if (templateDuplicates.length > 0) {
      templateMatch = {
        templateHash,
        matchedReportIds: templateDuplicates.map(r => r.id),
        weight: 25,
      };
    }
  } catch {}

  let revisionResult: TriageRecommendation["revision"] = null;
  try {
    const highSimMatch = similarityMatches.find(m => m.similarity >= 70);
    if (highSimMatch) {
      const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const [matchedRow] = await db
        .select({ id: reportsTable.id, slopScore: reportsTable.slopScore, createdAt: reportsTable.createdAt })
        .from(reportsTable)
        .where(eq(reportsTable.id, highSimMatch.reportId));
      if (matchedRow && matchedRow.createdAt >= cutoff48h) {
        revisionResult = detectRevision(analysisResult.slopScore, {
          id: matchedRow.id,
          slopScore: matchedRow.slopScore ?? 50,
          similarity: highSimMatch.similarity,
        });
      }
    }
  } catch {}

  const isRevision = revisionResult !== null;

  const temporalSignals = analysisResult.triageRecommendation?.temporalSignals ?? [];

  if (templateMatch) {
    analysisResult.evidence.push({
      type: "template_reuse",
      description: `Report structure matches ${templateMatch.matchedReportIds.length} previous submission(s) — possible mass-generated template`,
      weight: templateMatch.weight,
    });
    analysisResult.slopScore = Math.min(95, analysisResult.slopScore + templateMatch.weight);
  }

  for (const ts of temporalSignals) {
    analysisResult.evidence.push({
      type: "temporal_signal",
      description: `${ts.cveId}: report submitted ${ts.hoursSincePublication.toFixed(1)}h after CVE publication (${ts.signal.replace(/_/g, " ")})`,
      weight: ts.weight,
    });
    analysisResult.slopScore = Math.min(95, analysisResult.slopScore + ts.weight);
  }

  try {
    const updatedBase = generateTriageRecommendation(
      analysisResult.slopScore,
      analysisResult.confidence,
      analysisResult.verification,
      analysisResult.evidence,
    );
    analysisResult.triageRecommendation = {
      ...updatedBase,
      temporalSignals,
      templateMatch,
      revision: revisionResult,
    };
  } catch {}

  const report = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(reportsTable)
      .values({
        deleteToken,
        contentHash,
        simhash,
        minhashSignature,
        lshBuckets,
        contentText: contentMode === "full" ? analysisText : null,
        redactedText: contentMode === "full" ? analysisText : null,
        contentMode,
        slopScore: analysisResult.slopScore,
        slopTier: analysisResult.slopTier,
        qualityScore: analysisResult.qualityScore,
        confidence: analysisResult.confidence,
        breakdown: { ...analysisResult.breakdown, llmUsed, redactionApplied },
        evidence: analysisResult.evidence,
        humanIndicators: analysisResult.humanIndicators,
        authenticityScore: analysisResult.authenticityScore,
        validityScore: analysisResult.validityScore,
        quadrant: analysisResult.quadrant,
        archetype: analysisResult.archetype,
        similarityMatches,
        sectionHashes,
        sectionMatches,
        redactionSummary,
        feedback: analysisResult.feedback,
        llmSlopScore: llmResult ? llmResult.llmSlopScore : null,
        llmFeedback: llmResult ? llmResult.llmFeedback : null,
        llmBreakdown: llmResult?.llmBreakdown ?? null,
        showInFeed,
        fileName: safeFileName,
        fileSize: rawFileSize,
        templateHash,
        vulnrapCompositeScore: vulnrapComposite?.overallScore ?? null,
        vulnrapCompositeLabel: vulnrapComposite?.label ?? null,
        vulnrapEngineResults: vulnrapComposite
          ? { engines: vulnrapComposite.engineResults, compositeBreakdown: vulnrapComposite.compositeBreakdown, warnings: vulnrapComposite.warnings, engineCount: vulnrapComposite.engineCount }
          : null,
        vulnrapOverridesApplied: vulnrapComposite?.overridesApplied ?? null,
      })
      .returning();

    await tx.insert(reportHashesTable).values([
      { reportId: inserted.id, hashType: "sha256", hashValue: contentHash },
      { reportId: inserted.id, hashType: "simhash", hashValue: simhash },
    ]);

    if (similarityMatches.length > 0) {
      await tx.insert(similarityResultsTable).values(
        similarityMatches.map(m => ({
          sourceReportId: inserted.id,
          matchedReportId: m.reportId,
          similarityScore: m.similarity / 100,
          matchType: m.matchType,
        }))
      );
    }

    if (!isRevision) {
      await tx
        .insert(reportStatsTable)
        .values({ key: "total_reports", value: 1 })
        .onConflictDoUpdate({
          target: reportStatsTable.key,
          set: { value: sql`${reportStatsTable.value} + 1` },
        });
    }

    if (similarityMatches.length > 0) {
      await tx
        .insert(reportStatsTable)
        .values({ key: "duplicates_detected", value: 1 })
        .onConflictDoUpdate({
          target: reportStatsTable.key,
          set: { value: sql`${reportStatsTable.value} + 1` },
        });
    }

    return inserted;
  });

  const response = GetReportResponse.parse({
    id: report.id,
    deleteToken,
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    qualityScore: report.qualityScore,
    confidence: report.confidence,
    breakdown: safeBreakdown(report.breakdown),
    evidence: report.evidence ?? [],
    humanIndicators: report.humanIndicators ?? [],
    authenticityScore: report.authenticityScore,
    validityScore: report.validityScore,
    quadrant: report.quadrant,
    archetype: report.archetype,
    similarityMatches: report.similarityMatches,
    sectionHashes: report.sectionHashes ?? {},
    sectionMatches: report.sectionMatches ?? [],
    redactedText: report.redactedText,
    redactionSummary: report.redactionSummary ?? { totalRedactions: 0, categories: {} },
    feedback: report.feedback,
    llmSlopScore: report.llmSlopScore ?? null,
    llmFeedback: report.llmFeedback ?? null,
    llmBreakdown: report.llmBreakdown ?? null,
    llmEnhanced: report.llmSlopScore != null,
    llmFailed: llmUsed && report.llmSlopScore == null,
    llmUsed,
    redactionApplied,
    verification: analysisResult.verification ?? null,
    triageRecommendation: analysisResult.triageRecommendation ?? null,
    triageAssistant: analysisResult.triageAssistant ?? null,
    claims: analysisResult.claims ?? null,
    substance: analysisResult.substance ?? null,
    vulnrap: vulnrapComposite
      ? {
          compositeScore: vulnrapComposite.overallScore,
          label: vulnrapComposite.label,
          engines: vulnrapComposite.engineResults,
          compositeBreakdown: vulnrapComposite.compositeBreakdown,
          overridesApplied: vulnrapComposite.overridesApplied,
          warnings: vulnrapComposite.warnings,
          engineCount: vulnrapComposite.engineCount,
        }
      : null,
    fileName: report.fileName,
    fileSize: report.fileSize,
    createdAt: report.createdAt,
  });

  res.status(201).json(response);
});

function anonymizeId(id: number): string {
  return `VR-${id.toString(16).padStart(4, "0").toUpperCase()}`;
}

router.post("/reports/check", (req, res, next): void => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds 5MB limit." });
        return;
      }
      res.status(400).json({ error: err.message || "Upload failed." });
      return;
    }
    next();
  });
});

router.post("/reports/check", async (req, res): Promise<void> => {
  const skipRedaction = parseBoolParam(req.body.skipRedaction);
  const skipLlm = parseBoolParam(req.body.skipLlm) || skipRedaction;

  let text: string;
  const rawText = typeof req.body.rawText === "string" ? req.body.rawText : "";
  const reportUrl = typeof req.body.reportUrl === "string" ? req.body.reportUrl.trim() : "";

  if (req.file) {
    const fileName = req.file.originalname.toLowerCase();
    if (fileName.endsWith(".pdf") || req.file.mimetype === "application/pdf") {
      const pdfResult = await extractTextFromPdf(req.file.buffer);
      if (!pdfResult.success) {
        res.status(400).json({ error: pdfResult.error });
        return;
      }
      text = sanitizeText(pdfResult.text);
    } else {
      if (detectBinaryContent(req.file.buffer)) {
        res.status(400).json({ error: "File appears to contain binary content. Only plain text (.txt, .md) and PDF files are accepted." });
        return;
      }
      text = sanitizeText(req.file.buffer.toString("utf-8"));
    }
  } else if (reportUrl.length > 0) {
    const urlResult = await fetchUrlContent(reportUrl);
    if ("error" in urlResult) {
      res.status(400).json({ error: urlResult.error });
      return;
    }
    text = sanitizeText(urlResult.text);
  } else if (rawText.length > 0) {
    text = sanitizeText(rawText);
    if (Buffer.byteLength(rawText, "utf-8") > MAX_FILE_SIZE) {
      res.status(413).json({ error: "Text exceeds 5MB limit." });
      return;
    }
  } else {
    res.status(400).json({ error: "No content provided. Upload a file, paste text, or provide a URL." });
    return;
  }

  if (text.length === 0) {
    res.status(400).json({ error: "Content is empty or contains no readable text." });
    return;
  }

  const redactionApplied = !skipRedaction;
  const { redactedText, summary: redactionSummary } = skipRedaction
    ? { redactedText: text, summary: { totalRedactions: 0, categories: {} } }
    : redactReport(text);
  const analysisText = redactedText;

  const contentHash = computeContentHash(analysisText);

  const cachedReports = await db
    .select({
      id: reportsTable.id,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      qualityScore: reportsTable.qualityScore,
      confidence: reportsTable.confidence,
      breakdown: reportsTable.breakdown,
      evidence: reportsTable.evidence,
      humanIndicators: reportsTable.humanIndicators,
      authenticityScore: reportsTable.authenticityScore,
      validityScore: reportsTable.validityScore,
      quadrant: reportsTable.quadrant,
      archetype: reportsTable.archetype,
      similarityMatches: reportsTable.similarityMatches,
      sectionHashes: reportsTable.sectionHashes,
      sectionMatches: reportsTable.sectionMatches,
      redactionSummary: reportsTable.redactionSummary,
      feedback: reportsTable.feedback,
      llmSlopScore: reportsTable.llmSlopScore,
      llmFeedback: reportsTable.llmFeedback,
      llmBreakdown: reportsTable.llmBreakdown,
    })
    .from(reportsTable)
    .where(eq(reportsTable.contentHash, contentHash))
    .limit(1);

  if (cachedReports.length > 0) {
    const cached = cachedReports[0];
    logger.info({ contentHash, existingId: cached.id }, "Check: returning cached result for identical content");

    await db
      .insert(reportStatsTable)
      .values({ key: `recheck:${cached.id}`, value: 1 })
      .onConflictDoUpdate({
        target: reportStatsTable.key,
        set: { value: sql`${reportStatsTable.value} + 1` },
      })
      .catch(() => {});

    let cachedTriageRecommendation: TriageRecommendation | null = null;
    let cachedTriageAssistant: TriageAssistantResult | null = null;
    const cachedEvidence = (cached.evidence || []) as EvidenceItem[];
    try {
      const baseRec = generateTriageRecommendation(
        cached.slopScore, cached.confidence as number, null, cachedEvidence,
      );
      cachedTriageRecommendation = {
        ...baseRec,
        temporalSignals: [],
        templateMatch: null,
        revision: null,
      };
    } catch {}
    try {
      cachedTriageAssistant = generateTriageAssistant(
        analysisText, cached.slopScore, cached.confidence as number,
        cachedEvidence, null, null,
      );
    } catch {}

    const cachedHadLlm = cached.llmSlopScore != null;
    const stripLlm = skipLlm && cachedHadLlm;

    let responseSlopScore = cached.slopScore;
    let responseSlopTier = cached.slopTier;
    let responseConfidence = cached.confidence;
    let responseBreakdown = cached.breakdown;
    let responseEvidence = cached.evidence;

    let responseAuthenticityScore = cached.authenticityScore ?? 0;
    let responseValidityScore = cached.validityScore ?? 0;
    let responseQuadrant = cached.quadrant ?? "WEAK_HUMAN";
    let responseArchetype = cached.archetype ?? "REQUEST_DETAILS";

    if (stripLlm && cached.breakdown) {
      const bd = cached.breakdown as import("@workspace/db").ScoreBreakdown;
      const allEvidence = (cached.evidence || []) as EvidenceItem[];
      const recomputed = recomputeSlopScoreWithoutLlm(bd, allEvidence, analysisText);
      responseSlopScore = recomputed.slopScore;
      responseSlopTier = recomputed.slopTier;
      responseConfidence = recomputed.confidence;
      responseAuthenticityScore = recomputed.authenticityScore;
      responseValidityScore = recomputed.validityScore;
      responseQuadrant = recomputed.quadrant;
      responseArchetype = recomputed.archetype;
      responseBreakdown = { ...bd, llm: null, llmUsed: false, redactionApplied };
      responseEvidence = allEvidence.filter(e => e.type !== "llm_red_flag" && e.type !== "llm_observation");
    }

    const cachedAnalysisMode = (skipLlm || !cachedHadLlm) ? "heuristic_only" : "llm_enhanced";
    const cachedConfidenceNote = cachedAnalysisMode === "heuristic_only"
      ? "Running in heuristic-only mode — confidence reduced by 15%. Enable LLM analysis for higher precision on borderline reports."
      : null;
    const cachedConfigNotices = generateConfigImpactNotices({ skipLlm, skipRedaction });

    const response = CheckReportResponse.parse({
      slopScore: responseSlopScore,
      slopTier: responseSlopTier,
      qualityScore: cached.qualityScore,
      confidence: responseConfidence,
      breakdown: safeBreakdown(responseBreakdown),
      evidence: responseEvidence,
      humanIndicators: cached.humanIndicators,
      authenticityScore: responseAuthenticityScore,
      validityScore: responseValidityScore,
      quadrant: responseQuadrant,
      archetype: responseArchetype,
      analysisMode: cachedAnalysisMode,
      confidenceNote: cachedConfidenceNote,
      configNotices: cachedConfigNotices,
      diagnostics: null,
      similarityMatches: cached.similarityMatches,
      sectionHashes: cached.sectionHashes,
      sectionMatches: cached.sectionMatches,
      redactionSummary: cached.redactionSummary,
      feedback: cached.feedback,
      llmSlopScore: skipLlm ? null : (cached.llmSlopScore ?? null),
      llmFeedback: skipLlm ? null : (cached.llmFeedback ?? null),
      llmBreakdown: skipLlm ? null : (cached.llmBreakdown ?? null),
      llmEnhanced: skipLlm ? false : cachedHadLlm,
      llmFailed: !skipLlm && !cachedHadLlm,
      llmUsed: !skipLlm,
      redactionApplied,
      verification: null,
      triageRecommendation: cachedTriageRecommendation,
      triageAssistant: cachedTriageAssistant,
      previouslySubmitted: true,
      existingReportId: cached.id,
    });
    res.json(response);
    return;
  }

  let similarityMatches: ReturnType<typeof findSimilarReports> = [];
  let sectionHashes: Record<string, string> = {};
  let sectionMatches: ReturnType<typeof findSectionMatches> = [];

  try {
    const simhash = computeSimhash(analysisText);
    const minhashSignature = computeMinHash(analysisText);
    const lshBuckets = computeLSHBuckets(minhashSignature);
    const parsed = parseSections(analysisText);
    sectionHashes = parsed.sectionHashes;

    const checkLshConditions = lshBuckets.map(bucket =>
      sql`${reportsTable.lshBuckets}::jsonb @> ${JSON.stringify([bucket])}::jsonb`
    );

    const checkCandidates = checkLshConditions.length > 0
      ? await db
          .select({
            id: reportsTable.id,
            minhashSignature: reportsTable.minhashSignature,
            simhash: reportsTable.simhash,
            lshBuckets: reportsTable.lshBuckets,
            sectionHashes: reportsTable.sectionHashes,
          })
          .from(reportsTable)
          .where(or(...checkLshConditions))
          .limit(500)
      : [];

    similarityMatches = findSimilarReports(
      minhashSignature, simhash, lshBuckets,
      checkCandidates as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
    );

    sectionMatches = findSectionMatches(
      sectionHashes,
      checkCandidates as Array<{ id: number; sectionHashes: Record<string, string> }>,
    );
  } catch (simErr) {
    logger.error({ err: simErr, inputLength: analysisText.length }, "[SIMILARITY CRASH] Check: Similarity/section analysis failed");
  }

  const analysisResult = await performAnalysis(text, analysisText, { skipLlm });

  const { llmResult: checkLlmResult } = analysisResult;
  const configNotices = generateConfigImpactNotices({ skipLlm, skipRedaction });

  const response = CheckReportResponse.parse({
    slopScore: analysisResult.slopScore,
    slopTier: analysisResult.slopTier,
    qualityScore: analysisResult.qualityScore,
    confidence: analysisResult.confidence,
    breakdown: safeBreakdown(analysisResult.breakdown),
    evidence: analysisResult.evidence,
    humanIndicators: analysisResult.humanIndicators,
    authenticityScore: analysisResult.authenticityScore,
    validityScore: analysisResult.validityScore,
    quadrant: analysisResult.quadrant,
    archetype: analysisResult.archetype,
    analysisMode: analysisResult.analysisMode,
    confidenceNote: analysisResult.confidenceNote,
    configNotices,
    diagnostics: analysisResult.diagnostics,
    similarityMatches,
    sectionHashes,
    sectionMatches,
    redactionSummary,
    feedback: analysisResult.feedback,
    llmSlopScore: checkLlmResult ? checkLlmResult.llmSlopScore : null,
    llmFeedback: checkLlmResult ? checkLlmResult.llmFeedback : null,
    llmBreakdown: checkLlmResult?.llmBreakdown ?? null,
    llmEnhanced: checkLlmResult != null,
    llmFailed: !skipLlm && checkLlmResult == null && isLLMAvailable(),
    llmUsed: !skipLlm,
    redactionApplied,
    verification: analysisResult.verification ?? null,
    triageRecommendation: analysisResult.triageRecommendation ?? null,
    triageAssistant: analysisResult.triageAssistant ?? null,
    claims: analysisResult.claims ?? null,
    substance: analysisResult.substance ?? null,
    previouslySubmitted: false,
    existingReportId: null,
  });

  res.json(response);
});

router.get("/reports/feed", async (req, res): Promise<void> => {
  const limitParam = parseInt(String(req.query.limit || "10"), 10);
  const limit = Math.max(1, Math.min(50, isNaN(limitParam) ? 10 : limitParam));
  const offsetParam = parseInt(String(req.query.offset || "0"), 10);
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);
  const tierFilter = req.query.tier ? String(req.query.tier) : null;
  const sortParam = String(req.query.sort || "newest");

  const conditions = [eq(reportsTable.showInFeed, true)];
  if (tierFilter) {
    conditions.push(eq(reportsTable.slopTier, tierFilter));
  }
  const whereClause = and(...conditions)!;

  let orderClause;
  switch (sortParam) {
    case "oldest":
      orderClause = sql`${reportsTable.createdAt} asc, ${reportsTable.id} asc`;
      break;
    case "score_asc":
      orderClause = sql`${reportsTable.slopScore} asc, ${reportsTable.id} desc`;
      break;
    case "score_desc":
      orderClause = sql`${reportsTable.slopScore} desc, ${reportsTable.id} desc`;
      break;
    default:
      orderClause = sql`${reportsTable.createdAt} desc, ${reportsTable.id} desc`;
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(whereClause);
  const total = countResult?.count ?? 0;

  const [summaryResult] = await db
    .select({
      totalPublic: sql<number>`count(*)::int`,
      avgScore: sql<number>`coalesce(avg("slop_score"), 0)`,
    })
    .from(reportsTable)
    .where(eq(reportsTable.showInFeed, true));

  const tierRows = await db
    .select({
      tier: reportsTable.slopTier,
      count: sql<number>`count(*)::int`,
    })
    .from(reportsTable)
    .where(eq(reportsTable.showInFeed, true))
    .groupBy(reportsTable.slopTier);

  const tierCounts: Record<string, number> = {};
  for (const row of tierRows) {
    tierCounts[row.tier] = row.count;
  }

  const feedReports = await db
    .select({
      id: reportsTable.id,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      similarityMatches: reportsTable.similarityMatches,
      contentMode: reportsTable.contentMode,
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .where(whereClause)
    .orderBy(orderClause)
    .limit(limit)
    .offset(offset);

  const mapped = feedReports.map((r) => {
    const matches = r.similarityMatches as Array<{ reportId: number }>;
    return {
      id: r.id,
      reportCode: anonymizeId(r.id),
      slopScore: r.slopScore,
      slopTier: r.slopTier,
      matchCount: matches.length,
      contentMode: r.contentMode,
      createdAt: r.createdAt,
    };
  });

  const response = GetReportFeedResponse.parse({
    reports: mapped,
    total,
    hasMore: offset + limit < total,
    summary: {
      totalPublic: summaryResult?.totalPublic ?? 0,
      avgScore: Math.round((summaryResult?.avgScore ?? 0) * 10) / 10,
      tierCounts,
    },
  });
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  res.json(response);
});

router.get("/reports/lookup/:hash", async (req, res): Promise<void> => {
  const params = LookupByHashParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.contentHash, params.data.hash));

  if (!report) {
    const response = LookupByHashResponse.parse({
      found: false,
      reportId: null,
      slopScore: null,
      slopTier: null,
      matchCount: 0,
      firstSeen: null,
    });
    res.json(response);
    return;
  }

  const matches = (report.similarityMatches as Array<{ reportId: number; similarity: number; matchType: string }>);

  const response = LookupByHashResponse.parse({
    found: true,
    reportId: report.id,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    matchCount: matches.length,
    firstSeen: report.createdAt,
  });

  res.json(response);
});

router.get("/reports/:id/compare/:matchId", async (req, res): Promise<void> => {
  const params = CompareReportsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [sourceReport, matchedReport] = await Promise.all([
    db.select({
      id: reportsTable.id,
      redactedText: reportsTable.redactedText,
      contentMode: reportsTable.contentMode,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      similarityMatches: reportsTable.similarityMatches,
      sectionHashes: reportsTable.sectionHashes,
      createdAt: reportsTable.createdAt,
    }).from(reportsTable).where(eq(reportsTable.id, params.data.id)),
    db.select({
      id: reportsTable.id,
      redactedText: reportsTable.redactedText,
      contentMode: reportsTable.contentMode,
      slopScore: reportsTable.slopScore,
      slopTier: reportsTable.slopTier,
      sectionHashes: reportsTable.sectionHashes,
      createdAt: reportsTable.createdAt,
    }).from(reportsTable).where(eq(reportsTable.id, params.data.matchId)),
  ]);

  if (!sourceReport[0]) {
    res.status(404).json({ error: "Source report not found." });
    return;
  }
  if (!matchedReport[0]) {
    res.status(404).json({ error: "Matched report not found." });
    return;
  }

  const src = sourceReport[0];
  const mtch = matchedReport[0];

  const matches = (src.similarityMatches as Array<{ reportId: number; similarity: number; matchType: string }>) || [];
  const matchInfo = matches.find(m => m.reportId === params.data.matchId);

  if (!matchInfo) {
    res.status(404).json({ error: "No similarity relationship found between these reports." });
    return;
  }

  const snippetLength = 2000;

  const srcSections = (src.sectionHashes as Record<string, string>) || {};
  const mtchSections = (mtch.sectionHashes as Record<string, string>) || {};
  const allSectionTitles = new Set([
    ...Object.keys(srcSections).filter(k => k !== "__full_document"),
    ...Object.keys(mtchSections).filter(k => k !== "__full_document"),
  ]);

  const sectionComparison: Array<{ sectionTitle: string; status: string; sourceHash: string | null; matchedHash: string | null }> = [];
  let identicalCount = 0;

  for (const title of allSectionTitles) {
    const srcHash = srcSections[title] || null;
    const mtchHash = mtchSections[title] || null;

    let status: string;
    if (srcHash && mtchHash) {
      if (srcHash === mtchHash) {
        status = "identical";
        identicalCount++;
      } else {
        status = "different";
      }
    } else {
      status = "unique";
    }

    sectionComparison.push({ sectionTitle: title, status, sourceHash: srcHash, matchedHash: mtchHash });
  }

  const response = CompareReportsResponse.parse({
    sourceReport: {
      id: src.id,
      reportCode: anonymizeId(src.id),
      snippet: src.redactedText ? src.redactedText.slice(0, snippetLength) : null,
      slopScore: src.slopScore,
      slopTier: src.slopTier,
      contentMode: src.contentMode,
      sectionHashes: srcSections,
      createdAt: src.createdAt,
    },
    matchedReport: {
      id: mtch.id,
      reportCode: anonymizeId(mtch.id),
      snippet: mtch.contentMode === "full" && mtch.redactedText ? mtch.redactedText.slice(0, snippetLength) : null,
      slopScore: mtch.slopScore,
      slopTier: mtch.slopTier,
      contentMode: mtch.contentMode,
      sectionHashes: mtchSections,
      createdAt: mtch.createdAt,
    },
    similarity: matchInfo.similarity,
    matchType: matchInfo.matchType,
    sectionComparison,
    identicalSections: identicalCount,
    totalSections: allSectionTitles.size,
  });

  res.json(response);
});

router.get("/reports/:id/verify", async (req, res): Promise<void> => {
  const params = GetVerificationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.id, params.data.id));

  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }

  const matches = (report.similarityMatches as Array<{ reportId: number }>) || [];
  const secMatches = (report.sectionMatches as Array<{ sectionTitle: string }>) || [];

  const baseUrl = process.env.PUBLIC_URL || "https://vulnrap.com";
  const verifyUrl = `${baseUrl}/verify/${report.id}`;

  const response = GetVerificationResponse.parse({
    id: report.id,
    reportCode: anonymizeId(report.id),
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    similarityMatchCount: matches.length,
    sectionMatchCount: secMatches.length,
    contentHash: report.contentHash,
    verifyUrl,
    createdAt: report.createdAt,
  });

  res.json(response);
});

router.get("/reports/:id", async (req, res): Promise<void> => {
  const params = GetReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.id, params.data.id));

  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }

  let verification: VerificationResult | null = null;
  if (report.redactedText) {
    try {
      verification = await performActiveVerification(report.redactedText);
    } catch {
      verification = null;
    }
  }

  let triageRecommendation: TriageRecommendation | null = null;
  try {
    const base = generateTriageRecommendation(
      report.slopScore ?? 50,
      (report.confidence as number) ?? 0.5,
      verification,
      (report.evidence as EvidenceItem[]) ?? [],
    );
    const temporalSignals = computeTemporalSignals(verification, report.createdAt);

    let templateMatch: TriageRecommendation["templateMatch"] = null;
    if (report.templateHash) {
      const templateDuplicates = await db
        .select({ id: reportsTable.id })
        .from(reportsTable)
        .where(eq(reportsTable.templateHash, report.templateHash as string))
        .limit(10);
      const others = templateDuplicates.filter(r => r.id !== report.id);
      if (others.length > 0) {
        templateMatch = {
          templateHash: report.templateHash as string,
          matchedReportIds: others.map(r => r.id),
          weight: 25,
        };
      }
    }

    let revisionResult: TriageRecommendation["revision"] = null;
    try {
      const simMatches = (report.similarityMatches ?? []) as Array<{ reportId: number; similarity: number; matchType: string }>;
      const highSimMatch = simMatches.find(m => m.similarity >= 70);
      if (highSimMatch) {
        const cutoff48h = new Date(report.createdAt.getTime() - 48 * 60 * 60 * 1000);
        const [matchedRow] = await db
          .select({ id: reportsTable.id, slopScore: reportsTable.slopScore, createdAt: reportsTable.createdAt })
          .from(reportsTable)
          .where(eq(reportsTable.id, highSimMatch.reportId));
        if (matchedRow && matchedRow.createdAt >= cutoff48h) {
          revisionResult = detectRevision(report.slopScore ?? 50, {
            id: matchedRow.id,
            slopScore: matchedRow.slopScore ?? 50,
            similarity: highSimMatch.similarity,
          });
        }
      }
    } catch {}

    triageRecommendation = {
      ...base,
      temporalSignals,
      templateMatch,
      revision: revisionResult,
    };
  } catch {}

  let triageAssistant: TriageAssistantResult | null = null;
  try {
    if (report.redactedText) {
      triageAssistant = generateTriageAssistant(
        report.redactedText,
        report.slopScore ?? 50,
        (report.confidence as number) ?? 0.5,
        (report.evidence as EvidenceItem[]) ?? [],
        verification,
        null,
      );
    }
  } catch {}

  const response = GetReportResponse.parse({
    id: report.id,
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    qualityScore: report.qualityScore ?? 50,
    confidence: report.confidence ?? 0.5,
    breakdown: safeBreakdown(report.breakdown),
    evidence: report.evidence ?? [],
    humanIndicators: report.humanIndicators ?? [],
    authenticityScore: report.authenticityScore ?? 0,
    validityScore: report.validityScore ?? 0,
    quadrant: report.quadrant ?? "WEAK_HUMAN",
    archetype: report.archetype ?? "REQUEST_DETAILS",
    similarityMatches: report.similarityMatches,
    sectionHashes: report.sectionHashes ?? {},
    sectionMatches: report.sectionMatches ?? [],
    redactedText: report.redactedText,
    redactionSummary: report.redactionSummary ?? { totalRedactions: 0, categories: {} },
    feedback: report.feedback,
    llmSlopScore: report.llmSlopScore ?? null,
    llmFeedback: report.llmFeedback ?? null,
    llmBreakdown: report.llmBreakdown ?? null,
    llmEnhanced: report.llmSlopScore != null,
    llmFailed: (report.breakdown as import("@workspace/db").ScoreBreakdown | null)?.llmUsed === true && report.llmSlopScore == null,
    llmUsed: (report.breakdown as import("@workspace/db").ScoreBreakdown | null)?.llmUsed === true,
    redactionApplied: (report.breakdown as import("@workspace/db").ScoreBreakdown | null)?.redactionApplied !== false,
    verification,
    triageRecommendation,
    triageAssistant,
    vulnrap: (() => {
      if (report.vulnrapCompositeScore == null || report.vulnrapCompositeLabel == null) return null;
      const stored = (report.vulnrapEngineResults ?? {}) as {
        engines?: unknown[];
        compositeBreakdown?: { weightedSum: number; totalWeight: number; beforeOverride: number; afterOverride: number };
        warnings?: string[];
        engineCount?: number;
      };
      return {
        compositeScore: report.vulnrapCompositeScore,
        label: report.vulnrapCompositeLabel,
        engines: (stored.engines ?? []) as Array<{ engine: string; score: number; verdict: string; confidence: string }>,
        compositeBreakdown: stored.compositeBreakdown,
        overridesApplied: (report.vulnrapOverridesApplied ?? []) as string[],
        warnings: stored.warnings ?? [],
        engineCount: stored.engineCount ?? (stored.engines?.length ?? 0),
      };
    })(),
    fileName: report.fileName,
    fileSize: report.fileSize,
    createdAt: report.createdAt,
  });

  res.json(response);
});

router.get("/reports/:id/triage-report", async (req, res): Promise<void> => {
  const params = GetReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select()
    .from(reportsTable)
    .where(eq(reportsTable.id, params.data.id));

  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }

  let verification: VerificationResult | null = null;
  if (report.redactedText) {
    try {
      verification = await performActiveVerification(report.redactedText);
    } catch {
      verification = null;
    }
  }

  let triageRecommendation: TriageRecommendation | null = null;
  try {
    const base = generateTriageRecommendation(
      report.slopScore ?? 50,
      (report.confidence as number) ?? 0.5,
      verification,
      (report.evidence as EvidenceItem[]) ?? [],
    );
    const temporalSignals = computeTemporalSignals(verification, report.createdAt);

    let mdTemplateMatch: TriageRecommendation["templateMatch"] = null;
    if (report.templateHash) {
      const templateDuplicates = await db
        .select({ id: reportsTable.id })
        .from(reportsTable)
        .where(eq(reportsTable.templateHash, report.templateHash as string))
        .limit(10);
      const others = templateDuplicates.filter(r => r.id !== report.id);
      if (others.length > 0) {
        mdTemplateMatch = {
          templateHash: report.templateHash as string,
          matchedReportIds: others.map(r => r.id),
          weight: 25,
        };
      }
    }

    let mdRevision: TriageRecommendation["revision"] = null;
    try {
      const simMatches = (report.similarityMatches ?? []) as Array<{ reportId: number; similarity: number; matchType: string }>;
      const highSimMatch = simMatches.find(m => m.similarity >= 70);
      if (highSimMatch) {
        const cutoff48h = new Date(report.createdAt.getTime() - 48 * 60 * 60 * 1000);
        const [matchedRow] = await db
          .select({ id: reportsTable.id, slopScore: reportsTable.slopScore, createdAt: reportsTable.createdAt })
          .from(reportsTable)
          .where(eq(reportsTable.id, highSimMatch.reportId));
        if (matchedRow && matchedRow.createdAt >= cutoff48h) {
          mdRevision = detectRevision(report.slopScore ?? 50, {
            id: matchedRow.id,
            slopScore: matchedRow.slopScore ?? 50,
            similarity: highSimMatch.similarity,
          });
        }
      }
    } catch {}

    triageRecommendation = { ...base, temporalSignals, templateMatch: mdTemplateMatch, revision: mdRevision };
  } catch {}

  let mdTriageAssistant: TriageAssistantResult | null = null;
  try {
    if (report.redactedText) {
      mdTriageAssistant = generateTriageAssistant(
        report.redactedText,
        report.slopScore ?? 50,
        (report.confidence as number) ?? 0.5,
        (report.evidence as EvidenceItem[]) ?? [],
        verification,
        null,
      );
    }
  } catch {}

  const lines: string[] = [];
  lines.push(`# VulnRap Triage Report — VR-${report.id.toString(16).padStart(4, "0").toUpperCase()}`);
  lines.push("");
  lines.push(`**Date**: ${new Date().toISOString()}`);
  lines.push(`**Content Hash**: \`${report.contentHash}\``);
  lines.push(`**Slop Score**: ${report.slopScore} (${report.slopTier})`);
  lines.push(`**Confidence**: ${((report.confidence as number ?? 0.5) * 100).toFixed(0)}%`);
  lines.push("");

  if (triageRecommendation) {
    lines.push("## Triage Recommendation");
    lines.push("");
    lines.push(`**Action**: ${triageRecommendation.action}`);
    lines.push(`**Reason**: ${triageRecommendation.reason}`);
    lines.push("");
    lines.push(`> ${triageRecommendation.note}`);
    lines.push("");

    if (triageRecommendation.challengeQuestions.length > 0) {
      lines.push("## Challenge Questions");
      lines.push("");
      for (const q of triageRecommendation.challengeQuestions) {
        lines.push(`### ${q.category}`);
        lines.push(`**Question**: ${q.question}`);
        lines.push(`*Context*: ${q.context}`);
        lines.push("");
      }
    }

    if (triageRecommendation.temporalSignals.length > 0) {
      lines.push("## Temporal Signals");
      lines.push("");
      for (const s of triageRecommendation.temporalSignals) {
        lines.push(`- **${s.cveId}**: ${s.signal} (${s.hoursSincePublication.toFixed(1)}h since publication, weight ${s.weight})`);
      }
      lines.push("");
    }

    if (triageRecommendation.templateMatch) {
      const tm = triageRecommendation.templateMatch;
      lines.push("## Template Reuse");
      lines.push("");
      lines.push(`- **Template Hash**: \`${tm.templateHash}\``);
      lines.push(`- **Matched Reports**: ${tm.matchedReportIds.length} previous submission(s)`);
      lines.push(`- **Weight**: +${tm.weight}`);
      lines.push("");
    }

    if (triageRecommendation.revision) {
      const rev = triageRecommendation.revision;
      lines.push("## Revision Detection");
      lines.push("");
      lines.push(`- **Original Report**: #${rev.originalReportId}`);
      lines.push(`- **Similarity**: ${rev.similarity.toFixed(0)}%`);
      lines.push(`- **Direction**: ${rev.direction} (${rev.originalScore} → ${report.slopScore ?? 50}, change: ${rev.scoreChange})`);
      if (rev.changeSummary) {
        lines.push(`- **Summary**: ${rev.changeSummary}`);
      }
      lines.push("");
    }
  }

  if (verification) {
    lines.push("## Verification Results");
    lines.push("");
    lines.push(`| Check | Status | Detail |`);
    lines.push(`|-------|--------|--------|`);
    for (const check of verification.checks) {
      const icon = check.result === "verified" ? "✅" : check.result === "not_found" ? "❌" : "⚠️";
      lines.push(`| ${check.type} | ${icon} ${check.result} | ${check.detail} |`);
    }
    lines.push("");
  }

  const evidence = (report.evidence as EvidenceItem[]) ?? [];
  if (evidence.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const e of evidence) {
      lines.push(`- **[${e.type}]** ${e.description} (weight: ${e.weight})`);
    }
    lines.push("");
  }

  const humanIndicators = (report.humanIndicators as EvidenceItem[]) ?? [];
  if (humanIndicators.length > 0) {
    lines.push("## Human Signals");
    lines.push("");
    for (const h of humanIndicators) {
      lines.push(`- **[${h.type}]** ${h.description} (weight: ${h.weight})`);
    }
    lines.push("");
  }

  if (mdTriageAssistant) {
    if (mdTriageAssistant.reproGuidance) {
      const rg = mdTriageAssistant.reproGuidance;
      lines.push("## Reproduction Guidance");
      lines.push("");
      lines.push(`**Detected Vulnerability Class**: ${rg.vulnClass} (confidence: ${(rg.confidence * 100).toFixed(0)}%)`);
      lines.push("");
      lines.push("### Steps to Reproduce");
      for (const step of rg.steps) {
        lines.push(`${step.order}. ${step.instruction}${step.note ? ` *(${step.note})*` : ""}`);
      }
      lines.push("");
      lines.push("### Environment Needed");
      for (const env of rg.environment) {
        lines.push(`- ${env}`);
      }
      lines.push("");
      lines.push("### Recommended Tools");
      for (const tool of rg.tools) {
        lines.push(`- ${tool}`);
      }
      lines.push("");
    }

    if (mdTriageAssistant.gaps.length > 0) {
      lines.push("## Gap Analysis");
      lines.push("");
      for (const gap of mdTriageAssistant.gaps) {
        const icon = gap.severity === "critical" ? "🔴" : gap.severity === "important" ? "🟡" : "🔵";
        lines.push(`- ${icon} **${gap.category.replace(/_/g, " ")}** (${gap.severity}): ${gap.description}`);
        lines.push(`  - *Suggestion*: ${gap.suggestion}`);
      }
      lines.push("");
    }

    if (mdTriageAssistant.dontMiss.length > 0) {
      lines.push("## Don't Miss");
      lines.push("");
      for (const item of mdTriageAssistant.dontMiss) {
        lines.push(`### ${item.area}`);
        lines.push(`⚠️ ${item.warning}`);
        lines.push(`> ${item.reason}`);
        lines.push("");
      }
    }

    if (mdTriageAssistant.reporterFeedback.length > 0) {
      lines.push("## Reporter Feedback");
      lines.push("");
      for (const fb of mdTriageAssistant.reporterFeedback) {
        const icon = fb.tone === "positive" ? "✅" : fb.tone === "concern" ? "⚠️" : "ℹ️";
        lines.push(`- ${icon} ${fb.message}`);
      }
      lines.push("");
    }

    if (mdTriageAssistant.reproRecipe) {
      const rr = mdTriageAssistant.reproRecipe;
      lines.push(`## Reproduction Recipe: ${rr.title}`);
      lines.push("");
      if (rr.target) {
        lines.push(`**Target**: ${rr.target.name}${rr.target.version ? ` v${rr.target.version}` : ""}${rr.target.source ? ` (${rr.target.source})` : ""}`);
        lines.push("");
      }
      if (rr.setupCommands.length > 0) {
        lines.push("### Setup");
        lines.push("```bash");
        rr.setupCommands.forEach(cmd => lines.push(cmd));
        lines.push("```");
        lines.push("");
      }
      if (rr.pocScript) {
        lines.push(`### PoC Script (${rr.pocLanguage || "bash"})`);
        lines.push(`\`\`\`${rr.pocLanguage || "bash"}`);
        lines.push(rr.pocScript);
        lines.push("```");
        lines.push("");
      }
      if (rr.expectedOutput) {
        lines.push("### Expected Output");
        lines.push(rr.expectedOutput);
        lines.push("");
      }
      if (rr.dockerfile) {
        lines.push("### Dockerfile");
        lines.push("```dockerfile");
        lines.push(rr.dockerfile);
        lines.push("```");
        lines.push("");
      }
      if (rr.hardware && rr.hardware.length > 0) {
        lines.push("### Hardware Components");
        for (const hw of rr.hardware) {
          lines.push(`- **${hw.vendor}${hw.model ? ` ${hw.model}` : ""}** (${hw.type})`);
          if (hw.productUrl) lines.push(`  Product: ${hw.productUrl}`);
          if (hw.emulationOptions.length > 0) lines.push(`  Emulation: ${hw.emulationOptions[0]}`);
        }
        lines.push("");
      }
      if (rr.notes.length > 0) {
        lines.push("### Notes");
        rr.notes.forEach(n => lines.push(`- ⚠️ ${n}`));
        lines.push("");
      }
    }

    if (mdTriageAssistant.llmTriageGuidance) {
      const ltg = mdTriageAssistant.llmTriageGuidance;
      lines.push("## AI-Assisted Triage Guidance");
      lines.push("");
      if (ltg.reproSteps.length > 0) {
        lines.push("### Recommended Reproduction Steps");
        ltg.reproSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        lines.push("");
      }
      if (ltg.missingInfo.length > 0) {
        lines.push("### Missing Information");
        ltg.missingInfo.forEach(s => lines.push(`- ${s}`));
        lines.push("");
      }
      if (ltg.dontMiss.length > 0) {
        lines.push("### Don't Overlook");
        ltg.dontMiss.forEach(s => lines.push(`- ${s}`));
        lines.push("");
      }
      if (ltg.reporterFeedback) {
        lines.push(`**Reporter Assessment**: ${ltg.reporterFeedback}`);
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("*Generated by VulnRap v3.0 — Free & Anonymous Vulnerability Report Validation*");

  res.set("Content-Type", "text/markdown; charset=utf-8");
  res.send(lines.join("\n"));
});

router.delete("/reports/:id", async (req, res): Promise<void> => {
  const params = GetReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = DeleteReportBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Missing or invalid deleteToken." });
    return;
  }

  const [report] = await db
    .select({ id: reportsTable.id, deleteToken: reportsTable.deleteToken })
    .from(reportsTable)
    .where(eq(reportsTable.id, params.data.id));

  if (!report) {
    res.status(404).json({ error: "Report not found." });
    return;
  }

  if (!report.deleteToken || report.deleteToken.length === 0) {
    res.status(403).json({ error: "This report cannot be deleted (no delete token was issued)." });
    return;
  }

  const storedToken = report.deleteToken;
  const providedToken = body.data.deleteToken;

  if (typeof providedToken !== "string" || providedToken.length !== storedToken.length) {
    res.status(403).json({ error: "Invalid delete token." });
    return;
  }

  if (!crypto.timingSafeEqual(Buffer.from(storedToken, "utf-8"), Buffer.from(providedToken, "utf-8"))) {
    res.status(403).json({ error: "Invalid delete token." });
    return;
  }

  await db.delete(reportsTable).where(eq(reportsTable.id, params.data.id));

  logger.info({ reportId: params.data.id }, "Report deleted by user");

  const response = DeleteReportResponse.parse({
    message: "Report and all associated data have been permanently deleted.",
  });

  res.json(response);
});

export default router;
