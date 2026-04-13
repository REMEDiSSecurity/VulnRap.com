# VulnRap.com

## Overview

**Current Version**: 3.0.0 (2026-04-12) — OpenAPI spec version 3.0.0

VulnRap.com is a vulnerability report validation platform designed to assess the quality and originality of bug reports. It functions similarly to VirusTotal but for vulnerability reports, allowing anonymous users to upload reports for similarity checks against existing reports and to score them for potential AI-generated content. The platform employs a multi-axis scoring engine that combines linguistic fingerprinting, factual verification, and LLM semantic analysis, fused via Noisy-OR combination. A key feature is the auto-redaction of reports to remove PII, secrets, and identifying information before storage, ensuring user privacy. VulnRap aims to provide a robust tool for bug bounty hunters, PSIRT teams, and security researchers to efficiently triage and validate vulnerability disclosures.

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
    - Home/Submit page with drag-and-drop upload, privacy mode selection, and Analysis Options toggles (Skip AI analysis, Disable PII redaction with auto-skip-AI guardrail).
    - Analysis Results page displaying dual scores (AI Likelihood + Report Quality), confidence gauge (semicircular SVG), per-axis breakdown (Linguistic/Factual/Template/LLM), LLM radar chart (5-dimension spider chart), evidence signals with weight badges, evidence-highlighted report text with inline citations, redaction summary, similarity matches, and section-level analysis.
    - Analysis progress stepper component showing pipeline stages (Upload → Redact → Linguistic → Factual → Template/Similarity → LLM/Scoring → Triage) during submission/check.
    - Feedback Analytics dashboard (`/feedback-analytics`) with summary stats, rating distribution, score-vs-feedback correlation, outlier detection, daily trends, and recent feedback feed.
    - Batch Upload and Compare Two Reports functionalities.
    - Session History and Export/Download options.
    - Public verification page (`/verify/:id`) for sharing analysis results.
    - API documentation for developers and use case explanations.
- Supports triple input methods: file upload (.txt, .md, 5MB max), direct text paste, or URL link (GitHub, Gist, etc.).
- Utilizes generated API hooks from `@workspace/api-client-react`.

### Backend (`artifacts/api-server/`)
- **API Framework**: Express 5.
- **Database**: PostgreSQL with Drizzle ORM.
- **Auto-Redaction Engine**: Deterministic regex-based redaction of PII/secrets, applied before analysis or storage. Can be toggled via `skipRedaction` parameter (forces `skipLlm=true` to prevent unredacted data from reaching external APIs).
- **Analysis Options**: `skipLlm` and `skipRedaction` query params on POST `/reports` and `/reports/check`. Flags (`llmUsed`, `redactionApplied`) are persisted in the `breakdown` JSONB column and returned by GET `/reports/:id`.
- **Feedback Analytics**: GET `/feedback/analytics` returns aggregated stats (avg rating, helpfulness rate, rating distribution, daily trends, score-vs-feedback correlation by slop bucket, outlier reports where user feedback disagrees with engine scoring, and recent feedback entries).
- **Section Parser**: Parses reports into logical sections, hashes them with SHA-256, and classifies their value.
- **Similarity Engine**: Uses MinHash + Locality Sensitive Hashing (LSH), Simhash, and SHA-256 for near-duplicate and exact-match detection.
- **Multi-Axis Scoring Engine (v3.0)**:
    - **Axis 1 — Linguistic AI Fingerprinting** (`linguistic-analysis.ts`): Lexical markers (~50 weighted AI phrases), statistical text analysis (sentence length variance, passive voice ratio, contraction absence, bigram entropy), template detection ("dear security team", dependency dumps, OWASP padding).
    - **Axis 2 — Quality vs Slop Separation** (`sloppiness.ts`): Produces `qualityScore` (report completeness: version info, code blocks, repro steps) and heuristic `feedback` strings. Quality signals are intentionally separated from AI provenance signals.
    - **Axis 3 — Factual Verification** (`factual-verification.ts`): Severity inflation (CVSS 9.8 without RCE/auth-bypass), placeholder URLs (example.com, target.com), fabricated debug output (fake ASan addresses, GDB registers), fabricated CVE detection (sequential IDs, round numbers, unusually long IDs), hallucinated function names (generic CamelCase soup, mixed naming conventions).
    - **Axis 4 — LLM Semantic Analysis** (`llm-slop.ts`): 5-dimension evaluation: Specificity (0.15), Originality (0.25), Voice (0.20), Coherence (0.15), Hallucination (0.25). Uses Replit AI Integrations (OpenAI proxy via `AI_INTEGRATIONS_OPENAI_*` env vars, falls back to `OPENAI_*`). Cost guard: skips LLM for obvious clean/slop unless confidence < 0.5. Results cached by content hash (1hr TTL, 500 entries). Graceful null return when unavailable.
    - **Human Indicator Detection** (`human-indicators.ts`): Detects contractions, terse style, informal abbreviations (btw/fwiw/iirc), commit/PR refs, patched version refs, absence of AI pleasantries — all produce negative weights to reduce slop score for genuinely human reports.
    - **Axis 5 — Active Content Verification** (`active-verification.ts`): Project detection (GitHub/GitLab URLs, npm/PyPI packages, 40+ known OSS projects). GitHub API verification of file paths and function names referenced in reports (up to 5 checks per report, 200ms rate-limited, cached). NVD 2.0 API cross-referencing of CVE IDs with phrase-level plagiarism detection (>30% overlap flagged). PoC plausibility checking (placeholder domains + textbook payloads, fabricated HTTP responses). Verification axis score: 0-100, 50=neutral, below=human signals (verified refs), above=slop signals (missing refs, NVD plagiarism). Works without GITHUB_TOKEN (unauthenticated, lower rate limit). All API results cached by content hash (30min TTL, 500 entries).
    - **Score Fusion v2.1** (`score-fusion.ts`): Noisy-OR fusion (prior=15, floor=5, ceiling=95). Active axes (score > threshold) converted to probability, combined via 1-∏(1-p_i), mapped to 5-95 range. Fabrication boost: factual axis probability ×1.3 when fabricated_cve/hallucinated_function detected. Verified reference bonus: each verified check provides additional -3 slop reduction. Human indicator reduction applied post-fusion (floor=5). Score spread ~85pts (slop→90, legit→5).
