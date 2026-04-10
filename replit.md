# VulnRap.com

## Overview

VulnRap.com — a vulnerability report validation platform (like VirusTotal for bug reports). Allows anonymous users to upload vulnerability reports to check for similarity with other reports and score them for potential AI-generated sloppiness.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Security**: helmet.js, express-rate-limit, multer (file uploads)

## Architecture

### Similarity Engine (`artifacts/api-server/src/lib/similarity.ts`)
- MinHash + Locality Sensitive Hashing (LSH) for near-duplicate detection
- Simhash for structural similarity
- SHA-256 content hashing for exact-match deduplication
- Combined scoring: returns top-N matches above threshold

### Sloppiness Scoring (`artifacts/api-server/src/lib/sloppiness.ts`)
- Heuristic-based scoring (0-100 scale)
- Checks for: AI-generated phrases, missing version info, missing reproduction steps, missing code blocks, missing attack vector/impact, sentence length analysis, vocabulary diversity
- Tiers: Probably Legit (0-14), Mildly Suspicious (15-29), Questionable (30-49), Highly Suspicious (50-69), Pure Slop (70-100)
- Returns actionable feedback strings

### Privacy Modes
- **full**: Stores complete report text for similarity lookups and content review
- **similarity_only**: Stores only hashes/fingerprints, never the original text

### Database Schema (`lib/db/src/schema/reports.ts`)
- `reports` table: id, content_hash, simhash, minhash_signature, content_text (nullable), content_mode, slop_score, similarity_matches (jsonb), feedback (jsonb), file_name, file_size, created_at

### API Endpoints
- `POST /api/reports` — Upload a report for analysis (multipart, 20MB limit)
- `GET /api/reports/:id` — Get report analysis results
- `GET /api/reports/lookup/:hash` — Look up by SHA-256 hash
- `GET /api/stats` — Platform-wide statistics
- `GET /api/stats/recent` — Recent submission activity
- `GET /api/stats/distribution` — Slop score distribution histogram
- `GET /api/healthz` — Health check

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
