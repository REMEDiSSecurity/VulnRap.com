import { Router, type IRouter } from "express";
import { sql, gte } from "drizzle-orm";
import { db, analysisTracesTable, type PipelineTrace } from "@workspace/db";
import { GetLatencySnapshotResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const WINDOW_HOURS = 24;

const BIN_EDGES_MS = [
  50, 100, 200, 400, 800, 1500, 3000, 5000, 10000, 20000,
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

  const rows = await db
    .select({
      totalDurationMs: analysisTracesTable.totalDurationMs,
      trace: analysisTracesTable.trace,
    })
    .from(analysisTracesTable)
    .where(gte(analysisTracesTable.createdAt, since));

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
    const p95s = engineEntries.map((e) => e.percentiles.p95).sort((a, b) => a - b);
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

export default router;