- **PSIRT Triage Workflow** (`triage-recommendation.ts`): Automated triage recommendation engine for PSIRT teams. Decision tree: score≥75+conf≥0.7→AUTO_CLOSE, notFound≥2→CHALLENGE_REPORTER, score≥55→MANUAL_REVIEW, score≤25+verified≥2→PRIORITIZE, else STANDARD_TRIAGE. Generates challenge questions (missing_file, nvd_plagiarism, placeholder_poc, severity_inflation categories). Temporal signals detect suspiciously fast CVE turnaround (<2h=weight12, <24h=weight5). Template hash computation (normalize CVEs/URLs/versions/names→placeholders, SHA-256) for cross-report template reuse detection. Revision detection via >70% similarity to recent submissions. Exportable markdown triage report at GET `/reports/:id/triage-report`.
- **Triage Assistant** (`triage-assistant.ts`): Heuristic-driven triage assistant with 8 vulnerability class templates (XSS, SQLi, SSRF, deserialization, buffer overflow, path traversal, auth bypass, race condition). Gap analysis engine identifies missing report elements (PoC, environment, impact, version info, etc.) with severity levels. Don't-miss analysis warns about common triage blind spots. Reporter feedback generator assesses report quality signals. LLM prompt in `llm-slop.ts` produces `triage_guidance` (repro_steps, missing_info, dont_miss, reporter_feedback) in a single call alongside slop scoring (max_tokens=1500, input=6000 chars).
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
- `breakdown`: `{ linguistic, factual, template, llm, verification, quality }` per-axis scores
- `verification`: Active content verification results (`{ checks, summary, triageNotes, score, detectedProjects }`) — GitHub file/function verification, NVD CVE cross-referencing with plagiarism detection, PoC plausibility checking. Null when no verifiable references found.
- `triageRecommendation`: `{ action, reason, note, challengeQuestions, temporalSignals, templateMatch, revision }` — automated PSIRT triage action (AUTO_CLOSE/CHALLENGE_REPORTER/MANUAL_REVIEW/PRIORITIZE/STANDARD_TRIAGE). Null when not computed.
- `triageAssistant`: `{ reproGuidance, gaps, dontMiss, reporterFeedback, llmTriageGuidance }` — AI-enhanced triage assistant with heuristic reproduction guidance (8 vuln class templates: XSS, SQLi, SSRF, deserialization, buffer overflow, path traversal, auth bypass, race condition), gap analysis (missing report elements), don't-miss warnings, reporter behavior feedback, and optional LLM-generated guidance. Null when not computed.
- `evidence`: Array of `{ type, description, weight, matched }` signal objects
- `llmBreakdown`: `{ specificity, originality, voice, coherence, hallucination }` (null if LLM unavailable)
- `slopTier`: Human-readable tier (Clean ≤20 / Likely Human ≤35 / Questionable ≤55 / Likely Slop ≤75 / Slop >75)
- `humanIndicators`: Array of detected human writing indicators (contractions, informal style, commit refs, etc.)
- `feedback`: Heuristic feedback strings from rule-based engine (sourced from sloppiness.ts)

## External Dependencies

- **OpenAI-compatible API**: Used by the LLM Semantic Analysis axis. Configured via Replit AI Integrations (`AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`), falls back to `OPENAI_API_KEY`/`OPENAI_BASE_URL`. Model configurable via `OPENAI_MODEL` (defaults to `gpt-4o-mini`).
- **GitHub API**: Used by Active Content Verification for file path and code reference verification. Optional `GITHUB_TOKEN` or `GH_TOKEN` env var for higher rate limits (unauthenticated mode: 60 req/hr, authenticated: 5000 req/hr).
- **NVD API 2.0**: Used by Active Content Verification for CVE cross-referencing and description plagiarism detection. No API key required.
- **PostgreSQL**: The primary database for storing report data, hashes, and similarity results.