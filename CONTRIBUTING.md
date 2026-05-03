# Contributing to VulnRap

Thanks for your interest in improving VulnRap. This project is open source and contributions are welcome.

## Getting Started

1. Fork the repository and clone it locally
2. Install dependencies: `pnpm install`
3. Copy `.env.example` to `.env` and configure your PostgreSQL connection
4. Apply database migrations: `pnpm --filter @workspace/db run migrate`
5. Generate API client code: `pnpm --filter @workspace/api-spec run codegen`
6. Seed example data: `pnpm --filter @workspace/api-server run seed`
7. Start the API server: `pnpm --filter @workspace/api-server run dev`
8. Start the frontend: `pnpm --filter @workspace/vulnrap run dev`

## Project Structure

```
artifacts/
  vulnrap/          React + Vite frontend
  api-server/       Express API server
lib/
  db/               Drizzle ORM schema and database client
  api-spec/         OpenAPI specification + Orval codegen config
  api-zod/          Generated Zod validation schemas
  api-client-react/ Generated React Query hooks
```

## Development Workflow

- Run `pnpm run typecheck` before submitting changes
- If you modify `lib/api-spec/openapi.yaml`, regenerate client code with `pnpm --filter @workspace/api-spec run codegen`
- If you modify `lib/db/src/schema/`, generate a versioned migration with
  `pnpm --filter @workspace/db run generate`, review the SQL it writes
  under `lib/db/drizzle/`, and commit the file together with the
  updated `meta/_journal.json` and snapshot. Then apply it locally with
  `pnpm --filter @workspace/db run migrate`.
  - For fast schema iteration in your local dev DB you can still use
    `pnpm --filter @workspace/db run push` (alias: `push:dev`). **Local
    dev only — never run against production.** The script refuses to
    run when `NODE_ENV=production`. See [`docs/self-hosting.md`](docs/self-hosting.md)
    for the full upgrade flow.

### How `pnpm typecheck` is wired

The shared libs in `lib/<name>/` are TypeScript composite project references. They emit `.d.ts` files into a gitignored `lib/<name>/dist/` (driven by `lib/<name>/tsconfig.tsbuildinfo`). Every artifact (`artifacts/*/tsconfig.json`) consumes those dists via project references, and each artifact's own `typecheck` script is just `tsc -p tsconfig.json --noEmit` — it will silently read whatever `.d.ts` happens to be on disk.

To stop artifact typechecks from running against stale generated types, the root `pnpm typecheck` script always runs `pnpm run typecheck:libs` (i.e. `tsc --build`) **before** fanning out to the artifact typechecks. `tsc --build` is incremental, so this is effectively free in steady state but guarantees that an edit under `lib/db/src/`, `lib/avri-rubric/src/`, or `lib/api-zod/src/` is reflected in the dist outputs the artifacts then consume — without requiring a fresh `pnpm install` or a manual `pnpm typecheck:libs` first.

The same `tsc --build` step also runs as part of `postinstall` and inside `scripts/verify-codegen.mjs`. The explicit invocation in the root `typecheck` script is the belt-and-braces safeguard so the dependency does not rely on a side effect of either of those — please keep it there. If you ever see a phantom "no exported member …" error against a lib (or, worse, suspect a real lib schema change is going undetected by the artifact typecheck), suspect a stale `lib/<name>/dist/` first: run `pnpm typecheck:libs`, or delete `lib/*/dist` and `lib/*/tsconfig.tsbuildinfo` and re-run `pnpm typecheck`, before chasing it as a real type error.

## Areas Where Help is Wanted

- Improving the sloppiness detection heuristics (`artifacts/api-server/src/lib/sloppiness.ts`)
- Adding new redaction patterns (`artifacts/api-server/src/lib/redactor.ts`)
- Better section parsing for non-markdown report formats (`artifacts/api-server/src/lib/section-parser.ts`)
- Accessibility improvements across the frontend (target: WCAG 2.1 AA — see [docs/accessibility.md](docs/accessibility.md) for the running coverage and known gaps)
- Internationalization / localization
- Additional test coverage

## Reporting Issues

If you find a security vulnerability in VulnRap itself, please report it responsibly via the contact in `/.well-known/security.txt` rather than opening a public issue.

For bugs and feature requests, open a GitHub issue with steps to reproduce.

## Changelog entries

Every PR that ships a user-visible change (new feature, bug fix,
deprecation, removal, security fix) MUST add an entry to the
`## [Unreleased]` section at the top of [`CHANGELOG.md`](CHANGELOG.md)
under one of the standard
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) headings:
**Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**,
**Security**. Internal-only refactors and test-only changes don't
need an entry.

The release script (`scripts/release.mjs`) promotes the
`## [Unreleased]` section into a dated `## [<version>] - <date>`
heading on every cut, so the unreleased buffer becomes the
historical record. See [`docs/versioning.md`](docs/versioning.md)
for the full release process and the SemVer scheme used for the
project and the OpenAPI spec.

## Releasing

Maintainers cut releases via:

```bash
node scripts/release.mjs <next-version>
```

The script enforces a clean tree, runs typecheck + tests + build,
diffs the OpenAPI spec against the previous release tag for
breaking changes, promotes the changelog, and bumps
`package.json#version`. It then prints the manual `git tag` /
`git push` commands. Pushing the `v<version>` tag triggers
`.github/workflows/release.yml` (Docker image + release notes from
the changelog slice) and `.github/workflows/release-sbom.yml`
(CycloneDX SBOM attached to the release).

## Code Style

- TypeScript throughout
- No `any` types without justification
- Functional components with hooks for React code
- Zod for runtime validation
- Keep files focused; split large components

## Linting & Formatting

The repo ships a single ESLint flat config (`eslint.config.mjs`) and Prettier
config (`.prettierrc.json`) at the root. They cover the React frontend
(`artifacts/vulnrap`), the Node API server (`artifacts/api-server`), the
shared libraries under `lib/`, and the helper scripts under `scripts/`.

Common commands (run from the repo root):

```sh
pnpm run lint          # report ESLint errors and warnings
pnpm run lint:fix      # auto-fix the safe ones
pnpm run format        # rewrite files with Prettier
pnpm run format:check  # report files that need formatting
```

A pre-commit hook installed by [lefthook](https://lefthook.dev/) runs Prettier
`--write` and ESLint `--fix` on staged files only, plus a `tsc --noEmit` for
the workspace package(s) that own the touched TypeScript files. The hook is
installed automatically by `pnpm install` (via the `prepare` script). To run
it manually: `pnpm exec lefthook run pre-commit`.

To bypass the hook in an emergency, use the standard escape hatch:

```sh
git commit --no-verify
```

To skip hook installation entirely (e.g. in CI or non-git checkouts), set
`SKIP_HOOKS_INSTALL=1` or `CI=true` before running `pnpm install`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
