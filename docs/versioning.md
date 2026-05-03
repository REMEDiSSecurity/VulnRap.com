# Versioning, Release Process & Public API Stability

This document is the source of truth for how VulnRap is versioned, how
releases are cut, and which parts of the public surface a downstream
consumer (a self-hoster, a curl user, the React Query client) can rely
on between releases.

## Two version numbers

VulnRap exposes **two independent SemVer numbers**:

| Number              | Where it lives                            | What it covers                                                                                  |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Project version** | `package.json#version` (root)             | The product as a whole — UI, scoring engines, infra. Bumped on every release.                   |
| **Spec version**    | `lib/api-spec/openapi.yaml#info.version`  | The HTTP `/api/...` contract. Bumped only when the contract changes; major bump = breaking.     |

Both follow [Semantic Versioning 2.0.0](https://semver.org/). They move
independently — a UI-only release bumps the project version but leaves
the spec version untouched; an API-only deprecation may bump the spec
version without changing the project's minor / patch.

The running build's values are always observable via:

```bash
curl https://vulnrap.com/api/version
# {
#   "project": "vulnrap",
#   "projectVersion": "3.8.0",
#   "gitSha": "a1b2c3d4e5f6",
#   "specVersion": "3.0.0",
#   "builtAt": "2026-04-15T18:32:01.000Z"
# }
```

`gitSha` and `builtAt` are baked into the bundle by
`artifacts/api-server/build.mjs` (esbuild `define`); a dev server with
no git history reports `gitSha=dev` and an epoch `builtAt`.

## Public API stability

`/api/version`, `/api/healthz`, `/api/reports*`, `/api/stats`,
`/api/feedback`, `/api/cohort`, `/api/presets`, `/api/roadmap`,
`/api/status`, `/api/incidents`, `/api/gallery`, `/api/showcase`,
`/api/embed`, and `/api/changelog.json` are **stable**. Breaking
changes to any of these endpoints require a major bump of
`info.version` in the OpenAPI spec.

`/api/test-yourself` and `/api/phrase-suggestions` are **experimental**
— their wire shape may change in a minor release. They are tagged in
the OpenAPI spec; consumers should pin to a specific spec version.

`/api/internal/*`, `/api/calibration/*`, `/api/audit-log/*`,
`/api/webhooks/*`, and `/api/test/*` are **reviewer-only / dev-only**
and are explicitly NOT part of the public stability contract. They are
gated by `CALIBRATION_TOKEN` (or 404 in production) and may change at
any time.

### What counts as a breaking change

A spec-version major bump is required for any of the following:

- Removing a path or operation.
- Renaming an `operationId` (the generated React Query / Zod client
  keys off it, so a rename breaks compiled clients even if the wire
  shape is unchanged).
- Removing a field that was listed under `required` in a response
  schema.
- Removing an enum value from a response field.
- Changing the type of an existing field.
- Tightening validation on a request body in a way that would reject a
  previously-accepted payload.

Adding optional response fields, adding new operations, adding new
enum values to a *request* field, and loosening validation on a
request body are all minor bumps.

### Deprecation policy

A stable endpoint is deprecated by:

1. Marking it `deprecated: true` in `lib/api-spec/openapi.yaml`.
2. Adding a `Deprecation` HTTP header on responses (RFC 8594) in the
   route handler.
3. Documenting the replacement and removal date in `CHANGELOG.md`
   under the next release's "Deprecated" section.

Deprecated stable endpoints remain functional for **at least n - 1
minor versions of the spec**. A deprecation announced in spec 3.4.0
may be removed no earlier than 3.6.0; the matching project release
that removes the route requires a major spec bump.

## Reading the changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The top of the file always carries an `## [Unreleased]` section that
contributors add to as part of every PR (see [`CONTRIBUTING.md`](../CONTRIBUTING.md#changelog-entries)).
The release script promotes that section into a dated heading on every
cut, so the historical record is always the same shape as the
unreleased buffer.

Each release entry is grouped under the standard headings: **Added**,
**Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

The pre-`v3.8.0` history was tracked informally in the README using
"v3.x.x / Sprint NN" labels. Those labels are reconstructed onto
SemVer for the seeded entries near the bottom of the changelog. From
`v3.8.0` onwards every release is recorded contemporaneously.

## Release process

### Tooling

- `scripts/release.mjs` — the driver. Run it locally on a clean tree;
  it does the validation, prints the manual `git tag` / `git push`
  commands at the end. It deliberately does NOT push or commit on the
  operator's behalf.
- `scripts/openapi-breaking-diff.mjs` — zero-dependency JS detector
  used by the release script. For full coverage CI also runs
  [`oasdiff`](https://github.com/Tufin/oasdiff) against the previous
  release tag's spec.
- `.github/workflows/release.yml` — triggered by the `v*` tag push,
  builds the Docker image and renders the release notes from the
  matching CHANGELOG section.
- `.github/workflows/release-sbom.yml` — same trigger, generates the
  CycloneDX SBOM and attaches it to the GitHub Release.

### Steps

1. Land all PRs targeting the release. Every PR must include a
   `## [Unreleased]` entry under one of the standard headings.
2. From a clean checkout of `main`:

   ```bash
   node scripts/release.mjs <next-version>
   # e.g. node scripts/release.mjs 3.9.0
   # add --allow-breaking when intentionally landing a major spec bump
   ```

   This runs:
   - `pnpm run typecheck`
   - `pnpm run test`
   - `pnpm run build`
   - `scripts/openapi-breaking-diff.mjs` against the previous release
     tag's spec
   - Promotes `## [Unreleased]` -> `## [<version>] - <date>` in
     `CHANGELOG.md`
   - Bumps `package.json#version`
   - Prints the exact `git commit` / `git tag` / `git push` commands
3. Run those commands. Pushing the `v<version>` tag fires both
   `release.yml` (Docker image + release notes) and
   `release-sbom.yml` (CycloneDX SBOM).
4. Verify the resulting GitHub Release page lists the SBOM and the
   image, and that the rendered release notes match the new
   CHANGELOG section.
5. After deploy, hit `/api/version` on the deployed instance and
   confirm `projectVersion` and `gitSha` match the tagged commit.

### Bypasses

- `RELEASE_ALLOW_DIRTY=1` — skip the dirty-tree check (rehearsals only).
- `RELEASE_SKIP_TESTS=1` — skip `pnpm test` (rehearsals only).
- `--allow-breaking` — allow OpenAPI breaking changes (still requires
  a manual major bump of `info.version` in the spec).
- `--dry-run` — do everything except mutate files / push.

## Verifying a self-hosted instance

```bash
curl http://localhost:8080/api/version
```

The returned `projectVersion` should match the tag you deployed; the
`gitSha` should match `git rev-parse --short=12 v<version>` for the
same tag. If `gitSha` is `dev`, the instance was built without git
history (e.g. an extracted source zip) — that's supported but means
the SHA cannot be cross-referenced against the public repo.

## Why internal `package.json`s stay at `0.0.0/private`

Every package under `artifacts/` and `lib/` is `"private": true` and
stays pinned to `0.0.0`. They are workspace-internal — never published
to a registry — so there is no consumer who would key off their
version field. The single source of truth for "what version of
VulnRap is this" is the root `package.json#version`, mirrored at
runtime by `GET /api/version`.
