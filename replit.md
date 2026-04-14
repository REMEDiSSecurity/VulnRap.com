# VulnRap.com

## Overview

VulnRap.com is a vulnerability report validation platform designed to assess the likelihood that an incoming report describes a real, reproducible issue. It functions similarly to VirusTotal but for vulnerability reports, allowing PSIRT teams to upload incoming reports for validity scoring, factual verification, and similarity detection. The platform employs a multi-axis scoring engine combining factual verification, linguistic analysis, LLM semantic analysis, and template detection, fused via Noisy-OR combination. Reports are auto-redacted to remove PII, secrets, and identifying information before storage. The core purpose is to determine if a report describes a real, valid vulnerability regardless of its origin.

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
- Built with React 19, Vite 7, and Tailwind CSS 4, utilizing a Cyberpunk glassmorphism design system.
- Provides interfaces for report submission (drag-and-drop, text paste, URL), analysis results display (dual scores, per-axis breakdown, LLM radar chart, evidence-highlighted text), progress tracking, feedback analytics, and public verification.
- Supports triple input methods: file upload (.txt, .md, 5MB max), direct text paste, or URL link.

### Backend (`artifacts/api-server/`)
- **API Framework**: Express 5 with PostgreSQL and Drizzle ORM.
- **Auto-Redaction Engine**: Deterministic regex-based redaction of PII/secrets.
- **Analysis Options**: Supports `skipLlm` and `skipRedaction` parameters.
- **Feedback Analytics**: Aggregates and analyzes user feedback on report scoring.
- **Proof-of-Work Bot Protection**: Implements SHA-256 challenges for feedback submissions.
- **Scoring Config Versioning**: Centralizes and tracks all scoring parameters.
- **Feedback-Driven Calibration Engine**: Analyzes feedback to generate and apply tuning suggestions for scoring.
- **Section Parser**: Parses reports into logical sections, hashes, and classifies them.
- **Similarity Engine**: Uses MinHash + LSH, Simhash, and SHA-256 for near-duplicate and exact-match detection.
- **Two-Axis Scoring Engine (v4.0 — Sprint 6)**:
    - **Authenticity Axis (0-100)**: Measures AI-authorship likelihood from linguistic fingerprinting, spectral text analysis, template patterns, and sycophantic phrase detection. Human indicators reduce this score.
    - **Validity Axis (0-100)**: Measures technical substance from evidence quality, hallucination detection, claim specificity, internal consistency, and factual verification.
    - **Quadrant Classification**: `AI_SLOP` (high auth, low valid → AUTO_CLOSE), `AI_ASSISTED` (high auth, high valid → PRIORITIZE_REVIEW), `WEAK_HUMAN` (low auth, low valid → REQUEST_DETAILS), `STRONG_HUMAN` (low auth, high valid → ACCEPT).
    - **Derived slopScore**: `authenticityScore × (1 - validityScore × 0.8 / 100)` — AI-ness only penalized when substance is low.
    - **New Analysis Modules**: `spectral-analysis.ts` (sentence/paragraph uniformity, hedge density), `evidence-quality.ts` (HTTP requests, code, patches, stack traces), `hallucination-detector.ts` (fabricated addresses, phantom scripts, impact escalation), `claim-specificity.ts` (named projects, CVEs, endpoints), `internal-consistency.ts` (vuln-language mismatch, CVSS inflation).
    - **Sycophantic Phrase Detection**: Compound multiplier for stacked AI pleasantries (apologies, eager responses, formal greetings).
    - **Pre-Redaction Human Indicator**: Reports with `[REDACTED]`/`[REMOVED]` placeholders are recognized as pre-redacted by the reporter, reducing slop score.
    - **Linguistic AI Fingerprinting**: Detects lexical markers, statistical text patterns, and template usage.
    - **Quality vs Slop Separation**: Assesses report completeness (`qualityScore`) distinct from AI provenance.
    - **Factual Verification**: Identifies fabricated details like severity inflation, placeholder URLs, fabricated debug output, and hallucinated function names.
    - **LLM Semantic Analysis**: Evaluates reports across 5 dimensions (Specificity, Originality, Voice, Coherence, Hallucination) and produces `reproduction_recipe` and `triage_guidance`.
    - **Human Indicator Detection**: Identifies human writing traits (contractions, informal style, commit refs, pre-redaction) to reduce slop scores.
    - **Active Content Verification**: Verifies referenced projects, file paths, function names via GitHub API, and CVEs via NVD 2.0 API, including plagiarism detection and PoC plausibility.
    - **Score Fusion v4.0**: Two-axis model computing authenticityScore and validityScore, with quadrant classification and derived slopScore for backward compatibility.
