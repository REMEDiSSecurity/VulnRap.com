#!/usr/bin/env bash
set -euo pipefail

# Task #182 + Task #250 + Task #251 -- Run the vulnrap Playwright e2e suite
# against the PRODUCTION builds of @workspace/vulnrap and @workspace/api-server.
#
# This wraps `pnpm --filter @workspace/vulnrap run test:e2e` so it can be
# wired into a registered validation step (and any future CI workflow).
# The Playwright config (artifacts/vulnrap/playwright.config.ts) handles
# the webServer plumbing for both the bundled api-server (dist/index.mjs
# via `start`) and the vite preview build, so this script's job is to:
#   (1) ensure a runnable Chromium binary is on disk
#   (2) provision E2E_CALIBRATION_TOKEN for the strict-auth GET on
#       /feedback/calibration/handwavy-phrases (Task #163 + Task #152)
#   (3) ask scripts/vulnrap-e2e-select-specs.mjs which specs the current
#       branch's changes can possibly affect, and pass that subset to
#       Playwright -- saves wall-clock when the change is unrelated to
#       the FLAT hand-wavy phrase panel or only touches one spec file.
#
# The hand-wavy specs themselves (handwavy-undo.spec.ts,
# handwavy-reinstate-batch.spec.ts, handwavy-remove-confirm.spec.ts,
# and friends) default the token to "e2e-calibration-token" when the
# env var is unset, and so does playwright.config.ts. We export the
# same default explicitly here so a fail-loud override
# (E2E_CALIBRATION_TOKEN=...) propagates to both the webServer env
# block and the spec-side request contexts.
#
# Task #250 — Build cache reuse.
# The Playwright `webServer` blocks chain `node scripts/build-if-stale.mjs`
# in front of `start`/`serve`, so the vite + esbuild builds are reused when
# `artifacts/api-server/dist/index.mjs` and
# `artifacts/vulnrap/dist/public/index.html` are newer than every watched
# source dir/file (each artifact's own src/ + build configs + every
# `@workspace/*` dep declared in its package.json, resolved to
# `lib/<short-name>/src`). On a cold container both builds run; on a warm
# back-to-back run both are skipped and the e2e step starts the servers
# in well under a second of build-cache overhead.
#
# Critical: the cache check MUST run with the same build-time env
# Playwright uses for the webServer (notably `VITE_CALIBRATION_TOKEN`,
# `BASE_PATH`, and `PUBLIC_URL`, which Vite inlines into the bundle).
# To avoid that env having to be duplicated in this script, we deliberately
# do NOT pre-warm the cache here — Playwright's webServer commands handle
# both the freshness check and (if needed) the build under the right env.
#
# Escape hatches (Task #250 + Task #251):
#   E2E_SKIP_PROD_BUILD=1   trust the existing dist/ (no freshness check;
#                           use when CI built it in a separate stage).
#   E2E_FORCE_PROD_BUILD=1  always rebuild (escape hatch when the mtime
#                           heuristic ever looks suspect).
#   E2E_RUN_ALL_SPECS=1     force the full suite (skip the change-aware
#                           filter). Use this for nightly runs or when
#                           debugging the selector itself.
#   E2E_DIFF_BASE=<ref>     override the git ref the selector compares
#                           against (defaults to origin/main, then main).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELECTOR="${SCRIPT_DIR}/vulnrap-e2e-select-specs.mjs"

echo "[vulnrap-e2e-check] Running the vulnrap Playwright e2e suite against the PRODUCTION builds of vulnrap and api-server..."
echo "[vulnrap-e2e-check] (vite preview + bundled dist/index.mjs, not the dev servers)"

if [ "${E2E_SKIP_PROD_BUILD:-0}" = "1" ]; then
  echo "[vulnrap-e2e-check] E2E_SKIP_PROD_BUILD=1 — trusting existing dist/ (no rebuild)"
elif [ "${E2E_FORCE_PROD_BUILD:-0}" = "1" ]; then
  echo "[vulnrap-e2e-check] E2E_FORCE_PROD_BUILD=1 — rebuilding both bundles"
else
  echo "[vulnrap-e2e-check] Build cache: rebuilding only stale targets (override with E2E_FORCE_PROD_BUILD=1 or E2E_SKIP_PROD_BUILD=1)"
fi

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

# --- Change-aware spec selection (Task #251) ---
# The selector prints either:
#   ALL                 -> run every spec
#   NONE                -> skip the suite entirely
#   <spec>...           -> one spec basename per line, run only those
# stderr from the selector is forwarded so the reasoning shows up in logs.
echo "[vulnrap-e2e-check] Selecting specs based on the current branch's changed files..."
SELECTOR_OUTPUT="$(node "${SELECTOR}")"
SELECTED_SPECS=()
RUN_MODE="all"
while IFS= read -r line; do
  [ -z "${line}" ] && continue
  if [ "${line}" = "ALL" ]; then
    RUN_MODE="all"
    SELECTED_SPECS=()
    break
  elif [ "${line}" = "NONE" ]; then
    RUN_MODE="none"
    SELECTED_SPECS=()
    break
  else
    RUN_MODE="subset"
    SELECTED_SPECS+=("${line}")
  fi
done <<<"${SELECTOR_OUTPUT}"

if [ "${RUN_MODE}" = "none" ]; then
  echo "[vulnrap-e2e-check] No vulnrap e2e surface area was touched -- skipping suite."
  echo "[vulnrap-e2e-check] (set E2E_RUN_ALL_SPECS=1 to force the full suite)"
  exit 0
fi

if [ "${RUN_MODE}" = "subset" ]; then
  echo "[vulnrap-e2e-check] Running ${#SELECTED_SPECS[@]} change-affected spec(s):"
  for spec in "${SELECTED_SPECS[@]}"; do
    echo "  - ${spec}"
  done
  if ! pnpm --filter @workspace/vulnrap exec playwright test \
    --config playwright.config.ts \
    "${SELECTED_SPECS[@]}"; then
    echo "" >&2
    echo "[vulnrap-e2e-check] ERROR: change-affected vulnrap Playwright specs failed against the production builds." >&2
    echo "  Failing spec is one of: ${SELECTED_SPECS[*]}" >&2
    echo "  Inspect the failing spec and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
    echo "  (set E2E_RUN_ALL_SPECS=1 to also run the unrelated specs and rule out a wider regression)" >&2
    exit 1
  fi
  echo "[vulnrap-e2e-check] change-affected vulnrap Playwright specs passed (${#SELECTED_SPECS[@]} spec(s))."
  exit 0
fi

# RUN_MODE == "all"
echo "[vulnrap-e2e-check] Running the FULL vulnrap Playwright e2e suite (a shared file changed or no diff was available)."
if ! pnpm --filter @workspace/vulnrap run test:e2e; then
  echo "" >&2
  echo "[vulnrap-e2e-check] ERROR: vulnrap Playwright e2e suite failed against the production builds." >&2
  echo "  A spec under artifacts/vulnrap/e2e/ (including the hand-wavy phrase panel coverage) regressed." >&2
  echo "  Inspect the failing spec and the Playwright report under artifacts/vulnrap/playwright-report/." >&2
  exit 1
fi

echo "[vulnrap-e2e-check] vulnrap Playwright e2e suite passed."
