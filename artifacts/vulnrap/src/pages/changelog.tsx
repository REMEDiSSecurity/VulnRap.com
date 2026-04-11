import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Shield, Bug, Wrench, Sparkles, Lock, Trash2, Eye, Code2, Globe } from "lucide-react";

export const CURRENT_VERSION = "1.0.0";
export const RELEASE_DATE = "2026-04-11";

const CHANGELOG: ChangelogEntry[] = [
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

type SectionType = "feature" | "fix" | "security";

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
