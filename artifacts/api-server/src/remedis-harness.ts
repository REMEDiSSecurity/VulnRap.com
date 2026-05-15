// REMEDiS eval harness (Task #1326).
//
// Runs the current vulnrap scoring pipeline (`analyzeWithEnginesTraced`)
// against the 170-report REMEDiS corpus and prints/saves the metric set
// from the REMEDiS handoff (HANDOFF.md §"What CI should look like"):
//
//   - L1 stability across N passes (signal extraction determinism)
//   - Final verdict stability across N passes
//   - Macro F1 (binary: predicted-real vs ground-truth-real)
//   - Expected Calibration Error (ECE)
//   - Brier score
//   - FP rate (slop -> predicted real)
//   - FN rate (real -> predicted not real)
//   - L1 p95 latency (extract_signals stage)
//   - L2 p95 latency (engines stage)
//   - End-to-end cost per report (we have no LLM in path -> $0)
//
// The harness writes a single JSON results file and a human-readable
// table to stdout. It exits non-zero when any THRESHOLDS row fails.
// This is intentionally a *measuring stick*: it is expected to fail
// some thresholds today; that is what motivates Task #1327 (L1
// deterministic pre-filters). The baseline run is committed at
// `eval/remedis-baseline.json` so future runs can diff against it.
//
// Usage (from the repo root, after `pnpm --filter @workspace/api-server run build`):
//
//   node --enable-source-maps artifacts/api-server/dist/remedis-harness.mjs \
//     [--passes 5] [--reports-dir eval/remedis-corpus/AllReports/reports] \
//     [--out eval/remedis-results/<ts>.json] [--baseline] [--no-exit-on-fail]
//
// Or via `bash scripts/remedis-harness.sh`.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { analyzeWithEnginesTraced } from "./lib/engines";

// ---------------------------------------------------------------------------
// Thresholds (REMEDiS handoff §"What CI should look like").
// Tune from a single block here.
// ---------------------------------------------------------------------------
const THRESHOLDS = {
  l1StabilityMin: 1.0, // == 100%
  finalVerdictStabilityMin: 0.95,
  macroF1Min: 0.8,
  eceMax: 0.05,
  brierMax: 0.08,
  fpRateMax: 0.02, // predicted real but ground truth != real
  fnRateMax: 0.05, // ground truth real but predicted != real
  l1LatencyP95MsMax: 10,
  l2LatencyP95MsMax: 3000,
  costPerReportMaxUsd: 0.05,
} as const;

// Whether a vulnrap composite label means "the pipeline thinks this is a
// real, actionable report". Vulnrap doesn't predict authenticity natively
// (it scores substance + AI-authorship), so we collapse to a binary against
// REMEDiS's authenticity ground truth. The split mirrors today's product
// behaviour: STRONG/PROMISING/REASONABLE are the labels the UI surfaces as
// "worth a human's time", everything else is "likely not real".
const REAL_LABELS = new Set<string>(["STRONG", "PROMISING", "REASONABLE"]);
function predictsReal(label: string): boolean {
  return REAL_LABELS.has(label);
}

interface CorpusReport {
  id: string;
  rawReport: string;
  groundTruth: {
    authenticity: string;
    quality_tier?: string;
    vuln_class?: string | null;
    is_duplicate_of?: string | null;
    expected_realness_score?: [number, number];
    expected_severity_band?: string;
  };
}

interface PerReport {
  reportId: string;
  groundTruthAuthenticity: string;
  groundTruthIsReal: number; // 1 or 0
  predictedLabel: string; // first-pass composite.label
  predictedRealnessScore: number; // first-pass composite.overallScore / 100
  predictedIsReal: number;
  l1StabilityHash: string; // first-pass signal-summary hash
  l1StabilityCount: number; // distinct signal-summary hashes across passes (1 = stable)
  finalStabilityCount: number; // distinct label/score combos across passes (1 = stable)
  l1LatencyMs: number; // median across passes — extract_signals stage
  l2LatencyMs: number; // median across passes — everything after extract_signals
  totalLatencyMs: number; // median across passes — full analyze() wall time
}

