import { Router, type IRouter } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { reportsTable } from "@workspace/db";
import {
  GetReportParams,
  GetReportResponse,
  LookupByHashParams,
  LookupByHashResponse,
} from "@workspace/api-zod";
import { computeMinHash, computeSimhash, computeContentHash, findSimilarReports } from "../lib/similarity";
import { analyzeSloppiness } from "../lib/sloppiness";
import { sanitizeText, sanitizeFileName } from "../lib/sanitize";

const MAX_FILE_SIZE = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "text/plain",
      "text/markdown",
      "text/x-markdown",
      "application/octet-stream",
    ];
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith(".txt") || ext.endsWith(".md")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported file type. Only .txt and .md files are accepted."));
    }
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
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded. Please attach a .txt or .md file." });
    return;
  }

  const contentMode = req.body.contentMode === "similarity_only" ? "similarity_only" : "full";
  const rawText = req.file.buffer.toString("utf-8");
  const text = sanitizeText(rawText);

  if (text.length === 0) {
    res.status(400).json({ error: "File is empty or contains no readable text." });
    return;
  }

  const contentHash = computeContentHash(text);
  const simhash = computeSimhash(text);
  const minhashSignature = computeMinHash(text);

  const existingReports = await db
    .select({
      id: reportsTable.id,
      minhashSignature: reportsTable.minhashSignature,
      simhash: reportsTable.simhash,
    })
    .from(reportsTable);

  const similarityMatches = findSimilarReports(minhashSignature, simhash, existingReports as Array<{ id: number; minhashSignature: number[]; simhash: string }>);

  const analysis = analyzeSloppiness(text);

  const fileName = req.file.originalname ? sanitizeFileName(req.file.originalname) : null;

  const [report] = await db
    .insert(reportsTable)
    .values({
      contentHash,
      simhash,
      minhashSignature,
      contentText: contentMode === "full" ? text : null,
      contentMode,
      slopScore: analysis.score,
      similarityMatches,
      feedback: analysis.feedback,
      fileName,
      fileSize: req.file.size,
    })
    .returning();

  const response = GetReportResponse.parse({
    id: report.id,
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: analysis.tier,
    similarityMatches: report.similarityMatches,
    feedback: report.feedback,
    fileName: report.fileName,
    fileSize: report.fileSize,
    createdAt: report.createdAt,
  });

  res.status(201).json(response);
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

  const analysis = analyzeSloppiness(
    report.contentText || ""
  );

  const response = GetReportResponse.parse({
    id: report.id,
    contentHash: report.contentHash,
    contentMode: report.contentMode,
    slopScore: report.slopScore,
    slopTier: analysis.tier,
    similarityMatches: report.similarityMatches,
    feedback: report.feedback,
    fileName: report.fileName,
    fileSize: report.fileSize,
    createdAt: report.createdAt,
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
  const analysis = analyzeSloppiness(report.contentText || "");

  const response = LookupByHashResponse.parse({
    found: true,
    reportId: report.id,
    slopScore: report.slopScore,
    slopTier: analysis.tier,
    matchCount: matches.length,
    firstSeen: report.createdAt,
  });

  res.json(response);
});

export default router;
