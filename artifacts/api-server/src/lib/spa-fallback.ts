import fs from "fs";
import path from "path";
import type { Request, Response } from "express";
import {
  extractReportIdFromPath,
  buildOgMetaForReport,
  injectOgMeta,
} from "./og-meta-injection";
import { logger } from "./logger";

export function createSpaFallback(frontendDir: string) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache");
    const indexPath = path.join(frontendDir, "index.html");

    const reportId = extractReportIdFromPath(req.path);
    if (reportId) {
      try {
        const meta = await buildOgMetaForReport(reportId, req);
        if (meta) {
          const rawHtml = fs.readFileSync(indexPath, "utf-8");
          const rewritten = injectOgMeta(rawHtml, meta);
          res.type("html").send(rewritten);
          return;
        }
      } catch (err) {
        logger.warn(
          { err, reportId },
          "og-meta SPA rewrite failed; serving default index.html",
        );
      }
    }

    res.sendFile(indexPath);
  };
}
