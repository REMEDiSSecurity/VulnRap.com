#!/bin/bash
# Task #1326 — REMEDiS eval harness wrapper.
#
# Builds the api-server (so we run against current scoring-engine code,
# not a stale dist) and runs the harness against the 170-report
# REMEDiS corpus under eval/remedis-corpus/AllReports/reports/.
#
# Exits non-zero on threshold failure (REMEDiS handoff §"What CI
# should look like"). Pass --no-exit-on-fail to override (useful when
# capturing a new baseline that is expected to regress).
#
# Env:
#   LOG_LEVEL=silent (default here) — suppresses pino noise from the
#     scoring pipeline so the human-readable table is the only stdout.
#   REMEDIS_HARNESS_PASSES — N passes per report (default 5).
#
# Usage:
#   bash scripts/remedis-harness.sh                # CI mode
#   bash scripts/remedis-harness.sh --baseline     # rewrites eval/remedis-baseline.json
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CORPUS_DIR="eval/remedis-corpus/AllReports/reports"
if [ ! -d "$CORPUS_DIR" ]; then
  echo "[remedis-harness] corpus missing at $CORPUS_DIR; extracting attached_assets zip..."
  mkdir -p eval/remedis-corpus
  python3 - <<'PY'
import zipfile, os
z = zipfile.ZipFile('attached_assets/AllReports_1778880171809.zip')
for n in z.namelist():
    if n.startswith('__MACOSX') or n.endswith('.DS_Store'):
        continue
    z.extract(n, 'eval/remedis-corpus')
PY
fi

REPORT_COUNT="$(find "$CORPUS_DIR" -maxdepth 1 -name 'rr-*.json' | wc -l | tr -d ' ')"
if [ "$REPORT_COUNT" != "170" ]; then
  echo "[remedis-harness] FAIL: expected 170 reports in $CORPUS_DIR, found $REPORT_COUNT." >&2
  echo "[remedis-harness] Re-extract attached_assets/AllReports_1778880171809.zip and retry." >&2
  exit 2
fi

echo "[remedis-harness] building api-server..."
pnpm --filter @workspace/api-server run build >/dev/null

PASSES="${REMEDIS_HARNESS_PASSES:-5}"
export LOG_LEVEL="${LOG_LEVEL:-silent}"

node --enable-source-maps "$REPO_ROOT/artifacts/api-server/dist/remedis-harness.mjs" \
  --passes "$PASSES" \
  --reports-dir "$CORPUS_DIR" \
  "$@"