interface HarnessSummary {
  generatedAt: string;
  scoringEngineVersion: string | null;
  nReports: number;
  nPasses: number;
  stability: {
    l1Stability: number;
    finalVerdictStability: number;
  };
  accuracy: {
    binaryAccuracy: number;
    macroF1Binary: number;
    perClassRecall: Record<string, { recall: number; support: number }>;
    fpRateRealClass: number;
    fnRateRealClass: number;
  };
  calibration: { brierScore: number; ece: number };
  latency: {
    l1P50Ms: number;
    l1P95Ms: number;
    l2P50Ms: number;
    l2P95Ms: number;
    totalP50Ms: number;
    totalP95Ms: number;
  };
  costPerReportUsd: number;
  thresholds: Record<string, { value: number; max?: number; min?: number; pass: boolean }>;
  ciPass: boolean;
}

interface HarnessOutput {
  summary: HarnessSummary;
  perReport: PerReport[];
}

// ---------------------------------------------------------------------------
// Corpus loader
// ---------------------------------------------------------------------------
async function loadCorpus(dir: string): Promise<CorpusReport[]> {
  const entries = await fs.readdir(dir);
  const files = entries.filter((f) => f.startsWith("rr-") && f.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new Error(
      `[remedis-harness] no rr-*.json reports found under ${dir}. ` +
        `Re-extract attached_assets/AllReports_*.zip into eval/remedis-corpus/`,
    );
  }
  const out: CorpusReport[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf-8");
    const j = JSON.parse(raw);
    if (typeof j.id !== "string" || typeof j.raw_report !== "string" || !j.ground_truth) {
      throw new Error(`[remedis-harness] ${f}: malformed (missing id/raw_report/ground_truth)`);
    }
    out.push({ id: j.id, rawReport: j.raw_report, groundTruth: j.ground_truth });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx];
}

function brier(scores: number[], truths: number[]): number {
  if (scores.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < scores.length; i++) {
    const d = scores[i] - truths[i];
    s += d * d;
  }
  return s / scores.length;
}

function ece(scores: number[], truths: number[], nBins = 10): number {
  if (scores.length === 0) return 0;
  const bins: Array<{ confSum: number; truthSum: number; n: number }> = Array.from(
    { length: nBins },
    () => ({ confSum: 0, truthSum: 0, n: 0 }),
  );
  for (let i = 0; i < scores.length; i++) {
    const b = Math.min(nBins - 1, Math.floor(scores[i] * nBins));
    bins[b].confSum += scores[i];
    bins[b].truthSum += truths[i];
    bins[b].n += 1;
  }
  let total = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    const conf = b.confSum / b.n;
    const acc = b.truthSum / b.n;
    total += (b.n / scores.length) * Math.abs(conf - acc);
  }
  return total;
}

function f1BinaryReal(preds: number[], truths: number[]): { f1Real: number; f1NotReal: number; macro: number } {
  const tp = preds.reduce((a, p, i) => a + (p === 1 && truths[i] === 1 ? 1 : 0), 0);
  const fp = preds.reduce((a, p, i) => a + (p === 1 && truths[i] === 0 ? 1 : 0), 0);
  const fn = preds.reduce((a, p, i) => a + (p === 0 && truths[i] === 1 ? 1 : 0), 0);
  const tn = preds.reduce((a, p, i) => a + (p === 0 && truths[i] === 0 ? 1 : 0), 0);
  const f = (tpv: number, fpv: number, fnv: number) => {
    const p = tpv + fpv > 0 ? tpv / (tpv + fpv) : 0;
    const r = tpv + fnv > 0 ? tpv / (tpv + fnv) : 0;
    return p + r > 0 ? (2 * p * r) / (p + r) : 0;
  };
  const f1Real = f(tp, fp, fn);
  const f1NotReal = f(tn, fn, fp);
  return { f1Real, f1NotReal, macro: (f1Real + f1NotReal) / 2 };
}

