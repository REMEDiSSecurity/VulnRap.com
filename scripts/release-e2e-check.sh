#!/usr/bin/env bash
set -euo pipefail

echo "[release-e2e-check] Running e2e smoke tests against the PRODUCTION builds of vulnrap and api-server..."
echo "[release-e2e-check] (vite preview + bundled dist/index.mjs, not the dev servers)"
# By default the Playwright webServer chains scripts/build-if-stale.mjs in
# front of `start`/`serve`, so the vite + esbuild builds are reused when
# dist/ is newer than every watched source (saves ~15s on back-to-back runs).
# Task #351 also wires in a cross-restart persistent cache: when dist/ is
# missing or stale (e.g. on a cold container), build-if-stale.mjs first
# tries to restore a content-addressed snapshot from
# `.cache/build-if-stale/<target>/<hash>/` before paying for a full build,
# and snapshots the resulting dist/ post-build for the next cold start.
# CI callers that already produced an up-to-date dist/ in a separate stage
# can short-circuit the freshness check entirely with E2E_SKIP_PROD_BUILD=1;
# E2E_FORCE_PROD_BUILD=1 forces a rebuild (and skips the persistent cache
# restore) if the heuristic ever looks stale; BUILD_IF_STALE_DISABLE_CACHE=1
# disables only the persistent cache while keeping the per-container
# freshness check.
if [ "${E2E_SKIP_PROD_BUILD:-0}" = "1" ]; then
  echo "[release-e2e-check] E2E_SKIP_PROD_BUILD=1 — trusting existing dist/ (no rebuild)"
elif [ "${E2E_FORCE_PROD_BUILD:-0}" = "1" ]; then
  echo "[release-e2e-check] E2E_FORCE_PROD_BUILD=1 — rebuilding both bundles"
fi

CHROMIUM_PATH="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-${REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}}"
if [ -z "${CHROMIUM_PATH}" ] || [ ! -x "${CHROMIUM_PATH}" ]; then
  echo "[release-e2e-check] ERROR: No Chromium binary available." >&2
  echo "  Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE to a runnable Chromium build before retrying." >&2
  exit 1
fi
echo "[release-e2e-check] Using Chromium at: ${CHROMIUM_PATH}"

# Specs that must pass against the PRODUCTION builds before a release ships.
# Keep this list in sync with the user flows we consider release-blocking:
#   - diagnostics-panel.spec.ts                   : the diagnostics panel + bundled api-server contract
#   - handwavy-undo.spec.ts                       : the FLAT hand-wavy phrase add+undo flow
#   - handwavy-reinstate-batch.spec.ts            : the "Reinstate all" batch flow
#   - handwavy-production-scan-limit.spec.ts      : Task #125 production-scan window control (input + warning + persistence + subtitle)
# Task #274 — The bulk preview/confirm phrase flows are just as release-blocking
# as the FLAT add+undo flow above: a bundled-only regression in any of these
# would let the reviewer either lose valid detections (failed dry-run gating)
# or silently re-arm a high-thrash marker (failed reinstate-confirm). Each
# spec drives the production vite preview + dist/index.mjs through a single
# user-visible flow, so they belong on the release gate alongside the
# original four.
#   - handwavy-bulk-preview.spec.ts               : side-by-side bulk-removal preview + confirm gating (Task #154)
#   - handwavy-bulk-undo.spec.ts                  : "Undo this batch" banner action (Task #142)
#   - handwavy-preview-side-by-side.spec.ts       : single-add side-by-side preview + destructive confirm (Task #126)
#   - handwavy-reinstate-batch-preview.spec.ts    : per-batch "Preview reinstate" dry-run + confirm (Task #177)
#   - handwavy-reinstate-batch-thrash.spec.ts     : bulk-reinstate thrash warning surface (Task #179)
#   - handwavy-reinstate-confirm.spec.ts          : per-row reinstate AlertDialog confirm (Task #153)
#   - handwavy-removal-batches-panel.spec.ts      : inline "Recent batch removals" reinstate picker (Task #175)
#   - handwavy-remove-confirm.spec.ts             : high-thrash single-remove confirm panel (Task #152)
#   - handwavy-remove-preview.spec.ts             : per-row Trash dry-run + acknowledgment gate (Task #173)
#   - handwavy-revert-disabled.spec.ts            : per-edit Revert disabled-state on the edit history (Task #148)
RELEASE_SPECS=(
  diagnostics-panel.spec.ts
  handwavy-undo.spec.ts
  handwavy-reinstate-batch.spec.ts
  handwavy-production-scan-limit.spec.ts
  handwavy-bulk-preview.spec.ts
  handwavy-bulk-undo.spec.ts
  handwavy-preview-side-by-side.spec.ts
  handwavy-reinstate-batch-preview.spec.ts
  handwavy-reinstate-batch-thrash.spec.ts
  handwavy-reinstate-confirm.spec.ts
  handwavy-removal-batches-panel.spec.ts
  handwavy-remove-confirm.spec.ts
  handwavy-remove-preview.spec.ts
  handwavy-revert-disabled.spec.ts
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
