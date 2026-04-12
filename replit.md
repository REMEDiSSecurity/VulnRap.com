# VulnRap.com

## Overview

**Current Version**: 2.0.0 (2026-04-12) — OpenAPI spec version 2.0.0

VulnRap.com is a vulnerability report validation platform designed to assess the quality and originality of bug reports. It functions similarly to VirusTotal but for vulnerability reports, allowing anonymous users to upload reports for similarity checks against existing reports and to score them for potential AI-generated content. The platform employs a multi-axis scoring engine that combines linguistic fingerprinting, factual verification, and LLM semantic analysis, fused via Bayesian combination. A key feature is the auto-redaction of reports to remove PII, secrets, and identifying information before storage, ensuring user privacy. VulnRap aims to provide a robust tool for bug bounty hunters, PSIRT teams, and security researchers to efficiently triage and validate vulnerability disclosures.

## User Preferences

I want iterative development.
Ask before making major changes.
Do not make changes to the folder `artifacts/vulnrap/src/assets`.
Do not make changes to the file `artifacts/api-server/src/seed.ts`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/auto-form.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/auto-form-label.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/auto-form-object.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/multi-select.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/number-field.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/rating-group.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/rich-text-editor.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/tag-group.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/components/ui/date-field.tsx`.
Do not make changes to the file `artifacts/vulnrap/src/lib/orval/client-fetch.ts`.
Do not make changes to the file `artifacts/vulnrap/src/lib/orval/orval-plugin.ts`.
Do not make changes to the file `artifacts/api-server/src/openapi.ts`.
Do not make changes to the file `artifacts/api-server/src/db/migrations/meta/_journal.json`.

## System Architecture

The project is structured as a pnpm workspace monorepo using TypeScript, with distinct `frontend` and `api-server` packages.

### Frontend (`artifacts/vulnrap/`)
- Built with React 19, Vite 7, Tailwind CSS 4, and React Router v7.
- Employs a Cyberpunk glassmorphism design system with glass cards, glow effects, gradient elements, and animated laser visuals.
- Features route-level code splitting for performance.
- Provides various user interfaces including:
    - Home/Submit page with drag-and-drop upload and privacy mode selection.
    - Analysis Results page displaying dual scores (AI Likelihood + Report Quality), confidence indicator, per-axis breakdown (Linguistic/Factual/Template/LLM), evidence signals with weight badges, LLM dimension scores, redaction summary, similarity matches, and section-level analysis.
    - Batch Upload and Compare Two Reports functionalities.
    - Session History and Export/Download options.
    - Public verification page (`/verify/:id`) for sharing analysis results.
    - API documentation for developers and use case explanations.
- Supports triple input methods: file upload (.txt, .md), direct text paste, or URL link (GitHub, Gist, etc.).
- Utilizes generated API hooks from `@workspace/api-client-react`.

### Backend (`artifacts/api-server/`)
- **API Framework**: Express 5.
- **Database**: PostgreSQL with Drizzle ORM.
- **Auto-Redaction Engine**: Deterministic regex-based redaction of PII/secrets, applied before analysis or storage.
- **Section Parser**: Parses reports into logical sections, hashes them with SHA-256, and classifies their value.
- **Similarity Engine**: Uses MinHash + Locality Sensitive Hashing (LSH), Simhash, and SHA-256 for near-duplicate and exact-match detection.
- **Multi-Axis Scoring Engine (v2.0)**:
    - **Axis 1 — Linguistic AI Fingerprinting** (`linguistic-analysis.ts`): Lexical markers (~50 weighted AI phrases), statistical text analysis (sentence length variance, passive voice ratio, contraction absence, bigram entropy), template detection ("dear security team", dependency dumps, OWASP padding).
    - **Axis 2 — Quality vs Slop Separation** (`sloppiness.ts`): Produces `qualityScore` (report completeness: version info, code blocks, repro steps) and heuristic `feedback` strings. Quality signals are intentionally separated from AI provenance signals.
    - **Axis 3 — Factual Verification** (`factual-verification.ts`): Severity inflation (CVSS 9.8 without RCE/auth-bypass), placeholder URLs (example.com, target.com), fabricated debug output (fake ASan addresses, GDB registers), fabricated CVE detection (sequential IDs, round numbers, unusually long IDs), hallucinated function names (generic CamelCase soup, mixed naming conventions).
    - **Axis 4 — LLM Semantic Analysis** (`llm-slop.ts`): 5-dimension evaluation: Specificity (0.15), Originality (0.25), Voice (0.20), Coherence (0.15), Hallucination (0.25). Uses OpenAI-compatible API. Graceful null return when unavailable.
    - **Score Fusion** (`score-fusion.ts`): Bayesian combination with base weights: Linguistic 0.25, Factual 0.30, LLM 0.35, Template 0.10. Dynamic boost to Factual 0.50 when `fabricated_cve` or `hallucinated_function` evidence detected. No-LLM redistribution: Linguistic 39%, Factual 44%, Template 17%. Confidence formula: `min(1.0, 0.3 + evidenceCount*0.07 + 0.2 if llm)`. Final slopScore: `rawScore*confidence + 50*(1-confidence)`.
- **Input Sanitization**: Strips scripts, sanitizes attributes, neutralizes URIs, removes control characters, and guards against excessive input length and binary content.
- **Upload Pipeline**: Ensures reports are redacted, hashed, compared for similarity, and analyzed by the multi-axis engine, with only redacted text (or just hashes in `similarity_only` mode) stored.
- **Privacy Modes**: `full` (stores redacted text and hashes) and `similarity_only` (stores only hashes).
- **API Endpoints**: Comprehensive set of endpoints for submitting, checking, deleting, retrieving, and comparing reports, alongside statistics and health checks.

### Core Technologies
- **Monorepo**: pnpm workspaces
- **Frontend**: React, Vite, Tailwind CSS, Radix UI, shadcn/ui
- **Backend**: Node.js, Express, PostgreSQL, Drizzle ORM
- **Data Fetching**: TanStack React Query, Orval-generated hooks
- **Validation**: Zod, drizzle-zod
- **API Codegen**: Orval (from OpenAPI spec)
- **Security**: helmet.js, express-rate-limit, multer
- **Build**: esbuild (API server), Vite (frontend)

### API Codegen Workflow
After modifying `lib/api-spec/openapi.yaml`, regenerate clients:
1. `cd lib/api-spec && pnpm run codegen` (generates React hooks + Zod schemas via Orval)
2. `cd lib/api-client-react && npx tsc --build` (compiles TypeScript declarations)
3. `cd lib/api-zod && npx tsc --build` (compiles Zod package)
4. If DB schema changed: `pnpm --filter @workspace/db run push`

### Key API Response Fields
- `slopScore` (0-100): AI likelihood score (higher = more likely AI-generated)
- `qualityScore` (0-100): Report completeness score (separate from AI detection)
- `confidence` (0.0-1.0): Analysis confidence level
- `breakdown`: `{ linguistic, factual, template, llm, quality }` per-axis scores
- `evidence`: Array of `{ type, description, weight, matched }` signal objects
- `llmBreakdown`: `{ specificity, originality, voice, coherence, hallucination }` (null if LLM unavailable)
- `slopTier`: Human-readable tier (Probably Legit / Mildly Suspicious / Questionable / Highly Suspicious / Pure Slop)
- `feedback`: Heuristic feedback strings from rule-based engine (sourced from sloppiness.ts)

## External Dependencies

- **OpenAI-compatible API**: Used by the LLM Semantic Analysis axis for evaluating reports. Configurable via `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` (defaults to `gpt-4o-mini`).
- **PostgreSQL**: The primary database for storing report data, hashes, and similarity results.