- **PSIRT Triage Workflow**: Provides automated triage recommendations (e.g., AUTO_CLOSE, CHALLENGE_REPORTER) and generates challenge questions.
- **Triage Assistant**: Offers heuristic guidance based on 8 vulnerability class templates, identifies missing report elements, and generates reporter feedback.
- **Input Sanitization**: Cleanses input by stripping scripts, sanitizing attributes, and neutralizing URIs.
- **Upload Pipeline**: Ensures reports are redacted, hashed, compared, and analyzed, storing only redacted text or hashes depending on privacy mode.
- **Privacy Modes**: `full` (stores redacted text and hashes) and `similarity_only` (stores only hashes).
- **Global Error Boundary (K1)**: Per-stage try/catch wrapping the analysis pipeline. Individual stages can fail without crashing the whole analysis. Diagnostics (inputStats, stages, parseWarnings, totalDurationMs) included in API response.
- **LLM-Free Fallback Mode (G1-G4)**: When `skipLlm=true` or LLM is unavailable, validity weights are redistributed to strongest heuristics. Confidence reduced by 15%. `analysisMode` ("heuristic_only"|"llm_enhanced") and `confidenceNote` fields in API response.
- **Config Impact Notices (M1-M2)**: `configNotices` array in API response explaining how current settings (skipLlm, skipRedaction) affect accuracy, latency, and privacy. Generated by `config-notices.ts`.
- **Key API Response Fields**: Includes `slopScore`, `qualityScore`, `confidence`, `authenticityScore`, `validityScore`, `quadrant`, `archetype`, `analysisMode`, `confidenceNote`, `configNotices`, `diagnostics`, `breakdown`, `verification` results, `triageRecommendation`, `triageAssistant`, `evidence`, `llmBreakdown`, `slopTier`, `humanIndicators`, and `feedback`.

### Core Technologies
- **Monorepo**: pnpm workspaces
- **Frontend**: React, Vite, Tailwind CSS, Radix UI, shadcn/ui
- **Backend**: Node.js, Express, PostgreSQL, Drizzle ORM
- **Data Fetching**: TanStack React Query, Orval-generated hooks
- **Validation**: Zod, drizzle-zod
- **API Codegen**: Orval (from OpenAPI spec)

## External Dependencies

- **OpenAI-compatible API**: Used for LLM Semantic Analysis, configurable via Replit AI Integrations or standard OpenAI environment variables.
- **GitHub API**: Used by Active Content Verification for file path and code reference verification.
- **NVD API 2.0**: Used by Active Content Verification for CVE cross-referencing and description plagiarism detection.
- **PostgreSQL**: The primary database for storing report data, hashes, and similarity results.

## Testing

- **Unit Tests**: 114 tests across 10 test files in `artifacts/api-server/src/lib/`, using Vitest.
  - Run: `pnpm --filter @workspace/api-server test`
  - Watch: `pnpm --filter @workspace/api-server test:watch`
  - Coverage: sanitize, redactor, human-indicators, sloppiness, section-parser, similarity, linguistic-analysis, factual-verification, score-fusion, triage-assistant