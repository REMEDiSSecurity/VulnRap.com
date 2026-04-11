# VulnRap

**Like VirusTotal, but for vulnerability reports.**

VulnRap is a free, anonymous vulnerability report validation platform for bug bounty hunters and PSIRT teams. Upload a report and instantly get:

- **AI Slop Detection** — Heuristic scoring (0-100) that flags AI-generated filler, missing technical depth, and stylometric red flags
- **Similarity Matching** — MinHash + LSH + SimHash fingerprinting catches near-duplicate and structurally similar submissions across the entire database
- **Section-Level Hashing** — Individual sections are hashed independently, so copied "Steps to Reproduce" blocks get flagged even when the rest differs
- **Auto-Redaction** — PII, secrets, API keys, credentials, and identifying information are stripped before anything is stored or compared

Reports are auto-redacted, then compared. Nothing identifies you. No accounts required.

## Why This Exists

PSIRT teams waste hours triaging AI-generated garbage and duplicate submissions. Bug bounty hunters unknowingly submit reports that are near-identical to existing ones. VulnRap gives both sides a quick sanity check before the report enters a program's queue.

Built and funded by [REMEDiS Security](https://remedissecurity.com) and [COMPLiTT](https://complitt.com).

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
  → Sloppiness Scoring (AI phrase detection, stylometry, structure checks)
  → Store redacted text + fingerprints (or fingerprints only in private mode)
```

### Privacy Modes

- **Share with the community** — Stores redacted text + all fingerprints. Enables duplicate detection for everyone.
- **Keep it private** — Stores only mathematical fingerprints. No text saved at all.

## Quick Start

### Automated Setup

```bash
git clone https://github.com/remedisllc/vulnrap.git
cd vulnrap
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
git clone https://github.com/remedisllc/vulnrap.git
cd vulnrap
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

VulnRap works without any AI API key — heuristic scoring is fully functional on its own. To enable the LLM semantic analysis layer, add to your `.env`:

```bash
OPENAI_API_KEY=sk-...
# Optional: override model (default: gpt-4o-mini)
# OPENAI_MODEL=gpt-4o
# Optional: use a compatible API (Ollama, vLLM, Azure, etc.)
# OPENAI_BASE_URL=http://localhost:11434/v1
```

### Download Source

To download VulnRap as a ZIP archive without git history:

```bash
curl -L https://github.com/remedisllc/vulnrap/archive/refs/heads/main.zip -o vulnrap.zip
unzip vulnrap.zip
cd vulnrap-main
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
| `/verify/:id` | Public verification page for sharing with bug bounty programs |
| `/stats` | Platform statistics dashboard |
| `/developers` | API documentation and integration guide |
| `/privacy` | Privacy policy explaining what is stored and how |

## Local vs Hosted

You can run VulnRap entirely on your own infrastructure within your own PSIRT. Everything works locally — report submission, auto-redaction, slop scoring, section hashing, and the full UI.

The one thing a local instance **cannot** do is cross-reference reports submitted by other organizations. Community-wide similarity matching (detecting duplicates across different submitters) only works on the hosted instance at [vulnrap.com](https://vulnrap.com) because it requires a shared database of fingerprints. A local instance operates with its own independent database, so similarity matching only finds duplicates within your own submissions.

If your team wants both privacy and community matching, you can use the hosted instance with **Similarity-Only** privacy mode — only mathematical fingerprints are stored, no report text.

## How Slop Detection Works

Two-layer scoring architecture:

### 1. Heuristic Engine (40% of final score)
Deterministic, regex-based analysis that checks for:
- **AI filler phrases** — "It is important to note," "As an AI language model," etc.
- **Missing technical depth** — No reproduction steps, no version info, no code blocks, no attack vectors
- **Stylometric signals** — Unusually long sentences, low vocabulary diversity, walls of text
- **Structure analysis** — Reports that read like essays instead of technical documents

### 2. LLM Semantic Analyzer (60% of final score, optional)
When `OPENAI_API_KEY` is configured, an LLM evaluates five PSIRT-specific dimensions:
- **Technical Specificity** — Are version numbers, endpoints, and payloads concrete?
- **PoC Validity** — Does the proof-of-concept match the claimed vulnerability class?
- **Target Specificity** — Could this report be copy-pasted against any application?
- **Narrative Credibility** — Does it read like someone who actually tested this?
- **Template/Mass-Submission Signals** — Rigid template structure, boilerplate remediation advice?

If the LLM is unavailable, VulnRap falls back to heuristic-only scoring automatically.

### Score Tiers
- **0-14**: Probably Legit
- **15-29**: Mildly Suspicious
- **30-49**: Questionable
- **50-69**: Highly Suspicious
- **70-100**: Pure Slop

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

If you find a security vulnerability in VulnRap itself, please report it responsibly via the contact in [/.well-known/security.txt](https://vulnrap.com/.well-known/security.txt) rather than opening a public issue.

## License

MIT — see [LICENSE](LICENSE) for details.

Built by [REMEDiS Security](https://remedissecurity.com) and [COMPLiTT](https://complitt.com).
