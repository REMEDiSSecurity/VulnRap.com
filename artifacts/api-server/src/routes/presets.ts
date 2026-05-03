// Task #631 — Curated public preset library.
//
// Loads the static `data/presets.json` file once at module import time
// and serves it from `GET /api/presets`. The presets describe sensitivity
// + per-engine weighting profiles that the `/presets` UI page renders and
// `/check?preset=<id>` consumes to bootstrap local settings. Curated
// only for v1: there is no admin/write endpoint.
import { Router, type IRouter } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { ListPresetsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Mirrors the lookup pattern used by data/handwavy-phrases.json and
// data/ai-self-disclosure-phrases.json: try the cwd-relative path first
// (matches `pnpm --filter @workspace/api-server` invocations) and fall
// back to the monorepo-relative path so tests run from the repo root
// also resolve. Bundled output (esbuild) loses the helpful __dirname
// anchor, hence the explicit cwd probes.
const PRESETS_CANDIDATES = [
  process.env.PRESETS_PATH,
  path.resolve(process.cwd(), "data/presets.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/presets.json"),
].filter((p): p is string => !!p);

function resolvePresetsPath(): string {
  for (const candidate of PRESETS_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[presets] Could not find presets.json. Tried: ${PRESETS_CANDIDATES.join(", ")}`,
  );
}

// Parse and validate eagerly so a malformed `presets.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller. The thrown ZodError is loud enough to surface in CI.
function loadPresets() {
  const raw = JSON.parse(readFileSync(resolvePresetsPath(), "utf8")) as Record<string, unknown>;
  return ListPresetsResponse.parse({
    version: raw.version,
    presets: raw.presets,
  });
}

const PRESET_LIBRARY = loadPresets();

router.get("/presets", (_req, res) => {
  // 1h cache + short stale-while-revalidate. The file is curator-edited
  // and rarely changes; the `version` field in the payload lets clients
  // bust their own caches when needed.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(PRESET_LIBRARY);
});

export default router;
