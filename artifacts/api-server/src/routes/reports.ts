import { Router, type IRouter } from "express";
import crypto from "crypto";
import multer from "multer";
import { eq, or, sql } from "drizzle-orm";
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
import { fuseScores, type FusionResult, type EvidenceItem } from "../lib/score-fusion";
import { redactReport } from "../lib/redactor";
import { parseSections, findSectionMatches } from "../lib/section-parser";
import { sanitizeText, sanitizeFileName, detectBinaryContent } from "../lib/sanitize";
import { extractTextFromPdf } from "../lib/pdf";
import { logger } from "../lib/logger";
import { performActiveVerification, type VerificationResult } from "../lib/active-verification";
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

interface AnalysisResult extends FusionResult {
  feedback: string[];
  llmResult: Awaited<ReturnType<typeof analyzeSlopWithLLM>>;
  verification: VerificationResult | null;
  triageRecommendation: TriageRecommendation | null;
  triageAssistant: TriageAssistantResult | null;
}

async function performAnalysis(originalText: string, redactedText: string): Promise<AnalysisResult> {
  const [heuristic, linguistic, factual, verification] = await Promise.all([
    Promise.resolve(analyzeSloppiness(originalText)),
    Promise.resolve(analyzeLinguistic(originalText)),
    Promise.resolve(analyzeFactual(originalText)),
    performActiveVerification(redactedText).catch((err) => {
      logger.warn({ err }, "Active verification failed, skipping");
      return null;
    }),
  ]);

  const preliminary = fuseScores(linguistic, factual, null, heuristic.qualityScore, originalText, undefined, verification);

  let llmResult: LLMSlopResult | null = null;
  const llmAvailable = isLLMAvailable();
  const callLlm = shouldCallLLM(preliminary.slopScore, preliminary.confidence);
  logger.info(
    { preliminaryScore: preliminary.slopScore, confidence: preliminary.confidence, llmAvailable, callLlm },
    "LLM decision"
  );
  if (callLlm) {
    llmResult = await analyzeSlopWithLLM(redactedText);
  }

  const fusion = llmResult
    ? fuseScores(linguistic, factual, llmResult, heuristic.qualityScore, originalText, undefined, verification)
    : preliminary;

  let triageRecommendation: TriageRecommendation | null = null;
  try {
    const base = generateTriageRecommendation(
      fusion.slopScore,
      fusion.confidence,
      verification,
      fusion.evidence,
    );
    const temporalSignals = computeTemporalSignals(verification);
    triageRecommendation = {
      ...base,
      temporalSignals,
      templateMatch: null,
      revision: null,
    };
  } catch (err) {
    logger.warn({ err }, "Triage recommendation generation failed");
  }

  let triageAssistant: TriageAssistantResult | null = null;
  try {
    triageAssistant = generateTriageAssistant(
      originalText,
      fusion.slopScore,
      fusion.confidence,
      fusion.evidence,
      verification,
      llmResult?.llmTriageGuidance ?? null,
    );
  } catch (err) {
    logger.warn({ err }, "Triage assistant generation failed");
  }

  return {
    ...fusion,
    feedback: heuristic.feedback,
    llmResult,
    verification,
    triageRecommendation,
    triageAssistant,
  };
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

  const { redactedText, summary: redactionSummary } = redactReport(text);

  const analysisText = redactedText;

  const contentHash = computeContentHash(analysisText);
  const simhash = computeSimhash(analysisText);
  const minhashSignature = computeMinHash(analysisText);
  const lshBuckets = computeLSHBuckets(minhashSignature);

  const { sections, sectionHashes } = parseSections(analysisText);

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

  const similarityMatches = findSimilarReports(
    minhashSignature,
    simhash,
    lshBuckets,
    candidateReports as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
  );

  const sectionMatches = findSectionMatches(
    sectionHashes,
    candidateReports as Array<{ id: number; sectionHashes: Record<string, string> }>,
  );

  const analysisResult = await performAnalysis(text, redactedText);
  const { llmResult } = analysisResult;

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
        breakdown: analysisResult.breakdown,
        evidence: analysisResult.evidence,
        humanIndicators: analysisResult.humanIndicators,
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
    breakdown: report.breakdown ?? { linguistic: 0, factual: 0, template: 0, llm: null, verification: null, quality: 50 },
    evidence: report.evidence ?? [],
    humanIndicators: report.humanIndicators ?? [],
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
    verification: analysisResult.verification ?? null,
    triageRecommendation: analysisResult.triageRecommendation ?? null,
    triageAssistant: analysisResult.triageAssistant ?? null,
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

  const { redactedText, summary: redactionSummary } = redactReport(text);
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

    const response = CheckReportResponse.parse({
      slopScore: cached.slopScore,
      slopTier: cached.slopTier,
      qualityScore: cached.qualityScore,
      confidence: cached.confidence,
      breakdown: cached.breakdown,
      evidence: cached.evidence,
      humanIndicators: cached.humanIndicators,
      similarityMatches: cached.similarityMatches,
      sectionHashes: cached.sectionHashes,
      sectionMatches: cached.sectionMatches,
      redactionSummary: cached.redactionSummary,
      feedback: cached.feedback,
      llmSlopScore: cached.llmSlopScore ?? null,
      llmFeedback: cached.llmFeedback ?? null,
      llmBreakdown: cached.llmBreakdown ?? null,
      llmEnhanced: cached.llmSlopScore != null,
      verification: null,
      triageRecommendation: cachedTriageRecommendation,
      triageAssistant: cachedTriageAssistant,
      previouslySubmitted: true,
      existingReportId: cached.id,
    });
    res.json(response);
    return;
  }

  const simhash = computeSimhash(analysisText);
  const minhashSignature = computeMinHash(analysisText);
  const lshBuckets = computeLSHBuckets(minhashSignature);
  const { sectionHashes } = parseSections(analysisText);

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

  const similarityMatches = findSimilarReports(
    minhashSignature, simhash, lshBuckets,
    checkCandidates as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
  );

  const sectionMatches = findSectionMatches(
    sectionHashes,
    checkCandidates as Array<{ id: number; sectionHashes: Record<string, string> }>,
  );

  const analysisResult = await performAnalysis(text, analysisText);

  const { llmResult: checkLlmResult } = analysisResult;

  const response = CheckReportResponse.parse({
    slopScore: analysisResult.slopScore,
    slopTier: analysisResult.slopTier,
    qualityScore: analysisResult.qualityScore,
    confidence: analysisResult.confidence,
    breakdown: analysisResult.breakdown,
    evidence: analysisResult.evidence,
    humanIndicators: analysisResult.humanIndicators,
    similarityMatches,
    sectionHashes,
    sectionMatches,
    redactionSummary,
    feedback: analysisResult.feedback,
    llmSlopScore: checkLlmResult ? checkLlmResult.llmSlopScore : null,
    llmFeedback: checkLlmResult ? checkLlmResult.llmFeedback : null,
    llmBreakdown: checkLlmResult?.llmBreakdown ?? null,
    llmEnhanced: checkLlmResult != null,
    verification: analysisResult.verification ?? null,
    triageRecommendation: analysisResult.triageRecommendation ?? null,
    triageAssistant: analysisResult.triageAssistant ?? null,
    previouslySubmitted: false,
    existingReportId: null,
  });

  res.json(response);
});

router.get("/reports/feed", async (req, res): Promise<void> => {
  const limitParam = parseInt(String(req.query.limit || "10"), 10);
  const limit = Math.max(1, Math.min(50, isNaN(limitParam) ? 10 : limitParam));

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
    .where(eq(reportsTable.showInFeed, true))
    .orderBy(sql`${reportsTable.createdAt} desc`)
    .limit(limit);

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

  const response = GetReportFeedResponse.parse({ reports: mapped });
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
    breakdown: report.breakdown ?? { linguistic: 0, factual: 0, template: 0, llm: null, verification: null, quality: 50 },
    evidence: report.evidence ?? [],
    humanIndicators: report.humanIndicators ?? [],
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
    verification,
    triageRecommendation,
    triageAssistant,
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
