// Sprint 9 v3: Dataset auto-discovery for Gate 2/3 validation.
// Looks for curated datasets in well-known locations and exposes loaders that
// streaming-parse them. When the files are absent (the default in CI / dev),
// `available()` returns false and validation tests skip themselves.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";

export interface DatasetPaths {
  curatedV2: string | null;        // vuln_reports_dataset_v2.json.gz (1,554 reports)
  hackerOneParquet: string | null; // train-00000-of-00001.parquet (10K H1)
  nvdJsonl: string | null;         // nvd_cve_10000_records.jsonl
  cisaKevJsonl: string | null;     // cisa_kev_1568_records.jsonl
}

const DATA_ROOTS = [
  process.env.VULNRAP_DATASETS_DIR,
  "/mnt/vulnrap/data",
  path.resolve(process.cwd(), "datasets"),
  path.resolve(process.cwd(), "../../datasets"),
].filter((p): p is string => Boolean(p));

const DATASET_FILES: Record<keyof DatasetPaths, string[]> = {
  curatedV2: ["vuln_reports_dataset_v2.json.gz", "vuln_reports_dataset_v2.json"],
  hackerOneParquet: ["train-00000-of-00001.parquet"],
  nvdJsonl: ["nvd_cve_10000_records.jsonl", "nvd_cve_10000_records.jsonl.gz"],
  cisaKevJsonl: ["cisa_kev_1568_records.jsonl", "cisa_kev_1568_records.jsonl.gz"],
};

export function discover(): DatasetPaths {
  const out: DatasetPaths = { curatedV2: null, hackerOneParquet: null, nvdJsonl: null, cisaKevJsonl: null };
  for (const root of DATA_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const key of Object.keys(DATASET_FILES) as (keyof DatasetPaths)[]) {
      if (out[key]) continue;
      for (const fname of DATASET_FILES[key]) {
        const p = path.join(root, fname);
        if (fs.existsSync(p)) { out[key] = p; break; }
      }
    }
  }
  return out;
}

export function available(key: keyof DatasetPaths): boolean {
  return discover()[key] !== null;
}

export interface CuratedReport {
  id: string;
  text: string;
  label?: string;     // "ai_slop" | "human_authentic" | "borderline"
  cwes?: string[];
  source?: string;
}

export async function* iterateCuratedV2(): AsyncGenerator<CuratedReport> {
  const p = discover().curatedV2;
  if (!p) return;
  const raw = p.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(p)).toString("utf8")
    : fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw);
  const arr: unknown[] = Array.isArray(parsed) ? parsed : (parsed.reports ?? parsed.data ?? []);
  for (const r of arr) {
    const obj = r as Record<string, unknown>;
    const text = (obj.text ?? obj.report_text ?? obj.body ?? obj.content ?? "") as string;
    if (!text || text.length < 50) continue;
    yield {
      id: String(obj.id ?? obj.report_id ?? ""),
      text,
      label: obj.label as string | undefined,
      cwes: (obj.cwes ?? obj.cwe_ids) as string[] | undefined,
      source: obj.source as string | undefined,
    };
  }
}

export async function* iterateJsonl(p: string): AsyncGenerator<Record<string, unknown>> {
  const stream = p.endsWith(".gz")
    ? fs.createReadStream(p).pipe(zlib.createGunzip())
    : fs.createReadStream(p);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { yield JSON.parse(trimmed); } catch { /* skip malformed */ }
  }
}

// Known curl-slop H1 IDs from the published audit.
export const KNOWN_CURL_SLOP_H1_IDS: string[] = [
  "2199174", "2298307", "2819666", "2823554", "2871792", "2887487", "2905552",
  "2912277", "2981245", "3100073", "3101127", "3116935", "3117697", "3125820",
  "3125832", "3137657", "3158093", "3230082", "3231321", "3242005", "3249936",
  "3250490", "3272982", "3293884", "3295650",
];

// Known legitimate fixtures.
export const KNOWN_LEGIT_REFERENCES = [
  { id: "CVE-2025-0725", note: "gzip overflow via libcurl" },
  { id: "H1-3225565", note: "firefox-db2pem" },
];
