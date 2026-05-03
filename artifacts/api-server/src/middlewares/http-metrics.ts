// Task #724 — Tiny middleware that records per-request Prometheus metrics.
//
// Runs after the route is matched (uses `req.route?.path` when available, and
// falls back to "unmatched" so we never explode the label cardinality on 404
// scanners). Increments an in-flight gauge on entry and decrements on
// `res.on("finish")` so even error responses are accounted for.
import type { Request, Response, NextFunction } from "express";
import {
  httpRequestDuration,
  httpRequestTotal,
  httpRequestsInFlight,
} from "../lib/metrics";

function resolveRoute(req: Request): string {
  const routePath = (req as Request & { route?: { path?: string } }).route
    ?.path;
  if (typeof routePath === "string" && routePath.length > 0) {
    // baseUrl is the mount point (e.g. "/api"); routePath is the matched
    // pattern (e.g. "/reports/:id"). Concatenate so dashboards see the full
    // template.
    return (req.baseUrl || "") + routePath;
  }
  return "unmatched";
}

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  const method = req.method;
  httpRequestsInFlight.inc({ method });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    httpRequestsInFlight.dec({ method });
    const route = resolveRoute(req);
    const labels = {
      method,
      route,
      status_code: String(res.statusCode),
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    httpRequestDuration.observe(labels, seconds);
    httpRequestTotal.inc(labels);
  };
  res.on("finish", finish);
  res.on("close", finish);
  next();
}
