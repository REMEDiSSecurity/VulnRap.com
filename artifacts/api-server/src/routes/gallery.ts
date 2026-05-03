// Task #647 — Curated sample-report gallery.
//
// Loads the static `data/gallery.json` file once at module import time
// and serves it from `GET /api/gallery`. Mirrors the load-and-validate
// pattern used by `presets.ts` (Task #631): try cwd-relative first,
// then fall back to monorepo-relative so tests run from the repo root
// also resolve. Curated only for v1 — there is no admin/write endpoint.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { Router, type IRouter } from "express";
import { ListGalleryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const GALLERY_CANDIDATES = [
  process.env.GALLERY_PATH,
  path.resolve(process.cwd(), "data/gallery.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/gallery.json"),
].filter((p): p is string => !!p);

function resolveGalleryPath(): string {
  for (const candidate of GALLERY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[gallery] Could not find gallery.json. Tried: ${GALLERY_CANDIDATES.join(", ")}`,
  );
}

// Eager parse + validate so a malformed `gallery.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadGallery() {
  const raw = JSON.parse(readFileSync(resolveGalleryPath(), "utf8")) as Record<
    string,
    unknown
  >;
  return ListGalleryResponse.parse({
    version: raw.version,
    samples: raw.samples,
  });
}

const GALLERY_LIBRARY = loadGallery();

router.get("/gallery", (_req, res) => {
  // 1h cache + short stale-while-revalidate. The file is curator-edited
  // and rarely changes; the `version` field lets clients bust their
  // own caches when needed.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(GALLERY_LIBRARY);
});

export default router;
