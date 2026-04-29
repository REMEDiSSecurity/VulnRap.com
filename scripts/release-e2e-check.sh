#!/usr/bin/env bash
set -euo pipefail

echo "[release-e2e-check] Running diagnostics e2e smoke test against the PRODUCTION builds of vulnrap and api-server..."
echo "[release-e2e-check] (vite preview + bundled dist/index.mjs, not the dev servers)"

CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}}"
if [ -z "${CHROMIUM_PATH}" ] || [ ! -x "${CHROMIUM_PATH}" ]; then
  echo "[release-e2e-check] ERROR: No Chromium binary available." >&2
  echo "  Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE to a runnable Chromium build before retrying." >&2
  exit 1
fi
echo "[release-e2e-check] Using Chromium at: ${CHROMIUM_PATH}"

if ! pnpm --filter @workspace/vulnrap exec playwright test \
  --config playwright.config.ts \
  diagnostics-panel.spec.ts; then
  echo "" >&2
  echo "[release-e2e-check] ERROR: Diagnostics e2e check failed against the production builds." >&2
  echo "  The vulnrap frontend and api-server contract regressed -- this release is BLOCKED." >&2
  echo "  This may indicate a vite build/base-path issue or a bundled api-server (dist/index.mjs) regression that the dev servers did not surface." >&2
  echo "  Inspect the failing spec at artifacts/vulnrap/e2e/diagnostics-panel.spec.ts and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
  exit 1
fi

echo "[release-e2e-check] Diagnostics e2e check passed."
