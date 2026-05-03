# Changelog

All notable changes to **VulnRap** are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to the version scheme documented in
[`docs/versioning.md`](docs/versioning.md):

- The **project** follows [Semantic Versioning](https://semver.org/) — the version recorded in
  the root `package.json` and surfaced via `GET /api/version`.
- The **OpenAPI contract** (`lib/api-spec/openapi.yaml#info.version`)
  carries its own SemVer and is bumped independently per the
  [Public API stability](docs/versioning.md#public-api-stability) rules.

The pre-1.0 / pre-CHANGELOG history of the project was tracked in the
README using "v3.x.x / Sprint NN" labels. Those labels are mapped onto
SemVer below for the historical entries; from this point forward every
release lands as a new heading here as part of the release script
(`scripts/release.mjs`).

## [Unreleased]

### Added
- `GET /api/version` returns `{ project, projectVersion, gitSha, specVersion, builtAt }`
  for self-hosters and hosted-instance users to confirm exactly which
  build they're talking to. (Task #728)
- `docs/versioning.md` documents the project + spec SemVer scheme,
  deprecation policy, and how to read the changelog. (Task #728)
- `scripts/release.mjs` orchestrates a release end-to-end:
  typecheck → tests → build → OpenAPI breaking-change diff → CHANGELOG
  promotion → manifest bump → printed `git tag` / `git push` commands.
  (Task #728)
- `scripts/openapi-breaking-diff.mjs` flags removed paths / operations,
  renamed `operationId`s, and removed required response fields between
  two `openapi.yaml` snapshots. Used by the release script and
  recommended for use in CI alongside `oasdiff`. (Task #728)
- `.github/workflows/release.yml` is triggered by `v*` tag pushes,
  builds the Docker image, runs the SBOM workflow, and renders the
  matching CHANGELOG section into the GitHub Release notes. (Task #728)

### Changed
- Root `package.json#version` moved off the placeholder `0.0.0` and
  now carries the project's real SemVer. (Task #728)

## [3.8.0] - 2026-04-15

### Changed
- Three-engine composite scoring rewired: Engine 1 (AI authorship) now
  contributes 5% inverted, Engine 2 (technical substance) 60%, Engine 3
  (CWE coherence) 35%. README "Composite Scoring (Three-Engine, v3.8.0)"
  documents the rationale.

### Added
- Sprint 12 A2 `BEHAVIORAL_MATCH_REWARD` composite override (+6) when a
  GOLD_SIGNAL fires AND Engine 3 ≥ 60 with no negative CWE signals AND
  Engine 1 verdict ≠ RED.
- Sprint 12 A1 substance gate: Engine 3 capped at 42 when Engine 2
  reports near-zero substance.

## [3.6.0] - 2026-02-01

### Added
- Dev-only `GET /api/test/run` endpoint for fixture-battery harness use
  (handler returns 404 in production).
- AVRI feature flag (`VULNRAP_USE_AVRI`) lets Engine 2 swap its rubric
  for one of nine CWE-family-specific rubrics with gold signals and
  absence penalties.

## [0.1.0] - 2025-Q4

### Added
- Initial public surface: report submission, MinHash + LSH + SimHash
  similarity matching, multi-axis scoring (linguistic, factual,
  template, optional LLM), section-level SHA-256 hashing, auto-redaction
  of PII / secrets / credentials, Swagger UI under `/api/docs`, and the
  React + Vite frontend.

[Unreleased]: https://github.com/REMEDiSSecurity/VulnRap.com/compare/v3.8.0...HEAD
[3.8.0]: https://github.com/REMEDiSSecurity/VulnRap.com/compare/v3.6.0...v3.8.0
[3.6.0]: https://github.com/REMEDiSSecurity/VulnRap.com/compare/v0.1.0...v3.6.0
[0.1.0]: https://github.com/REMEDiSSecurity/VulnRap.com/releases/tag/v0.1.0
