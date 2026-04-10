import { Router, type IRouter } from "express";
import multer from "multer";
import { eq, or, sql as dsql } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { computeMinHash, computeSimhash, computeContentHash, computeLSHBuckets, findSimilarReports } from "../lib/similarity";
import { analyzeSloppiness } from "../lib/sloppiness";
import { redactReport } from "../lib/redactor";
import { parseSections, findSectionMatches } from "../lib/section-parser";
import { sanitizeText, sanitizeFileName } from "../lib/sanitize";
import { extractTextFromPdf } from "../lib/pdf";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
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
        res.status(413).json({ error: "File exceeds 20MB limit." });
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
      res.status(413).json({ error: "Text exceeds 20MB limit." });
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
    dsql`${reportsTable.lshBuckets}::jsonb @> ${JSON.stringify([bucket])}::jsonb`
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

  const analysis = analyzeSloppiness(text);

  const report = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(reportsTable)
      .values({
        contentHash,
        simhash,
        minhashSignature,
        lshBuckets,
        contentText: contentMode === "full" ? analysisText : null,
        redactedText: contentMode === "full" ? analysisText : null,
        contentMode,
        slopScore: analysis.score,
        slopTier: analysis.tier,
        similarityMatches,
        sectionHashes,
        sectionMatches,
        redactionSummary,
        feedback: analysis.feedback,
        showInFeed,
        fileName: safeFileName,
        fileSize: rawFileSize,
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

    await tx
      .insert(reportStatsTable)
      .values({ key: "total_reports", value: 1 })
      .onConflictDoUpdate({
        target: reportStatsTable.key,
        set: { value: sql`${reportStatsTable.value} + 1` },
      });

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
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    similarityMatches: report.similarityMatches,
    sectionHashes: report.sectionHashes ?? {},
    sectionMatches: report.sectionMatches ?? [],
    redactedText: report.redactedText,
    redactionSummary: report.redactionSummary ?? { totalRedactions: 0, categories: {} },
    feedback: report.feedback,
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
        res.status(413).json({ error: "File exceeds 20MB limit." });
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
      res.status(413).json({ error: "Text exceeds 20MB limit." });
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
  const { sectionHashes } = parseSections(analysisText);

  const checkLshConditions = lshBuckets.map(bucket =>
    dsql`${reportsTable.lshBuckets}::jsonb @> ${JSON.stringify([bucket])}::jsonb`
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

  const analysis = analyzeSloppiness(text);

  const [existingReport] = await db
    .select({ id: reportsTable.id })
    .from(reportsTable)
    .where(eq(reportsTable.contentHash, contentHash));

  const response = CheckReportResponse.parse({
    slopScore: analysis.score,
    slopTier: analysis.tier,
    similarityMatches,
    sectionHashes,
    sectionMatches,
    redactionSummary,
    feedback: analysis.feedback,
    previouslySubmitted: !!existingReport,
    existingReportId: existingReport?.id ?? null,
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

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.PUBLIC_URL || "https://vulnrap.com";
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

  const response = GetReportResponse.parse({
    id: report.id,
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    similarityMatches: report.similarityMatches,
    sectionHashes: report.sectionHashes ?? {},
    sectionMatches: report.sectionMatches ?? [],
    redactedText: report.redactedText,
    redactionSummary: report.redactionSummary ?? { totalRedactions: 0, categories: {} },
    feedback: report.feedback,
    fileName: report.fileName,
    fileSize: report.fileSize,
    createdAt: report.createdAt,
  });

  res.json(response);
});

export default router;
