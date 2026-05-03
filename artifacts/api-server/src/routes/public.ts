// Task #617 — Public-safe transparency endpoints. Wraps the internal
// AVRI drift compute with a redacted DTO so the public `/transparency`
// page can show that the platform actively monitors itself for
// calibration drift without exposing reviewer-only fields.
import { Router, type IRouter } from "express";
import { getPublicDriftSummary } from "../lib/avri-drift-public";
import { buildCweCatalog } from "../lib/cwe-catalog";

const router: IRouter = Router();

router.get("/public/drift-summary", async (req, res) => {
  try {
    const summary = await getPublicDriftSummary();
    res.json(summary);
  } catch (err) {
    req.log?.error(err, "Failed to generate public drift summary");
    res.status(500).json({ error: "Failed to generate public drift summary." });
  }
});

// Task #663 — Public CWE catalog used by the `/cwe` reference page.
// Cached aggressively because the underlying fingerprint library is
// static and the per-CWE counts only shift as the corpus grows.
router.get("/public/cwe-catalog", async (req, res) => {
  try {
    const catalog = await buildCweCatalog();
    res.set(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=1200",
    );
    res.json(catalog);
  } catch (err) {
    req.log?.error(err, "Failed to build CWE catalog");
    res.status(500).json({ error: "Failed to build CWE catalog." });
  }
});

export default router;
