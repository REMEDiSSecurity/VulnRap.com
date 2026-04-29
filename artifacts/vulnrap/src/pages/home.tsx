import { useState, useRef, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { UploadCloud, Shield, FileText, Loader2, CheckCircle, XCircle, Search, Zap, Eye, HelpCircle, Lock, Fingerprint, ShieldCheck, Volume2, VolumeX, ClipboardPaste, Clock, ExternalLink, Info, X, Link2, ChevronDown, Play, AlertTriangle, Trash2, Mail, BrainCircuit, ShieldOff, Users, TrendingUp, TrendingDown } from "lucide-react";
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
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-green flex-shrink-0">
          <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Auto-Redaction
            <ChevronDown className={`w-4 h-4 text-green-400/50 group-hover/card:text-green-400 transition-all duration-200 ${expanded ? "rotate-180 text-green-400" : ""}`} />
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
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-cyan flex-shrink-0">
          <Fingerprint className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Section Hashing
            <ChevronDown className={`w-4 h-4 text-cyan-400/50 group-hover/card:text-cyan-400 transition-all duration-200 ${expanded ? "rotate-180 text-cyan-400" : ""}`} />
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
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-violet flex-shrink-0">
          <Eye className="w-4 h-4 sm:w-5 sm:h-5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Validity Scoring
            <ChevronDown className={`w-4 h-4 text-violet-400/50 group-hover/card:text-violet-400 transition-all duration-200 ${expanded ? "rotate-180 text-violet-400" : ""}`} />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">Three-engine composite scoring: Technical Substance (60%), CWE Coherence (35%), and AI Authorship (5%) vote with different weights and fuse into a single composite score and triage label. CWE Coherence is capped when Substance reports near-zero evidence, so a report can't earn 24 composite points just for naming the right CWE number. Tap to see how.</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">

          <ScoringPipelineDiagram />

          <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground/85 leading-relaxed">
              <span className="text-violet-300 font-semibold">AVRI (in flight, behind <span className="font-mono">VULNRAP_USE_AVRI</span>):</span> swaps Engine 2's rubric for one of eight CWE-family-specific rubrics (memory corruption, injection, auth/access, crypto/protocol, DoS/resource, info exposure, request forgery, hardware) with family-specific gold signals and absence penalties. Weights stay 5/60/35; only Engine 2's internals change. Default off in production until calibration confirms the score-gap target. The legacy <span className="font-mono">slopScore</span> API field is mapped from the composite for backward compatibility.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60" />
              Inside Engine 1 — AI Authorship surface patterns (deterministic, 5% of composite)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Three components feed Engine 1's 0–100 sub-score: <span className="font-mono text-violet-300">Linguistic (40%)</span> = lexical 60% + statistical 40%, <span className="font-mono text-cyan-300">Template (35%)</span>, <span className="font-mono text-orange-300">Spectral (25%)</span>. If both linguistic and template scores are high, a compound boost of up to 15 points is applied. Engine 1 then contributes 5% to the final composite.
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
              Inside Engine 2 — Technical Substance (60% of composite)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              In the current production path, Engine 2's 0–100 sub-score is built from five weighted evidence categories: <span className="font-mono text-cyan-300">Code Evidence (35%) + References (30%) + Reproducibility (20%) + PoC Integrity (10%) + Claim/Evidence Ratio (5%)</span>, with up to a +15 point bonus when many strong-evidence signals stack. When LLM analysis is enabled, heuristic and LLM substance scores are blended 50/50; if they disagree by more than 30 points, the lower (more conservative) score is used. <span className="text-violet-300">Under the AVRI flag, this entire rubric is swapped for the matching CWE-family rubric — same Engine 2 slot, family-specific gold signals and absence penalties.</span>
            </p>
          </div>

          <div className="space-y-2 border-t border-border/30 pt-4">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-400/60" />
              Inside Engine 3 — CWE Coherence (35% of composite)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Engine 3 checks that the vulnerability class the report claims (e.g. SQL injection, buffer overflow, SSRF) is consistent with the evidence and PoC actually shown. A claimed XSS whose payload triggers a database error, a stated buffer overflow with no memory-corruption indicators, or a CVE citation that disagrees with NVD's assigned CWE all lower this engine's sub-score sharply. CWE Coherence is the second-largest vote (35%) because mismatched-class reports are one of the most reliable LLM-slop tells.
            </p>
            <div className="rounded-md bg-violet-500/5 border border-violet-500/15 px-3 py-2">
              <p className="text-[11px] text-muted-foreground/85 leading-relaxed">
                <span className="text-violet-300 font-semibold">Substance gate:</span> Engine 3 is cross-referenced against Engine 2 before it votes. When Engine 2 reports near-zero technical substance (<span className="font-mono">&lt;30</span>), Engine 3 is capped at <span className="font-mono">42</span>; when Substance is weak (<span className="font-mono">&lt;45</span>), Engine 3 is capped at <span className="font-mono">55</span>. Citing the right CWE number is necessary but not sufficient — the report still has to show the evidence that goes with that CWE. Reports that pass the Substance bar are unaffected. The cap fires as an <span className="font-mono">E3_SUBSTANCE_GATE</span> override visible on the result page, and can be disabled in an emergency via the <span className="font-mono">VULNRAP_E3_SUBSTANCE_CAP</span> env flag.
              </p>
            </div>
          </div>

          <div className="space-y-2 border-t border-border/30 pt-4">
            <h4 className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/60" />
              LLM Substance Analysis (optional, feeds Engine 2)
            </h4>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              When the LLM is enabled, it evaluates the report from a PSIRT triage perspective across five substance dimensions that regex cannot assess. It returns per-dimension 0–100 scores plus concrete observations, which are then blended into Engine 2's substance sub-score (50/50, conservative-on-disagreement). The LLM is also gated by a cost guard — it only runs when the heuristic score lands in the borderline 25–60 range or initial confidence is below 0.5 — so most clearly-clean and clearly-slop reports never incur an LLM call.
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

type ExampleEngineRow = {
  key: "e1" | "e2" | "e3";
  title: string;
  weight: number;
  rawScore: number;
  effectiveScore?: number;
  gateNote?: string;
  inverted?: boolean;
};

type WorkedExample = {
  variant: "slop" | "genuine";
  caseHeadline: string;
  caseSubhead: string;
  whatsThereLines: string[];
  rows: ExampleEngineRow[];
  composite: number;
  triageLabel: string;
  triageSummary: string;
};

const ENGINE_HEX: Record<"e1" | "e2" | "e3", { fill: string; faded: string; track: string; ring: string }> = {
  e1: { fill: "#fbbf24", faded: "rgba(251,191,36,0.35)", track: "rgba(251,191,36,0.10)", ring: "rgba(251,191,36,0.40)" },
  e2: { fill: "#22d3ee", faded: "rgba(34,211,238,0.35)", track: "rgba(34,211,238,0.10)", ring: "rgba(34,211,238,0.40)" },
  e3: { fill: "#a78bfa", faded: "rgba(167,139,250,0.35)", track: "rgba(167,139,250,0.10)", ring: "rgba(167,139,250,0.40)" },
};

const WORKED_EXAMPLES: WorkedExample[] = [
  {
    variant: "slop",
    caseHeadline: "SLOP ATTEMPT",
    caseSubhead: "CWE-89 cited · no PoC, no payload, no endpoint",
    whatsThereLines: [
      "Right CWE number. Generic prose (\u201CIt is important to note that",
      "SQL injection vulnerabilities\u2026\u201D). Zero code blocks. Zero file paths.",
    ],
    rows: [
      { key: "e1", title: "AI Authorship", weight: 5, rawScore: 78, inverted: true },
      { key: "e2", title: "Technical Substance", weight: 60, rawScore: 17 },
      { key: "e3", title: "CWE Coherence", weight: 35, rawScore: 78, effectiveScore: 42, gateNote: "E2 < 30 \u2192 cap E3 at 42" },
    ],
    composite: 26,
    triageLabel: "CHALLENGE_REPORTER",
    triageSummary: "Auto-generates challenge questions for the reporter.",
  },
  {
    variant: "genuine",
    caseHeadline: "GENUINE REPORT",
    caseSubhead: "CWE-89 cited · full PoC, exact payload, real endpoint",
    whatsThereLines: [
      "Right CWE. Sober technical voice. curl PoC with payload",
      "\u201C' OR 1=1 --\u201D. Exact file path + line number. Real DB error.",
    ],
    rows: [
      { key: "e1", title: "AI Authorship", weight: 5, rawScore: 18, inverted: true },
      { key: "e2", title: "Technical Substance", weight: 60, rawScore: 76 },
      { key: "e3", title: "CWE Coherence", weight: 35, rawScore: 82 },
    ],
    composite: 78,
    triageLabel: "PRIORITIZE",
    triageSummary: "Routes straight to a senior reviewer.",
  },
];

function rowContribution(row: ExampleEngineRow): number {
  const base = row.inverted ? 100 - row.rawScore : (row.effectiveScore ?? row.rawScore);
  return Math.round(base * (row.weight / 100) * 10) / 10;
}

function EngineRowSvg({ row, x, y, width }: { row: ExampleEngineRow; x: number; y: number; width: number }) {
  const palette = ENGINE_HEX[row.key];
  const gated = typeof row.effectiveScore === "number";
  const barX = x;
  const barY = y + 28;
  const barW = width;
  const barH = 9;
  const rawW = (row.rawScore / 100) * barW;
  const effW = gated ? (row.effectiveScore! / 100) * barW : rawW;
  const contrib = rowContribution(row);
  const contribText = row.inverted
    ? `0.05 \u00D7 (100 \u2212 ${row.rawScore}) = ${contrib.toFixed(1)}`
    : `0.${row.weight.toString().padStart(2, "0")} \u00D7 ${gated ? row.effectiveScore : row.rawScore} = ${contrib.toFixed(1)}`;

  return (
    <g>
      {/* Title row: swatch + name + score (weight is in the legend, not repeated here) */}
      <circle cx={x + 4} cy={y + 8} r={3.5} fill={palette.fill} />
      <text x={x + 14} y={y + 12} fontSize={12.5} fontWeight={600} fill="#e2e8f0" fontFamily="ui-sans-serif, system-ui">
        {row.title}
      </text>

      {/* Score (right-aligned). For gated rows: strike-through raw, then effective. */}
      {gated ? (
        <>
          <text
            x={x + width - 32}
            y={y + 12}
            textAnchor="end"
            fontSize={11}
            fill={palette.faded}
            fontFamily="ui-monospace, SFMono-Regular"
            fontWeight={600}
            textDecoration="line-through"
            opacity={0.7}
          >
            {row.rawScore}
          </text>
          <text x={x + width - 26} y={y + 12} fontSize={12} fontWeight={700} fill={palette.fill} fontFamily="ui-monospace, SFMono-Regular">
            {row.effectiveScore}
          </text>
          <text x={x + width} y={y + 12} textAnchor="end" fontSize={9.5} fill="#64748b" fontFamily="ui-monospace, SFMono-Regular">
            /100
          </text>
        </>
      ) : (
        <>
          <text x={x + width - 22} y={y + 12} textAnchor="end" fontSize={12} fontWeight={700} fill={palette.fill} fontFamily="ui-monospace, SFMono-Regular">
            {row.rawScore}
          </text>
          <text x={x + width} y={y + 12} textAnchor="end" fontSize={9.5} fill="#64748b" fontFamily="ui-monospace, SFMono-Regular">
            /100
          </text>
        </>
      )}

      {/* Bar — track + raw fill (faded if gated) + effective fill on top */}
      <rect x={barX} y={barY} width={barW} height={barH} rx={4.5} fill={palette.track} />
      <rect x={barX} y={barY} width={rawW} height={barH} rx={4.5} fill={palette.fill} opacity={gated ? 0.32 : 1} />
      {gated && <rect x={barX} y={barY} width={effW} height={barH} rx={4.5} fill={palette.fill} />}
      {/* Clamp marker — vertical amber line at the cap position */}
      {gated && (
        <>
          <line x1={barX + effW} y1={barY - 3} x2={barX + effW} y2={barY + barH + 3} stroke="#fbbf24" strokeWidth={2} />
          <polygon
            points={`${barX + effW - 3.5},${barY - 5} ${barX + effW + 3.5},${barY - 5} ${barX + effW},${barY - 1.5}`}
            fill="#fbbf24"
          />
        </>
      )}

      {/* Contribution math */}
      <text x={x + 14} y={barY + barH + 14} fontSize={10} fill="#64748b" fontFamily="ui-monospace, SFMono-Regular">
        {contribText}
      </text>

      {/* Gate annotation (only for clamped E3 row) */}
      {gated && row.gateNote && (
        <g>
          <rect x={x + width - 200} y={barY + barH + 22} width={200} height={18} rx={4} fill="rgba(251,191,36,0.10)" stroke="rgba(251,191,36,0.45)" />
          <text x={x + width - 192} y={barY + barH + 35} fontSize={10} fontWeight={600} fill="#fbbf24" fontFamily="ui-monospace, SFMono-Regular">
            {`\u{1F512} substance gate \u00B7 ${row.gateNote}`}
          </text>
        </g>
      )}
    </g>
  );
}

function WorkedExampleSvg({ ex, x, y, width, height }: { ex: WorkedExample; x: number; y: number; width: number; height: number }) {
  const isSlop = ex.variant === "slop";
  const accent = isSlop ? "#f43f5e" : "#10b981";
  const accentSoft = isSlop ? "rgba(244,63,94,0.35)" : "rgba(16,185,129,0.35)";
  const accentBg = isSlop ? "rgba(244,63,94,0.06)" : "rgba(16,185,129,0.06)";
  const compositeColor = isSlop ? "#fb7185" : "#34d399";
  const triageColor = isSlop ? "#fbbf24" : "#34d399";
  const triageSoft = isSlop ? "rgba(251,191,36,0.45)" : "rgba(16,185,129,0.45)";
  const triageFill = isSlop ? "rgba(251,191,36,0.12)" : "rgba(16,185,129,0.12)";

  const padX = 18;
  const innerX = x + padX;
  const innerW = width - padX * 2;

  // Vertical layout
  const headerY = y + 28;
  const subheadY = y + 56;
  const whatY = y + 76;
  const dividerY1 = y + 116;
  // Engine row positions
  const rowGap = 60;
  const rowsStartY = y + 138;
  const rowYs = ex.rows.map((_, i) => rowsStartY + i * rowGap);
  // Slop card's E3 has the gate annotation, which adds ~20px below the contribution math.
  // We pad subsequent layout sections accordingly.
  const lastRowExtra = ex.rows.some((r) => typeof r.effectiveScore === "number") ? 22 : 0;
  const dividerY2 = rowsStartY + ex.rows.length * rowGap - 20 + lastRowExtra;
  const sumY = dividerY2 + 18;
  const compY = dividerY2 + 50;

  // Sum string
  const sumPieces = ex.rows.map((r) => rowContribution(r).toFixed(1));
  const sumText = `${sumPieces.join(" + ")} \u2248 ${ex.composite}`;

  // Triage badge sizing
  const triageW = ex.triageLabel.length * 7 + 18;

  return (
    <g>
      {/* Card background + border */}
      <rect x={x} y={y} width={width} height={height} rx={12} fill={accentBg} />
      <rect x={x} y={y} width={width} height={height} rx={12} fill="none" stroke={accentSoft} strokeWidth={1.25} />

      {/* Case headline badge */}
      <rect x={innerX} y={headerY - 14} width={ex.caseHeadline.length * 7.5 + 14} height={20} rx={4} fill={`${accent}26`} stroke={accentSoft} />
      <text x={innerX + 8} y={headerY} fontSize={11} fontWeight={800} fill={accent} fontFamily="ui-monospace, SFMono-Regular" letterSpacing={0.8}>
        {isSlop ? "\u26A0  " : "\u2713  "}{ex.caseHeadline}
      </text>

      {/* Subhead */}
      <text x={innerX} y={subheadY} fontSize={11.5} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui">
        {ex.caseSubhead}
      </text>

      {/* What's there (multi-line italic) */}
      {ex.whatsThereLines.map((line, i) => (
        <text key={i} x={innerX} y={whatY + i * 14} fontSize={10.5} fill="#64748b" fontStyle="italic" fontFamily="ui-sans-serif, system-ui">
          {line}
        </text>
      ))}

      {/* Divider */}
      <line x1={innerX} y1={dividerY1} x2={innerX + innerW} y2={dividerY1} stroke="rgba(148,163,184,0.18)" />

      {/* Engine rows */}
      {ex.rows.map((row, i) => (
        <EngineRowSvg key={row.key} row={row} x={innerX} y={rowYs[i]} width={innerW} />
      ))}

      {/* Divider */}
      <line x1={innerX} y1={dividerY2} x2={innerX + innerW} y2={dividerY2} stroke="rgba(148,163,184,0.18)" />

      {/* Sum line */}
      <text x={innerX} y={sumY} fontSize={10.5} fill="#94a3b8" fontFamily="ui-monospace, SFMono-Regular">
        {sumText}
      </text>

      {/* Composite label */}
      <text x={innerX} y={compY - 12} fontSize={9} fontWeight={700} fill="#64748b" fontFamily="ui-sans-serif, system-ui" letterSpacing={1.5}>
        COMPOSITE
      </text>
      {/* Big composite number */}
      <text x={innerX} y={compY + 28} fontSize={42} fontWeight={800} fill={compositeColor} fontFamily="ui-monospace, SFMono-Regular">
        {ex.composite}
      </text>

      {/* Triage badge (right side) */}
      <rect x={innerX + innerW - triageW} y={compY - 8} width={triageW} height={22} rx={4} fill={triageFill} stroke={triageSoft} />
      <text
        x={innerX + innerW - triageW / 2}
        y={compY + 7}
        textAnchor="middle"
        fontSize={11}
        fontWeight={800}
        fill={triageColor}
        fontFamily="ui-monospace, SFMono-Regular"
        letterSpacing={0.5}
      >
        {ex.triageLabel}
      </text>
      {/* Triage summary (right side, wraps to two lines if needed; we keep it short) */}
      <text x={innerX + innerW} y={compY + 28} textAnchor="end" fontSize={10} fill="#64748b" fontFamily="ui-sans-serif, system-ui">
        {ex.triageSummary}
      </text>
    </g>
  );
}

const DIAGRAM_ENGINES = [
  { key: "e1" as const, title: "AI Authorship", weight: 5 },
  { key: "e2" as const, title: "Technical Substance", weight: 60 },
  { key: "e3" as const, title: "CWE Coherence", weight: 35 },
];

function LegendChips({ x, y, layout }: { x: number; y: number; layout: "inline" | "stacked" }) {
  // inline: label and chips on the same row (wide layout)
  // stacked: label on its own row above the chips (narrow layout)
  if (layout === "inline") {
    let chipX = x + 230;
    return (
      <g>
        <text x={x} y={y + 14} fontSize={11} fontWeight={700} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui" letterSpacing={1.2}>
          {"3 ENGINES VOTE \u00B7 WEIGHTS SUM TO 100%"}
        </text>
        {DIAGRAM_ENGINES.map((e) => {
          const palette = ENGINE_HEX[e.key];
          const w = e.title.length * 6.6 + 60;
          const cx = chipX;
          chipX += w + 8;
          return (
            <g key={e.key}>
              <rect x={cx} y={y} width={w} height={20} rx={4} fill={palette.track} stroke={palette.ring} />
              <circle cx={cx + 9} cy={y + 10} r={3} fill={palette.fill} />
              <text x={cx + 17} y={y + 14} fontSize={10.5} fontWeight={700} fill={palette.fill} fontFamily="ui-sans-serif, system-ui">
                {e.title}
              </text>
              <text x={cx + w - 8} y={y + 14} textAnchor="end" fontSize={10} fill="#94a3b8" fontFamily="ui-monospace, SFMono-Regular">
                {e.weight}%
              </text>
            </g>
          );
        })}
      </g>
    );
  }
  // Stacked layout: label on row 1, chips on row 2
  let chipX = x;
  return (
    <g>
      <text x={x} y={y + 12} fontSize={10.5} fontWeight={700} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui" letterSpacing={1.2}>
        {"3 ENGINES VOTE \u00B7 WEIGHTS SUM TO 100%"}
      </text>
      {DIAGRAM_ENGINES.map((e) => {
        const palette = ENGINE_HEX[e.key];
        const w = e.title.length * 6.6 + 60;
        const cx = chipX;
        chipX += w + 8;
        return (
          <g key={e.key}>
            <rect x={cx} y={y + 22} width={w} height={20} rx={4} fill={palette.track} stroke={palette.ring} />
            <circle cx={cx + 9} cy={y + 32} r={3} fill={palette.fill} />
            <text x={cx + 17} y={y + 36} fontSize={10.5} fontWeight={700} fill={palette.fill} fontFamily="ui-sans-serif, system-ui">
              {e.title}
            </text>
            <text x={cx + w - 8} y={y + 36} textAnchor="end" fontSize={10} fill="#94a3b8" fontFamily="ui-monospace, SFMono-Regular">
              {e.weight}%
            </text>
          </g>
        );
      })}
    </g>
  );
}

const DIAGRAM_ARIA_LABEL =
  "Three-engine composite scoring with two worked examples. Slop attempt: AI Authorship 78, Substance 17, CWE Coherence raw 78 capped at 42 by the substance gate, composite 26, triage CHALLENGE_REPORTER. Genuine report: AI Authorship 18, Substance 76, CWE Coherence 82, composite 78, triage PRIORITIZE.";

function ScoringPipelineDiagram() {
  // ---- Wide (sm and up) layout: cards side-by-side ----
  const wideVBW = 1000;
  const wideVBH = 600;
  const widePadX = 24;
  const wideInnerW = wideVBW - widePadX * 2;
  const wideCardGap = 24;
  const wideCardW = (wideInnerW - wideCardGap) / 2;
  const wideCardY = 56;
  const wideCardH = 488;

  // ---- Narrow (below sm) layout: cards stacked vertically ----
  const narrowVBW = 600;
  const narrowPadX = 20;
  const narrowInnerW = narrowVBW - narrowPadX * 2;
  const narrowLegendH = 60;
  const narrowCardGap = 20;
  const narrowCardH = 488;
  const narrowCard1Y = narrowLegendH + 8;
  const narrowCard2Y = narrowCard1Y + narrowCardH + narrowCardGap;
  const narrowFooterY = narrowCard2Y + narrowCardH + 12;
  const narrowVBH = narrowFooterY + 28;

  return (
    <div
      className="relative rounded-xl border border-cyan-500/15 p-3 sm:p-5 overflow-hidden"
      style={{
        background: "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)",
        boxShadow: "0 0 0 1px rgba(0,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.35)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 18% 100%, rgba(244,63,94,0.22), transparent 70%), radial-gradient(ellipse 60% 40% at 82% 100%, rgba(52,211,153,0.22), transparent 70%)",
        }}
      />

      {/* Screen reader prose walkthrough — read once regardless of which SVG renders. */}
      <p className="sr-only">
        Worked-example diagram comparing two reports that both cite CWE-89. The slop attempt has no proof of concept,
        no payload, and no endpoint; its engine scores are AI Authorship 78, Technical Substance 17, raw CWE Coherence 78.
        Because Substance is below 30, the substance gate caps Engine 3 at 42, so the weighted composite lands at 26 and
        triage routes to CHALLENGE_REPORTER. The genuine report has the same CWE number but with a curl proof of concept,
        the exact payload, an endpoint, a file path with line number, and a real database error; its engine scores are
        AI Authorship 18, Technical Substance 76, CWE Coherence 82. The substance gate does not fire, so the composite
        lands at 78 and triage routes to PRIORITIZE.
      </p>

      {/* Wide layout: cards side-by-side, shown at sm and up */}
      <svg
        viewBox={`0 0 ${wideVBW} ${wideVBH}`}
        className="hidden sm:block relative w-full h-auto"
        role="img"
        aria-label={DIAGRAM_ARIA_LABEL}
        preserveAspectRatio="xMidYMid meet"
      >
        <LegendChips x={widePadX} y={14} layout="inline" />
        <WorkedExampleSvg ex={WORKED_EXAMPLES[0]} x={widePadX} y={wideCardY} width={wideCardW} height={wideCardH} />
        <WorkedExampleSvg ex={WORKED_EXAMPLES[1]} x={widePadX + wideCardW + wideCardGap} y={wideCardY} width={wideCardW} height={wideCardH} />
        <text x={wideVBW / 2} y={wideCardY + wideCardH + 30} textAnchor="middle" fontSize={11.5} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui">
          <tspan fontWeight={700} fill="#e2e8f0">Same CWE-89 cited.</tspan>
          {"  "}What separates these reports is{" "}
          <tspan fill="#22d3ee" fontFamily="ui-monospace, SFMono-Regular">substance</tspan>
          . When Engine 2 sees no evidence, the substance gate caps Engine 3.
        </text>
      </svg>

      {/* Narrow layout: cards stacked vertically, shown below sm */}
      <svg
        viewBox={`0 0 ${narrowVBW} ${narrowVBH}`}
        className="block sm:hidden relative w-full h-auto"
        role="img"
        aria-label={DIAGRAM_ARIA_LABEL}
        preserveAspectRatio="xMidYMid meet"
      >
        <LegendChips x={narrowPadX} y={4} layout="stacked" />
        <WorkedExampleSvg ex={WORKED_EXAMPLES[0]} x={narrowPadX} y={narrowCard1Y} width={narrowInnerW} height={narrowCardH} />
        <WorkedExampleSvg ex={WORKED_EXAMPLES[1]} x={narrowPadX} y={narrowCard2Y} width={narrowInnerW} height={narrowCardH} />
        <text x={narrowVBW / 2} y={narrowFooterY + 14} textAnchor="middle" fontSize={11} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui">
          <tspan fontWeight={700} fill="#e2e8f0">Same CWE-89 cited.</tspan>
          {"  "}What separates them is{" "}
          <tspan fill="#22d3ee" fontFamily="ui-monospace, SFMono-Regular">substance</tspan>.
        </text>
      </svg>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [inputMode, setInputMode] = useState<InputMode>("text");
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

  // Scroll-triggered fade-in for major glass-card sections.
  // Elements tagged with `data-scroll-fade` are observed; when they intersect
  // the viewport they get `is-visible` and the CSS transition runs.
  // We only add the `scroll-fade-in` class via JS so that users on browsers
  // without IntersectionObserver (or with JS off entirely) still see content.
  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-scroll-fade]"));
    if (els.length === 0) return;
    els.forEach((el) => el.classList.add("scroll-fade-in"));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
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
    const timer = setTimeout(dismissMirrorBanner, 5000);
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
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-primary uppercase glow-text" data-testid="text-heading">Vuln Report Rap Sheet</h1>
        <p className="text-sm sm:text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed px-2">
          Assess the likelihood that an incoming vulnerability report describes a real, reproducible issue. Cross-check claims against live sources, detect duplicate submissions, and surface what deserves analyst time. Built for PSIRT teams, triage analysts, and anyone buried in an inbox full of incoming reports.
        </p>
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
              "border-2 border-dashed rounded-xl p-3 min-h-[7rem] flex flex-col items-center justify-center gap-2 transition-all cursor-pointer",
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
                <XCircle className="w-6 h-6 text-destructive shrink-0" />
                <div className="text-center">
                  <p className="font-medium text-destructive text-sm">{fileError}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Click to select a different file</p>
                </div>
              </>
            ) : file ? (
              <>
                <div className="flex items-center gap-2 text-center">
                  <FileText className="w-5 h-5 text-primary shrink-0" />
                  <div className="text-left">
                    <p className="font-medium text-sm leading-tight" data-testid="text-filename">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); setFileError(null); setStage("idle"); }} className="h-7 text-xs" data-testid="button-clear">
                  Clear Selection
                </Button>
              </>
            ) : (
              <>
                <UploadCloud className="w-6 h-6 text-muted-foreground shrink-0" />
                <div className="text-center">
                  <p className="font-medium text-sm">Drag & drop your report here</p>
                  <p className="text-xs text-muted-foreground mt-0.5">or click to browse files (.txt, .md)</p>
                </div>
              </>
            )}
          </div>
          ) : inputMode === "text" ? (
          <div className="space-y-2">
            <textarea
              data-testid="input-rawtext"
              className="w-full h-28 min-h-[7rem] rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
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

      <VideoSection />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <AutoRedactionCard />
        <SectionHashingCard />
        <SlopDetectionCard />
      </div>

      <div className="glass-card rounded-xl p-4 sm:p-6 space-y-4 sm:space-y-5" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 01 · Workflow</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            How It Works
          </h2>
        </div>
        {/*
          Each step now leads with a colored icon badge using the same
          icon-glow vocabulary as the feature cards above (Auto-Redaction,
          Section Hashing, Slop Detection) so the visuals feel native to the
          page. On desktop (sm+) the icon sits at the top of a vertical card
          alongside the big gradient step number; on mobile it acts as the
          left-hand visual anchor of a horizontal row, with the step label
          inline with the title on the right.
        */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          {/* Step 01 — Submit */}
          <div className="flex sm:block items-start gap-3 sm:gap-0 sm:space-y-3 p-4 rounded-xl glass-card feature-card relative">
            <div className="p-2 sm:p-2.5 rounded-lg icon-glow-cyan flex-shrink-0 w-10 h-10 sm:w-auto sm:h-auto flex items-center justify-center">
              <UploadCloud className="w-5 h-5 text-cyan-400" />
            </div>
            <div className="space-y-1 sm:space-y-2 min-w-0 flex-1">
              <div className="hidden sm:block text-3xl font-bold step-number leading-none">01</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="sm:hidden text-[10px] font-mono font-bold tracking-wider text-cyan-400/80">STEP 01</span>
                <h3 className="font-medium text-sm">Submit</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upload a file, paste text, or link a URL. We begin processing immediately.
              </p>
            </div>
          </div>

          {/* Step 02 — Auto-Redact */}
          <div className="flex sm:block items-start gap-3 sm:gap-0 sm:space-y-3 p-4 rounded-xl glass-card feature-card relative">
            <div className="p-2 sm:p-2.5 rounded-lg icon-glow-green flex-shrink-0 w-10 h-10 sm:w-auto sm:h-auto flex items-center justify-center">
              <ShieldOff className="w-5 h-5 text-green-400" />
            </div>
            <div className="space-y-1 sm:space-y-2 min-w-0 flex-1">
              <div className="hidden sm:block text-3xl font-bold step-number leading-none">02</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="sm:hidden text-[10px] font-mono font-bold tracking-wider text-green-400/80">STEP 02</span>
                <h3 className="font-medium text-sm">Auto-Redact</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                PII, secrets, and company names are scrubbed automatically before anything is stored.
              </p>
            </div>
          </div>

          {/* Step 03 — Analyze */}
          <div className="flex sm:block items-start gap-3 sm:gap-0 sm:space-y-3 p-4 rounded-xl glass-card feature-card relative">
            <div className="p-2 sm:p-2.5 rounded-lg icon-glow-violet flex-shrink-0 w-10 h-10 sm:w-auto sm:h-auto flex items-center justify-center">
              <BrainCircuit className="w-5 h-5 text-violet-400" />
            </div>
            <div className="space-y-1 sm:space-y-2 min-w-0 flex-1">
              <div className="hidden sm:block text-3xl font-bold step-number leading-none">03</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="sm:hidden text-[10px] font-mono font-bold tracking-wider text-violet-400/80">STEP 03</span>
                <h3 className="font-medium text-sm">Analyze</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Claims are verified against live sources, sections are compared for duplicates, and the report is scored for validity.
              </p>
            </div>
          </div>

          {/* Step 04 — Results */}
          <div className="flex sm:block items-start gap-3 sm:gap-0 sm:space-y-3 p-4 rounded-xl glass-card feature-card relative">
            <div className="p-2 sm:p-2.5 rounded-lg icon-glow-amber flex-shrink-0 w-10 h-10 sm:w-auto sm:h-auto flex items-center justify-center">
              <CheckCircle className="w-5 h-5 text-amber-400" />
            </div>
            <div className="space-y-1 sm:space-y-2 min-w-0 flex-1">
              <div className="hidden sm:block text-3xl font-bold step-number leading-none">04</div>
              <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="sm:hidden text-[10px] font-mono font-bold tracking-wider text-amber-400/80">STEP 04</span>
                <h3 className="font-medium text-sm">Results</h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Get a validity score, similarity matches, verification results, triage recommendation, and redaction summary.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-xl p-4 sm:p-6 space-y-4 sm:space-y-5" data-testid="section-methodology" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 02 · Methodology</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" />
            What happens around the engines
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
            The three engines and their sub-weights live in the <span className="text-foreground font-semibold">Validity Scoring</span> card up top. This section covers everything <em>around</em> them: the live sources we go check, the pieces of evidence that disproportionately move the score, and how we landed on these weights in the first place.
          </p>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md icon-glow-green flex-shrink-0">
              <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
            </span>
            How we check the claims (validation sources)
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Engine scoring tells us if the report <em>looks</em> real. Active verification tells us if it <em>is</em> real. Anything we can verify, we go check live:
          </p>
          <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span><strong className="text-foreground">CVE database (NVD):</strong> Every CVE the report cites is looked up live. We check the ID actually exists, that the description and CWE match what the report claims, and we flag anything that's hallucinated or misattributed.</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span><strong className="text-foreground">GitHub repositories &amp; commits:</strong> If the report references a repo, file path, line number, or commit SHA, we fetch it to verify the file exists, the line is real, and the commit hash resolves. Fake-looking paths like <code className="font-mono text-[10px] bg-muted px-1 rounded">src/utils/helper.js:42</code> with nothing else specific are a classic slop signal.</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span><strong className="text-foreground">Package → repository mapping:</strong> When a report names an npm/PyPI/Maven package, we map it to its real source repo and verify the affected version actually exists in the registry's release history.</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span><strong className="text-foreground">Section fingerprints (duplicate detection):</strong> Every paragraph is hashed and compared against every other report we've ever seen. If your "novel" finding is paragraph-for-paragraph identical to a report we processed three months ago, we'll tell you.</span>
            </li>
            <li className="flex gap-2">
              <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
              <span><strong className="text-foreground">Verification tags:</strong> Each verified claim is tagged <em className="text-foreground">referenced</em> (the report itself pointed to a real, checkable source) or <em className="text-foreground">fallback</em> (we had to go find a likely source ourselves). Referenced verifications carry more weight than fallbacks.</span>
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md icon-glow-amber flex-shrink-0">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
            </span>
            Evidence multipliers — what bumps the score up or down
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            On top of the engine vote, certain pieces of evidence get an outsized effect because they were the most reliable signal in our calibration data:
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-lg bg-green-500/5 border border-green-500/20 p-3 space-y-2">
              <h4 className="text-xs font-bold text-green-400 flex items-center gap-1.5">
                <TrendingUp className="w-3.5 h-3.5" />
                Pulls the score toward "looks real"
              </h4>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                {[
                  "A CVE ID that resolves and matches the described bug",
                  "A real commit SHA on the affected repo",
                  "Real file paths with real line numbers",
                  "A working command-line PoC with actual output",
                  "Tight CWE/PoC alignment",
                ].map((item) => (
                  <li key={item} className="flex gap-1.5 items-start">
                    <CheckCircle className="w-3 h-3 text-green-400/80 mt-0.5 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3 space-y-2">
              <h4 className="text-xs font-bold text-red-400 flex items-center gap-1.5">
                <TrendingDown className="w-3.5 h-3.5" />
                Pulls the score toward "likely slop"
              </h4>
              <ul className="space-y-1.5 text-[11px] text-muted-foreground">
                {[
                  "Hallucinated CVE IDs or non-existent paths",
                  "Generic \"an attacker could…\" speculation with no PoC",
                  "Title CWE doesn't match the evidence shown",
                  "Section-for-section duplicate of an earlier report",
                  "Test/example certificates being claimed as live findings",
                ].map((item) => (
                  <li key={item} className="flex gap-1.5 items-start">
                    <XCircle className="w-3 h-3 text-red-400/80 mt-0.5 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-xl p-4 sm:p-6 space-y-4" data-testid="section-methodology-origin" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 03 · Origin Story</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            How we landed on this methodology — and how to make it better
          </h2>
        </div>
        <div className="space-y-3 text-xs sm:text-sm text-muted-foreground leading-relaxed">
          <div className="pull-quote space-y-3">
            <p>
              These weights and signals didn't come out of thin air. We worked through a large corpus of real-world vulnerability submissions — a mix of well-known confirmed reports, public bug-bounty disclosures, and the increasingly familiar wave of LLM-generated slop that PSIRT inboxes have been flooded with over the last two years. For each report we recorded what humans ultimately decided about it (real, duplicate, or noise), then tuned the engine weights and the evidence multipliers until the model's verdicts lined up with the human verdicts.
            </p>
            <p>
              That's how we ended up at the <span className="text-foreground font-semibold">60% / 35% / 5%</span> split (refined from an earlier 55% / 40% / 5% as the substance-vs-coherence calibration matured through Sprint 12): substance-of-PoC and CWE-coherence were the two signals that consistently separated real submissions from generated ones, while pure linguistic "this sounds like an LLM wrote it" cues turned out to be much noisier than they look in isolation. The blog post on the field test walks through specific examples from that round of calibration if you want to see the receipts.
            </p>
          </div>
          <div className="rounded-xl bg-primary/5 border border-primary/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary" />
              Got a better idea? We genuinely want to hear it.
            </h3>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
              We don't think this is the final word on triage scoring. If you've got a signal we're missing, a verification source we should be hitting, an evidence pattern that fooled us, or a corpus we should be calibrating against — please reach out. The more analyst experience we can fold into the weights, the better this gets for everyone drowning in incoming reports.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href="mailto:remedisllc@gmail.com?subject=VulnRap%20methodology%20feedback"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors glow-button"
                data-testid="link-methodology-feedback"
              >
                <Mail className="w-3.5 h-3.5" />
                Email the team
              </a>
              <a
                href="https://github.com/REMEDiSSecurity/VulnRap.Com/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:border-primary/40 text-xs font-medium text-foreground transition-colors"
                data-testid="link-methodology-issues"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open an issue on GitHub
              </a>
            </div>
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
        className="w-full p-4 sm:p-6 flex items-center justify-between text-left cursor-pointer group/card"
        aria-expanded={expanded}
      >
        <div className="space-y-1">
          <span className="eyebrow-label">Section 04 · Privacy</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Lock className="w-5 h-5 text-primary" />
            Transparency: Where Your Data Goes
          </h2>
        </div>
        <ChevronDown className={`w-5 h-5 text-cyan-400/50 group-hover/card:text-cyan-400 transition-all duration-200 ${expanded ? "rotate-180 text-cyan-400" : ""}`} />
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
                <li className="flex gap-2"><span className="text-violet-400 mt-0.5">4.</span>The three-engine composite scorer analyzes the redacted text in server memory — Engine 1 AI Authorship (linguistic, template, spectral), Engine 2 Technical Substance (evidence quality, references, reproducibility, PoC integrity, claim/evidence ratio — or the matching CWE-family rubric when AVRI is enabled), and Engine 3 CWE Coherence. The original (pre-redaction) text is never written to disk or database. When the optional LLM is enabled and the heuristic score is borderline, the redacted version is sent to the configured AI provider for a substance second opinion that blends into Engine 2. The three engines fuse with fixed weights — Substance 60%, Coherence 35%, Authorship 5% — into a single composite, with Engine 3 capped against Engine 2 so reports without evidence can't earn coherence points for citing the right CWE alone, and the legacy <span className="font-mono">slopScore</span> field is mapped from that composite for backward compatibility.</li>
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
      <div className="glass-card rounded-xl p-6 space-y-4" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 05 · Live Activity</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        {/* Structured skeleton mirroring the actual report row layout
            (mono code chunk, badge, score progress, time-ago) so the loading
            state previews real content shape rather than flat bars. */}
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 p-3 rounded-lg glass-card animate-pulse"
              aria-hidden="true"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="h-3.5 w-20 sm:w-24 rounded bg-primary/15" />
                <div className="h-3 w-12 rounded bg-muted/30 hidden md:block" />
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="h-1.5 w-16 rounded-full bg-muted/30 hidden sm:block" />
                <div className="h-3 w-6 rounded bg-muted/40" />
                <div className="h-3 w-10 rounded bg-muted/25" />
              </div>
            </div>
          ))}
        </div>
        <span className="sr-only">Loading recent reports…</span>
      </div>
    );
  }

  if (!reports || reports.length === 0) {
    return (
      <div className="glass-card rounded-xl p-6 space-y-4" data-scroll-fade>
        <div className="space-y-1">
          <span className="eyebrow-label">Section 05 · Live Activity</span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        <p className="text-sm text-muted-foreground text-center py-6">
          No public reports yet. Be the first to share one with the community.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl p-4 sm:p-6 space-y-3 sm:space-y-4" data-scroll-fade>
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <span className="eyebrow-label">Section 05 · Live Activity</span>
          <h2 className="text-base sm:text-lg font-bold flex items-center gap-2">
            <Clock className="w-4 sm:w-5 h-4 sm:h-5 text-primary" />
            Recent Reports
          </h2>
        </div>
        <span className="text-[10px] sm:text-xs text-muted-foreground whitespace-nowrap mt-1">{total} public report{total !== 1 ? "s" : ""}</span>
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
