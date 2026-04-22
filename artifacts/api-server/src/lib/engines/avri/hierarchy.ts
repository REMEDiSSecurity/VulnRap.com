// CWE hierarchy lookup. Reads the curated parent-chain JSON shipped with the
// API server and exposes a small helper to walk ancestors so we can map
// uncommon CWEs back to a known rubric family.

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

interface HierarchyFile {
  _meta?: unknown;
  [cweNumber: string]: string[] | unknown;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_PATHS = [
  // dist-relative (after tsc): dist/lib/engines/avri/ -> dist/../../../data
  path.resolve(__dirname, "../../../../data/cwe-hierarchy.json"),
  // src-relative (vitest / tsx): src/lib/engines/avri/ -> src/../../../data
  path.resolve(__dirname, "../../../../data/cwe-hierarchy.json"),
  // pkg-root fallback
  path.resolve(process.cwd(), "data/cwe-hierarchy.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/cwe-hierarchy.json"),
];

let CACHED: Map<string, string[]> | null = null;

function loadHierarchy(): Map<string, string[]> {
  if (CACHED) return CACHED;
  const out = new Map<string, string[]>();
  for (const p of CANDIDATE_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as HierarchyFile;
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_")) continue;
        // Strip "_2" disambiguation suffixes from the curated file.
        const key = k.replace(/_\d+$/, "");
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
          out.set(key, v as string[]);
        }
      }
      break;
    } catch {
      // try next candidate
    }
  }
  CACHED = out;
  return out;
}

/**
 * Normalize a CWE label like "CWE-79", "cwe79", "79" to the bare numeric id.
 * Returns null when the input does not contain a CWE number.
 */
export function normalizeCweId(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = String(input).match(/(?:cwe[-_]?)?(\d{1,4})/i);
  return m ? m[1] : null;
}

/**
 * Walk the parent chain for a CWE up to `maxDepth` levels and return all
 * ancestors (including the input). Used by the classifier to decide whether
 * an unrecognized CWE belongs to a known family via its parent.
 */
export function ancestorsOf(cweNumber: string, maxDepth = 6): string[] {
  const hierarchy = loadHierarchy();
  const visited = new Set<string>();
  const queue: Array<{ cwe: string; depth: number }> = [{ cwe: cweNumber, depth: 0 }];
  while (queue.length > 0) {
    const { cwe, depth } = queue.shift()!;
    if (visited.has(cwe)) continue;
    visited.add(cwe);
    if (depth >= maxDepth) continue;
    const parents = hierarchy.get(cwe) ?? [];
    for (const p of parents) {
      if (!visited.has(p)) queue.push({ cwe: p, depth: depth + 1 });
    }
  }
  return Array.from(visited);
}

/** For diagnostics: report whether the hierarchy file was actually loaded. */
export function hierarchySize(): number {
  return loadHierarchy().size;
}
