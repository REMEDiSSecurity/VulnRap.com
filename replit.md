# VulnRap.com

## Overview

VulnRap.com — a vulnerability report validation platform (like VirusTotal for bug reports). Allows anonymous users to upload vulnerability reports to check for similarity with other reports and score them for potential AI-generated sloppiness. Reports are auto-redacted before storage to remove PII, secrets, and identifying information.

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Frontend**: React 19 + Vite 7 + Tailwind CSS 4 + React Router v7
- **UI library**: Radix UI + shadcn/ui components
- **Data fetching**: TanStack React Query + Orval-generated hooks
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (API server), Vite (frontend)
- **Security**: helmet.js, express-rate-limit, multer (file uploads)
- **API docs**: swagger-ui-express served at `/api/docs`

## Architecture

### Frontend (`artifacts/vulnrap/`)
- React + Vite app at root path "/"
- Dark terminal-inspired aesthetic with cyan/violet accents, Space Mono font
- Custom AI-generated logo: synthetic bug inspected by lasers (`src/assets/logo.png`)
- Pages:
  - `/` — Home/upload with logo hero, 3 feature explainer cards, drag-and-drop upload, privacy mode selector, "How It Works" steps, hover hint tooltips
  - `/results/:id` — Analysis results: slop score, auto-redaction summary, similarity matches, section-level analysis with per-section hashes, feedback, expandable redacted report view
  - `/stats` — Platform statistics dashboard (metrics, distribution histogram, recent activity)
  - `/privacy` — Honest privacy policy: explains auto-redaction, what gets stored and compared, how comparison works, data lifecycle
- Uses generated API hooks from `@workspace/api-client-react`
- File upload supports .txt, .md (20MB max, client-side validated)
- Hover explainer tooltips on all key UI elements

### Auto-Redaction Engine (`artifacts/api-server/src/lib/redactor.ts`)
- Deterministic regex-based redaction (same input = same output)
- Redacts: emails, IPs, API keys, JWTs, AWS keys, passwords, connection strings, private keys, phone numbers, SSNs, credit cards, UUIDs, internal hostnames/URLs, company names, usernames
- Runs on every upload before analysis or storage
- Returns redacted text + summary (counts by category)

### Section Parser (`artifacts/api-server/src/lib/section-parser.ts`)
- Parses reports into logical sections (by markdown headers or paragraph breaks)
- Hashes each section independently with SHA-256
- Classifies sections by weight (high/medium/low value)
- Finds exact section matches against existing reports for granular duplicate detection

### Similarity Engine (`artifacts/api-server/src/lib/similarity.ts`)
- MinHash + Locality Sensitive Hashing (LSH) for near-duplicate detection
- Deterministic hash coefficients (SHA-256 seeded, stable across restarts)
- Simhash for structural similarity
- SHA-256 content hashing for exact-match deduplication
- Combined scoring: returns top-N matches above threshold

### Sloppiness Scoring (`artifacts/api-server/src/lib/sloppiness.ts`)
- Heuristic-based scoring (0-100 scale)
- Checks for: AI-generated phrases, missing version info, missing reproduction steps, missing code blocks, missing attack vector/impact, sentence length analysis, vocabulary diversity
- Tiers: Probably Legit (0-14), Mildly Suspicious (15-29), Questionable (30-49), Highly Suspicious (50-69), Pure Slop (70-100)
- Returns actionable feedback strings

### Upload Pipeline
1. User uploads .txt/.md file
2. Auto-redaction engine scrubs PII/secrets from raw text
3. All hashing (SHA-256, MinHash, Simhash, LSH, section hashes) runs on redacted text only
4. Similarity comparison against existing redacted reports
5. Section-level hash matching for granular duplicate detection
6. Sloppiness analysis runs on original text (for accurate AI detection)
7. Only redacted text is stored (never raw); in similarity_only mode, not even redacted text is stored

### Privacy Modes
- **full**: Stores redacted report text + all hashes/fingerprints
- **similarity_only**: Stores only hashes/fingerprints, no text at all

### Database Schema (`lib/db/src/schema/`)
- `reports` table: id, content_hash, simhash, minhash_signature, content_text (nullable), redacted_text (nullable), content_mode, slop_score, slop_tier, similarity_matches (jsonb), section_hashes (jsonb), section_matches (jsonb), redaction_summary (jsonb), feedback (jsonb), file_name, file_size, created_at
- `report_hashes` table: indexed hash lookup (sha256, simhash per report)
- `similarity_results` table: pairwise similarity scores
- `report_stats` table: aggregate counters

### API Endpoints
- `POST /api/reports` — Upload a report for analysis (multipart, 20MB limit)
- `GET /api/reports/:id` — Get report analysis results (includes redacted text, section hashes, redaction summary)
- `GET /api/reports/lookup/:hash` — Look up by SHA-256 hash
- `GET /api/stats` — Platform-wide statistics
- `GET /api/stats/recent` — Recent submission activity
- `GET /api/stats/distribution` — Slop score distribution histogram
- `GET /api/healthz` — Health check
- `GET /api/docs` — Swagger UI interactive API documentation

### Seed Data
- 6 realistic vulnerability reports seeded via `pnpm --filter @workspace/api-server run seed`
- Includes: XSS, IDOR, SQLi, SSRF, race condition reports (legit) + 1 AI-generated slop report
- Seed script at `artifacts/api-server/src/seed.ts`

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run seed` — seed example vulnerability reports
- `pnpm --filter @workspace/vulnrap run dev` — run frontend dev server

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
