// Task #694 — Curated /showcase endpoint.
//
// Loads the static `data/showcase.json` file once at module import
// time and serves it from `GET /api/showcase`. Mirrors the
// load-and-validate pattern used by `gallery.ts` (Task #647) and
// `presets.ts` (Task #631): try cwd-relative first, then fall back
// to monorepo-relative so tests run from the repo root also resolve.
// Curated only for v1 — there is no admin/write endpoint.
import { Router, type IRouter } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { ListShowcaseResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const SHOWCASE_CANDIDATES = [
  process.env.SHOWCASE_PATH,
  path.resolve(process.cwd(), "data/showcase.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/showcase.json"),
].filter((p): p is string => !!p);

function resolveShowcasePath(): string {
  for (const candidate of SHOWCASE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[showcase] Could not find showcase.json. Tried: ${SHOWCASE_CANDIDATES.join(", ")}`,
  );
}

// Eager parse + validate so a malformed `showcase.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadShowcase() {
  const raw = JSON.parse(readFileSync(resolveShowcasePath(), "utf8")) as Record<string, unknown>;
  return ListShowcaseResponse.parse({
    version: raw.version,
    entries: raw.entries,
  });
}

const SHOWCASE_LIBRARY = loadShowcase();

router.get("/showcase", (_req, res) => {
  // 1h cache + short stale-while-revalidate. The file is curator-edited
  // and rarely changes; the `version` field lets clients bust their
  // own caches when needed.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(SHOWCASE_LIBRARY);
});

export default router;
