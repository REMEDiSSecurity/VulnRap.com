# Threat Model

## Project Overview

VulnRap.com is a public vulnerability-report validation platform. It accepts report text, files, or allow-listed URLs, runs similarity detection and multi-engine scoring, stores either redacted text or hashes depending on submission mode, and exposes public result and verification pages through a React/Vite frontend (`artifacts/vulnrap`) backed by an Express 5 API server (`artifacts/api-server`) with PostgreSQL via Drizzle.

Production-relevant external dependencies are GitHub/NVD lookups for active verification and an optional OpenAI-compatible LLM for semantic scoring. Replit provides TLS in production. `artifacts/mockup-sandbox` is treated as dev-only unless future scans prove production reachability.

## Assets

- **Submitted vulnerability reports** — report text, redacted text, hashes, section hashes, similarity links, file names, and scoring outputs. These can contain sensitive vulnerability details or internal context.
- **Derived analysis artifacts** — evidence lists, triage recommendations, diagnostics traces, AVRI/VulnRap engine results, and verification outputs. These reveal how the service classified a report and can expose internal analysis context.
- **User feedback data** — ratings, helpful/not-helpful signals, optional comments, and report associations. These may contain reviewer reasoning or additional sensitive context.
- **Calibration state** — scoring config, hand-wavy phrase list, phrase history, and reviewer metadata. Integrity matters because tampering can bias scoring; confidentiality matters where reviewer identities or live tuning data are exposed.
- **Application secrets** — database credentials, `CALIBRATION_TOKEN`, `VISITOR_HMAC_KEY`, API keys, and any provider tokens. Exposure or unsafe defaults can compromise integrity, privacy, or cost controls.
- **Service availability / spend budget** — public analysis endpoints can trigger CPU-heavy parsing, database work, outbound verification, and optional LLM calls. Abuse here can create downtime or unexpected cost.

## Trust Boundaries

- **Browser / public client → API server** — all request bodies, query params, file uploads, URLs, and IDs are attacker-controlled. The server must enforce validation, privacy, access control, and abuse limits.
- **API server → PostgreSQL** — the API has broad access to stored reports, feedback, traces, and calibration data. Any broken authorization or over-broad response shaping can expose the full corpus.
- **API server → external services** — verification requests to GitHub/NVD and optional LLM calls cross into third-party systems and consume rate-limited/costed resources.
- **Public → reviewer boundary** — most routes are intentionally public, while calibration mutations are supposed to be reviewer-only when `CALIBRATION_TOKEN` is configured. This boundary must never fail open for production-sensitive actions.
- **Public feed / share link boundary** — `showInFeed` and `contentMode` create privacy expectations for submitted reports. Public retrieval routes must honor those expectations consistently.
- **Production / dev-only boundary** — `artifacts/mockup-sandbox`, tests, fixtures, and local-only workflows are out of scope unless reachable from the production Express app or bundled frontend.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/*.ts`, frontend pages under `artifacts/vulnrap/src/pages/*` that call `/api/*`.
- **Highest-risk code areas:** `artifacts/api-server/src/routes/reports.ts`, `artifacts/api-server/src/routes/feedback.ts`, `artifacts/api-server/src/routes/calibration.ts`, `artifacts/api-server/src/lib/active-verification.ts`, `artifacts/api-server/src/lib/llm-slop.ts`, `lib/db/src/schema/reports.ts`.
- **Public surfaces:** report submission/check endpoints, report retrieval/compare/verify/diagnostics/triage endpoints, stats, feedback analytics, and calibration read endpoints.
- **Reviewer-only surfaces:** calibration mutation routes guarded by `requireCalibrationAuth`.
- **Usually ignore unless proven reachable in prod:** `artifacts/mockup-sandbox`, tests, scripts, fixtures, and migration metadata.

## Threat Categories

### Information Disclosure

This application stores vulnerability-report material that may still be sensitive even after redaction. Public result URLs, report IDs, diagnostics endpoints, similarity endpoints, feedback analytics, and calibration read APIs all risk exposing report content, corpus relationships, reviewer comments, or internal tuning state if response shaping is too broad or identifiers are guessable.

Required guarantees:
- Public report retrieval endpoints MUST enforce the intended privacy model for non-public submissions.
- Guessable identifiers MUST NOT be sufficient to enumerate sensitive report content or derived analysis.
- Public analytics endpoints MUST avoid exposing per-report or reviewer-sensitive data unless that exposure is an explicit, documented product guarantee.
- Diagnostics and verification responses MUST exclude secrets, raw identifiers, and internal-only context not needed by public users.

### Denial of Service

Public analysis endpoints accept large user-controlled inputs and can trigger PDF parsing, similarity scans, database lookups, outbound verification, and optional LLM inference. Weak or missing throttling here creates an availability and cost-amplification risk.

Required guarantees:
- Every expensive public analysis path MUST have meaningful abuse controls, not just broad global middleware.
- Request size, parsing work, external fetches, and LLM usage MUST be bounded for unauthenticated callers.
- External calls MUST have tight allow-lists and timeouts so attacker input cannot turn the service into a resource amplifier.

### Tampering

The scoring pipeline depends on configuration, phrase lists, and feedback-driven calibration. If public callers can mutate or unduly influence reviewer state, the platform’s output can be poisoned.

Required guarantees:
- Calibration and tuning mutations MUST require a server-enforced reviewer secret in production.
- Public input MUST NOT directly rewrite shared scoring state without explicit authorization.
- Stored report data and traces MUST be deleted only with an unguessable delete credential.

### Spoofing

The main privileged action in this codebase is reviewer calibration control rather than end-user accounts. If reviewer authorization is missing, weak, or optional in production, any public caller can impersonate a reviewer.

Required guarantees:
- Reviewer-only routes MUST validate a strong secret server-side before applying state changes.
- Production deployments MUST configure required secrets for privileged routes and identity-derived hashing.

### Security Misconfiguration / Secret Handling

The service behavior changes materially when environment variables are missing (`CALIBRATION_TOKEN`, `VISITOR_HMAC_KEY`, LLM keys). Missing secrets should degrade safely without exposing privileged mutation or weakening privacy guarantees.

Required guarantees:
- Production-sensitive secrets MUST fail closed where omission would expose privileged functionality.
- Optional analytics/privacy secrets MUST not silently create broader tracking or disclosure risk.
- Public CORS and headers MUST stay constrained to intended origins and methods.
