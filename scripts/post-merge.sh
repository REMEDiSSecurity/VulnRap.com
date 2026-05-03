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
# Task #641 — Pre-merge scoring gate. Only run when the merged diff
# touched scoring-relevant code: the workspace `lib/` packages OR the
# api-server's `src/lib/` (engines, scoring, calibration, fusion).
# Anything else (UI changes, route handlers, docs) cannot regress
# scoring tier outputs, so we skip the gate to keep post-merge fast.
#
# Bypass: export SCORING_GATE_BYPASS=1 before invoking this hook to
# skip the gate even when it would otherwise run. Intended for
# legitimate calibration changes; see README "Pre-merge scoring gate".
SCORING_GATE_PATHS_REGEX='^(lib/|artifacts/api-server/src/lib/)'
# Pick the widest correct range we can prove. In a real `git merge`
# post-merge hook ORIG_HEAD points at the pre-merge tip, so
# `ORIG_HEAD..HEAD` covers every commit the merge brought in (handles
# multi-commit merges and fast-forwards alike). When ORIG_HEAD is
# missing (e.g. a manual `bash scripts/post-merge.sh`, a fresh clone,
# or a CI runner re-invoking the hook) we fall back to upstream..HEAD,
# then to HEAD~1..HEAD. If none of those resolve we treat the diff as
# "unknown" and run the gate anyway — better to spend a minute on a
# replay than to silently skip enforcement for a scoring change.
SCORING_GATE_RANGE=""
if git rev-parse --verify ORIG_HEAD >/dev/null 2>&1 && [ "$(git rev-parse ORIG_HEAD)" != "$(git rev-parse HEAD)" ]; then
  SCORING_GATE_RANGE="ORIG_HEAD..HEAD"
elif git rev-parse --verify '@{upstream}' >/dev/null 2>&1 && [ "$(git rev-parse '@{upstream}')" != "$(git rev-parse HEAD)" ]; then
  SCORING_GATE_RANGE="@{upstream}..HEAD"
elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
  SCORING_GATE_RANGE="HEAD~1..HEAD"
fi

if [ -n "$SCORING_GATE_RANGE" ]; then
  CHANGED_PATHS="$(git diff --name-only "$SCORING_GATE_RANGE" 2>/dev/null || true)"
  echo "[post-merge] Scoring-gate diff range: $SCORING_GATE_RANGE"
  RUN_GATE=0
  if echo "$CHANGED_PATHS" | grep -Eq "$SCORING_GATE_PATHS_REGEX"; then
    RUN_GATE=1
  fi
else
  CHANGED_PATHS=""
  echo "[post-merge] Scoring-gate diff range: <unknown> — defaulting to RUN."
  RUN_GATE=1
fi

# Wind-down override (2026-05-03): the dev DB carries scores from older
# engine versions, so the replay step trips on every merge that touches
# `lib/` (even pure schema additions like phrase_suggestions in #634).
# We're in wind-down mode — no new scoring work is landing — so default
# the gate to BYPASS for post-merge runs to let the in-flight queue
# drain cleanly. The gate itself is unchanged and is still invoked
# directly via `bash scripts/scoring-gate.sh`.
#
# To RE-ENABLE the gate in post-merge: delete the two lines below, or
# set SCORING_GATE_BYPASS=0 in the environment.
#
# This default is intentionally LOUD — every post-merge run prints a
# WIND-DOWN BYPASS warning so a future agent can't miss that the
# guardrail is off. After any scoring-engine change in `lib/` or
# `artifacts/api-server/src/lib/`, run the gate manually:
#     bash scripts/scoring-gate.sh
: "${SCORING_GATE_BYPASS:=1}"
export SCORING_GATE_BYPASS
if [ "$SCORING_GATE_BYPASS" = "1" ]; then
  echo "[post-merge] WARNING: SCORING_GATE_BYPASS=1 (wind-down default). The pre-merge scoring gate is disabled for post-merge runs." >&2
  echo "[post-merge] WARNING: Run 'bash scripts/scoring-gate.sh' manually after any scoring-engine change. See replit.md > Wind-Down Notes." >&2
fi

if [ "$RUN_GATE" -eq 1 ]; then
  echo "[post-merge] Scoring-relevant paths changed (or range unknown); running pre-merge scoring gate..."
  if ! bash scripts/scoring-gate.sh; then
    echo "[post-merge] FAIL: scoring gate failed for this merge." >&2
    echo "[post-merge] FAIL: see README 'Pre-merge scoring gate' for the bypass procedure." >&2
    echo "[post-merge] FAIL: re-run with SCORING_GATE_BYPASS=1 only for intentional calibration changes." >&2
    exit 1
  fi
else
  echo "[post-merge] No scoring-relevant paths changed; skipping pre-merge scoring gate."
fi

echo "[post-merge] vulnrap-e2e registrar decision for the merged diff:"
DECISION="$(node scripts/vulnrap-e2e-register.mjs 2>&1 >/dev/null || true)"
RECOMMENDATION="$(node scripts/vulnrap-e2e-register.mjs 2>/dev/null || echo "REGISTER")"
echo "  recommendation: ${RECOMMENDATION}"
echo "  reasoning: ${DECISION}"
