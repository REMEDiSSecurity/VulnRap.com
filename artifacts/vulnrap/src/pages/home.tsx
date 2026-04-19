import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { UploadCloud, Shield, FileText, Loader2, CheckCircle, XCircle, Search, Zap, Eye, HelpCircle, Lock, Fingerprint, ShieldCheck, Volume2, VolumeX, ClipboardPaste, Clock, ExternalLink, Info, X, Link2, ChevronDown, Play, AlertTriangle, Trash2, Mail, BrainCircuit, ShieldOff, Users } from "lucide-react";
import { LogoBeams } from "@/components/laser-effects";
import { CrawlingBugs } from "@/components/crawling-bugs";
import { useSubmitReport, SubmitReportBodyContentMode, useGetReportFeed, getGetReportFeedQueryKey, useGetVisitorStats, getGetVisitorStatsQueryKey, recordVisit } from "@workspace/api-client-react";
import { addHistoryEntry } from "@/lib/history";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn, anonymizeId } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";
import { AnalysisStepper } from "@/components/analysis-stepper";
import logoSrc from "@/assets/logo.png";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TEXT_LENGTH = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"];

function getSlopColor(score: number) {
  const s = getSettings();
  return getSlopColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function getSlopProgressColor(score: number) {
  const s = getSettings();
  return getSlopProgressColorCustom(score, s.slopThresholdLow, s.slopThresholdHigh);
}

function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

type InputMode = "file" | "text" | "link";
type UploadStage = "idle" | "uploading" | "analyzing" | "done" | "error";

function validateFile(file: File): string | null {
  const ext = file.name.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(e => ext.endsWith(e));
  if (!hasValidExt) {
    return `Unsupported file type. Accepted formats: .txt, .md, .pdf`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 5MB.`;
  }
  if (file.size === 0) {
    return "File is empty. Please select a file with content.";
  }
  return null;
}

const redactionCategories = [
  {
    label: "Personal Information",
    color: "text-red-400",
    items: [
      { what: "Email addresses", example: "user@company.com", replacement: "[REDACTED_EMAIL]" },
      { what: "Phone numbers", example: "+1 (555) 123-4567", replacement: "[REDACTED_PHONE]" },
      { what: "Social Security numbers", example: "123-45-6789", replacement: "[REDACTED_SSN]" },
      { what: "Credit card numbers", example: "4111 1111 1111 1111", replacement: "[REDACTED_CARD]" },
      { what: "Usernames & attributions", example: "reported by: jdoe", replacement: "[REDACTED_USERNAME]" },
    ],
  },
  {
    label: "Secrets & Credentials",
    color: "text-orange-400",
    items: [
      { what: "API keys & tokens", example: "api_key: sk_live_abc123...", replacement: "[REDACTED_API_KEY]" },
      { what: "Bearer tokens", example: "Bearer eyJhbG...", replacement: "Bearer [REDACTED_TOKEN]" },
      { what: "JWTs", example: "eyJhbG...eyJzdW...sig", replacement: "[REDACTED_JWT]" },
      { what: "AWS access keys", example: "AKIAIOSFODNN7...", replacement: "[REDACTED_AWS_KEY]" },
      { what: "Private keys (RSA/EC)", example: "-----BEGIN PRIVATE KEY-----", replacement: "[REDACTED_PRIVATE_KEY]" },
      { what: "Passwords", example: "password: hunter2", replacement: "[REDACTED_PASSWORD]" },
      { what: "Hex secrets", example: "secret: a1b2c3d4e5f6...", replacement: "[REDACTED_SECRET]" },
    ],
  },
  {
    label: "Infrastructure",
    color: "text-cyan-400",
    items: [
      { what: "IPv4 addresses", example: "192.168.1.100", replacement: "[REDACTED_IP]" },
      { what: "IPv6 addresses", example: "2001:0db8:85a3::8a2e", replacement: "[REDACTED_IP]" },
      { what: "Connection strings", example: "postgres://user:pass@host/db", replacement: "[REDACTED_CONNECTION_STRING]" },
      { what: "URLs with credentials", example: "https://admin:pass@host", replacement: "[REDACTED_URL_WITH_CREDS]" },
      { what: "Internal hostnames", example: "dev1.corp.internal", replacement: "[REDACTED_HOSTNAME]" },
      { what: "Internal/private URLs", example: "http://10.0.0.1:8080/admin", replacement: "[REDACTED_INTERNAL_URL]" },
      { what: "UUIDs", example: "550e8400-e29b-41d4-a716-...", replacement: "[REDACTED_UUID]" },
    ],
  },
  {
    label: "Organization",
    color: "text-purple-400",
    items: [
      { what: "Company names", example: "...at Acme Corp", replacement: "[REDACTED_COMPANY] Corp" },
    ],
  },
];

function MethodologySuggestionFooter({ topic }: { topic: string }) {
  const subject = encodeURIComponent(`Methodology Suggestion: ${topic}`);
  return (
    <div className="border-t border-border/30 pt-3 flex items-center justify-between gap-3">
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Have a better idea for how we handle <span className="text-foreground">{topic}</span>? We're always looking to improve our methodology.
      </p>
      <a
        href={`mailto:remedisllc@gmail.com?subject=${subject}`}
        className="flex-shrink-0 inline-flex items-center gap-1.5 text-[10px] text-primary/70 hover:text-primary transition-colors border border-primary/20 hover:border-primary/40 rounded-md px-2.5 py-1"
      >
        <Mail className="w-2.5 h-2.5" />
        Suggest a change
      </a>
    </div>
  );
}

function AutoRedactionCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer"
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-green flex-shrink-0">
          <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Auto-Redaction
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">PII, secrets, and company names are scrubbed from submitted reports before storage or comparison. Tap to see exactly what gets caught.</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-3 py-2 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Redaction is regex-based, not AI-powered. It catches common patterns but <strong className="text-foreground">cannot guarantee</strong> every sensitive value is removed. Unusual formats, obfuscated data, or context-dependent secrets may slip through. If a report contains highly sensitive details, consider pre-sanitizing before uploading.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {redactionCategories.map((cat) => (
              <div key={cat.label} className="space-y-2">
                <h4 className={`text-xs font-bold ${cat.color}`}>{cat.label}</h4>
                <div className="space-y-1.5">
                  {cat.items.map((item) => (
                    <div key={item.what} className="rounded-md bg-muted/30 px-2.5 py-1.5">
                      <p className="text-xs font-medium text-foreground">{item.what}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5" title={item.example}>{item.example}</p>
                      <p className="text-[10px] text-green-400/80 font-mono mt-0.5">→ {item.replacement}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border/50 pt-3">
            All patterns are applied in order. Company names are detected by suffix (Inc, Corp, LLC, Ltd, etc.). Usernames are caught in key-value pairs (<code className="text-[10px] bg-muted/50 px-1 rounded">username: jdoe</code>) and attribution lines (<code className="text-[10px] bg-muted/50 px-1 rounded">reported by: Jane</code>). Redaction happens server-side before any text is stored or compared.
          </p>
          <MethodologySuggestionFooter topic="Auto-Redaction" />
        </div>
      )}
    </div>
  );
}

const similarityMethods = [
  {
    label: "MinHash + Jaccard",
    color: "text-cyan-400",
    description: "Estimates set similarity between documents using randomized hashing.",
    details: [
      "Text is normalized (lowercased, whitespace collapsed) and split into 5-word shingles (sliding windows)",
      "Each shingle is hashed with MD5, then 128 independent hash functions produce a MinHash signature",
      "Two signatures are compared by counting matching positions — the ratio approximates Jaccard similarity",
      "Fast O(n) comparison regardless of document length",
    ],
  },
  {
    label: "SimHash",
    color: "text-blue-400",
    description: "Produces a 64-bit fingerprint that preserves structural similarity.",
    details: [
      "Each word is hashed with SHA-256, then bits are weighted (+1 or −1) across a 64-position vector",
      "Final fingerprint is the sign of each position — similar documents produce similar bit patterns",
      "Compared using Hamming distance (count of differing bits), converted to a 0–100% similarity score",
      "Good at catching structurally similar reports even when word choices differ",
    ],
  },
  {
    label: "LSH Banding",
    color: "text-green-400",
    description: "Locality-Sensitive Hashing narrows the search space before full comparison.",
    details: [
      "The 128-value MinHash signature is divided into 16 bands of 8 rows each",
      "Each band is hashed independently — if any band matches between two reports, they become candidates",
      "Candidates get full Jaccard + SimHash comparison; non-candidates are skipped entirely",
      "This makes similarity search sub-linear: we avoid comparing every report against every other report",
    ],
  },
  {
    label: "Section-Level Hashing",
    color: "text-purple-400",
    description: "Each section of your report is hashed and compared independently.",
    details: [
      "Reports are split by Markdown headers (# / ## / ### / ####), or by paragraph breaks if unstructured",
      "Each section is SHA-256 hashed after normalization — identical sections produce identical hashes",
      "Sections are weighted by type: high-value (vulnerability, PoC, impact), medium (environment, scope), or standard",
      "Detects when someone copies a specific section (e.g. the same PoC) even if the rest of the report differs",
    ],
  },
  {
    label: "Content Hash",
    color: "text-yellow-400",
    description: "SHA-256 of the full document for exact-match deduplication.",
    details: [
      "A single SHA-256 hash of the entire report text",
      "If two reports produce the same hash, they are byte-for-byte identical (after redaction)",
      "Used as a fast first-pass check before running heavier similarity algorithms",
    ],
  },
];

const matchTypes = [
  { type: "Near-duplicate", threshold: "Jaccard ≥ 80% or LSH candidate + Jaccard ≥ 60%", color: "text-red-400" },
  { type: "High-similarity", threshold: "Jaccard ≥ 50%", color: "text-orange-400" },
  { type: "Structural", threshold: "SimHash ≥ 80%", color: "text-yellow-400" },
  { type: "Semantic", threshold: "Combined ≥ 15% (catch-all)", color: "text-muted-foreground" },
];

function SectionHashingCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer"
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-cyan flex-shrink-0">
          <Fingerprint className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Section Hashing
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">Each section is hashed independently, detecting partial matches across reports your team has received. Tap to see how.</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              We use five complementary algorithms to detect similarity. No single method catches everything — combining them reduces false negatives while keeping false positives low.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {similarityMethods.map((method) => (
              <div key={method.label} className="space-y-2 rounded-lg bg-muted/20 p-3">
                <h4 className={`text-xs font-bold ${method.color}`}>{method.label}</h4>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{method.description}</p>
                <ul className="space-y-1">
                  {method.details.map((detail, i) => (
                    <li key={i} className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                      <span className={`mt-1 w-1 h-1 rounded-full ${method.color.replace("text-", "bg-")} flex-shrink-0`} />
                      {detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="border-t border-border/50 pt-3 space-y-2">
            <h4 className="text-xs font-bold text-foreground">Match Classification</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {matchTypes.map((mt) => (
                <div key={mt.type} className="rounded-md bg-muted/30 px-2.5 py-1.5">
                  <p className={`text-[11px] font-medium ${mt.color}`}>{mt.type}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{mt.threshold}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              The final similarity score is the maximum of Jaccard and SimHash scores. Only reports exceeding the 15% threshold appear in results. Top 10 matches are returned, sorted by similarity.
            </p>
          </div>
          <MethodologySuggestionFooter topic="Similarity Detection" />
        </div>
      )}
    </div>
  );
}

const authenticitySignals = [
  {
    label: "Formulaic Phrase Detection",
    color: "text-violet-400",
    description: "Scans for 30+ weighted phrases that are hallmarks of AI-generated text. Compound multipliers increase the score when multiple phrases appear together.",
    phrases: [
      "it is important to note", "delve into", "comprehensive analysis", "in today's digital landscape",
      "robust security", "multifaceted", "paramount", "holistic approach", "meticulous",
      "it's crucial to", "represents a significant", "proactive measures",
    ],
    scoring: "Each phrase has an individual weight (3–10). Multiple hits apply compound multipliers (1.0× → 1.2× → 1.5× → 2.0× → 3.0×).",
  },
  {
    label: "Template Detection",
    color: "text-cyan-400",
    description: "Detects known report templates and boilerplate structure. Contributes 35% of the Authenticity axis.",
    checks: [
      { what: "Software version", points: "+8 if missing", example: "version 2.4.1" },
      { what: "Affected component/path", points: "+8 if missing", example: "/api/auth/login" },
      { what: "Reproduction steps", points: "+10 if missing", example: "Steps to reproduce" },
      { what: "Code blocks or PoC", points: "+5 if missing", example: "```curl ...```" },
      { what: "Attack vector / CVE / CWE", points: "+5 if missing", example: "CWE-79, network" },
      { what: "Impact assessment", points: "+5 if missing", example: "severity: high" },
      { what: "Expected vs. observed behavior", points: "+5 if missing", example: "should return 403" },
    ],
  },
  {
    label: "Spectral & Statistical Analysis",
    color: "text-orange-400",
    description: "Analyzes text entropy, periodicity, sentence structure, and vocabulary diversity. Contributes 25% of the Authenticity axis.",
    checks: [
      { what: "Report length", points: "<30 words: +25, <100: +10, >5000: +10", example: "Extremely short or padded" },
      { what: "Average sentence length", points: "+8 if avg >30 words/sentence", example: "AI tends to write long sentences" },
      { what: "Vocabulary diversity", points: "+10 if unique ratio <30%", example: "Repetitive, low-diversity language" },
      { what: "Text entropy & periodicity", points: "Spectral analysis of character patterns", example: "AI text is more uniform" },
    ],
  },
];

const llmSubstanceDimensions = [
  {
    label: "PoC Validity (pocValidity)",
    description: "Does the proof-of-concept actually exercise the claimed vulnerability? Does it target the right library, use realistic inputs, and produce the described outcome?",
    example: "A real curl command hitting the vulnerable endpoint vs. a generic template with placeholder URLs",
  },
  {
    label: "Claim Specificity (claimSpecificity)",
    description: "Are version numbers, file paths, endpoints, and payloads concrete and internally consistent, or vague placeholders?",
    example: "\"/api/v2/users/profile\" with version 2.4.1 vs. \"the API endpoint\"",
  },
  {
    label: "Domain Coherence (domainCoherence)",
    description: "Does the reporter understand what the project actually does? Do the claimed vulnerabilities make sense for this type of software?",
    example: "Claiming SSRF in a client-side UI library, or SQLi in a project that doesn't use a database",
  },
  {
    label: "Substance Score (substanceScore)",
    description: "Overall technical depth — does the report contain real evidence, original analysis, and actionable details? Or is it generic padding?",
    example: "Specific error messages and stack traces vs. textbook vulnerability definitions",
  },
  {
    label: "Coherence Score (coherenceScore)",
    description: "Is the report internally consistent? Do reproduction steps match claims? Does the narrative flow logically without contradictions?",
    example: "SQLi claim matched with SQLi payload vs. an XSS payload paired with a SQLi description",
  },
];

const slopTiers = [
  { tier: "Clean", range: "0–19", color: "text-green-500", bg: "bg-green-500/10" },
  { tier: "Likely Human", range: "20–39", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  { tier: "Questionable", range: "40–59", color: "text-yellow-500", bg: "bg-yellow-500/10" },
  { tier: "Likely Slop", range: "60–79", color: "text-orange-500", bg: "bg-orange-500/10" },
  { tier: "Slop", range: "80–100", color: "text-destructive", bg: "bg-destructive/10" },
];

function SlopDetectionCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer"
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-violet flex-shrink-0">
          <Eye className="w-4 h-4 sm:w-5 sm:h-5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Validity Scoring
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">Two-axis scoring: Authenticity measures AI-authorship patterns, Validity measures technical substance. Combined into a single slopScore with quadrant classification. Tap to see how.</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">

          <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2.5 space-y-1">
            <p className="text-[11px] font-bold text-violet-300 uppercase tracking-wide">Two-Axis Scoring (v4.0)</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every report is scored on two independent axes: <span className="text-foreground font-mono">Authenticity (0–100)</span> measures AI-authorship likelihood from linguistic fingerprinting, spectral analysis, and template detection. <span className="text-foreground font-mono">Validity (0–100)</span> measures technical substance from evidence quality, hallucination detection, claim specificity, internal consistency, and factual verification. The final slopScore is derived as <span className="text-foreground font-mono">authenticity × 0.65 + (100 − validity) × 0.35</span>. Reports are classified into quadrants: AI Slop (high auth, low validity → auto-close), AI Assisted (high auth, high validity → prioritize review), Weak Human (low auth, low validity → request details), Strong Human (low auth, high validity → accept). Fabrication evidence (fake CVEs, hallucinated functions) triggers a 1.3× boost. Verified references reduce the score. Human-writing signals (contractions, terse style, commit refs) reduce authenticity post-fusion.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400/60" />
              Authenticity Axis — AI surface patterns (deterministic)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Three components feed the authenticity score: <span className="font-mono text-violet-300">Linguistic (40%)</span> = lexical 60% + statistical 40%, <span className="font-mono text-cyan-300">Template (35%)</span>, <span className="font-mono text-orange-300">Spectral (25%)</span>. If both linguistic and template scores are high, a compound boost of up to 15 points is applied.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {authenticitySignals.map((signal) => (
                <div key={signal.label} className="space-y-2 rounded-lg bg-muted/20 p-3">
                  <h4 className={`text-xs font-bold ${signal.color}`}>{signal.label}</h4>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{signal.description}</p>
                  {"phrases" in signal && (
                    <>
                      <div className="flex flex-wrap gap-1">
                        {(signal as { phrases: string[] }).phrases.map((phrase) => (
                          <span key={phrase} className="text-[9px] bg-violet-500/10 text-violet-300 px-1.5 py-0.5 rounded font-mono">
                            {phrase}
                          </span>
                        ))}
                        <span className="text-[9px] text-muted-foreground px-1.5 py-0.5">+18 more...</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">{(signal as { scoring: string }).scoring}</p>
                    </>
                  )}
                  {"checks" in signal && (
                    <div className="space-y-1">
                      {(signal as { checks: { what: string; points: string; example: string }[] }).checks.map((check) => (
                        <div key={check.what} className="rounded-md bg-muted/30 px-2 py-1">
                          <div className="flex justify-between items-baseline gap-2">
                            <span className="text-[10px] font-medium text-foreground">{check.what}</span>
                            <span className="text-[9px] text-orange-400/80 font-mono whitespace-nowrap">{check.points}</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground mt-0.5">{check.example}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2 border-t border-border/30 pt-4">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
              Validity Axis — technical substance
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Six heuristic components feed the validity score: <span className="font-mono text-cyan-300">Evidence Quality (25%) + Hallucination (20%) + Claim Specificity (20%) + Internal Consistency (15%) + Factual (10%) + Verification (10%)</span>. When LLM analysis is enabled, heuristic and LLM validity scores are blended 50/50. If they disagree by more than 30 points, the lower (more conservative) score is used.
            </p>
          </div>

          <div className="space-y-2 border-t border-border/30 pt-4">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
              LLM Substance Analysis (optional)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              The LLM evaluates reports from a PSIRT triage perspective across five substance dimensions that regex cannot assess. It returns per-dimension 0–100 scores plus concrete observations. LLM substance scores also feed back into the authenticity axis — low PoC validity or domain coherence increases the authenticity score, while high scores reduce it.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {llmSubstanceDimensions.map((dim) => (
                <div key={dim.label} className="rounded-lg bg-cyan-500/5 border border-cyan-500/10 p-3 space-y-1">
                  <p className="text-[11px] font-bold text-cyan-300">{dim.label}</p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{dim.description}</p>
                  <p className="text-[10px] text-muted-foreground/60 italic">e.g. {dim.example}</p>
                </div>
              ))}
            </div>
            <div className="rounded-md bg-muted/20 px-3 py-2 mt-1">
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                <span className="text-foreground font-medium">LLM → Validity fusion:</span> The LLM's <span className="font-mono text-cyan-400">validityScore</span> is adjusted by <span className="font-mono text-cyan-400">substanceScore</span> and <span className="font-mono text-cyan-400">coherenceScore</span> modifiers, then blended 50/50 with the heuristic validity score. Per-dimension scores are shown on the results page.
              </p>
            </div>
          </div>

          <div className="border-t border-border/50 pt-3 space-y-2">
            <h4 className="text-xs font-bold text-foreground">Score Tiers</h4>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {slopTiers.map((t) => (
                <div key={t.tier} className={`rounded-md ${t.bg} px-2.5 py-1.5 text-center`}>
                  <p className={`text-[11px] font-bold ${t.color}`}>{t.tier}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t.range}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Neither layer alone is definitive. A high score means the report has characteristics commonly seen in AI-generated text — it does not prove the report was AI-written. A low score means the report looks human-written, not that the vulnerability is real or valid.
            </p>
          </div>
          <MethodologySuggestionFooter topic="Slop Detection" />
        </div>
      )}
    </div>
  );
}

function VideoSection() {
  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-2xl mx-auto w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl glass-card hover:bg-primary/5 transition-colors group"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">
          <Play className="w-4 h-4" />
          Watch the rap sheet
          <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-primary/20 text-primary border border-primary/30 animate-pulse">New</span>
        </span>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded-xl glass-card-accent overflow-hidden">
            <video
              className="w-full"
              controls
              playsInline
              autoPlay
              preload="metadata"
            >
              <source src={`${import.meta.env.BASE_URL}vulnrap-rap-sheet.mov`} type="video/quicktime" />
              <source src={`${import.meta.env.BASE_URL}vulnrap-rap-sheet.mov`} type="video/mp4" />
              Your browser does not support video playback.
            </video>
          </div>
          <p className="text-center text-[10px] text-muted-foreground/50">
            Looking for our{" "}
            <a
              href={`${import.meta.env.BASE_URL}vulnrap-intro.mp4`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/60 hover:text-primary hover:underline transition-colors"
            >
              previous rap video
            </a>
            ?
          </p>
        </div>
      )}
    </div>
  );
}

function Explainer({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
      <TooltipTrigger
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label="More info"
        className="inline-flex ml-1 cursor-help"
      >
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="center"
        collisionPadding={12}
        className="w-56 bg-popover border border-border text-popover-foreground shadow-lg text-left font-normal normal-case px-3 py-2 whitespace-normal"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<SubmitReportBodyContentMode>(SubmitReportBodyContentMode.full);
  const [showInFeed, setShowInFeed] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [skipLlm, setSkipLlm] = useState(false);
  const [skipRedaction, setSkipRedaction] = useState(false);
  const logoRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = logoRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const cy = rect.top + rect.height / 2;
      document.documentElement.style.setProperty("--beam-origin-y", `${cy}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--beam-origin-y");
    };
  }, []);

  const submitMutation = useSubmitReport({
    mutation: {
      onMutate: () => {
        setStage("uploading");
        setTimeout(() => setStage((prev) => prev === "uploading" ? "analyzing" : prev), 800);
      },
      onSuccess: (data) => {
        setStage("done");
        if (data.deleteToken) {
          try {
            const tokens = JSON.parse(sessionStorage.getItem("vulnrap_delete_tokens") || "{}");
            tokens[data.id] = data.deleteToken;
            sessionStorage.setItem("vulnrap_delete_tokens", JSON.stringify(tokens));
          } catch {}
        }
        addHistoryEntry({
          id: data.id,
          reportCode: anonymizeId(data.id),
          slopScore: data.slopScore,
          slopTier: data.slopTier,
          matchCount: data.similarityMatches?.length || 0,
          contentMode: data.contentMode,
          fileName: data.fileName || null,
          timestamp: new Date().toISOString(),
          type: "submit",
        });
        toast({ title: "Analysis complete", description: "Navigating to results..." });
        setTimeout(() => navigate(`/results/${data.id}`), 600);
      },
      onError: (err: unknown) => {
        setStage("error");
        let message = "An error occurred during analysis.";
        if (err && typeof err === "object") {
          const e = err as Record<string, unknown>;
          if ("data" in e && e.data && typeof e.data === "object" && "error" in (e.data as Record<string, unknown>)) {
            message = String((e.data as Record<string, unknown>).error);
          } else if ("message" in e && typeof e.message === "string") {
            message = e.message;
          } else if ("error" in e) {
            message = String(e.error);
          }
        }
        toast({
          title: "Upload failed",
          description: message,
          variant: "destructive"
        });
      }
    }
  });

  const handleFileSelect = (selectedFile: File) => {
    const error = validateFile(selectedFile);
    if (error) {
      setFile(null);
      setFileError(error);
      toast({ title: "Invalid file", description: error, variant: "destructive" });
      return;
    }
    setFile(selectedFile);
    setFileError(null);
    setStage("idle");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleSubmit = () => {
    const feedVal = (mode === "full" && showInFeed) ? "true" : "false";
    if (inputMode === "file") {
      if (!file) {
        toast({ title: "No file selected", description: "Please select a report file first.", variant: "destructive" });
        return;
      }
      const error = validateFile(file);
      if (error) {
        setFileError(error);
        toast({ title: "Invalid file", description: error, variant: "destructive" });
        return;
      }
      submitMutation.mutate({ data: { file, contentMode: mode, showInFeed: feedVal, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } });
    } else if (inputMode === "link") {
      const trimmedUrl = reportUrl.trim();
      if (!trimmedUrl) {
        toast({ title: "No URL entered", description: "Please enter a link to a report.", variant: "destructive" });
        return;
      }
      try { new URL(trimmedUrl); } catch {
        toast({ title: "Invalid URL", description: "Please enter a valid HTTPS URL.", variant: "destructive" });
        return;
      }
      submitMutation.mutate({ data: { reportUrl: trimmedUrl, contentMode: mode, showInFeed: feedVal, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } });
    } else {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        toast({ title: "No text entered", description: "Please paste your report text first.", variant: "destructive" });
        return;
      }
      if (new Blob([trimmed]).size > MAX_TEXT_LENGTH) {
        toast({ title: "Text too large", description: "Pasted text exceeds the 5MB limit.", variant: "destructive" });
        return;
      }
      submitMutation.mutate({ data: { rawText: trimmed, contentMode: mode, showInFeed: feedVal, skipLlm: skipLlm ? "true" : "false", skipRedaction: skipRedaction ? "true" : "false" } });
    }
  };

  const hasContent = inputMode === "file" ? !!file : inputMode === "link" ? reportUrl.trim().length > 0 : rawText.trim().length > 0;
  const isProcessing = stage === "uploading" || stage === "analyzing" || stage === "done";

  const getButtonContent = () => {
    switch (stage) {
      case "uploading":
        return <><Loader2 className="w-5 h-5 animate-spin" /> Uploading...</>;
      case "analyzing":
        return <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing report...</>;
      case "done":
        return <><CheckCircle className="w-5 h-5" /> Complete</>;
      case "error":
        return <><XCircle className="w-5 h-5" /> Failed - Try Again</>;
      default:
        return "Analyze Report";
    }
  };

  const [mirrorBannerDismissed, setMirrorBannerDismissed] = useState(() => {
    try { return sessionStorage.getItem("vulnrap-mirror-dismissed") === "1"; } catch { return false; }
  });

  const dismissMirrorBanner = () => {
    setMirrorBannerDismissed(true);
    try { sessionStorage.setItem("vulnrap-mirror-dismissed", "1"); } catch {}
  };

  useEffect(() => {
    if (mirrorBannerDismissed) return;
    const timer = setTimeout(dismissMirrorBanner, 13370);
    return () => clearTimeout(timer);
  }, [mirrorBannerDismissed]);

  return (
    <div className="max-w-4xl mx-auto space-y-8 sm:space-y-10">
      <CrawlingBugs />
      {!mirrorBannerDismissed && (
        <div className="relative mt-2 sm:mt-4 mx-auto max-w-3xl rounded-lg border border-primary/20 bg-primary/5 backdrop-blur-sm px-3 sm:px-4 py-3 flex items-start gap-2.5 sm:gap-3 text-sm">
          <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 text-muted-foreground leading-relaxed text-xs sm:text-sm">
            <span className="text-primary font-semibold">CyMeme.com</span> is the official alternate mirror for{" "}
            <a href="https://vulnrap.com" className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors font-medium">VulnRap.com</a>.
            {" "}Many enterprise networks block newly registered domains — if you can't reach VulnRap.com directly, you're in the right place.
          </div>
          <button
            onClick={dismissMirrorBanner}
            className="shrink-0 text-muted-foreground/60 hover:text-primary transition-colors p-0.5 rounded"
            aria-label="Dismiss notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="space-y-4 sm:space-y-6 text-center pt-4 sm:pt-6">
        <div className="relative flex justify-center">
          <div className="relative">
            <LogoBeams />
            <div className="absolute inset-0 rounded-xl bg-primary/10 blur-3xl scale-150 z-0" />
            <img ref={logoRef} src={logoSrc} alt="VulnRap" className="relative z-10 w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-xl logo-glow gradient-border" />
          </div>
        </div>
        <h1 className="text-3xl sm:text-4xl md:text-6xl font-bold tracking-tight text-primary uppercase glow-text" data-testid="text-heading">Report Validation</h1>
        <p className="text-sm sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed px-2">
          Assess the likelihood that an incoming vulnerability report describes a real, reproducible issue. Cross-check claims against live sources, detect duplicate submissions, and surface what deserves analyst time. Built for PSIRT teams, triage analysts, and anyone buried in an inbox full of incoming reports.
        </p>
      </div>

      <VideoSection />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <AutoRedactionCard />
        <SectionHashingCard />
        <SlopDetectionCard />
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-primary" />
            Submit Report
            <Explainer text="Submit a vulnerability report for analysis. Upload a file or paste your report text directly. We'll verify factual claims, check it against previously submitted reports, and score the likelihood the issue is real and reproducible." />
          </CardTitle>
          <CardDescription>Upload a file, paste text, or link to a report (Max 5MB)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 sm:space-y-8">
          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-3 sm:px-4 py-2.5 sm:py-3 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-yellow-500">Heads up:</strong> We try to auto-redact PII, secrets, credentials, and company names before storing or comparing your report. If your report contains sensitive details, pre-sanitize those sections yourself before uploading.
          </div>
          <div className="flex rounded-xl overflow-hidden glass-card">
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all",
                inputMode === "file"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => { setInputMode("file"); setStage("idle"); }}
              data-testid="tab-file"
            >
              <UploadCloud className="w-4 h-4 shrink-0" />
              <span className="hidden xs:inline">Upload</span> File
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "text"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => { setInputMode("text"); setStage("idle"); }}
              data-testid="tab-text"
            >
              <ClipboardPaste className="w-4 h-4 shrink-0" />
              Paste
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 text-xs sm:text-sm font-medium transition-all border-l border-border/30",
                inputMode === "link"
                  ? "bg-primary text-primary-foreground glow-button"
                  : "hover:bg-muted/30 text-muted-foreground"
              )}
              onClick={() => { setInputMode("link"); setStage("idle"); }}
              data-testid="tab-link"
            >
              <Link2 className="w-4 h-4 shrink-0" />
              Link
            </button>
          </div>

          {inputMode === "file" ? (
          <div
            data-testid="dropzone"
            className={cn(
              "border-2 border-dashed rounded-xl p-6 sm:p-10 md:p-12 flex flex-col items-center justify-center gap-3 sm:gap-4 transition-all cursor-pointer",
              isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/20 hover:border-primary/40",
              file && !fileError ? "border-primary/40 bg-primary/5" : "",
              fileError ? "border-destructive bg-destructive/5" : ""
            )}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".txt,.md"
              onChange={handleFileChange}
              data-testid="input-file"
            />
            {fileError ? (
              <>
                <div className="p-4 rounded-full bg-destructive/10">
                  <XCircle className="w-8 h-8 text-destructive" />
                </div>
                <div className="text-center">
                  <p className="font-medium text-destructive">{fileError}</p>
                  <p className="text-sm text-muted-foreground mt-1">Click to select a different file</p>
                </div>
              </>
            ) : file ? (
              <>
                <FileText className="w-12 h-12 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-lg" data-testid="text-filename">{file.name}</p>
                  <p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); setFileError(null); setStage("idle"); }} className="mt-2" data-testid="button-clear">
                  Clear Selection
                </Button>
              </>
            ) : (
              <>
                <div className="p-4 rounded-full bg-muted">
                  <UploadCloud className="w-8 h-8 text-muted-foreground" />
                </div>
                <div className="text-center">
                  <p className="font-medium">Drag & drop your report here</p>
                  <p className="text-sm text-muted-foreground mt-1">or click to browse files (.txt, .md)</p>
                </div>
              </>
            )}
          </div>
          ) : inputMode === "text" ? (
          <div className="space-y-2">
            <textarea
              data-testid="input-rawtext"
              className="w-full h-64 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
              placeholder="Paste your vulnerability report text here...&#10;&#10;This field accepts plain text only. All content is treated as text -- no HTML, markdown rendering, or code execution."
              value={rawText}
              onChange={(e) => { setRawText(e.target.value); setStage("idle"); }}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="flex justify-between items-center text-xs text-muted-foreground">
              <span>{rawText.length > 0 ? `${rawText.length.toLocaleString()} characters` : "No text entered"}</span>
              {rawText.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  onClick={() => { setRawText(""); setStage("idle"); }}
                  data-testid="button-clear-text"
                >
                  Clear text
                </button>
              )}
            </div>
          </div>
          ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <input
                type="url"
                data-testid="input-url"
                className="w-full rounded-xl glass-card px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
                placeholder="https://github.com/user/repo/blob/main/report.md"
                value={reportUrl}
                onChange={(e) => { setReportUrl(e.target.value); setStage("idle"); }}
                spellCheck={false}
                autoComplete="off"
              />
              {reportUrl.trim().length > 0 && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                    onClick={() => { setReportUrl(""); setStage("idle"); }}
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
            <div className="rounded-lg bg-muted/30 px-4 py-3 text-xs text-muted-foreground leading-relaxed space-y-1.5">
              <p className="font-medium text-foreground/80">Supported sources:</p>
              <p>GitHub (blob URLs auto-converted to raw), GitHub Gists, GitLab, Pastebin, dpaste, hastebin, paste.debian.net</p>
              <p>HTTPS only — max 5MB. The URL must point to plain text, not an HTML page.</p>
            </div>
          </div>
          )}

          <div className="space-y-4">
            <h3 className="font-medium flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              How should we handle your report?
            </h3>
            <RadioGroup value={mode} onValueChange={(v) => { setMode(v as SubmitReportBodyContentMode); if (v === "similarity_only") setShowInFeed(false); }} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "full" ? "border-primary bg-primary/5" : "border-border")} onClick={() => setMode(SubmitReportBodyContentMode.full)}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.full} id="full" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="full" className="font-bold cursor-pointer">Share with the community</Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">We understand that the only way this works is with trust — and data in the form of reports that can be compared. Your report (with PII and secrets auto-removed) is saved and helps the entire community detect duplicates and AI slop. If you'd be willing to gift us some training data — rejected AI slop, or examples of what you look for in a valid report — the community as a whole benefits. Please <a href="mailto:remedisllc@gmail.com" className="text-primary hover:underline">reach out</a> if you can!</p>
                  </div>
                </div>
                {mode === "full" && (
                  <label className="flex items-center gap-2 mt-3 ml-7 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={showInFeed}
                      onChange={(e) => setShowInFeed(e.target.checked)}
                      className="rounded border-border accent-primary w-4 h-4"
                    />
                    <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">Show in the recent reports feed on this site</span>
                  </label>
                )}
              </div>
              <div className={cn("border rounded-lg p-4 cursor-pointer hover:border-primary/50 transition-colors", mode === "similarity_only" ? "border-primary bg-primary/5" : "border-border")} onClick={() => { setMode(SubmitReportBodyContentMode.similarity_only); setShowInFeed(false); }}>
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={SubmitReportBodyContentMode.similarity_only} id="similarity_only" className="mt-1" />
                  <div className="space-y-1">
                    <Label htmlFor="similarity_only" className="font-bold cursor-pointer">Keep it private</Label>
                    <p className="text-xs text-muted-foreground leading-relaxed">We only store a mathematical fingerprint of your report -- no text is saved at all. Use this for sensitive zero-days you want to keep confidential.</p>
                  </div>
                </div>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-3">
            <h3 className="font-medium flex items-center gap-2 text-sm">
              <Zap className="w-4 h-4 text-primary" />
              Analysis Options
              <Explainer text="Control what happens during analysis. By default, both AI analysis and PII redaction are enabled." />
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className={`flex items-start gap-3 p-3 rounded-lg border border-border transition-colors ${skipRedaction ? "opacity-60 cursor-not-allowed" : "hover:border-primary/30 cursor-pointer"} group`}>
                <input
                  type="checkbox"
                  checked={skipLlm}
                  onChange={(e) => setSkipLlm(e.target.checked)}
                  disabled={skipRedaction}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-llm"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <BrainCircuit className="w-3.5 h-3.5" />
                    Skip AI analysis
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {skipRedaction
                      ? "Locked on — AI analysis is disabled when PII redaction is off."
                      : "Disable LLM calls — analysis uses only local heuristic and statistical scoring. No report data is sent to any external AI provider."}
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/30 transition-colors cursor-pointer group">
                <input
                  type="checkbox"
                  checked={skipRedaction}
                  onChange={(e) => { setSkipRedaction(e.target.checked); if (e.target.checked) setSkipLlm(true); }}
                  className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                  data-testid="toggle-skip-redaction"
                />
                <div className="space-y-1">
                  <span className="text-xs font-medium text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                    <ShieldOff className="w-3.5 h-3.5" />
                    Disable PII redaction
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Skip PII auto-redaction. Report text will not be sanitized for personally identifiable information. AI analysis is automatically disabled when redaction is off to prevent unredacted data from reaching external services.
                  </p>
                </div>
              </label>
            </div>
            {skipRedaction && (
              <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 px-3 py-2 flex items-start gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                <AlertTriangle className="w-3.5 h-3.5 text-orange-500 mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-orange-300 leading-relaxed">
                  <strong>Warning:</strong> Only use for known slop submissions or local deployments. PII, secrets, and company names in your report will <strong>not</strong> be removed before storage or comparison.
                </p>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 px-4 sm:px-6">
          <Button
            className="w-full h-11 sm:h-12 text-base sm:text-lg font-bold gap-2 glow-button"
            onClick={handleSubmit}
            disabled={!hasContent || isProcessing || !!fileError}
            data-testid="button-submit"
          >
            {getButtonContent()}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Free and anonymous. No account required. <Link to="/privacy" className="text-primary hover:underline">Read our privacy policy</Link> to learn exactly what we store.
          </p>
        </CardFooter>
      </Card>

      <AnalysisStepper isActive={isProcessing && stage !== "done"} mode="submit" className="my-4" />

      <div className="glass-card rounded-xl p-4 sm:p-6 space-y-4 sm:space-y-5">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          How It Works
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <div className="space-y-1.5 sm:space-y-2 p-3 sm:p-4 rounded-xl glass-card feature-card">
            <div className="text-2xl sm:text-3xl font-bold step-number">01</div>
            <h3 className="font-medium text-xs sm:text-sm">Submit</h3>
            <p className="text-[11px] sm:text-xs text-muted-foreground leading-relaxed">
              Upload a file, paste text, or link a URL. We begin processing immediately.
            </p>
          </div>
          <div className="space-y-1.5 sm:space-y-2 p-3 sm:p-4 rounded-xl glass-card feature-card">
            <div className="text-2xl sm:text-3xl font-bold step-number">02</div>
            <h3 className="font-medium text-xs sm:text-sm">Auto-Redact</h3>
            <p className="text-[11px] sm:text-xs text-muted-foreground leading-relaxed">
              PII, secrets, and company names are scrubbed automatically before anything is stored.
            </p>
          </div>
          <div className="space-y-1.5 sm:space-y-2 p-3 sm:p-4 rounded-xl glass-card feature-card">
            <div className="text-2xl sm:text-3xl font-bold step-number">03</div>
            <h3 className="font-medium text-xs sm:text-sm">Analyze</h3>
            <p className="text-[11px] sm:text-xs text-muted-foreground leading-relaxed">
              Claims are verified against live sources, sections are compared for duplicates, and the report is scored for validity.
            </p>
          </div>
          <div className="space-y-1.5 sm:space-y-2 p-3 sm:p-4 rounded-xl glass-card feature-card">
            <div className="text-2xl sm:text-3xl font-bold step-number">04</div>
            <h3 className="font-medium text-xs sm:text-sm">Results</h3>
            <p className="text-[11px] sm:text-xs text-muted-foreground leading-relaxed">
              Get a validity score, similarity matches, verification results, triage recommendation, and redaction summary.
            </p>
          </div>
        </div>
      </div>

      <TransparencySection />

      <RecentReportsFeed />

      <VisitorCounter />
    </div>
  );
}

