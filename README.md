# VulnRap

**Like VirusTotal, but for vulnerability reports.**

VulnRap is a free, anonymous vulnerability report validation platform built for PSIRT and triage teams receiving vulnerability reports. Upload an incoming report and instantly get:

- **Report Validity Scoring** — Multi-axis scoring (0-100) fusing factual verification, linguistic analysis, LLM semantic analysis, template detection, and active content verification via Noisy-OR fusion to assess whether a report describes a real, reproducible issue
- **Similarity Matching** — MinHash + LSH + SimHash fingerprinting catches near-duplicate and structurally similar submissions across the entire database
- **Section-Level Hashing** — Individual sections are hashed independently, so copied "Steps to Reproduce" blocks get flagged even when the rest differs
- **Auto-Redaction** — PII, secrets, API keys, credentials, and identifying information are stripped before anything is stored or compared

- **PSIRT Triage Workflow** — Automated triage recommendations (AUTO_CLOSE / CHALLENGE_REPORTER / MANUAL_REVIEW / PRIORITIZE), challenge questions, temporal signals, template reuse detection
- **AI Triage Assistant** — Reproduction guidance for 8 vulnerability classes, gap analysis, don't-miss warnings, and reporter behavior assessment with merged LLM + heuristic insights

Reports are auto-redacted, then compared. Nothing identifies you. No accounts required.

## Why This Exists

PSIRT teams waste hours triaging reports that turn out to describe non-existent vulnerabilities — fabricated function names, placeholder PoCs, templated content, duplicate submissions. VulnRap gives triage teams a quick validity check on incoming reports before they consume analyst time. The question isn't "was this written by AI?" — it's "does this report describe a real issue?"

