#!/bin/bash
set -e
pnpm install --frozen-lockfile
# `pnpm install` above runs the root `postinstall`, which regenerates
# `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/`
# from `lib/api-spec/openapi.yaml` and rebuilds the lib project-reference
# dist outputs (`tsc --build`). Verify nothing got committed stale and
# that the dist outputs still typecheck against the freshly-regenerated
# sources, so the next step (api-server build) can't compile against an
# out-of-sync client without anyone noticing.
echo "[post-merge] Verifying generated OpenAPI client + lib dist outputs are in sync with the spec..."
pnpm run verify:codegen

pnpm --filter db push

echo "[post-merge] Building api-server for legacy vulnrap backfill..."
pnpm --filter @workspace/api-server run build

echo "[post-merge] Running legacy vulnrap backfill (limit=500, batch-size=50)..."
if ! pnpm --filter @workspace/api-server run backfill:vulnrap -- --limit=500 --batch-size=50; then
  echo "[post-merge] WARNING: legacy vulnrap backfill failed; legacy reports will keep falling back to the 50/50 matrix until the next deploy." >&2
fi
