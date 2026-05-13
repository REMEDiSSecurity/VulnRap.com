import { Router, type IRouter } from "express";
import { sql, gte, and, isNotNull } from "drizzle-orm";
import { db, analysisTracesTable, type PipelineTrace } from "@workspace/db";
import { GetLatencySnapshotResponse, GetLatencyHistoryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const WINDOW_HOURS = 24;

const BIN_EDGES_MS = [50, 100, 200, 400, 800, 1500, 3000, 5000, 10000, 20000];

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

function makeBins(values: number[]): { ltMs: number; count: number }[] {
  const bins = BIN_EDGES_MS.map((ltMs) => ({ ltMs, count: 0 }));
  const overflow = { ltMs: BIN_EDGES_MS[BIN_EDGES_MS.length - 1], count: 0 };
  for (const v of values) {
    let placed = false;
    for (let i = 0; i < BIN_EDGES_MS.length; i++) {
      if (v < BIN_EDGES_MS[i]) {
        bins[i].count += 1;
        placed = true;
        break;
      }
    }
    if (!placed) overflow.count += 1;
  }
  return [...bins, overflow];
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    percentiles: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      sampleCount: sorted.length,
    },
    bins: makeBins(values),
  };
}

router.get("/public/latency-snapshot", async (_req, res): Promise<void> => {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  // ORGANIC TRAFFIC ONLY — synthetic heartbeat rows (report_id IS
  // NULL) are excluded so we never publish latency derived from our
  // own self-tests. Heartbeats are still used by the status route
  // for "is the pipeline alive" liveness, just not for latency.
  const rows = await db
    .select({
      totalDurationMs: analysisTracesTable.totalDurationMs,
      trace: analysisTracesTable.trace,
    })
    .from(analysisTracesTable)
    .where(
      and(
        gte(analysisTracesTable.createdAt, since),
        isNotNull(analysisTracesTable.reportId),
      ),
    );

  const pipelineDurations: number[] = [];
  const perEngine = new Map<string, number[]>();

  for (const row of rows) {
    if (typeof row.totalDurationMs === "number" && row.totalDurationMs >= 0) {
      pipelineDurations.push(row.totalDurationMs);
    }
    const trace = row.trace as PipelineTrace | null;
    if (!trace || !Array.isArray(trace.stages)) continue;
    for (const stage of trace.stages) {
      if (!stage || typeof stage.durationMs !== "number") continue;
      const list = perEngine.get(stage.stage) ?? [];
      list.push(stage.durationMs);
      perEngine.set(stage.stage, list);
    }
  }

  const pipeline = summarize(pipelineDurations);

  const engineEntries = Array.from(perEngine.entries())
    .map(([engine, values]) => ({ engine, ...summarize(values) }))
    .sort((a, b) => b.percentiles.p95 - a.percentiles.p95);

  let worstEngine: {
    engine: string;
    p95: number;
    pipelineP95: number;
    ratio: number;
  } | null = null;

  if (engineEntries.length >= 2 && pipeline.percentiles.p95 > 0) {
    const p95s = engineEntries
      .map((e) => e.percentiles.p95)
      .sort((a, b) => a - b);
    const median = p95s[Math.floor(p95s.length / 2)];
    const top = engineEntries[0];
    if (
      median > 0 &&
      top.percentiles.p95 / median >= 1.5 &&
      top.percentiles.p95 / pipeline.percentiles.p95 >= 0.25
    ) {
      worstEngine = {
        engine: top.engine,
        p95: top.percentiles.p95,
        pipelineP95: pipeline.percentiles.p95,
        ratio: Number((top.percentiles.p95 / median).toFixed(2)),
      };
    }
  }

  const response = GetLatencySnapshotResponse.parse({
    windowHours: WINDOW_HOURS,
    generatedAt: new Date().toISOString(),
    sampleCount: pipelineDurations.length,
    pipeline,
    engines: engineEntries,
    worstEngine,
  });

  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
  res.json(response);
});

const DEFAULT_HISTORY_DAYS = 14;
const MAX_HISTORY_DAYS = 90;

router.get("/public/latency-history", async (req, res): Promise<void> => {
  const daysParam = Number(req.query.days) || DEFAULT_HISTORY_DAYS;
  const days = Math.max(1, Math.min(daysParam, MAX_HISTORY_DAYS));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // ORGANIC TRAFFIC ONLY — see comment in /public/latency-snapshot.
  const rows = await db
    .select({
      totalDurationMs: analysisTracesTable.totalDurationMs,
      trace: analysisTracesTable.trace,
      createdAt: analysisTracesTable.createdAt,
    })
    .from(analysisTracesTable)
    .where(
      and(
        gte(analysisTracesTable.createdAt, since),
        isNotNull(analysisTracesTable.reportId),
      ),
    );

  const buckets = new Map<
    string,
    { pipeline: number[]; engines: Map<string, number[]> }
  >();

  for (const row of rows) {
    const dateKey = row.createdAt.toISOString().slice(0, 10);
    let bucket = buckets.get(dateKey);
    if (!bucket) {
      bucket = { pipeline: [], engines: new Map() };
      buckets.set(dateKey, bucket);
    }

    if (typeof row.totalDurationMs === "number" && row.totalDurationMs >= 0) {
      bucket.pipeline.push(row.totalDurationMs);
    }

    const trace = row.trace as PipelineTrace | null;
    if (!trace || !Array.isArray(trace.stages)) continue;
    for (const stage of trace.stages) {
      if (!stage || typeof stage.durationMs !== "number") continue;
      const list = bucket.engines.get(stage.stage) ?? [];
      list.push(stage.durationMs);
      bucket.engines.set(stage.stage, list);
    }
  }

  const daily = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const sortedPipeline = [...bucket.pipeline].sort((a, b) => a - b);
      const engines = Array.from(bucket.engines.entries())
        .map(([engine, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            engine,
            percentiles: {
              p50: Number(percentile(sorted, 50).toFixed(1)),
              p95: Number(percentile(sorted, 95).toFixed(1)),
              p99: Number(percentile(sorted, 99).toFixed(1)),
              sampleCount: sorted.length,
            },
          };
        })
        .sort((a, b) => a.engine.localeCompare(b.engine));

      return {
        date,
        sampleCount: sortedPipeline.length,
        pipeline: {
          p50: Number(percentile(sortedPipeline, 50).toFixed(1)),
          p95: Number(percentile(sortedPipeline, 95).toFixed(1)),
          p99: Number(percentile(sortedPipeline, 99).toFixed(1)),
          sampleCount: sortedPipeline.length,
        },
        engines,
      };
    });

  const response = GetLatencyHistoryResponse.parse({
    days,
    generatedAt: new Date().toISOString(),
    daily,
  });

  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  res.json(response);
});

export default router;
