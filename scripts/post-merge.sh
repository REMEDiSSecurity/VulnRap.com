#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push

echo "[post-merge] Building api-server for legacy vulnrap backfill..."
pnpm --filter @workspace/api-server run build

echo "[post-merge] Running legacy vulnrap backfill (limit=500, batch-size=50)..."
if ! pnpm --filter @workspace/api-server run backfill:vulnrap -- --limit=500 --batch-size=50; then
  echo "[post-merge] WARNING: legacy vulnrap backfill failed; legacy reports will keep falling back to the 50/50 matrix until the next deploy." >&2
fi
