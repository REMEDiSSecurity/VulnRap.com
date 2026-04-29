#!/usr/bin/env bash
set -euo pipefail

# Task #182 — Run the full vulnrap Playwright e2e suite against the
# PRODUCTION builds of @workspace/vulnrap and @workspace/api-server.
#
# This wraps `pnpm --filter @workspace/vulnrap run test:e2e` so it can be
# wired into a registered validation step (and any future CI workflow).
# The Playwright config (artifacts/vulnrap/playwright.config.ts) handles
# the webServer plumbing for both the bundled api-server (dist/index.mjs
# via `start`) and the vite preview build, so this script's job is just
# to (1) ensure a runnable Chromium binary is on disk and (2) provision
# E2E_CALIBRATION_TOKEN for the strict-auth GET on
# /feedback/calibration/handwavy-phrases (Task #163 + Task #152).
#
# The hand-wavy specs themselves (handwavy-undo.spec.ts,
# handwavy-reinstate-batch.spec.ts, handwavy-remove-confirm.spec.ts,
# and friends) default the token to "e2e-calibration-token" when the
# env var is unset, and so does playwright.config.ts. We export the
# same default explicitly here so a fail-loud override
# (E2E_CALIBRATION_TOKEN=...) propagates to both the webServer env
# block and the spec-side request contexts.

echo "[vulnrap-e2e-check] Running the full vulnrap Playwright e2e suite against the PRODUCTION builds of vulnrap and api-server..."
echo "[vulnrap-e2e-check] (vite preview + bundled dist/index.mjs, not the dev servers)"

CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}}"
if [ -z "${CHROMIUM_PATH}" ] || [ ! -x "${CHROMIUM_PATH}" ]; then
  echo "[vulnrap-e2e-check] ERROR: No Chromium binary available." >&2
  echo "  Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE to a runnable Chromium build before retrying." >&2
  exit 1
fi
echo "[vulnrap-e2e-check] Using Chromium at: ${CHROMIUM_PATH}"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${CHROMIUM_PATH}"

# Default the calibration token to the same value playwright.config.ts uses
# so the strict-auth GET on /feedback/calibration/handwavy-phrases succeeds
# without any extra wiring. Callers can override (e.g. CI secret) by
# exporting E2E_CALIBRATION_TOKEN before invoking this script.
export E2E_CALIBRATION_TOKEN="${E2E_CALIBRATION_TOKEN:-e2e-calibration-token}"
echo "[vulnrap-e2e-check] E2E_CALIBRATION_TOKEN is set (length=${#E2E_CALIBRATION_TOKEN})."

if ! pnpm --filter @workspace/vulnrap run test:e2e; then
  echo "" >&2
  echo "[vulnrap-e2e-check] ERROR: vulnrap Playwright e2e suite failed against the production builds." >&2
  echo "  A spec under artifacts/vulnrap/e2e/ (including the hand-wavy phrase panel coverage) regressed." >&2
  echo "  Inspect the failing spec and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
  exit 1
fi

echo "[vulnrap-e2e-check] vulnrap Playwright e2e suite passed."
