#!/usr/bin/env bash
# VulnRap GitHub Action entrypoint.
#
# Scores a single vulnerability report against POST /api/reports/check and
# exposes the resulting composite score, tier and triage verdict as
# step outputs. Optionally fails the job when the score crosses a
# configurable threshold.
#
# Dependencies: bash, curl, jq — all preinstalled on standard GitHub-hosted
# runners (ubuntu-*, macos-*, windows-* via Git Bash).

set -euo pipefail

REPORT_TEXT="${INPUT_REPORT_TEXT:-}"
REPORT_FILE="${INPUT_REPORT_FILE:-}"
API_BASE_URL="${INPUT_API_BASE_URL:-https://vulnrap.com}"
FAIL_THRESHOLD="${INPUT_FAIL_THRESHOLD:-70}"
SKIP_LLM="${INPUT_SKIP_LLM:-false}"
SKIP_REDACTION="${INPUT_SKIP_REDACTION:-false}"

API_BASE_URL="${API_BASE_URL%/}"
ENDPOINT="${API_BASE_URL}/api/reports/check"

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required but not installed on this runner." >&2
  exit 2
fi

if [[ -z "${REPORT_TEXT}" && -z "${REPORT_FILE}" ]]; then
  echo "::error::Either 'report-text' or 'report-file' must be provided." >&2
  exit 2
fi

if [[ -n "${REPORT_TEXT}" && -n "${REPORT_FILE}" ]]; then
  echo "::error::Provide only one of 'report-text' or 'report-file', not both." >&2
  exit 2
fi

if [[ -n "${REPORT_FILE}" && ! -f "${REPORT_FILE}" ]]; then
  echo "::error::report-file '${REPORT_FILE}' does not exist." >&2
  exit 2
fi

TMP_DIR="${RUNNER_TEMP:-/tmp}"
RESPONSE_SUFFIX="${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}-$$"
RESPONSE_FILE="${TMP_DIR}/vulnrap-response-${RESPONSE_SUFFIX}.json"

CURL_ARGS=(
  --silent
  --show-error
  --fail-with-body
  --location
  --max-time 120
  --output "${RESPONSE_FILE}"
  --write-out "%{http_code}"
  -F "skipLlm=${SKIP_LLM}"
  -F "skipRedaction=${SKIP_REDACTION}"
)

if [[ -n "${REPORT_FILE}" ]]; then
  CURL_ARGS+=(-F "file=@${REPORT_FILE}")
else
  CURL_ARGS+=(--form-string "rawText=${REPORT_TEXT}")
fi

echo "Scoring report against ${ENDPOINT} ..."

set +e
HTTP_CODE=$(curl "${CURL_ARGS[@]}" "${ENDPOINT}")
CURL_STATUS=$?
set -e

if [[ ${CURL_STATUS} -ne 0 ]]; then
  echo "::error::VulnRap request failed (curl exit ${CURL_STATUS}, http ${HTTP_CODE:-unknown})." >&2
  if [[ -s "${RESPONSE_FILE}" ]]; then
    echo "Response body:" >&2
    cat "${RESPONSE_FILE}" >&2 || true
  fi
  exit 1
fi

if ! jq -e . "${RESPONSE_FILE}" >/dev/null 2>&1; then
  echo "::error::VulnRap returned a non-JSON response (http ${HTTP_CODE})." >&2
  cat "${RESPONSE_FILE}" >&2 || true
  exit 1
fi

SLOP_SCORE=$(jq -r '.slopScore // empty' "${RESPONSE_FILE}")
SLOP_TIER=$(jq -r '.slopTier // "UNKNOWN"' "${RESPONSE_FILE}")
QUALITY_SCORE=$(jq -r '.qualityScore // empty' "${RESPONSE_FILE}")
CONFIDENCE=$(jq -r '.confidence // empty' "${RESPONSE_FILE}")
ARCHETYPE=$(jq -r '.archetype // .triageRecommendation.archetype // "UNKNOWN"' "${RESPONSE_FILE}")
SIM_COUNT=$(jq -r '(.similarityMatches // []) | length' "${RESPONSE_FILE}")

if [[ -z "${SLOP_SCORE}" ]]; then
  echo "::error::Response did not include a slopScore field." >&2
  cat "${RESPONSE_FILE}" >&2
  exit 1
fi

VERDICT="${ARCHETYPE}"

{
  echo "slop-score=${SLOP_SCORE}"
  echo "slop-tier=${SLOP_TIER}"
  echo "verdict=${VERDICT}"
  echo "quality-score=${QUALITY_SCORE}"
  echo "confidence=${CONFIDENCE}"
  echo "similarity-match-count=${SIM_COUNT}"
  echo "raw-json=${RESPONSE_FILE}"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## VulnRap analysis"
    echo ""
    echo "| Field | Value |"
    echo "| ----- | ----- |"
    echo "| Slop score | \`${SLOP_SCORE}\` / 100 |"
    echo "| Tier | \`${SLOP_TIER}\` |"
    echo "| Verdict | \`${VERDICT}\` |"
    echo "| Quality | \`${QUALITY_SCORE}\` / 100 |"
    echo "| Confidence | \`${CONFIDENCE}\` |"
    echo "| Similar reports | \`${SIM_COUNT}\` |"
  } >> "${GITHUB_STEP_SUMMARY}"
fi

echo "VulnRap: slopScore=${SLOP_SCORE} tier=${SLOP_TIER} verdict=${VERDICT} similar=${SIM_COUNT}"

if [[ "${FAIL_THRESHOLD}" =~ ^[0-9]+$ ]] && [[ "${SLOP_SCORE}" =~ ^[0-9]+$ ]]; then
  if (( SLOP_SCORE >= FAIL_THRESHOLD )); then
    echo "::error::Slop score ${SLOP_SCORE} >= fail-threshold ${FAIL_THRESHOLD}." >&2
    exit 1
  fi
fi
