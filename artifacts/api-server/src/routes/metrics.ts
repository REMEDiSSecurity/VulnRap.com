// Task #724 — Prometheus scrape endpoint.
//
// Mounted under /api/metrics (so it inherits the same helmet / CORS posture
// as the rest of the API). Opt-in via env vars:
//   METRICS_ENABLED  (default "true"; set "false" to disable entirely)
//   METRICS_TOKEN    (optional bearer token for hosted setups; when set,
//                     requests must send `Authorization: Bearer <token>`)
import { Router, type IRouter, type Request, type Response } from "express";
import { registry } from "../lib/metrics";

const router: IRouter = Router();

function isEnabled(): boolean {
  const raw = process.env.METRICS_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

function isAuthorized(req: Request): boolean {
  const token = process.env.METRICS_TOKEN;
  const trimmed = token?.trim() ?? "";
  if (trimmed.length === 0) {
    // Task #1310 — Fail closed in production. METRICS_TOKEN is enforced
    // at startup by validateProductionConfig; this is defence-in-depth
    // so a future regression that loosens the startup check still
    // can't expose the scrape endpoint to the public Internet (it would
    // leak per-route latency / volume telemetry useful for recon).
    if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
      return false;
    }
    return true;
  }
  const auth = req.header("authorization");
  if (!auth) return false;
  const expected = `Bearer ${trimmed}`;
  return auth === expected;
}

router.get("/metrics", async (req: Request, res: Response) => {
  if (!isEnabled()) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).type("text/plain").send("Unauthorized");
    return;
  }
  try {
    const body = await registry.metrics();
    res.setHeader("Content-Type", registry.contentType);
    res.send(body);
  } catch (err) {
    res
      .status(500)
      .type("text/plain")
      .send(`Failed to render metrics: ${(err as Error).message}`);
  }
});

export default router;
