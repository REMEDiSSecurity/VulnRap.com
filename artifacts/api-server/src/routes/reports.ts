import { Router, type IRouter } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { computeMinHash, computeSimhash, computeContentHash, computeLSHBuckets, findSimilarReports } from "../lib/similarity";
import { analyzeSloppiness } from "../lib/sloppiness";
import { redactReport } from "../lib/redactor";
import { parseSections, findSectionMatches } from "../lib/section-parser";
import { sanitizeText, sanitizeFileName } from "../lib/sanitize";
import { extractTextFromPdf } from "../lib/pdf";
import { sql } from "drizzle-orm";

const MAX_FILE_SIZE = 20 * 1024 * 1024;

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

  let text: string;
  let safeFileName: string | null = null;
  let rawFileSize: number;

  const rawText = typeof req.body.rawText === "string" ? req.body.rawText : "";

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
  } else if (rawText.length > 0) {
    text = sanitizeText(rawText);
    safeFileName = "pasted-text.txt";
    rawFileSize = Buffer.byteLength(rawText, "utf-8");
    if (rawFileSize > MAX_FILE_SIZE) {
      res.status(413).json({ error: "Text exceeds 20MB limit." });
      return;
    }
  } else {
    res.status(400).json({ error: "No content provided. Upload a file or paste report text." });
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

  const existingReports = await db
    .select({
      id: reportsTable.id,
      minhashSignature: reportsTable.minhashSignature,
      simhash: reportsTable.simhash,
      lshBuckets: reportsTable.lshBuckets,
      sectionHashes: reportsTable.sectionHashes,
    })
    .from(reportsTable);

  const similarityMatches = findSimilarReports(
    minhashSignature,
    simhash,
    lshBuckets,
    existingReports as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
  );

  const sectionMatches = findSectionMatches(
    sectionHashes,
    existingReports as Array<{ id: number; sectionHashes: Record<string, string> }>,
  );

  const analysis = analyzeSloppiness(text);

  const [report] = await db
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
      fileName: safeFileName,
      fileSize: rawFileSize,
    })
    .returning();

  await db.insert(reportHashesTable).values([
    { reportId: report.id, hashType: "sha256", hashValue: contentHash },
    { reportId: report.id, hashType: "simhash", hashValue: simhash },
  ]);

  if (similarityMatches.length > 0) {
    await db.insert(similarityResultsTable).values(
      similarityMatches.map(m => ({
        sourceReportId: report.id,
        matchedReportId: m.reportId,
        similarityScore: m.similarity / 100,
        matchType: m.matchType,
      }))
    );
  }

  await db
    .insert(reportStatsTable)
    .values({ key: "total_reports", value: 1 })
    .onConflictDoUpdate({
      target: reportStatsTable.key,
      set: { value: sql`${reportStatsTable.value} + 1` },
    });

  if (similarityMatches.length > 0) {
    await db
      .insert(reportStatsTable)
      .values({ key: "duplicates_detected", value: 1 })
      .onConflictDoUpdate({
        target: reportStatsTable.key,
        set: { value: sql`${reportStatsTable.value} + 1` },
      });
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
  } else if (rawText.length > 0) {
    text = sanitizeText(rawText);
    if (Buffer.byteLength(rawText, "utf-8") > MAX_FILE_SIZE) {
      res.status(413).json({ error: "Text exceeds 20MB limit." });
      return;
    }
  } else {
    res.status(400).json({ error: "No content provided. Upload a file or paste report text." });
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

  const existingReports = await db
    .select({
      id: reportsTable.id,
      minhashSignature: reportsTable.minhashSignature,
      simhash: reportsTable.simhash,
      lshBuckets: reportsTable.lshBuckets,
      sectionHashes: reportsTable.sectionHashes,
    })
    .from(reportsTable);

  const similarityMatches = findSimilarReports(
    minhashSignature, simhash, lshBuckets,
    existingReports as Array<{ id: number; minhashSignature: number[]; simhash: string; lshBuckets: string[] }>,
  );

  const sectionMatches = findSectionMatches(
    sectionHashes,
    existingReports as Array<{ id: number; sectionHashes: Record<string, string> }>,
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
