# Contributing to VulnRap

Thanks for your interest in improving VulnRap. This project is open source and contributions are welcome.

## Getting Started

1. Fork the repository and clone it locally
2. Install dependencies: `pnpm install`
3. Copy `.env.example` to `.env` and configure your PostgreSQL connection
4. Push the database schema: `pnpm --filter @workspace/db run push`
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
- If you modify `lib/db/src/schema/`, push changes with `pnpm --filter @workspace/db run push`

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
