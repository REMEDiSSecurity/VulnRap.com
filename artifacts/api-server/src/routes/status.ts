// Task #706 — Public status / uptime page snapshot.
// Reads the analysis_traces telemetry table to derive:
//   * 30-day uptime % (fraction of last 30 days that recorded ≥1 trace).
//   * 24h p50/p95 end-to-end pipeline latency.
//   * Per-engine subsystem health (linguistic, substance, CWE, AVRI, LLM
//     gate) based on how recently each pipeline stage was last seen.
import { Router, type IRouter } from "express";
import { gte } from "drizzle-orm";
import { db, analysisTracesTable, type PipelineTrace } from "@workspace/db";
import { GetPublicStatusResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const UPTIME_WINDOW_DAYS = 30;
const LATENCY_WINDOW_HOURS = 24;
const RECENT_HEALTHY_MS = 60 * 60 * 1000; // 1h
const RECENT_DEGRADED_MS = 6 * 60 * 60 * 1000; // 6h

// Stable identifiers surfaced on the public status page, mapped to the
// pipeline stage names emitted by `analyzeWithEnginesTraced`. The "LLM
// gate" subsystem maps to the perplexity stage — the only LLM-derived
// scoring layer in the current pipeline.
const ENGINE_DEFINITIONS: ReadonlyArray<{
  id: string;
  label: string;
  stages: ReadonlyArray<string>;
}> = [
  { id: "linguistic", label: "Linguistic Engine", stages: ["engine1_ai_authorship"] },
  { id: "substance", label: "Substance Engine", stages: ["engine2_substance"] },
  { id: "cwe", label: "CWE Coherence Engine", stages: ["engine3_cwe_coherence"] },
  { id: "avri", label: "AVRI Engine", stages: ["avri_composite"] },
  { id: "llm_gate", label: "LLM Gate", stages: ["perplexity"] },
];

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  const frac = rank - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

router.get("/public/status", async (_req, res): Promise<void> => {
  const now = Date.now();
  const uptimeSince = new Date(now - UPTIME_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const latencySince = new Date(now - LATENCY_WINDOW_HOURS * 60 * 60 * 1000);

  const rows = await db
    .select({
      createdAt: analysisTracesTable.createdAt,
      totalDurationMs: analysisTracesTable.totalDurationMs,
      trace: analysisTracesTable.trace,
    })
    .from(analysisTracesTable)
    .where(gte(analysisTracesTable.createdAt, uptimeSince));

  // Uptime: distinct UTC day buckets observed in the 30-day window.
  const distinctDays = new Set<string>();
  for (const row of rows) {
    distinctDays.add(dayKey(row.createdAt));
  }
  const daysWithTraffic = Math.min(distinctDays.size, UPTIME_WINDOW_DAYS);
  const uptimePercentage = Number(
    ((daysWithTraffic / UPTIME_WINDOW_DAYS) * 100).toFixed(2),
  );

  // Latency: 24h pipeline p50/p95.
  const latencyDurations: number[] = [];
  for (const row of rows) {
    if (
      row.createdAt.getTime() >= latencySince.getTime() &&
      typeof row.totalDurationMs === "number" &&
      row.totalDurationMs >= 0
    ) {
      latencyDurations.push(row.totalDurationMs);
    }
  }
  latencyDurations.sort((a, b) => a - b);
  const p50Ms = Number(percentile(latencyDurations, 50).toFixed(1));
  const p95Ms = Number(percentile(latencyDurations, 95).toFixed(1));

  // Per-engine: when did we last see each known stage, and how many of
  // those occurrences happened in the last hour?
  const lastSeenByStage = new Map<string, number>();
  const recentCountByStage = new Map<string, number>();
  for (const row of rows) {
    const trace = row.trace as PipelineTrace | null;
    if (!trace || !Array.isArray(trace.stages)) continue;
    const ts = row.createdAt.getTime();
    const isRecent = now - ts <= RECENT_HEALTHY_MS;
    for (const stage of trace.stages) {
      if (!stage || typeof stage.stage !== "string") continue;
      const prev = lastSeenByStage.get(stage.stage) ?? 0;
      if (ts > prev) lastSeenByStage.set(stage.stage, ts);
      if (isRecent) {
        recentCountByStage.set(
          stage.stage,
          (recentCountByStage.get(stage.stage) ?? 0) + 1,
        );
      }
    }
  }

  const engines = ENGINE_DEFINITIONS.map((def) => {
    let lastSeen = 0;
    let recentCount = 0;
    for (const stageName of def.stages) {
      const seen = lastSeenByStage.get(stageName) ?? 0;
      if (seen > lastSeen) lastSeen = seen;
      recentCount += recentCountByStage.get(stageName) ?? 0;
    }
    let status: "operational" | "degraded" | "down" | "unknown";
    if (lastSeen === 0) {
      status = "unknown";
    } else if (now - lastSeen <= RECENT_HEALTHY_MS) {
      status = "operational";
    } else if (now - lastSeen <= RECENT_DEGRADED_MS) {
      status = "degraded";
    } else {
      status = "down";
    }
    return {
      id: def.id,
      label: def.label,
      status,
      recentSampleCount: recentCount,
      lastSeenAt: lastSeen === 0 ? null : new Date(lastSeen).toISOString(),
    };
  });

  // Overall: down > degraded > operational. "unknown" engines do not
  // bring the banner down — a freshly-deployed instance with no traffic
  // shouldn't read as broken.
  let overallStatus: "operational" | "degraded" | "down" = "operational";
  for (const eng of engines) {
    if (eng.status === "down") {
      overallStatus = "down";
      break;
    }
    if (eng.status === "degraded" && overallStatus === "operational") {
      overallStatus = "degraded";
    }
  }

  const response = GetPublicStatusResponse.parse({
    generatedAt: new Date(now).toISOString(),
    overallStatus,
    uptime: {
      windowDays: UPTIME_WINDOW_DAYS,
      daysWithTraffic,
      uptimePercentage,
    },
    latency: {
      windowHours: LATENCY_WINDOW_HOURS,
      sampleCount: latencyDurations.length,
      p50Ms,
      p95Ms,
    },
    engines,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json(response);
});

export default router;
