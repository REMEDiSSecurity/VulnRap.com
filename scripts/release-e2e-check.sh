#!/usr/bin/env bash
set -euo pipefail

echo "[release-e2e-check] Running diagnostics e2e smoke test (vulnrap <-> api-server contract)..."

CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}}"
if [ -z "${CHROMIUM_PATH}" ] || [ ! -x "${CHROMIUM_PATH}" ]; then
  echo "[release-e2e-check] ERROR: No Chromium binary available." >&2
  echo "  Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE to a runnable Chromium build before retrying." >&2
  exit 1
fi
echo "[release-e2e-check] Using Chromium at: ${CHROMIUM_PATH}"

if ! pnpm --filter @workspace/vulnrap run test:e2e; then
  echo "" >&2
  echo "[release-e2e-check] ERROR: Diagnostics e2e check failed." >&2
  echo "  The vulnrap frontend and api-server contract regressed -- this release is BLOCKED." >&2
  echo "  Inspect the failing spec at artifacts/vulnrap/e2e/diagnostics-panel.spec.ts and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
  exit 1
fi

echo "[release-e2e-check] Diagnostics e2e check passed."
