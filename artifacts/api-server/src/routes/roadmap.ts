// Task #693 — Public roadmap.
//
// Loads the static `data/roadmap.json` file once at module import time
// and serves it from `GET /api/roadmap`. Mirrors the load-and-validate
// pattern used by `gallery.ts` (Task #647) and `presets.ts` (Task #631):
// try cwd-relative first, then fall back to monorepo-relative so tests
// run from the repo root also resolve. Curated only — there is no
// admin/write endpoint.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { Router, type IRouter } from "express";
import { ListRoadmapResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const ROADMAP_CANDIDATES = [
  process.env.ROADMAP_PATH,
  path.resolve(process.cwd(), "data/roadmap.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/roadmap.json"),
].filter((p): p is string => !!p);

function resolveRoadmapPath(): string {
  for (const candidate of ROADMAP_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[roadmap] Could not find roadmap.json. Tried: ${ROADMAP_CANDIDATES.join(", ")}`,
  );
}

// Eager parse + validate so a malformed `roadmap.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadRoadmap() {
  const raw = JSON.parse(readFileSync(resolveRoadmapPath(), "utf8")) as Record<
    string,
    unknown
  >;
  return ListRoadmapResponse.parse({
    version: raw.version,
    updatedAt: raw.updatedAt,
    items: raw.items,
    shipped: raw.shipped,
  });
}

const ROADMAP = loadRoadmap();

router.get("/roadmap", (_req, res) => {
  // 1h cache + short stale-while-revalidate. The file is curator-edited
  // and rarely changes; the `version` field lets clients bust their
  // own caches when needed.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(ROADMAP);
});

export default router;
