import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Shield, Bug, Wrench, Sparkles, Lock, Trash2, Eye, Code2, Globe, Brain, Crosshair, Search, Target } from "lucide-react";

export const CURRENT_VERSION = "3.0.0";
export const RELEASE_DATE = "2026-04-12";

const CHANGELOG: ChangelogEntry[] = [
  {
    version: "3.0.0",
    date: "2026-04-12",
    label: "PSIRT Triage Engine",
    labelColor: "border-indigo-500 text-indigo-400",
    sections: [
      {
        icon: <Crosshair className="w-4 h-4 text-indigo-400" />,
        title: "AI Triage Assistant",
        type: "feature",
        items: [
          "New triage assistant panel with tabbed UI (Reproduce / Gaps / Don't Miss / Reporter Feedback) on results and check pages",
          "8 vulnerability class templates with tailored reproduction steps: XSS, SQLi, SSRF, insecure deserialization, buffer overflow, path traversal, auth bypass, and race condition",
          "Heuristic reproduction guidance enriched with LLM-suggested steps — merged into a single unified step list with source badges (heuristic vs AI)",
          "Gap analysis engine identifies missing report elements (PoC, versions, environment, repro steps, HTTP details, auth context, network position, CVSS, dependency versions, source locations) with severity levels (critical/important/minor) and audience tags (triager/reporter/both)",
          "Don't-miss warnings: always-on dependency tree reminder, source file verification, endpoint validation, attack chain evaluation, RCE claim verification, fabricated debug output, ambiguous score zone, scope creep detection",
          "Reporter behavior assessment with structured strengths, prioritized improvements, and slop-specific warnings sorted by priority",
          "Copy-to-clipboard for full markdown triage summary on both results and check pages",
          "LLM prompt expanded to produce triage_guidance (repro steps, missing info, don't-miss, reporter feedback) alongside slop scoring in a single call",
        ],
      },
      {
        icon: <Target className="w-4 h-4 text-yellow-400" />,
        title: "PSIRT Triage Recommendations",
        type: "feature",
        items: [
          "Automated triage action engine for PSIRT teams: AUTO_CLOSE, CHALLENGE_REPORTER, MANUAL_REVIEW, PRIORITIZE, or STANDARD_TRIAGE",
          "Decision tree: score ≥75 + confidence ≥0.7 → AUTO_CLOSE; 2+ not-found references → CHALLENGE_REPORTER; score ≥55 → MANUAL_REVIEW; score ≤25 + 2+ verified → PRIORITIZE",
          "Challenge question generator with 4 categories: missing_file, nvd_plagiarism, placeholder_poc, severity_inflation",
          "Temporal signal detection: suspiciously fast CVE turnaround (<2h = weight 12, <24h = weight 5)",
          "Template hash computation: normalize CVEs/URLs/versions/names → placeholders, SHA-256 hash, cross-report template reuse detection",
          "Revision detection: >70% similarity to recent submissions within 48h window, with score direction tracking (improved/degraded)",
          "Exportable markdown triage report at GET /reports/:id/triage-report with all signals",
        ],
      },
      {
        icon: <Search className="w-4 h-4 text-green-400" />,
        title: "Active Content Verification (Axis 5)",
        type: "feature",
        items: [
          "New analysis axis: real-time verification of technical claims against live sources",
          "GitHub API integration: verifies file paths and function names referenced in reports (up to 5 checks per report, 200ms rate-limited, cached)",
          "NVD 2.0 API cross-referencing: validates CVE IDs and detects phrase-level plagiarism from NVD descriptions (>30% overlap flagged)",
          "PoC plausibility checking: flags placeholder domains (example.com, target.com) and textbook payloads",
          "Project detection engine: recognizes GitHub/GitLab URLs, npm/PyPI packages, and 40+ known OSS projects",
          "Verification axis score: 0-100 (50=neutral, below=human signals from verified refs, above=slop signals from missing refs/NVD plagiarism)",
          "Works without GITHUB_TOKEN (unauthenticated: 60 req/hr; authenticated: 5,000 req/hr)",
          "All API results cached by content hash (30min TTL, 500 entries)",
        ],
      },
      {
        icon: <Sparkles className="w-4 h-4 text-cyan-400" />,
        title: "Score Fusion v2.1 — Noisy-OR",
        type: "improvement",
        items: [
          "Replaced Bayesian combination with Noisy-OR fusion: prior=15, floor=5, ceiling=95",
          "Active axes (score > threshold) converted to probability, combined via 1−∏(1−pᵢ), mapped to 5-95 range",
          "Fabrication boost: factual axis probability ×1.3 when fabricated_cve or hallucinated_function detected",
          "Verified reference bonus: each verified check provides additional −3 slop reduction",
          "New score tiers: Clean (≤20), Likely Human (≤35), Questionable (≤55), Likely Slop (≤75), Slop (>75)",
          "Score spread ~85pts (slop→90, legit→5) for better differentiation",
        ],
      },
      {
        icon: <Eye className="w-4 h-4 text-purple-400" />,
        title: "Human Indicator Detection",
        type: "feature",
        items: [
          "New human-indicators.ts module that detects genuine human writing signals",
          "Detects: contractions, terse/informal style, informal abbreviations (btw/fwiw/iirc), commit/PR references, patched version references, absence of AI pleasantries",
          "Human indicators produce negative weights that reduce slop score for genuinely human reports",
          "Displayed as a separate 'Human Signals' section on the results page",
        ],
      },
      {
        icon: <Eye className="w-4 h-4 text-primary" />,
        title: "Frontend Enhancements",
        type: "improvement",
        items: [
          "Client-side sensitivity tuning: Lenient / Balanced / Strict presets that adjust axis weights locally without changing the backend score",
          "Report comparison feature: side-by-side comparison of two reports with similarity breakdown",
          "Session history: track previously analyzed reports in the current browser session",
          "Batch upload support for analyzing multiple reports at once",
        ],
      },
      {
        icon: <Code2 className="w-4 h-4 text-orange-400" />,
        title: "API & Schema",
        type: "improvement",
        items: [
          "OpenAPI spec updated to v3.0.0 with TriageAssistant, ReproGuidance, GapItem, DontMissItem, ReporterFeedbackItem, LLMTriageGuidance, ReproStep, TriageRecommendation schemas",
          "triageAssistant and triageRecommendation fields added to POST /reports, POST /reports/check, and GET /reports/:id responses",
          "New GET /reports/:id/triage-report endpoint returns exportable markdown triage report",
          "GET /reports/:id/compare/:matchId endpoint for side-by-side report comparison",
          "DELETE /reports/:id endpoint with timing-safe token validation",
          "LLM max_tokens increased from 600→1500, input text limit from 4000→6000 chars",
          "verification, humanIndicators fields added to all report responses; templateHash included in triageRecommendation",
        ],
      },
    ],
  },
  {
    version: "2.0.0",
    date: "2026-04-12",
    label: "Multi-Axis Scoring Engine",
    labelColor: "border-violet-500 text-violet-400",
    sections: [
      {
        icon: <Brain className="w-4 h-4 text-violet-400" />,
        title: "Multi-Axis Score Fusion",
        type: "feature",
        items: [
          "Complete scoring engine overhaul: replaced the 40/60 heuristic/LLM blend with a Bayesian multi-axis fusion system",
          "Four independent scoring axes: Linguistic AI Fingerprinting (0.25), Factual Verification (0.30), LLM Semantic Analysis (0.35), Template Detection (0.10)",
          "New qualityScore (0-100) separated from slopScore — a terse real report can have low quality but also low slop",
          "Confidence indicator (0.0-1.0) reflects how much evidence was available for the score: formula min(1.0, 0.3 + evidenceCount×0.07 + 0.2 if LLM)",
          "Dynamic weight boosting: Factual axis automatically boosted to 0.50 when fabricated CVEs, hallucinated function names, future-dated CVEs, or fake debug output are detected",
          "Graceful LLM degradation: when LLM unavailable, weights redistribute to Linguistic 39%, Factual 44%, Template 17%",
          "Final slopScore formula: rawScore × confidence + 50 × (1 − confidence) — low-confidence scores regress toward 50",
        ],
      },
      {
        icon: <Bug className="w-4 h-4 text-red-400" />,
        title: "Fabrication Detection",
        type: "feature",
        items: [
          "Fabricated CVE detection: flags sequential CVE IDs, suspiciously round numbers (divisible by 1000), and unusually long ID digits",
          "Hallucinated function name detection: flags generic CamelCase compositions (ProcessDataManagerHandler) and inconsistent naming convention mixtures",
          "Both fabrication signals trigger dynamic weight boosting in the score fusion layer",
          "Evidence signals displayed with weight badges and matched text snippets on results",
        ],
      },
      {
        icon: <Sparkles className="w-4 h-4 text-cyan-400" />,
        title: "LLM Dimension Overhaul",
        type: "improvement",
        items: [
          "LLM now evaluates 5 weighted dimensions: Specificity (0.15), Originality (0.25), Voice (0.20), Coherence (0.15), Hallucination (0.25)",
          "Per-dimension scores (0-100) shown in a dedicated LLM Dimension Scores card on results",
          "Replaced legacy single-score LLM output with structured multi-dimension JSON response",
        ],
      },
      {
        icon: <Eye className="w-4 h-4 text-primary" />,
        title: "Frontend Score Display",
        type: "feature",
        items: [
          "Dual score display: AI Likelihood (slopScore) and Report Quality (qualityScore) shown side by side",
          "Confidence bar with percentage and High/Medium/Low label",
          "Axis Breakdown card: per-axis progress bars for Linguistic, Factual, Template, and LLM",
          "Evidence Signals card: lists all detected signals with weight badges, type labels, and matched text",
          "LLM Dimension Scores card: per-dimension bars for Specificity, Originality, Voice, Coherence, Hallucination",
          "Check page and Compare page updated with same scoring display",
          "TXT and JSON exports include all new scoring fields",
        ],
      },
      {
        icon: <Code2 className="w-4 h-4 text-orange-400" />,
        title: "API & Schema",
        type: "improvement",
        items: [
          "API responses now include qualityScore, confidence, breakdown (per-axis), evidence array, and llmBreakdown (per-dimension)",
          "OpenAPI spec updated with ScoreBreakdown and EvidenceItem schemas, all new fields marked as required",
          "Database schema: added quality_score, confidence, breakdown (JSONB), evidence (JSONB) columns",
          "Dead code cleanup: removed unused imports and stale interfaces across backend and frontend",
        ],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-04-11",
    label: "LLM Enhancement",
    labelColor: "border-cyan-500 text-cyan-400",
    sections: [
      {
        icon: <Brain className="w-4 h-4 text-cyan-400" />,
        title: "LLM-Enhanced Slop Detection",
        type: "feature",
        items: [
          "Two-layer scoring architecture: deterministic heuristic engine (40%) + LLM semantic analyzer (60%)",
          "LLM layer evaluates four semantic dimensions: Technical Specificity, Internal Coherence, Genericity, and Narrative Credibility",
          "LLM returns 2–4 concrete, report-specific observations shown in a dedicated 'LLM Semantic Analysis' section on results",
          "Results page shows LLM Enhanced / Heuristic badge on the score card and a side-by-side score breakdown (heuristic vs LLM raw scores)",
          "Graceful fallback: if LLM is unavailable the system runs heuristic-only and sets llmEnhanced: false with no user-visible error",
          "LLM score and observations stored in the database (llmSlopScore, llmFeedback) and returned in the GET /api/reports/:id and check endpoints",
          "Model: configurable via OPENAI_MODEL env var (default: gpt-4o-mini); works with any OpenAI-compatible API",
          "Home page 'How Slop Detection Works' card expanded to explain both layers with a dedicated LLM Semantic Analyzer section",
        ],
      },
      {
        icon: <Shield className="w-4 h-4 text-green-400" />,
        title: "Security Fixes",
        type: "fix",
        items: [
          "Fixed buffer length mismatch crash in timingSafeEqual — length is now checked before comparison to prevent RangeError",
          "user_feedback FK updated to onDelete: cascade — deleting a report now cleans up all associated feedback rows",
          "Transparency section copy corrected — no longer incorrectly states that the delete token is hashed",
        ],
      },
      {
        icon: <Code2 className="w-4 h-4 text-orange-400" />,
        title: "API & Docs",
        type: "improvement",
        items: [
          "POST /api/reports response now includes llmSlopScore, llmEnhanced, and llmFeedback fields",
          "POST /api/reports/check endpoint also returns LLM fields",
          "Developers page updated with DELETE endpoint documentation, curl example, and LLM response fields",
          "Privacy page Data Lifecycle section updated to document delete token behavior",
          "Vite dev proxy configured: /api/* forwarded to port 8080 so Playwright tests can run against frontend URL",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-04-11",
    label: "Initial Release",
    labelColor: "border-primary text-primary",
    sections: [
      {
        icon: <Sparkles className="w-4 h-4 text-primary" />,
        title: "Core Platform",
        type: "feature",
        items: [
          "Full vulnerability report analysis pipeline: auto-redaction → similarity matching → slop scoring → section hashing",
          "Triple input modes: file upload (.txt, .md, 20MB), text paste, and URL fetch (GitHub, Gist, GitLab, Pastebin, and more)",
          "Privacy modes: Full (stores redacted text + hashes) and Similarity-Only (hashes only, no text stored)",
          "Shareable results page at /results/:id with slop score, similarity matches, section hashes, and redaction summary",
          "Public verification badge page at /verify/:id — lightweight, linkable, no auth required",
          "Receiver flow at /check — run full analysis on an incoming report without storing anything",
          "Platform statistics dashboard at /stats with auto-refresh, score distribution histogram, and recent activity feed",
        ],
      },
      {
        icon: <Shield className="w-4 h-4 text-yellow-400" />,
        title: "Auto-Redaction Engine",
        type: "feature",
        items: [
          "Deterministic regex-based redaction (same input always produces identical output)",
          "Redacts: emails, IPv4/IPv6 addresses, API keys, JWTs, AWS access/secret keys, passwords, connection strings, private keys (PEM), phone numbers, SSNs, credit card numbers, UUIDs, internal hostnames and URLs, company names, usernames",
          "Runs on every upload before any hashing, comparison, or storage",
          "Returns per-category redaction counts in the analysis response",
          "Raw (pre-redaction) text never written to disk or database — exists only in process memory during analysis",
        ],
      },
      {
        icon: <Code2 className="w-4 h-4 text-cyan-400" />,
        title: "Similarity & Hashing Engine",
        type: "feature",
        items: [
          "MinHash + Locality Sensitive Hashing (LSH) for near-duplicate detection across large report sets",
          "Simhash for structural/document-level similarity fingerprinting",
          "SHA-256 content hashing for exact-match deduplication",
          "Deterministic hash coefficients seeded with SHA-256 — stable across server restarts",
          "Section parser: splits reports by markdown headers or paragraph breaks, hashes each section independently",
          "Section-level similarity matching surfaces partial overlaps (e.g., boilerplate Steps to Reproduce sections)",
          "Combined scoring with configurable thresholds returns top-N matches",
        ],
      },
      {
        icon: <Bug className="w-4 h-4 text-red-400" />,
        title: "Sloppiness (AI Detection) Scoring",
        type: "feature",
        items: [
          "Heuristic scoring engine on a 0–100 scale across five tiers: Probably Legit, Mildly Suspicious, Questionable, Highly Suspicious, Pure Slop",
          "Checks: AI-generated filler phrases, missing version/build info, missing reproduction steps, missing code blocks or commands, missing attack vector / CVE / CWE, sentence length clustering, vocabulary diversity (type-token ratio)",
          "Returns actionable feedback strings for each triggered heuristic",
          "Slop analysis intentionally runs on original (pre-redaction) text for accurate AI-pattern detection",
        ],
      },
      {
        icon: <Eye className="w-4 h-4 text-purple-400" />,
        title: "Transparency & Methodology Cards",
        type: "feature",
        items: [
          "Expandable methodology cards on the home page — each card reveals the exact regex patterns, algorithm parameters, thresholds, and slop tier scoring mapped to actual server-side code",
          "Auto-Redaction card: shows all category regex patterns",
          "Section Hashing card: shows MinHash shingle size, hash count, LSH band configuration, Simhash bit-weight algorithm",
          "Slop Detection card: shows all phrase categories, scoring weights, and tier cutoffs",
          "Transparency section on the home page: explicitly documents what runs in-browser vs server-side, what is and is not stored in PostgreSQL, and how deletion works",
        ],
      },
      {
        icon: <Trash2 className="w-4 h-4 text-orange-400" />,
        title: "Report Deletion System",
        type: "feature",
        items: [
          "Every submitted report receives a cryptographically random 64-character hex delete token (256-bit entropy via crypto.randomBytes)",
          "Delete token stored server-side; returned once at submission time and never re-exposed via GET endpoints",
          "Token stored client-side in sessionStorage — scoped to the browser session, automatically cleared when session ends",
          "Results page shows a Delete button with a confirmation dialog while the session is active",
          "DELETE /api/reports/:id endpoint validates token using timing-safe comparison (crypto.timingSafeEqual) to prevent brute-force timing attacks",
          "Length-mismatch guard prevents Node.js from throwing on buffer length differences — always returns clean 403 instead",
          "Successful deletion cascades to all associated data: report hashes, similarity results, user feedback, and redacted text",
        ],
      },
      {
        icon: <Globe className="w-4 h-4 text-green-400" />,
        title: "Platform & UI",
        type: "feature",
        items: [
          "Cyberpunk glassmorphism design system: glass cards with backdrop blur, glow text, gradient borders (static + animated), colored icon glow backgrounds, cyber grid background, gradient histogram bars",
          "Animated laser visual effects: background beams, ambient flashes, scan line — all respect prefers-reduced-motion",
          "Cursor bug animations for visual flair",
          "Custom AI-generated logo: synthetic bug inspected by lasers",
          "Hover explainer tooltips on all major UI controls",
          "Drag-and-drop file upload with visual drop zone indicator",
          "Route-level code splitting with React.lazy() and Suspense for fast initial load",
          "Full pages: Home, Results, Verify, Check, Stats, API Docs, Blog, Use Cases, Security Policy, Privacy Policy, Terms of Service, Changelog",
          "CyMeme.com listed as official alternate mirror for VulnRap.com",
        ],
      },
      {
        icon: <Lock className="w-4 h-4 text-blue-400" />,
        title: "Security & Infrastructure",
        type: "feature",
        items: [
          "Express 5 API server with helmet.js security headers, express-rate-limit, compression middleware",
          "URL submission allowlist: raw.githubusercontent.com, github.com, gist.github.com, gist.githubusercontent.com, gitlab.com, pastebin.com, dpaste.org, hastebin.com, paste.debian.net, bpa.st — HTTPS only, 5MB cap, 15s timeout, per-hop redirect validation",
          "Text paste field is plain-text only — no HTML rendering, no script execution, content auto-escaped by React",
          "Multipart file upload validation: extension, size, and content-type checks server-side; files processed in memory and never written to disk",
          "PostgreSQL with Drizzle ORM; all FK relationships include onDelete: cascade",
          "Swagger UI at /api/docs; OpenAPI spec served at /api/openapi.yaml",
          "Vite dev server proxy: /api/* forwarded to API server on port 8080 for seamless local development",
          "Structured JSON logging via pino",
        ],
      },
      {
        icon: <Wrench className="w-4 h-4 text-muted-foreground" />,
        title: "Bug Fixes",
        type: "fix",
        items: [
          "Fixed timing-safe token comparison crash: buffer length mismatch now returns 403 instead of throwing a Node.js TypeError",
          "Fixed user_feedback foreign key missing onDelete: cascade — deleting a report with feedback no longer fails with a FK constraint error",
          "Fixed OpenAPI schema including deleteToken in GET response shape — token is never returned on GET requests to prevent accidental exposure",
          "Replaced all 'bug bounty' references with inclusive 'vulnerability report/researcher/program' language across all pages",
          "Corrected transparency section text: delete token described as 'owner-initiated deletion' (not 'hashed') to match actual plaintext storage implementation",
        ],
      },
    ],
  },
];

type SectionType = "feature" | "fix" | "security" | "improvement";

interface ChangelogSection {
  icon: React.ReactNode;
  title: string;
  type: SectionType;
  items: string[];
}

interface ChangelogEntry {
  version: string;
  date: string;
  label: string;
  labelColor: string;
  sections: ChangelogSection[];
}

const TYPE_COLORS: Record<SectionType, string> = {
  feature: "text-primary",
  fix: "text-yellow-400",
  security: "text-red-400",
  improvement: "text-orange-400",
};

export default function Changelog() {
  return (
    <div className="max-w-3xl mx-auto space-y-8 py-4">
      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight glow-text">Changelog</h1>
        <p className="text-sm text-muted-foreground">
          A complete record of every feature, fix, and improvement shipped to VulnRap.
        </p>
      </div>

      {CHANGELOG.map((entry) => (
        <Card key={entry.version} className="bg-card/40 backdrop-blur border-border">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="text-xl font-mono font-bold text-primary glow-text-sm">
                v{entry.version}
              </CardTitle>
              <Badge variant="outline" className={entry.labelColor}>
                {entry.label}
              </Badge>
              <span className="text-xs text-muted-foreground font-mono ml-auto">{entry.date}</span>
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            {entry.sections.map((section, si) => (
              <div key={si}>
                {si > 0 && <Separator className="mb-6 opacity-30" />}
                <div className="flex items-center gap-2 mb-3">
                  {section.icon}
                  <h3 className={`text-sm font-bold ${TYPE_COLORS[section.type]}`}>
                    {section.title}
                  </h3>
                  <Badge
                    variant="outline"
                    className={`ml-auto text-[10px] px-1.5 py-0 h-4 ${
                      section.type === "fix"
                        ? "border-yellow-500/40 text-yellow-500/70"
                        : section.type === "security"
                          ? "border-red-500/40 text-red-500/70"
                          : "border-primary/30 text-primary/60"
                    }`}
                  >
                    {section.type === "fix" ? "fix" : section.type === "security" ? "security" : "feat"}
                  </Badge>
                </div>
                <ul className="space-y-2">
                  {section.items.map((item, ii) => (
                    <li key={ii} className="flex gap-2.5 text-sm text-muted-foreground leading-relaxed">
                      <span className={`mt-1 shrink-0 w-1.5 h-1.5 rounded-full ${
                        section.type === "fix" ? "bg-yellow-500/60" :
                        section.type === "security" ? "bg-red-500/60" :
                        "bg-primary/60"
                      }`} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <p className="text-center text-xs text-muted-foreground/40 pb-4">
        Future updates will be added here as they ship.
      </p>
    </div>
  );
}
