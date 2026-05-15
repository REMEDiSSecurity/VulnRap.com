// Task #1327 — REMEDiS L1 pre-filter corpus smoke.
//
// Standalone script that runs *only* the L1 pre-filter stage across
// the REMEDiS corpus (170 reports) and reports:
//
//   - How many reports each rule family fires on
//   - Which reports in the "expected quarantines" set fired (target ≥10/13)
//   - Whether the "must not quarantine" real-report set stayed clean
//     (target: zero FPs on rr-130, rr-133, rr-051, rr-125, rr-126,
//     rr-127, rr-128)
//
// This is intentionally lighter than `remedis-harness.ts` — it doesn't
// run engines/LLMs, so it executes in well under a second across 170
// reports and is cheap enough to call from CI on every PR. The full
// harness still owns the calibration / latency / Brier metrics.
//
// Usage:
//   node --enable-source-maps artifacts/api-server/dist/remedis-prefilter-smoke.mjs \
//     [--reports-dir eval/remedis-corpus/AllReports/reports]

import { promises as fs } from "node:fs";
import path from "node:path";
import { runPreFilters } from "./lib/pre-filters";

const EXPECTED_QUARANTINE_IDS = [
  "rr-016", // prompt-injection bait
  "rr-025", // extortion-not-vuln
  "rr-058", // double-extortion data leak
  "rr-100", // RAG indirect injection (canary fires on the embedded prompt)
  "rr-149", // CVE impossible format
  "rr-150", // CVE future year
  "rr-152", // CVE letter in id
  "rr-154", // fake threat-intel firm (partnership fee)
  "rr-157", // fake CERT/CC
  "rr-158", // fake_h1_or_similar BEC
  "rr-159", // BEC variant
  "rr-160", // fake H1 triager re-verify credentials
  "rr-163", // extortion variant
];

const MUST_NOT_QUARANTINE_IDS = [
  "rr-051", // German real
  "rr-125", // French real
  "rr-126", // Japanese real
  "rr-127", // Spanish real
  "rr-128", // Portuguese real
  "rr-130", // anonymized real
  "rr-133", // typo'd but real
];

interface CorpusReport {
  id: string;
  rawReport: string;
  groundTruth: { authenticity: string };
}

async function loadCorpus(dir: string): Promise<CorpusReport[]> {
  const entries = await fs.readdir(dir);
  const files = entries
    .filter((f) => f.startsWith("rr-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error(
      `[prefilter-smoke] no rr-*.json reports found under ${dir}. ` +
        `Re-extract attached_assets/AllReports_*.zip into eval/remedis-corpus/`,
    );
  }
  const out: CorpusReport[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf-8");
    const j = JSON.parse(raw);
    out.push({
      id: j.id,
      rawReport: j.raw_report,
      groundTruth: j.ground_truth,
    });
  }
  return out;
}

interface SmokeResult {
  generatedAt: string;
  nReports: number;
  quarantined: number;
  byRule: Record<string, number>;
  byFlag: Record<string, number>;
  expectedQuarantineHits: Array<{ id: string; flags: string[] }>;
  expectedQuarantineMisses: string[];
  falsePositives: Array<{ id: string; flags: string[] }>;
  perReport: Array<{
    id: string;
    authenticity: string;
    quarantined: boolean;
    flags: string[];
    escalateTo: string | null;
  }>;
}

async function main(): Promise<void> {
  const reportsDir =
    process.argv.includes("--reports-dir")
      ? process.argv[process.argv.indexOf("--reports-dir") + 1]
      : path.resolve(
          process.cwd(),
          "eval/remedis-corpus/AllReports/reports",
        );
  const corpus = await loadCorpus(reportsDir);

  const byRule: Record<string, number> = {};
  const byFlag: Record<string, number> = {};
  const perReport: SmokeResult["perReport"] = [];
  const expectedHits: SmokeResult["expectedQuarantineHits"] = [];
  const fps: SmokeResult["falsePositives"] = [];
  let quarantined = 0;

  for (const r of corpus) {
    const result = runPreFilters({ rawText: r.rawReport });
    if (result.shouldQuarantine) quarantined++;
    for (const fire of result.fires) {
      byRule[fire.rule] = (byRule[fire.rule] ?? 0) + 1;
      byFlag[fire.flag] = (byFlag[fire.flag] ?? 0) + 1;
    }
    perReport.push({
      id: r.id,
      authenticity: r.groundTruth.authenticity,
      quarantined: result.shouldQuarantine,
      flags: result.flags,
      escalateTo: result.escalateTo,
    });
    const shortId = r.id.split("-").slice(0, 2).join("-");
    if (
      result.shouldQuarantine &&
      EXPECTED_QUARANTINE_IDS.includes(shortId)
    ) {
      expectedHits.push({ id: r.id, flags: result.flags });
    }
    if (
      result.shouldQuarantine &&
      MUST_NOT_QUARANTINE_IDS.includes(shortId)
    ) {
      fps.push({ id: r.id, flags: result.flags });
    }
  }

  const expectedHitIds = new Set(
    expectedHits.map((h) => h.id.split("-").slice(0, 2).join("-")),
  );
  const missed = EXPECTED_QUARANTINE_IDS.filter(
    (id) => !expectedHitIds.has(id),
  );

  const out: SmokeResult = {
    generatedAt: new Date().toISOString(),
    nReports: corpus.length,
    quarantined,
    byRule,
    byFlag,
    expectedQuarantineHits: expectedHits,
    expectedQuarantineMisses: missed,
    falsePositives: fps,
    perReport,
  };

  console.log("\n=== REMEDiS L1 pre-filter smoke ===");
  console.log(`reports=${out.nReports} quarantined=${out.quarantined}`);
  console.log("\nBy rule family:");
  for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(28)} ${n}`);
  }
  console.log("\nBy flag:");
  for (const [flag, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${flag.padEnd(34)} ${n}`);
  }
  console.log(
    `\nExpected-quarantine fires: ${expectedHits.length} / ${EXPECTED_QUARANTINE_IDS.length} (target ≥10)`,
  );
  for (const h of expectedHits) console.log(`  HIT  ${h.id}  [${h.flags.join(", ")}]`);
  if (missed.length) {
    console.log("Missed expected quarantines:");
    for (const m of missed) console.log(`  MISS ${m}`);
  }
  console.log(
    `\nFalse positives in must-not-quarantine set: ${fps.length} (target 0)`,
  );
  for (const fp of fps) console.log(`  FP   ${fp.id}  [${fp.flags.join(", ")}]`);

  const outPath = path.resolve(
    process.cwd(),
    "eval/remedis-results/prefilter-smoke.json",
  );
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n[prefilter-smoke] wrote ${path.relative(process.cwd(), outPath)}`);

  const okHits = expectedHits.length >= 10;
  const okFps = fps.length === 0;
  if (!okHits || !okFps) {
    console.error(
      `[prefilter-smoke] FAIL — hits=${expectedHits.length}/${EXPECTED_QUARANTINE_IDS.length}, fps=${fps.length}`,
    );
    process.exit(1);
  }
  console.log("[prefilter-smoke] PASS");
}

main().catch((err) => {
  console.error("[prefilter-smoke] fatal:", err);
  process.exit(2);
});
