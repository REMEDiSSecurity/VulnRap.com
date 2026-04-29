#!/usr/bin/env bash
set -euo pipefail

echo "[release-e2e-check] Running e2e smoke tests against the PRODUCTION builds of vulnrap and api-server..."
echo "[release-e2e-check] (vite preview + bundled dist/index.mjs, not the dev servers)"

CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}}"
if [ -z "${CHROMIUM_PATH}" ] || [ ! -x "${CHROMIUM_PATH}" ]; then
  echo "[release-e2e-check] ERROR: No Chromium binary available." >&2
  echo "  Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE to a runnable Chromium build before retrying." >&2
  exit 1
fi
echo "[release-e2e-check] Using Chromium at: ${CHROMIUM_PATH}"

# Specs that must pass against the PRODUCTION builds before a release ships.
# Keep this list in sync with the user flows we consider release-blocking:
#   - diagnostics-panel.spec.ts        : the diagnostics panel + bundled api-server contract
#   - handwavy-undo.spec.ts            : the FLAT hand-wavy phrase add+undo flow
#   - handwavy-reinstate-batch.spec.ts : the "Reinstate all" batch flow
RELEASE_SPECS=(
  diagnostics-panel.spec.ts
  handwavy-undo.spec.ts
  handwavy-reinstate-batch.spec.ts
)

if ! pnpm --filter @workspace/vulnrap exec playwright test \
  --config playwright.config.ts \
  "${RELEASE_SPECS[@]}"; then
  echo "" >&2
  echo "[release-e2e-check] ERROR: Release-gate e2e check failed against the production builds." >&2
  echo "  The vulnrap frontend and api-server contract regressed -- this release is BLOCKED." >&2
  echo "  This may indicate a vite build/base-path issue or a bundled api-server (dist/index.mjs) regression that the dev servers did not surface." >&2
  echo "  Failing spec is one of: ${RELEASE_SPECS[*]}" >&2
  echo "  Inspect the specs under artifacts/vulnrap/e2e/ and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
  exit 1
fi

echo "[release-e2e-check] Release-gate e2e check passed (${#RELEASE_SPECS[@]} specs)."
