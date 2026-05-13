// Task #706 — Public status / uptime page snapshot.
// Reads the analysis_traces telemetry table to derive:
//   * 30-day uptime % (fraction of last 30 days that recorded ≥1 trace).
//   * 24h p50/p95 end-to-end pipeline latency.
//   * Per-engine subsystem health (linguistic, substance, CWE, AVRI, LLM
//     gate) based on how recently each pipeline stage was last seen.
import { Router, type IRouter } from "express";
import { gte } from "drizzle-orm";
import { createHash } from "crypto";
import { db, analysisTracesTable, type PipelineTrace } from "@workspace/db";
import {
  GetPublicStatusResponse,
  GetPublicStatusIncidentsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const UPTIME_WINDOW_DAYS = 30;
const LATENCY_WINDOW_HOURS = 24;
const RECENT_HEALTHY_MS = 60 * 60 * 1000; // 1h
const RECENT_DEGRADED_MS = 6 * 60 * 60 * 1000; // 6h

// Stable identifiers surfaced on the public status page, mapped to the
// pipeline stage names emitted by `analyzeWithEnginesTraced`. The "LLM
// gate" subsystem maps to the perplexity stage — the only LLM-derived
// scoring layer in the current pipeline.
//
// In AVRI mode (production default), Engines 1/2/3 run *inside*
// `runAvriComposite` and are not emitted as separate trace stages. We
// therefore treat `avri_composite` as evidence of health for those
// sub-engines too — otherwise they always appear "Down" even though
// they are executing on every report.
const ENGINE_DEFINITIONS: ReadonlyArray<{
  id: string;
  label: string;
  stages: ReadonlyArray<string>;
}> = [
  {
    id: "linguistic",
    label: "Linguistic Engine",
    stages: ["engine1_ai_authorship", "avri_composite"],
  },
  {
    id: "substance",
    label: "Substance Engine",
    stages: ["engine2_substance", "avri_composite"],
  },
  {
    id: "cwe",
    label: "CWE Coherence Engine",
    stages: ["engine3_cwe_coherence", "avri_composite"],
  },
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

  // Per-engine: when did we last see ANY of the engine's stages, and
  // how many distinct traces in the last hour covered the engine? We
  // count per-trace (not per-stage) so an engine that maps to multiple
  // candidate stages — e.g. `engine1_ai_authorship` OR `avri_composite`
  // for Linguistic — isn't double-counted when both appear in the same
  // trace.
  const lastSeenByEngine = new Map<string, number>();
  const recentCountByEngine = new Map<string, number>();
  for (const row of rows) {
    const trace = row.trace as PipelineTrace | null;
    if (!trace || !Array.isArray(trace.stages)) continue;
    const ts = row.createdAt.getTime();
    const isRecent = now - ts <= RECENT_HEALTHY_MS;
    const stageSet = new Set<string>();
    for (const stage of trace.stages) {
      if (!stage || typeof stage.stage !== "string") continue;
      stageSet.add(stage.stage);
    }
    for (const def of ENGINE_DEFINITIONS) {
      const matches = def.stages.some((s) => stageSet.has(s));
      if (!matches) continue;
      const prev = lastSeenByEngine.get(def.id) ?? 0;
      if (ts > prev) lastSeenByEngine.set(def.id, ts);
      if (isRecent) {
        recentCountByEngine.set(
          def.id,
          (recentCountByEngine.get(def.id) ?? 0) + 1,
        );
      }
    }
  }

  const engines = ENGINE_DEFINITIONS.map((def) => {
    const lastSeen = lastSeenByEngine.get(def.id) ?? 0;
    const recentCount = recentCountByEngine.get(def.id) ?? 0;
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

const INCIDENT_GAP_MS = 60 * 60 * 1000; // 1h — gap threshold for incident detection

interface IncidentWindow {
  startMs: number;
  endMs: number | null;
  affectedEngineIds: Set<string>;
}

function buildIncidentId(startMs: number, engineIds: string[]): string {
  const raw = `${startMs}:${[...engineIds].sort().join(",")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

router.get("/public/status/incidents", async (_req, res): Promise<void> => {
  const now = Date.now();
  const since = new Date(now - UPTIME_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      createdAt: analysisTracesTable.createdAt,
      trace: analysisTracesTable.trace,
    })
    .from(analysisTracesTable)
    .where(gte(analysisTracesTable.createdAt, since));

  const stageToEngine = new Map<string, { id: string; label: string }>();
  for (const def of ENGINE_DEFINITIONS) {
    for (const stage of def.stages) {
      stageToEngine.set(stage, { id: def.id, label: def.label });
    }
  }

  const tracesByEngine = new Map<string, number[]>();
  for (const def of ENGINE_DEFINITIONS) {
    tracesByEngine.set(def.id, []);
  }

  for (const row of rows) {
    const trace = row.trace as PipelineTrace | null;
    if (!trace || !Array.isArray(trace.stages)) continue;
    const ts = row.createdAt.getTime();
    const seenEngines = new Set<string>();
    for (const stage of trace.stages) {
      if (!stage || typeof stage.stage !== "string") continue;
      const eng = stageToEngine.get(stage.stage);
      if (eng && !seenEngines.has(eng.id)) {
        seenEngines.add(eng.id);
        tracesByEngine.get(eng.id)!.push(ts);
      }
    }
  }

  for (const timestamps of tracesByEngine.values()) {
    timestamps.sort((a, b) => a - b);
  }

  const gapsByEngine = new Map<string, Array<{ startMs: number; endMs: number | null }>>();

  for (const def of ENGINE_DEFINITIONS) {
    const timestamps = tracesByEngine.get(def.id)!;
    const gaps: Array<{ startMs: number; endMs: number | null }> = [];

    if (timestamps.length === 0) {
      continue;
    }

    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i] - timestamps[i - 1];
      if (gap > INCIDENT_GAP_MS) {
        gaps.push({
          startMs: timestamps[i - 1],
          endMs: timestamps[i],
        });
      }
    }

    const lastTrace = timestamps[timestamps.length - 1];
    if (now - lastTrace > INCIDENT_GAP_MS) {
      gaps.push({
        startMs: lastTrace,
        endMs: null,
      });
    }

    if (gaps.length > 0) {
      gapsByEngine.set(def.id, gaps);
    }
  }

  const allGaps: Array<{ startMs: number; endMs: number | null; engineId: string }> = [];
  for (const [engineId, gaps] of gapsByEngine) {
    for (const gap of gaps) {
      allGaps.push({ ...gap, engineId });
    }
  }

  allGaps.sort((a, b) => a.startMs - b.startMs);

  const incidentWindows: IncidentWindow[] = [];
  for (const gap of allGaps) {
    const gapEnd = gap.endMs ?? now;
    if (incidentWindows.length > 0) {
      const last = incidentWindows[incidentWindows.length - 1];
      const lastEnd = last.endMs ?? now;
      if (gap.startMs <= lastEnd) {
        last.startMs = Math.min(last.startMs, gap.startMs);
        last.endMs =
          last.endMs === null || gap.endMs === null
            ? null
            : Math.max(last.endMs, gapEnd);
        last.affectedEngineIds.add(gap.engineId);
        continue;
      }
    }
    incidentWindows.push({
      startMs: gap.startMs,
      endMs: gap.endMs,
      affectedEngineIds: new Set([gap.engineId]),
    });
  }

  incidentWindows.sort((a, b) => b.startMs - a.startMs);

  const engineLabelMap = new Map<string, string>();
  for (const def of ENGINE_DEFINITIONS) {
    engineLabelMap.set(def.id, def.label);
  }

  const incidents = incidentWindows.map((w) => {
    const engineIds = [...w.affectedEngineIds].sort();
    const severity: "degraded" | "outage" =
      engineIds.length >= ENGINE_DEFINITIONS.length ? "outage" : "degraded";

    return {
      id: buildIncidentId(w.startMs, engineIds),
      severity,
      startedAt: new Date(w.startMs).toISOString(),
      endedAt: w.endMs !== null ? new Date(w.endMs).toISOString() : null,
      durationMs: w.endMs !== null ? w.endMs - w.startMs : null,
      affectedEngines: engineIds.map((id) => ({
        id,
        label: engineLabelMap.get(id) ?? id,
      })),
    };
  });

  const response = GetPublicStatusIncidentsResponse.parse({
    generatedAt: new Date(now).toISOString(),
    windowDays: UPTIME_WINDOW_DAYS,
    incidents,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json(response);
});

export default router;
