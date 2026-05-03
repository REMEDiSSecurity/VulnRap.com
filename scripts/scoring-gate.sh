#!/bin/bash
# Task #641 — Pre-merge scoring gate.
#
# Runs two layers of regression defense before any change to engines,
# scoring, or calibration is allowed to merge:
#
#   1. Golden corpus — vitest tests under
#      `artifacts/api-server/test/regression/` whose names end with
#      `.regression.test.ts` (companion task: scoring regression
#      golden corpus). These pin a curated fixture battery so any
#      tier movement on the seeded corpus fails loudly.
#
#   2. Production replay — the replay node script pulls the most
#      recent 100 reports from DATABASE_URL, recomputes their
#      slopTier through the *current* scoring pipeline, and fails if
#      the tier-flip rate exceeds 0.5%. This is the "are we worse
#      than yesterday on real data" check.
#
# Bypass: export SCORING_GATE_BYPASS=1 to skip the gate entirely.
# Intended for legitimate calibration changes where the new tiers ARE
# the desired behavior. The bypass is logged so the next reviewer can
# see at a glance that someone made a deliberate choice. See
# README "Pre-merge scoring gate" for the full bypass protocol.
set -uo pipefail

if [[ "${SCORING_GATE_BYPASS:-0}" == "1" ]]; then
  echo "[scoring-gate] BYPASS=1 — skipping golden corpus + replay. ($(date -u +%FT%TZ))"
  echo "[scoring-gate] Reason should be in the merge commit message."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

GATE_FAIL=0

echo "[scoring-gate] Step 1/2: golden corpus regression tests"
REGRESSION_DIR="artifacts/api-server/test/regression"
# shellcheck disable=SC2207
GOLDEN_TESTS=( $(find "$REGRESSION_DIR" -name "*.regression.test.ts" 2>/dev/null) )
if [[ ${#GOLDEN_TESTS[@]} -eq 0 ]]; then
  echo "[scoring-gate]   no *.regression.test.ts files under ${REGRESSION_DIR} yet — skipping step 1."
  echo "[scoring-gate]   (companion task 'Scoring regression golden corpus' will populate this.)"
else
  # Run them via the api-server's vitest config so path aliases + tsconfig resolve.
  RELATIVE_TESTS=()
  for t in "${GOLDEN_TESTS[@]}"; do
    RELATIVE_TESTS+=( "${t#artifacts/api-server/}" )
  done
  echo "[scoring-gate]   running ${#RELATIVE_TESTS[@]} golden corpus file(s): ${RELATIVE_TESTS[*]}"
  if ! pnpm --filter @workspace/api-server exec vitest run "${RELATIVE_TESTS[@]}" --reporter=verbose; then
    echo "[scoring-gate]   FAIL: golden corpus regression"
    GATE_FAIL=1
  fi
fi

echo "[scoring-gate] Step 2/2: production replay (last 100 reports)"
if ! node "$REPO_ROOT/scripts/scoring-gate-replay.mjs"; then
  echo "[scoring-gate]   FAIL: production replay"
  GATE_FAIL=1
fi

if [[ "$GATE_FAIL" -ne 0 ]]; then
  echo
  echo "[scoring-gate] ============================================="
  echo "[scoring-gate] GATE FAILED."
  echo "[scoring-gate]   - Inspect the per-fixture diff above."
  echo "[scoring-gate]   - If this is an intentional calibration change,"
  echo "[scoring-gate]     re-run with SCORING_GATE_BYPASS=1 and explain"
  echo "[scoring-gate]     the change in the merge commit. See README"
  echo "[scoring-gate]     'Pre-merge scoring gate' for the full protocol."
  echo "[scoring-gate] ============================================="
  exit 1
fi

echo "[scoring-gate] OK: gate passed."
exit 0
