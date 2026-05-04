# VulnRap GitLab CI/CD Component

Reusable GitLab CI/CD component that scores incoming security advisory MRs
(or any vulnerability report text) against
[VulnRap](https://vulnrap.com)'s multi-engine pipeline and exposes the
result (slop score, tier, triage verdict) as dotenv artifact variables
downstream jobs can consume.

The component calls `POST /api/reports/check` — the read-only endpoint
that runs the full pipeline (multi-engine consensus, similarity
matching, AVRI gold signals, PII auto-redaction) but **does not**
persist the report to the public feed.

- No API key required. The endpoint is open and rate-limited per IP.
- Uses `bash`, `curl` and `jq` installed at runtime on a minimal
  `alpine:3.20` image — no heavyweight runner images needed.

## Inputs

| Name             | Required | Default               | Description                                                                        |
| ---------------- | -------- | --------------------- | ---------------------------------------------------------------------------------- |
| `report-text`    | one of   | —                     | Inline report text.                                                                |
| `report-file`    | one of   | —                     | Path to a report file inside the workspace (`.txt`, `.md`, `.pdf`).                |
| `api-base-url`   | no       | `https://vulnrap.com` | Override for self-hosted deployments.                                              |
| `fail-threshold` | no       | `70`                  | Slop score (0-100) at which the job exits non-zero. Set to `999` to never fail.    |
| `skip-llm`       | no       | `false`               | Skip LLM analysis — heuristics only.                                               |
| `skip-redaction` | no       | `false`               | Skip PII auto-redaction (forces `skip-llm=true` server-side).                      |
| `stage`          | no       | `test`                | Pipeline stage to run the scoring job in.                                          |

Exactly one of `report-text` or `report-file` must be provided.

## Outputs (dotenv artifact variables)

The job writes a `vulnrap.env` dotenv artifact. Downstream jobs that
declare `needs: [vulnrap-score]` (or use `dependencies:`) automatically
receive these variables:

| Variable                          | Description                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `VULNRAP_SLOP_SCORE`              | Composite slop score 0-100 (higher = more likely AI slop).                                           |
| `VULNRAP_SLOP_TIER`               | Human-readable slop tier name.                                                                       |
| `VULNRAP_VERDICT`                 | Triage archetype — one of `AUTO_CLOSE`, `REQUEST_DETAILS`, `PRIORITIZE_REVIEW`, `ACCEPT`, `UNKNOWN`. |
| `VULNRAP_QUALITY_SCORE`           | Report quality / completeness 0-100.                                                                 |
| `VULNRAP_CONFIDENCE`              | Confidence in the slop score (0.0-1.0).                                                              |
| `VULNRAP_SIMILARITY_MATCH_COUNT`  | Near-duplicate count from the public corpus.                                                         |

## Usage

### Include via remote component

Point `include` at the raw template in the VulnRap repo:

```yaml
include:
  - component: gitlab.com/vulnrap/vulnrap/sdks/gitlab-component/template@main
    inputs:
      report-file: advisories/$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME.md
      fail-threshold: "80"
```

Or include the template directly by URL:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/vulnrap/vulnrap/main/sdks/gitlab-component/template.yml"
```

Then override inputs with variables in your pipeline.

### Score an advisory MR and gate the merge

```yaml
include:
  - remote: "https://raw.githubusercontent.com/vulnrap/vulnrap/main/sdks/gitlab-component/template.yml"

stages:
  - test
  - report

vulnrap-score:
  variables:
    INPUT_REPORT_FILE: advisories/CVE-2026-0001.md
    INPUT_FAIL_THRESHOLD: "80"

report-results:
  stage: report
  needs: [vulnrap-score]
  script:
    - echo "Slop score is $VULNRAP_SLOP_SCORE ($VULNRAP_SLOP_TIER)"
    - echo "Verdict is $VULNRAP_VERDICT"
    - |
      if [ "$VULNRAP_VERDICT" = "AUTO_CLOSE" ]; then
        echo "⚠️ This report was flagged as AI slop"
      fi
```

### Score inline text from an MR description

```yaml
include:
  - remote: "https://raw.githubusercontent.com/vulnrap/vulnrap/main/sdks/gitlab-component/template.yml"

vulnrap-score:
  variables:
    INPUT_REPORT_TEXT: "Found a path traversal in /api/files endpoint..."
    INPUT_FAIL_THRESHOLD: "999"
```

### Self-hosted VulnRap

Point the component at any deployment that exposes the same
`/api/reports/check` contract:

```yaml
vulnrap-score:
  variables:
    INPUT_REPORT_FILE: advisories/CVE-2026-0001.md
    INPUT_API_BASE_URL: https://vulnrap.internal.acme.example
```

## How the verdict is derived

`VULNRAP_VERDICT` is the `archetype` field returned by the API:

| Archetype           | Meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `AUTO_CLOSE`        | The pipeline is confident this is AI slop / no signal. |
| `REQUEST_DETAILS`   | Plausible but under-specified; ask the reporter.       |
| `PRIORITIZE_REVIEW` | Strong signal — a senior triager should look first.    |
| `ACCEPT`            | High-quality human research; route to the queue.       |
| `UNKNOWN`           | API did not return an archetype.                       |

Combine `VULNRAP_VERDICT` with `fail-threshold` to gate merges, label
issues, or hand off to your existing triage flow.

## Version pinning

For reproducible, supply-chain-safe builds, pin the remote include and
entrypoint URL to a specific commit SHA instead of `main`:

```yaml
include:
  - remote: "https://raw.githubusercontent.com/vulnrap/vulnrap/<COMMIT_SHA>/sdks/gitlab-component/template.yml"
    inputs:
      entrypoint-url: "https://raw.githubusercontent.com/vulnrap/vulnrap/<COMMIT_SHA>/sdks/gitlab-component/entrypoint.sh"
      report-file: advisories/CVE-2026-0001.md
```

## Vendoring

For maximum control, copy `entrypoint.sh` into your own repository
(e.g. `.vulnrap/entrypoint.sh`). The template automatically detects
vendored copies at `.vulnrap/entrypoint.sh` or
`sdks/gitlab-component/entrypoint.sh` before attempting a remote fetch:

```yaml
vulnrap-score:
  script:
    - bash .vulnrap/entrypoint.sh
```

## Limitations

- The job installs `bash`, `curl`, and `jq` via `apk` at runtime on
  `alpine:3.20`. On custom runner images that already have these tools,
  you can remove the `before_script` block.
- The hosted endpoint is rate-limited (~30 analyses / 15 min / IP).
  At program scale, self-host VulnRap and point `api-base-url` at it.
- Dotenv artifacts have a [5 KiB limit](https://docs.gitlab.com/ee/ci/yaml/artifacts_reports.html#artifactsreportsdotenv)
  in GitLab. The exported variables are well within this limit.