function round(n: number, places = 4): number {
  const k = 10 ** places;
  return Math.round(n * k) / k;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliOpts {
  passes: number;
  reportsDir: string;
  outPath: string | null;
  baseline: boolean;
  exitOnFail: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    passes: 5,
    reportsDir: path.resolve(process.cwd(), "eval/remedis-corpus/AllReports/reports"),
    outPath: null,
    baseline: false,
    exitOnFail: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--passes") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) {
        throw new Error(`[remedis-harness] --passes must be a positive integer, got: ${argv[i]}`);
      }
      opts.passes = v;
    }
    else if (a === "--reports-dir") opts.reportsDir = path.resolve(process.cwd(), argv[++i]);
    else if (a === "--out") opts.outPath = path.resolve(process.cwd(), argv[++i]);
    else if (a === "--baseline") opts.baseline = true;
    else if (a === "--no-exit-on-fail") opts.exitOnFail = false;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: remedis-harness [--passes N] [--reports-dir DIR] [--out FILE] [--baseline] [--no-exit-on-fail]",
      );
      process.exit(0);
    } else {
      throw new Error(`[remedis-harness] unknown arg: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  const corpus = await loadCorpus(opts.reportsDir);
  console.log(
    `[remedis-harness] reports=${corpus.length} passes=${opts.passes} dir=${opts.reportsDir}`,
  );

  const perReport: PerReport[] = [];
  const predScoresReal: number[] = [];
  const truthsReal: number[] = [];
  const predIsReal: number[] = [];
  const l1Latencies: number[] = [];
  const l2Latencies: number[] = [];
  const totalLatencies: number[] = [];
  let scoringEngineVersion: string | null = null;
  const perClassCorrectReal: Record<string, { correctRealMatch: number; total: number }> = {};

  for (const r of corpus) {
    const passes: Array<{
      label: string;
      score: number;
      sigHash: string;
      stagesMs: Record<string, number>;
      totalMs: number;
    }> = [];
    for (let p = 0; p < opts.passes; p++) {
      const t0 = Date.now();
      const traced = analyzeWithEnginesTraced(r.rawReport, {});
      const t1 = Date.now();
      scoringEngineVersion = traced.trace.scoringEngineVersion ?? scoringEngineVersion;
      const stagesMs: Record<string, number> = {};
      for (const s of traced.trace.stages) stagesMs[s.stage] = s.durationMs;
      const sigSummary = JSON.stringify(traced.trace.signalsSummary);
      const sigHash = crypto.createHash("sha256").update(sigSummary).digest("hex").slice(0, 16);
      passes.push({
        label: traced.composite.label,
        score: traced.composite.overallScore,
        sigHash,
        stagesMs,
        totalMs: t1 - t0,
      });
    }
    const first = passes[0];
    // Use median latency across passes (not just pass 1) to reduce
    // cold-start noise and better reflect repeated-run behaviour.
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const l1Ms = median(passes.map((p) => p.stagesMs.extract_signals ?? 0));
    const l2Ms = median(passes.map((p) => p.totalMs - (p.stagesMs.extract_signals ?? 0)));
    const totalMs = median(passes.map((p) => p.totalMs));

    const sigHashes = new Set(passes.map((p) => p.sigHash));
    const verdictKeys = new Set(passes.map((p) => `${p.label}|${p.score}`));

    const truthIsReal = r.groundTruth.authenticity === "real" ? 1 : 0;
    const predictedReal = predictsReal(first.label) ? 1 : 0;
    const predictedRealness = first.score / 100;

    predScoresReal.push(predictedRealness);
    truthsReal.push(truthIsReal);
    predIsReal.push(predictedReal);
    l1Latencies.push(l1Ms);
    l2Latencies.push(l2Ms);
    totalLatencies.push(totalMs);

    const cls = r.groundTruth.authenticity;
    if (!perClassCorrectReal[cls]) perClassCorrectReal[cls] = { correctRealMatch: 0, total: 0 };
    perClassCorrectReal[cls].total += 1;
    if (predictedReal === truthIsReal) perClassCorrectReal[cls].correctRealMatch += 1;

    perReport.push({
      reportId: r.id,
      groundTruthAuthenticity: cls,
      groundTruthIsReal: truthIsReal,
      predictedLabel: first.label,
      predictedRealnessScore: round(predictedRealness, 4),
      predictedIsReal: predictedReal,
      l1StabilityHash: first.sigHash,
      l1StabilityCount: sigHashes.size,
      finalStabilityCount: verdictKeys.size,
      l1LatencyMs: l1Ms,
      l2LatencyMs: l2Ms,
      totalLatencyMs: totalMs,
    });
  }

  // Stability: fraction of reports whose signal-hash / verdict-key was constant across all passes.
  const l1Stable = perReport.filter((r) => r.l1StabilityCount === 1).length / perReport.length;
  const finalStable = perReport.filter((r) => r.finalStabilityCount === 1).length / perReport.length;

  // Accuracy
  const binaryAcc = predIsReal.reduce((a, p, i) => a + (p === truthsReal[i] ? 1 : 0), 0) / predIsReal.length;
  const { macro: macroF1Binary } = f1BinaryReal(predIsReal, truthsReal);
  const realTotal = truthsReal.reduce((a, t) => a + t, 0);
  const notRealTotal = truthsReal.length - realTotal;
  const fpReal = predIsReal.reduce((a, p, i) => a + (p === 1 && truthsReal[i] === 0 ? 1 : 0), 0);
  const fnReal = predIsReal.reduce((a, p, i) => a + (p === 0 && truthsReal[i] === 1 ? 1 : 0), 0);
  const fpRate = notRealTotal > 0 ? fpReal / notRealTotal : 0;
  const fnRate = realTotal > 0 ? fnReal / realTotal : 0;

  const perClassRecall: Record<string, { recall: number; support: number }> = {};
  for (const [cls, v] of Object.entries(perClassCorrectReal)) {
    perClassRecall[cls] = { recall: round(v.correctRealMatch / v.total, 4), support: v.total };
  }

  const brierScore = brier(predScoresReal, truthsReal);
  const eceScore = ece(predScoresReal, truthsReal, 10);

  // No LLM calls in current pipeline; cost is effectively zero. Recorded as 0
  // so that future LLM-augmented passes can populate it.
  const costPerReportUsd = 0;

  const thresholdRows: HarnessSummary["thresholds"] = {
    l1_stability: { value: round(l1Stable), min: THRESHOLDS.l1StabilityMin, pass: l1Stable >= THRESHOLDS.l1StabilityMin },
    final_verdict_stability: {
      value: round(finalStable),
      min: THRESHOLDS.finalVerdictStabilityMin,
      pass: finalStable >= THRESHOLDS.finalVerdictStabilityMin,
    },
    macro_f1_binary_real: { value: round(macroF1Binary), min: THRESHOLDS.macroF1Min, pass: macroF1Binary >= THRESHOLDS.macroF1Min },
    ece: { value: round(eceScore), max: THRESHOLDS.eceMax, pass: eceScore <= THRESHOLDS.eceMax },
    brier: { value: round(brierScore), max: THRESHOLDS.brierMax, pass: brierScore <= THRESHOLDS.brierMax },
    fp_rate_real_class: { value: round(fpRate), max: THRESHOLDS.fpRateMax, pass: fpRate <= THRESHOLDS.fpRateMax },
    fn_rate_real_class: { value: round(fnRate), max: THRESHOLDS.fnRateMax, pass: fnRate <= THRESHOLDS.fnRateMax },
    l1_latency_p95_ms: {
      value: percentile(l1Latencies, 95),
      max: THRESHOLDS.l1LatencyP95MsMax,
      pass: percentile(l1Latencies, 95) <= THRESHOLDS.l1LatencyP95MsMax,
    },
    l2_latency_p95_ms: {
      value: percentile(l2Latencies, 95),
      max: THRESHOLDS.l2LatencyP95MsMax,
      pass: percentile(l2Latencies, 95) <= THRESHOLDS.l2LatencyP95MsMax,
    },
    cost_per_report_usd: {
      value: costPerReportUsd,
      max: THRESHOLDS.costPerReportMaxUsd,
      pass: costPerReportUsd <= THRESHOLDS.costPerReportMaxUsd,
    },
  };

  const ciPass = Object.values(thresholdRows).every((r) => r.pass);

  const summary: HarnessSummary = {
    generatedAt: new Date().toISOString(),
    scoringEngineVersion,
    nReports: corpus.length,
    nPasses: opts.passes,
    stability: { l1Stability: round(l1Stable), finalVerdictStability: round(finalStable) },
    accuracy: {
      binaryAccuracy: round(binaryAcc),
      macroF1Binary: round(macroF1Binary),
      perClassRecall,
      fpRateRealClass: round(fpRate),
      fnRateRealClass: round(fnRate),
    },
    calibration: { brierScore: round(brierScore), ece: round(eceScore) },
    latency: {
      l1P50Ms: percentile(l1Latencies, 50),
      l1P95Ms: percentile(l1Latencies, 95),
      l2P50Ms: percentile(l2Latencies, 50),
      l2P95Ms: percentile(l2Latencies, 95),
      totalP50Ms: percentile(totalLatencies, 50),
      totalP95Ms: percentile(totalLatencies, 95),
    },
    costPerReportUsd,
    thresholds: thresholdRows,
    ciPass,
  };

  // Print table
  console.log("\n=== REMEDiS Harness Results ===");
  console.log(`reports=${summary.nReports} passes=${summary.nPasses} engine=${summary.scoringEngineVersion ?? "?"}`);
  const padR = (s: string, n: number) => s.padStart(n);
  const padL = (s: string, n: number) => s.padEnd(n);
  console.log(
    "\n" +
      padL("metric", 28) +
      padR("value", 10) +
      padR("limit", 10) +
      "  status",
  );
  console.log("-".repeat(56));
  for (const [k, v] of Object.entries(thresholdRows)) {
    const limit = v.min !== undefined ? `>=${v.min}` : v.max !== undefined ? `<=${v.max}` : "";
    const status = v.pass ? "PASS" : "FAIL";
    console.log(padL(k, 28) + padR(String(v.value), 10) + padR(limit, 10) + "  " + status);
  }
  console.log("\nPer-class recall (predicted-real ↔ ground-truth):");
  for (const [k, v] of Object.entries(perClassRecall)) {
    console.log(`  ${padL(k, 20)} recall=${v.recall.toFixed(3)} n=${v.support}`);
  }
  console.log("\nLatency (ms): " + JSON.stringify(summary.latency));
  console.log(`\nCI: ${ciPass ? "PASS" : "FAIL"}\n`);

  // Write output
  const tsTag = summary.generatedAt.replace(/[:.]/g, "-");
  const defaultOut = opts.baseline
    ? path.resolve(process.cwd(), "eval/remedis-baseline.json")
    : path.resolve(process.cwd(), `eval/remedis-results/${tsTag}.json`);
  const outPath = opts.outPath ?? defaultOut;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const output: HarnessOutput = { summary, perReport };
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`[remedis-harness] wrote ${path.relative(process.cwd(), outPath)}`);

  if (!ciPass && opts.exitOnFail) {
    console.error("[remedis-harness] thresholds failed; see table above. Exit 1.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[remedis-harness] fatal:", err);
  process.exit(2);
});
