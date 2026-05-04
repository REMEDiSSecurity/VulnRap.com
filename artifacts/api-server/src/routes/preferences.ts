import { Router } from "express";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, userPreferences } from "@workspace/db";
import { requireCalibrationAuth } from "../middlewares/require-calibration-auth";
import { logger } from "../lib/logger";

const router = Router();

const THEME_KEY = "theme";
const VALID_THEMES = new Set(["system", "light", "dark"]);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function extractToken(req: import("express").Request): string | null {
  const headerVal = req.header("x-calibration-token");
  if (typeof headerVal === "string" && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  const auth = req.header("authorization");
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) {
      const tok = match[1].trim();
      if (tok.length > 0) return tok;
    }
  }
  return null;
}

router.get("/preferences/theme", requireCalibrationAuth, async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: "No token presented." });
      return;
    }
    const identity = hashToken(token);
    const rows = await db
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(
        and(
          eq(userPreferences.identityHash, identity),
          eq(userPreferences.key, THEME_KEY),
        ),
      )
      .limit(1);

    const theme = rows.length > 0 ? rows[0].value : null;
    res.json({ theme });
  } catch (err) {
    logger.error({ err }, "Failed to read theme preference");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/preferences/theme", requireCalibrationAuth, async (req, res) => {
  try {
    const { theme } = req.body as { theme?: string };
    if (typeof theme !== "string" || !VALID_THEMES.has(theme)) {
      res
        .status(400)
        .json({ error: `Invalid theme. Must be one of: ${[...VALID_THEMES].join(", ")}` });
      return;
    }
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: "No token presented." });
      return;
    }
    const identity = hashToken(token);
    const now = new Date();

    await db
      .insert(userPreferences)
      .values({
        identityHash: identity,
        key: THEME_KEY,
        value: theme,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userPreferences.identityHash, userPreferences.key],
        set: { value: theme, updatedAt: now },
      });

    res.json({ theme });
  } catch (err) {
    logger.error({ err }, "Failed to save theme preference");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