function VisitorCounter() {
  const { data: visitors } = useGetVisitorStats({
    query: { queryKey: getGetVisitorStatsQueryKey(), refetchInterval: 120_000 },
  });

  useEffect(() => {
    const key = "vulnrap_visit_recorded";
    const today = new Date().toISOString().slice(0, 10);
    if (sessionStorage.getItem(key) !== today) {
      recordVisit().then(() => sessionStorage.setItem(key, today)).catch(() => {});
    }
  }, []);

  if (!visitors || visitors.totalUniqueVisitors === 0) return null;

  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground/50 py-2">
      <Users className="w-3.5 h-3.5" />
      <span>
        <span className="font-mono font-medium text-muted-foreground/70">{visitors.totalUniqueVisitors.toLocaleString()}</span>
        {" "}unique visitors
      </span>
    </div>
  );
}

function TransparencySection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 sm:p-6 flex items-center justify-between text-left cursor-pointer"
      >
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Lock className="w-5 h-5 text-primary" />
          Transparency: Where Your Data Goes
        </h2>
        <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-cyan-500/5 border border-cyan-500/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
                <Shield className="w-4 h-4" />
                What Happens in Your Browser
              </h3>
              <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2"><span className="text-cyan-400 mt-0.5">1.</span>You select a file, paste text, or enter a URL — your raw content stays in your browser until you hit Submit.</li>
                <li className="flex gap-2"><span className="text-cyan-400 mt-0.5">2.</span>File type validation (.txt, .md, .pdf) and size checks (5MB max) run entirely in the browser.</li>
                <li className="flex gap-2"><span className="text-cyan-400 mt-0.5">3.</span>No content is sent to our server until you explicitly submit. There is no background upload, no preview processing, no analytics on your text.</li>
                <li className="flex gap-2"><span className="text-cyan-400 mt-0.5">4.</span>After submission, a one-time delete token is stored in your browser's session storage. This token lets you delete your report — it is never sent to any third party and is lost when you close the tab.</li>
              </ul>
            </div>

            <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-violet-400 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                What Happens on Our Server
              </h3>
              <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2"><span className="text-violet-400 mt-0.5">1.</span>Your raw text is received over HTTPS. For URLs, we fetch the content server-side (HTTPS only, allowlisted hosts).</li>
                <li className="flex gap-2"><span className="text-violet-400 mt-0.5">2.</span>The redaction engine runs immediately — regex patterns strip PII, secrets, credentials, and company names. The raw text is discarded and never stored.</li>
                <li className="flex gap-2"><span className="text-violet-400 mt-0.5">3.</span>All analysis (hashing, similarity, slop scoring) runs on the redacted text only.</li>
                <li className="flex gap-2"><span className="text-violet-400 mt-0.5">4.</span>The two-axis scoring engine analyzes the original text in server memory — Authenticity (linguistic, template, spectral) and Validity (evidence quality, hallucination, claim specificity, internal consistency, factual verification). This text is never written to disk or database. When the optional LLM is enabled, the redacted version is sent to the configured AI provider for substance analysis. The final slopScore is derived as authenticity × 0.65 + (100 − validity) × 0.35, with human-writing signals applied post-fusion.</li>
              </ul>
            </div>
          </div>

          <div className="rounded-xl bg-green-500/5 border border-green-500/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-green-400 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              What We Store (and What We Don't)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">Stored in PostgreSQL</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>SHA-256 content hash (of redacted text)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>SimHash fingerprint (64-bit structural hash)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>MinHash signature (128 integer array)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>LSH bucket keys (16 band hashes)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Per-section SHA-256 hashes</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Slop score, tier, and feedback</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Similarity match results</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Redaction summary (counts, not content)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Redacted text (only in "full" mode)</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>File name and size</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Delete token (for owner-initiated deletion)</li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">Never Stored</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Your original (pre-redaction) text</li>
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Your IP address or browser fingerprint</li>
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Cookies, login tokens, or session IDs</li>
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Any PII that was redacted</li>
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Analytics, tracking, or telemetry data</li>
                  <li className="flex gap-2"><span className="text-red-400">&#10007;</span>Source URLs (if you linked a report)</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-orange-500/5 border border-orange-500/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-orange-400 flex items-center gap-2">
              <Trash2 className="w-4 h-4" />
              Deleting Your Report
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              When you submit a report, we return a one-time <strong className="text-foreground">delete token</strong> stored in your browser's session storage. As long as your browser session is active (you haven't closed the tab or cleared storage), you can delete your report from the results page. Deletion is permanent — it removes the report row, all associated hashes, similarity records, and redacted text from our database. We use timing-safe comparison to validate the token, so brute-force attacks are not practical.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Important:</strong> If you close your tab or clear session storage, the delete token is gone. We cannot recover it, and we cannot delete the report on your behalf — by design, we have no way to identify who submitted what.
            </p>
          </div>

          <div className="rounded-xl bg-blue-500/5 border border-blue-500/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4" />
              How We Handle AI Analysis
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">When AI analysis is enabled (default)</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2"><span className="text-blue-400">1.</span>Your report text is PII-redacted first (unless you disable redaction).</li>
                  <li className="flex gap-2"><span className="text-blue-400">2.</span>The redacted text is truncated to 6,000 characters.</li>
                  <li className="flex gap-2"><span className="text-blue-400">3.</span>That truncated snippet is sent to the <span className="text-foreground font-medium">OpenAI API</span> (gpt-4o-mini) via a managed proxy for substance analysis across 5 dimensions: PoC validity, claim specificity, domain coherence, substance depth, and internal coherence.</li>
                  <li className="flex gap-2"><span className="text-blue-400">4.</span>OpenAI's API data policy: they do <strong className="text-foreground">not</strong> train on API data. <a href="https://openai.com/enterprise-privacy/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Read their policy</a>.</li>
                  <li className="flex gap-2"><span className="text-blue-400">5.</span>The LLM's substance scores are blended 50/50 with heuristic validity scores. If they disagree by more than 30 points, the more conservative (lower) score is used.</li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">When AI analysis is disabled</h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>No data leaves the server — analysis is purely local.</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Heuristic, linguistic, factual, and active verification axes still run.</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Results may be less precise for edge cases where LLM semantic analysis would have caught subtleties.</li>
                  <li className="flex gap-2"><span className="text-green-400">&#10003;</span>Use the "Skip AI analysis" toggle in the submission form to opt out.</li>
                </ul>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border/50 pt-3">
            We use no third-party analytics, tracking pixels, or CDNs. The entire application is self-contained. If you want to verify any of this, the redaction, hashing, and scoring logic is documented in the expandable cards above with exact algorithm details and thresholds. The full source code is <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">available on GitHub</a>.
          </p>
        </div>
      )}
    </div>
  );
}

