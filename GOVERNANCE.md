# Project Governance

This file documents the human-managed pieces of the project's operational
setup that live outside the source tree (e.g. GitHub repository settings).
Code-level conventions belong in `CONTRIBUTING.md`; this file is the
canonical reference for maintainers and for anyone setting up a fork.

## Required status checks (branch protection)

The CI workflows under `.github/workflows/` produce the following named
checks. To enforce them, a maintainer must enable branch protection on
`main` in the GitHub UI (Settings → Branches → Branch protection rules →
`main` → "Require status checks to pass before merging") and add each
required check below. The GitHub Actions runner publishes the check name
as `<workflow name> / <job name>`, which is what you select in the UI.

Required for every PR before merge to `main`:

- `CI / codegen / typecheck / unit tests / format`
  (workflow: `.github/workflows/ci.yml`, job `checks`)
- `CI / vulnrap e2e (diff-aware)`
  (workflow: `.github/workflows/ci.yml`, job `e2e`)
- `CodeQL / Analyze (javascript-typescript)`
  (workflow: `.github/workflows/codeql.yml`)

Recommended additional protection rules:

- "Require branches to be up to date before merging" — keeps the
  diff-aware e2e selector accurate against the current `main`.
- "Require linear history" — the project uses a rebase-style merge flow
  (see `scripts/post-merge.sh` and the `resolve_rebase_conflict` skill).
- "Do not allow bypassing the above settings" for non-admins.

The `Build (main)` and `Nightly e2e` workflows run after merge; they're
not part of the required-checks set.

## Workflow catalogue

| Workflow                 | File                                 | Trigger                           | What it does                                                                                                                         |
| ------------------------ | ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CI                       | `.github/workflows/ci.yml`           | PR + push to `main`               | Codegen verification, typecheck, every package's vitest suite, Prettier check, opt-in lint, and the diff-aware Playwright e2e suite. |
| Build (main)             | `.github/workflows/build.yml`        | push to `main`                    | Builds both artifacts and uploads `artifacts/*/dist` as workflow artifacts.                                                          |
| Nightly e2e (full suite) | `.github/workflows/nightly-e2e.yml`  | daily cron (04:17 UTC) + manual   | Forces `E2E_RUN_ALL_SPECS=1` so the whole Playwright suite runs against `main`; opens / updates a tracking issue on failure.         |
| CodeQL                   | `.github/workflows/codeql.yml`       | PR + push to `main` + weekly cron | JavaScript/TypeScript security + quality scan.                                                                                       |
| Release SBOM             | `.github/workflows/release-sbom.yml` | tag push (`v*`) + manual          | Generates a CycloneDX SBOM from the pnpm lockfile and attaches it to the matching GitHub Release.                                    |

## Dependency updates

`.github/dependabot.yml` configures Dependabot for:

- `npm` (pnpm-aware via `pnpm-lock.yaml` v9)
- `github-actions`
- `docker` (no-op until a `Dockerfile` lands; safe to keep enabled)

All three ecosystems run on a weekly Monday schedule, group minor + patch
updates together, and surface security updates without grouping. The
labels `dependencies`, `javascript`, `github-actions`, and `docker` are
applied to make filtering easy.

## Releases & SBOM

To cut a release:

1. Push a `vX.Y.Z` tag on `main`.
2. The `Release SBOM` workflow generates `vulnrap-sbom.cdx.json` (CycloneDX
   1.5 JSON) and attaches it to the GitHub Release for that tag.
3. The SBOM is also kept as a 90-day workflow artifact for auditability.

If you need to (re-)attach an SBOM to an existing release, run the
`Release SBOM` workflow manually and pass the tag name as the input.
