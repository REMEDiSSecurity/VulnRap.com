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

pnpm --filter db run push-force

echo "[post-merge] Building api-server for legacy vulnrap backfill..."
pnpm --filter @workspace/api-server run build

echo "[post-merge] Running legacy vulnrap backfill (limit=500, batch-size=50)..."
if ! pnpm --filter @workspace/api-server run backfill:vulnrap -- --limit=500 --batch-size=50; then
  echo "[post-merge] WARNING: legacy vulnrap backfill failed; legacy reports will keep falling back to the 50/50 matrix until the next deploy." >&2
fi

# Task #353 -- print the vulnrap-e2e registrar's decision for the merged
# diff so the next agent picking up the workspace can see at a glance
# whether the validation step needs re-registering or clearing. The
# actual registration mutation (setValidationCommand /
# clearValidationCommand) lives in the agent's code_execution sandbox
# and must be called by the agent via syncVulnrapE2eValidation -- see
# README "Running the Playwright e2e suite" for the snippet.
echo "[post-merge] vulnrap-e2e registrar decision for the merged diff:"
DECISION="$(node scripts/vulnrap-e2e-register.mjs 2>&1 >/dev/null || true)"
RECOMMENDATION="$(node scripts/vulnrap-e2e-register.mjs 2>/dev/null || echo "REGISTER")"
echo "  recommendation: ${RECOMMENDATION}"
echo "  reasoning: ${DECISION}"