function RecentReportsFeed() {
  const { data, isLoading } = useGetReportFeed({ limit: 10 }, {
    query: {
      queryKey: getGetReportFeedQueryKey({ limit: 10 }),
      staleTime: 15_000,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  });
  const reports = data?.reports;
  const total = data?.total ?? 0;

  if (isLoading) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Recent Reports
        </h2>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 rounded-lg bg-muted/20 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          Recent Reports
        </h2>
        <p className="text-sm text-muted-foreground text-center py-6">
          No public reports yet. Be the first to share one with the community.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base sm:text-lg font-bold flex items-center gap-2">
          <Clock className="w-4 sm:w-5 h-4 sm:h-5 text-primary" />
          Recent Reports
        </h2>
        <span className="text-[10px] sm:text-xs text-muted-foreground">{total} public report{total !== 1 ? "s" : ""}</span>
      </div>
      <div className="space-y-2">
        {reports.map((report) => (
          <Link
            key={report.id}
            to={`/verify/${report.id}`}
            className="flex items-center justify-between gap-2 p-2.5 sm:p-3 rounded-lg glass-card hover:border-primary/20 transition-all group"
          >
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <span className="font-mono text-xs sm:text-sm text-primary font-medium glow-text-sm truncate">{report.reportCode}</span>
              <Badge variant="secondary" className="text-[10px] hidden md:inline-flex">
                {report.contentMode === "full" ? "Shared" : "Private"}
              </Badge>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Progress value={report.slopScore} className="w-12 sm:w-16 h-1.5 hidden sm:block" indicatorClassName={getSlopProgressColor(report.slopScore)} />
                <span className={cn("font-mono text-xs font-medium w-6 text-right", getSlopColor(report.slopScore))}>{report.slopScore}</span>
              </div>
              {report.matchCount > 0 && (
                <Badge variant="outline" className="text-[10px] gap-1 hidden sm:inline-flex">
                  <Search className="w-2.5 h-2.5" />{report.matchCount}
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground w-10 sm:w-14 text-right">{timeAgo(report.createdAt)}</span>
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/0 group-hover:text-primary transition-colors hidden sm:block" />
            </div>
          </Link>
        ))}
      </div>
      <Link
        to="/reports"
        className="flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors group"
      >
        <span>View all{total > reports.length ? ` ${total}` : ""} reports</span>
        <ExternalLink className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