Built and funded by [REMEDiS Security](https://remedissecurity.com) and [COMPLiTT](https://complitt.com).

### Why Replit

We chose to build VulnRap on [Replit](https://replit.com) because we already had several other projects running there. Having an existing workspace made it easy to get things tested and off the ground quickly — database provisioning, environment configuration, and deployment were already familiar, so we could focus on the analysis engine instead of infrastructure setup. VulnRap can be self-hosted anywhere (see [Local vs Hosted](#local-vs-hosted)), but Replit gave us the fastest path from idea to live instance.

## Live Instance

**[vulnrap.com](https://vulnrap.com)** — free to use, no signup required.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 7, Tailwind CSS 4, React Router v7 |
| UI | Radix UI + shadcn/ui |
| Data Fetching | TanStack React Query + Orval (codegen from OpenAPI) |
| API Server | Express 5, TypeScript |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod v4 |
| Security | helmet, express-rate-limit, multer |

## Architecture

```
artifacts/
  vulnrap/            React + Vite frontend
  api-server/         Express 5 API server
lib/
  db/                 Drizzle ORM schema + migrations
  api-spec/           OpenAPI 3.0 specification
  api-zod/            Generated Zod schemas (from OpenAPI)
  api-client-react/   Generated React Query hooks (from OpenAPI)
```

### Analysis Pipeline

```
Upload/Paste → Sanitize → Auto-Redact PII/Secrets
  → SHA-256 Hash (exact match)
  → MinHash + LSH (near-duplicate detection)
  → SimHash (structural similarity)
  → Section Parsing → Per-Section SHA-256 (granular matching)
  → Multi-Axis Scoring:
      Axis 1: Linguistic AI Fingerprinting (phrases, statistics, templates)
      Axis 2: Quality vs Slop Separation (completeness scoring)
      Axis 3: Factual Verification (CVEs, functions, URLs, debug output)
      Axis 4: LLM Semantic Analysis (5 dimensions + triage guidance, optional)
      Axis 5: Active Content Verification (GitHub/NVD/PoC plausibility)
      Human Indicator Detection (contractions, terse style, commit refs)
  → Score Fusion (Noisy-OR combination → slopScore + qualityScore + confidence)
  → Triage Recommendation (AUTO_CLOSE / CHALLENGE / REVIEW / PRIORITIZE)
  → Triage Assistant (repro guidance, gap analysis, don't-miss, reporter feedback)
  → Store redacted text + fingerprints (or fingerprints only in private mode)
```

### Privacy Modes

- **Share with the community** — Stores redacted text + all fingerprints. Enables duplicate detection for everyone.
- **Keep it private** — Stores only mathematical fingerprints. No text saved at all.

## Quick Start

### Automated Setup

```bash
git clone https://github.com/REMEDiSSecurity/VulnRap.Com.git
cd VulnRap.Com
./setup.sh
```

The setup script checks prerequisites, installs dependencies, configures the database, and optionally seeds example reports. It will walk you through each step.

### Manual Setup

#### Prerequisites

- Node.js 20+
- pnpm 9+
- PostgreSQL 15+ (or use `docker compose up -d` to start one)

#### Steps

```bash
# Clone and install
git clone https://github.com/REMEDiSSecurity/VulnRap.Com.git
cd VulnRap.Com
pnpm install

# Start PostgreSQL (if you don't have one running)
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL connection string

# Push schema to database
pnpm --filter @workspace/db run push

# Generate API client code from OpenAPI spec
pnpm --filter @workspace/api-spec run codegen

# Seed example vulnerability reports (optional)
pnpm --filter @workspace/api-server run seed

# Start both services
PORT=8080 pnpm --filter @workspace/api-server run dev
PORT=5173 pnpm --filter @workspace/vulnrap run dev
```

### LLM Setup (Optional)

VulnRap works without any AI API key — the linguistic, factual, and template axes are fully functional on their own. To enable the LLM semantic analysis axis for deeper detection, add to your `.env`:

```bash
OPENAI_API_KEY=sk-...
# Optional: override model (default: gpt-5-nano)
# OPENAI_MODEL=gpt-4o
# Optional: use a compatible API (Ollama, vLLM, Azure, etc.)
# OPENAI_BASE_URL=http://localhost:11434/v1
```

### Download Source

To download VulnRap as a ZIP archive without git history:

```bash
curl -L https://github.com/REMEDiSSecurity/VulnRap.Com/archive/refs/heads/main.zip -o vulnrap.zip
unzip vulnrap.zip
cd VulnRap.Com-main
./setup.sh
```

## API

All endpoints are free, anonymous, and require no authentication.

```bash
# Submit a report for analysis
curl -X POST https://vulnrap.com/api/reports \
  -F "file=@vulnerability-report.txt" \
  -F "contentMode=full"

# Check a report without storing it (read-only)
curl -X POST https://vulnrap.com/api/reports/check \
  -F "rawText=Your report content here..."

# Get results
curl https://vulnrap.com/api/reports/42

# Platform stats
curl https://vulnrap.com/api/stats
```

Full interactive API docs: [vulnrap.com/api/docs](https://vulnrap.com/api/docs) (Swagger UI)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/reports` | Submit a report for full analysis |
| `POST` | `/api/reports/check` | Analyze without storing (receiver flow) |
| `GET` | `/api/reports/:id` | Get full analysis results |
| `GET` | `/api/reports/:id/verify` | Lightweight verification badge data |
| `GET` | `/api/reports/:id/triage-report` | Exportable markdown triage report |
| `DELETE` | `/api/reports/:id` | Delete a report (requires delete token) |
| `GET` | `/api/reports/:id/compare/:matchId` | Compare two reports side by side |
| `GET` | `/api/reports/lookup/:hash` | Find report by SHA-256 content hash |
| `GET` | `/api/stats` | Platform-wide statistics |
| `POST` | `/api/feedback` | Submit user feedback |
| `GET` | `/api/healthz` | Health check |

## Pages

| Route | Purpose |
|-------|---------|
| `/` | Submit a report for analysis |
| `/results/:id` | Full analysis results with slop score, similarity, redaction summary, verification badge |
| `/check` | Receiver flow — analyze an incoming report without storing anything |
| `/verify/:id` | Public verification page for sharing with vulnerability programs |
| `/stats` | Platform statistics dashboard |
| `/developers` | API documentation and integration guide |
| `/privacy` | Privacy policy explaining what is stored and how |

## Local vs Hosted

You can run VulnRap entirely on your own infrastructure within your own PSIRT. Everything works locally — report submission, auto-redaction, slop scoring, section hashing, and the full UI.

The one thing a local instance **cannot** do is cross-reference reports submitted by other organizations. Community-wide similarity matching (detecting duplicates across different submitters) only works on the hosted instance at [vulnrap.com](https://vulnrap.com) because it requires a shared database of fingerprints. A local instance operates with its own independent database, so similarity matching only finds duplicates within your own submissions.

If your team wants both privacy and community matching, you can use the hosted instance with **Similarity-Only** privacy mode — only mathematical fingerprints are stored, no report text.

## How Slop Detection Works

Multi-axis score fusion architecture (v3.0):

### Axis 1: Linguistic AI Fingerprinting
Deterministic analysis that checks for:
- **AI filler phrases** — ~50 weighted phrases ("It is important to note," "As an AI language model," etc.)
- **Statistical text analysis** — Sentence length variance, passive voice ratio, contraction absence, bigram entropy
- **Template detection** — Bounty template headers (Vulnerability Type, Severity, CVSS Score, etc.), formal letter patterns (Dear Team / Best regards), dependency dumps, OWASP padding
- **Sycophantic phrase detection** — 32 AI-generated filler patterns (years of experience, industry tools, discovered a critical, etc.)

### Axis 2: Quality vs Slop Separation
- **qualityScore** (0-100) — Report completeness: version info, code blocks, repro steps
- **Separated from AI detection** — A terse real report can have low quality but also low slop

### Axis 3: Factual Verification
- **Severity inflation** — Critical CVSS claims (9.8) without RCE/auth-bypass evidence
- **Placeholder URLs** — example.com, target.com, and other generic domains
- **Fabricated debug output** — Fake ASan addresses, GDB register values
- **Fabricated CVEs** — Sequential IDs, round numbers, unusually long digits
- **Hallucinated function names** — Generic CamelCase compositions, mixed naming conventions, known-fake functions for curl/websocket/http3
- **Fake file paths** — References to non-existent source files in known projects (e.g. lib/header_parser.c in curl)
- **Test certificate abuse** — Reports referencing demo/test certificates as real vulnerabilities

### Axis 4: LLM Semantic Analysis (optional)
When `OPENAI_API_KEY` is configured, an LLM evaluates five weighted dimensions:
- **Specificity** (0.15) — Are version numbers, endpoints, and payloads concrete?
- **Originality** (0.25) — Unique observations vs. rehashed vulnerability descriptions?
- **Voice** (0.20) — Natural human writing vs. AI-generated prose?
- **Coherence** (0.15) — Internal consistency, reproduction steps match claims?
- **Hallucination** (0.25) — Fabricated details, invented function names, made-up CVEs?

The LLM also produces **triage guidance** (reproduction steps, missing information, don't-miss warnings, reporter feedback) in the same call.

### Axis 5: Active Content Verification
- **GitHub API verification** — Checks if referenced file paths and function names actually exist in the target repo
- **NVD 2.0 cross-referencing** — Validates CVE IDs, detects plagiarism from NVD descriptions (>30% overlap)
- **PoC plausibility** — Flags placeholder domains and textbook payloads
- **Project detection** — Recognizes 40+ known OSS projects, GitHub/GitLab URLs, npm/PyPI packages

### Human Indicator Detection
- Detects contractions, terse/informal style, informal abbreviations (btw/fwiw/iirc), commit/PR references, patched version references
- Human indicators produce negative weights that reduce slop score

### Score Fusion (Noisy-OR)
- **Noisy-OR combination**: Active axes converted to probabilities, combined via `1 − ∏(1 − pᵢ)` with prior=15, floor=5, ceiling=95
- **Fabrication boost**: Factual axis probability ×1.3 when fabricated_cve or hallucinated_function detected
- **Verified reference bonus**: Each verified check provides additional −3 slop reduction
- **Human indicator reduction**: Applied post-fusion with floor=5
- **Score spread**: ~85pts (slop→90, legit→5)

### Score Tiers
- **0-19**: Clean
- **20-39**: Likely Human
- **40-59**: Questionable
- **60-79**: Likely Slop
- **80-100**: Slop

## PSIRT Triage Workflow

### Triage Recommendations
Automated decision engine for PSIRT teams:
- **AUTO_CLOSE** — Score ≥75 + confidence ≥0.7
- **CHALLENGE_REPORTER** — 2+ references not found in live sources
- **MANUAL_REVIEW** — Score ≥55
- **PRIORITIZE** — Score ≤25 + 2+ verified references
- **STANDARD_TRIAGE** — Default

Includes challenge questions, temporal signal detection (suspiciously fast CVE turnaround), template reuse detection, and revision tracking.

### AI Triage Assistant
- **Reproduction guidance** for 8 vulnerability classes (XSS, SQLi, SSRF, deserialization, buffer overflow, path traversal, auth bypass, race condition)
- **Gap analysis** — Identifies missing elements (PoC, versions, environment, HTTP details, auth context, network position, dependency versions)
- **Don't-miss warnings** — Dependency tree, source file verification, endpoint validation, attack chain analysis, RCE verification
- **Reporter assessment** — Structured strengths, prioritized improvements, slop-specific warnings

## How Similarity Detection Works

Three complementary algorithms run on every submission:

1. **MinHash + LSH** — Locality-sensitive hashing estimates Jaccard similarity between document shingle sets. LSH bands enable fast candidate lookup without comparing against every report.
2. **SimHash** — A 64-bit structural fingerprint that captures document-level similarity. Two reports with high SimHash similarity share similar word distributions.
3. **Section-Level SHA-256** — Each parsed section gets its own hash. Even if two reports differ overall, copied sections (like identical "Steps to Reproduce" blocks) are caught individually.

## Development

```bash
# Typecheck everything
pnpm run typecheck

# Regenerate API client after changing openapi.yaml
pnpm --filter @workspace/api-spec run codegen

# Push database schema changes
pnpm --filter @workspace/db run push
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## Security

If you find a security vulnerability in VulnRap itself, please report it responsibly via the contact in [/.well-known/security.txt](https://vulnrap.com/.well-known/security.txt) rather than opening a public issue. See [SECURITY.md](https://github.com/REMEDiSSecurity/VulnRap.Com/security/policy) for details.

## License

MIT — see [LICENSE](LICENSE) for details.

Built by [REMEDiS Security](https://remedissecurity.com) and [COMPLiTT](https://complitt.com).
