// Task #724 — Prometheus metrics registry & domain counters.
import client, { Counter, Histogram, Gauge, Registry } from "prom-client";
import { pool } from "@workspace/db";

export const registry: Registry = new client.Registry();

client.collectDefaultMetrics({
  register: registry,
  prefix: "vulnrap_",
});

export const httpRequestDuration: Histogram<string> = new client.Histogram({
  name: "vulnrap_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestTotal: Counter<string> = new client.Counter({
  name: "vulnrap_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

export const httpRequestsInFlight: Gauge<string> = new client.Gauge({
  name: "vulnrap_http_requests_in_flight",
  help: "Number of in-flight HTTP requests",
  labelNames: ["method"],
  registers: [registry],
});

// Domain counters
export const reportSubmittedTotal: Counter<string> = new client.Counter({
  name: "vulnrap_report_submitted_total",
  help: "Number of reports submitted (POST /api/reports success)",
  labelNames: ["outcome"],
  registers: [registry],
});

export const reportRedactedTotal: Counter<string> = new client.Counter({
  name: "vulnrap_report_redacted_total",
  help: "Number of reports run through the redactor",
  registers: [registry],
});

export const similarityMatchTotal: Counter<string> = new client.Counter({
  name: "vulnrap_similarity_match_total",
  help: "Number of similarity matches found across submissions",
  registers: [registry],
});

// External API metrics
export const externalApiCallTotal: Counter<string> = new client.Counter({
  name: "vulnrap_external_api_call_total",
  help: "External API calls by provider and outcome",
  labelNames: ["provider", "outcome"],
  registers: [registry],
});

export const externalApiCallDuration: Histogram<string> = new client.Histogram({
  name: "vulnrap_external_api_call_duration_seconds",
  help: "External API call duration in seconds",
  labelNames: ["provider", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// pg pool gauges
export const pgPoolTotal: Gauge<string> = new client.Gauge({
  name: "vulnrap_pg_pool_total",
  help: "Total pg pool clients",
  registers: [registry],
});
export const pgPoolIdle: Gauge<string> = new client.Gauge({
  name: "vulnrap_pg_pool_idle",
  help: "Idle pg pool clients",
  registers: [registry],
});
export const pgPoolWaiting: Gauge<string> = new client.Gauge({
  name: "vulnrap_pg_pool_waiting",
  help: "Pending acquire requests on the pg pool",
  registers: [registry],
});

let pgInterval: NodeJS.Timeout | null = null;
export function startPgPoolCollector(intervalMs = 5_000): void {
  if (pgInterval) return;
  const tick = () => {
    try {
      const p = pool as unknown as {
        totalCount?: number;
        idleCount?: number;
        waitingCount?: number;
      };
      pgPoolTotal.set(p.totalCount ?? 0);
      pgPoolIdle.set(p.idleCount ?? 0);
      pgPoolWaiting.set(p.waitingCount ?? 0);
    } catch {
      // ignore
    }
  };
  tick();
  pgInterval = setInterval(tick, intervalMs);
  pgInterval.unref?.();
}

export function stopPgPoolCollector(): void {
  if (pgInterval) {
    clearInterval(pgInterval);
    pgInterval = null;
  }
}

/**
 * Wrap an outbound external-API call so its duration and outcome land in
 * Prometheus regardless of how the caller handles errors. The provider label
 * is intentionally low-cardinality (e.g. "github", "openai", "nvd").
 */
export async function instrumentExternalCall<T>(
  provider: string,
  fn: () => Promise<T>,
  classify?: (value: T) => "success" | "error",
): Promise<T> {
  const start = process.hrtime.bigint();
  let outcome: "success" | "error" = "success";
  try {
    const value = await fn();
    if (classify) outcome = classify(value);
    return value;
  } catch (err) {
    outcome = "error";
    throw err;
  } finally {
    const elapsedSeconds =
      Number(process.hrtime.bigint() - start) / 1_000_000_000;
    externalApiCallTotal.inc({ provider, outcome });
    externalApiCallDuration.observe({ provider, outcome }, elapsedSeconds);
  }
}
