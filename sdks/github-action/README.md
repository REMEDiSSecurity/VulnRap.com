# VulnRap GitHub Action

Score an incoming security advisory PR or VDP issue body against
[VulnRap](https://vulnrap.com)'s multi-engine pipeline and expose the
result (slop score, tier, triage verdict) as step outputs you can
gate on.

The action calls `POST /api/reports/check` — the read-only endpoint
that runs the full pipeline (multi-engine consensus, similarity
matching, AVRI gold signals, PII auto-redaction) but **does not**
persist the report to the public feed.

- No API key required. The endpoint is open and rate-limited per IP.
- No JavaScript bundle or `node_modules` to maintain — the action is
  a single composite step using `bash`, `curl` and `jq` (preinstalled
  on every standard GitHub-hosted runner).
- Works on `ubuntu-*`, `macos-*` and `windows-*` (the latter via Git
  Bash that ships with `actions/checkout`).

## Inputs

| Name             | Required | Default               | Description                                                                        |
| ---------------- | -------- | --------------------- | ---------------------------------------------------------------------------------- |
| `report-text`    | one of   | —                     | Inline report text.                                                                |
| `report-file`    | one of   | —                     | Path to a report file inside the workspace (`.txt`, `.md`, `.pdf`).                |
| `api-base-url`   | no       | `https://vulnrap.com` | Override for self-hosted deployments.                                              |
| `fail-threshold` | no       | `70`                  | Slop score (0-100) at which the action exits non-zero. Set to `999` to never fail. |
| `skip-llm`       | no       | `false`               | Skip LLM analysis — heuristics only.                                               |
| `skip-redaction` | no       | `false`               | Skip PII auto-redaction (forces `skip-llm=true` server-side).                      |

Exactly one of `report-text` or `report-file` must be provided.

## Outputs

| Name                     | Description                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `slop-score`             | Composite slop score 0-100 (higher = more likely AI slop).                                           |
| `slop-tier`              | Human-readable slop tier name.                                                                       |
| `verdict`                | Triage archetype — one of `AUTO_CLOSE`, `REQUEST_DETAILS`, `PRIORITIZE_REVIEW`, `ACCEPT`, `UNKNOWN`. |
| `quality-score`          | Report quality / completeness 0-100.                                                                 |
| `confidence`             | Confidence in the slop score (0.0-1.0).                                                              |
| `similarity-match-count` | Near-duplicate count from the public corpus.                                                         |
| `raw-json`               | Path under `$RUNNER_TEMP` to the full JSON response for downstream steps.                            |

## Usage

### Score an advisory PR and post the result as a comment

```yaml
name: VulnRap triage

on:
  pull_request:
    paths:
      - "advisories/**.md"

jobs:
  score:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          # Required so the `git diff` step below can compare against the base
          # branch. The default shallow clone does not include base-branch refs.
          fetch-depth: 0

      - name: Pick the changed advisory
        id: pick
        run: |
          file=$(git diff --name-only origin/${{ github.base_ref }}... \
                  | grep -E '^advisories/.*\.md$' | head -n1)
          echo "file=${file}" >> "$GITHUB_OUTPUT"

      - name: Score with VulnRap
        id: vulnrap
        if: steps.pick.outputs.file != ''
        uses: vulnrap/vulnrap/sdks/github-action@main
        with:
          report-file: ${{ steps.pick.outputs.file }}
          fail-threshold: 80 # block the PR if it scores 80+

      - name: Comment on the PR
        if: steps.pick.outputs.file != ''
        uses: actions/github-script@v7
        with:
          script: |
            const score   = `${{ steps.vulnrap.outputs.slop-score }}`;
            const tier    = `${{ steps.vulnrap.outputs.slop-tier }}`;
            const verdict = `${{ steps.vulnrap.outputs.verdict }}`;
            const dupes   = `${{ steps.vulnrap.outputs.similarity-match-count }}`;
            const body = [
              `### VulnRap analysis`,
              ``,
              `- **Slop score:** ${score} / 100 (${tier})`,
              `- **Verdict:** \`${verdict}\``,
              `- **Similar reports:** ${dupes}`,
              ``,
              `_Posted by the VulnRap GitHub Action._`,
            ].join('\n');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });
```

### Score a VDP issue body

```yaml
on:
  issues:
    types: [opened, edited]

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - id: vulnrap
        uses: vulnrap/vulnrap/sdks/github-action@main
        with:
          report-text: ${{ github.event.issue.body }}
          fail-threshold: 999 # informational only — never fail the workflow

      - name: Auto-label low-quality reports
        if: steps.vulnrap.outputs.verdict == 'AUTO_CLOSE'
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ['needs-original-research'],
            });
```

### Self-hosted VulnRap

Point the action at any deployment that exposes the same `/api/reports/check`
contract:

```yaml
- uses: vulnrap/vulnrap/sdks/github-action@main
  with:
    report-file: advisories/CVE-2026-0001.md
    api-base-url: https://vulnrap.internal.acme.example
```

## How the verdict is derived

`verdict` is the `archetype` field returned by the API:

| Archetype           | Meaning                                                |
| ------------------- | ------------------------------------------------------ |
| `AUTO_CLOSE`        | The pipeline is confident this is AI slop / no signal. |
| `REQUEST_DETAILS`   | Plausible but under-specified; ask the reporter.       |
| `PRIORITIZE_REVIEW` | Strong signal — a senior triager should look first.    |
| `ACCEPT`            | High-quality human research; route to the queue.       |
| `UNKNOWN`           | API did not return an archetype.                       |

Combine `verdict` with `fail-threshold` to gate merges, label issues, or
hand off to your existing triage flow.

## Limitations

- The action shells out to `curl` and `jq`. They are preinstalled on
  GitHub-hosted runners but you may need to install them on minimal
  self-hosted runners.
- The hosted endpoint is rate-limited (~30 analyses / 15 min / IP).
  At program scale, run from a small fleet so you do not share an
  egress IP with the rest of your team — or self-host VulnRap and
  point `api-base-url` at it.
- This repository does not publish to the GitHub Marketplace. Reference
  the action by its repo path (`vulnrap/vulnrap/sdks/github-action@<ref>`)
  or vendor it into your own monorepo.
