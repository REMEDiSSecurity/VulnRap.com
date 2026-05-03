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
- Accessibility improvements across the frontend
- Internationalization / localization
- Additional test coverage

## Reporting Issues

If you find a security vulnerability in VulnRap itself, please report it responsibly via the contact in `/.well-known/security.txt` rather than opening a public issue.

For bugs and feature requests, open a GitHub issue with steps to reproduce.

## Code Style

- TypeScript throughout
- No `any` types without justification
- Functional components with hooks for React code
- Zod for runtime validation
- Keep files focused; split large components

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
