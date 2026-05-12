import { useState } from "react";
import {
  Lock,
  Shield,
  Zap,
  ShieldCheck,
  ChevronDown,
  Trash2,
  BrainCircuit,
} from "lucide-react";

export function TransparencySection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div id="section-privacy" className="glass-card rounded-xl overflow-hidden scroll-mt-20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3 sm:p-4 flex items-center justify-between gap-3 text-left cursor-pointer group/card rounded-xl ring-1 ring-transparent hover:ring-cyan-400/30 focus-visible:ring-cyan-400/50 focus-visible:outline-none transition-all duration-200"
        aria-expanded={expanded}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap min-w-0 flex-1">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Lock className="w-4 h-4 text-primary" />
            Where your data goes
          </h2>
          <span className="eyebrow-label">Section 05 · Privacy</span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-cyan-400/60 group-hover/card:text-cyan-400 transition-all duration-200 flex-shrink-0 ${expanded ? "rotate-180 text-cyan-400" : ""}`}
        />
      </button>

      {expanded && (
        <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-cyan-500/5 border border-cyan-500/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
                <Shield className="w-4 h-4" />
                What Happens in Your Browser
              </h3>
              <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-cyan-400 mt-0.5">1.</span>You select a
                  file, paste text, or enter a URL — your raw content stays in
                  your browser until you hit Submit.
                </li>
                <li className="flex gap-2">
                  <span className="text-cyan-400 mt-0.5">2.</span>File type
                  validation (.txt, .md, .pdf) and size checks (5MB max) run
                  entirely in the browser.
                </li>
                <li className="flex gap-2">
                  <span className="text-cyan-400 mt-0.5">3.</span>No content is
                  sent to our server until you explicitly submit. There is no
                  background upload, no preview processing, no analytics on your
                  text.
                </li>
                <li className="flex gap-2">
                  <span className="text-cyan-400 mt-0.5">4.</span>After
                  submission, a one-time delete token is stored in your
                  browser's session storage. This token lets you delete your
                  report — it is never sent to any third party and is lost when
                  you close the tab.
                </li>
              </ul>
            </div>

            <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-violet-400 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                What Happens on Our Server
              </h3>
              <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">1.</span>Your raw
                  text is received over HTTPS. For URLs, we fetch the content
                  server-side (HTTPS only, allowlisted hosts).
                </li>
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">2.</span>The
                  redaction engine runs immediately — regex patterns strip PII,
                  secrets, credentials, and company names. The raw text is
                  discarded and never stored.
                </li>
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">3.</span>All analysis
                  (hashing, similarity, slop scoring) runs on the redacted text
                  only.
                </li>
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">4.</span>The
                  three-engine composite scorer analyzes the redacted text in
                  server memory — Engine 1 AI Authorship (linguistic, template,
                  spectral), Engine 2 Technical Substance (evidence quality,
                  references, reproducibility, PoC integrity, claim/evidence
                  ratio — or the matching CWE-family rubric when AVRI is
                  enabled), and Engine 3 CWE Coherence. The original
                  (pre-redaction) text is never written to disk or database.
                  When the optional LLM is enabled and the heuristic score is
                  borderline, the redacted version is sent to the configured AI
                  provider for a substance second opinion that blends into
                  Engine 2. The three engines fuse with fixed weights —
                  Substance 60%, Coherence 35%, Authorship 5% — into a single
                  composite, with Engine 3 capped against Engine 2 so reports
                  without evidence can't earn coherence points for citing the
                  right CWE alone, and the legacy{" "}
                  <span className="font-mono">slopScore</span> field is mapped
                  from that composite for backward compatibility.
                </li>
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
                <h4 className="text-xs font-bold text-foreground">
                  Stored in PostgreSQL
                </h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>SHA-256
                    content hash (of redacted text)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>SimHash
                    fingerprint (64-bit structural hash)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>MinHash
                    signature (128 integer array)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>LSH bucket
                    keys (16 band hashes)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Per-section
                    SHA-256 hashes
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Slop score,
                    tier, and feedback
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Similarity
                    match results
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Redaction
                    summary (counts, not content)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Redacted
                    text (only in "full" mode)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>File name
                    and size
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Delete token
                    (for owner-initiated deletion)
                  </li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">
                  Never Stored
                </h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Your original
                    (pre-redaction) text
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Your IP
                    address or browser fingerprint
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Cookies, login
                    tokens, or session IDs
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Any PII that
                    was redacted
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Analytics,
                    tracking, or telemetry data
                  </li>
                  <li className="flex gap-2">
                    <span className="text-red-400">&#10007;</span>Source URLs
                    (if you linked a report)
                  </li>
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
              When you submit a report, we return a one-time{" "}
              <strong className="text-foreground">delete token</strong> stored
              in your browser's session storage. As long as your browser session
              is active (you haven't closed the tab or cleared storage), you can
              delete your report from the results page. Deletion is permanent —
              it removes the report row, all associated hashes, similarity
              records, and redacted text from our database. We use timing-safe
              comparison to validate the token, so brute-force attacks are not
              practical.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Important:</strong> If you
              close your tab or clear session storage, the delete token is gone.
              We cannot recover it, and we cannot delete the report on your
              behalf — by design, we have no way to identify who submitted what.
            </p>
          </div>

          <div className="rounded-xl bg-blue-500/5 border border-blue-500/20 p-4 space-y-3">
            <h3 className="text-sm font-bold text-blue-400 flex items-center gap-2">
              <BrainCircuit className="w-4 h-4" />
              How We Handle AI Analysis
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">
                  When AI analysis is enabled (default)
                </h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="text-blue-400">1.</span>Your report text is
                    PII-redacted first (unless you disable redaction).
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-400">2.</span>The redacted text
                    is truncated to 6,000 characters.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-400">3.</span>That truncated
                    snippet is sent to the{" "}
                    <span className="text-foreground font-medium">
                      OpenAI API
                    </span>{" "}
                    (gpt-4o-mini) via a managed proxy for substance analysis
                    across 5 dimensions: PoC validity, claim specificity, domain
                    coherence, substance depth, and internal coherence.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-400">4.</span>OpenAI's API data
                    policy: they do{" "}
                    <strong className="text-foreground">not</strong> train on
                    API data.{" "}
                    <a
                      href="https://openai.com/enterprise-privacy/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Read their policy
                    </a>
                    .
                  </li>
                  <li className="flex gap-2">
                    <span className="text-blue-400">5.</span>The LLM's substance
                    scores are blended 50/50 with heuristic validity scores. If
                    they disagree by more than 30 points, the more conservative
                    (lower) score is used.
                  </li>
                </ul>
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-foreground">
                  When AI analysis is disabled
                </h4>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>No data
                    leaves the server — analysis is purely local.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Heuristic,
                    linguistic, factual, and active verification axes still run.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Results may
                    be less precise for edge cases where LLM semantic analysis
                    would have caught subtleties.
                  </li>
                  <li className="flex gap-2">
                    <span className="text-green-400">&#10003;</span>Use the
                    "Skip AI analysis" toggle in the submission form to opt out.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-border/50 pt-3">
            We use no third-party analytics, tracking pixels, or CDNs. The
            entire application is self-contained. If you want to verify any of
            this, the redaction, hashing, and scoring logic is documented in the
            expandable cards above with exact algorithm details and thresholds.
            The full source code is{" "}
            <a
              href="https://github.com/REMEDiSSecurity/VulnRap.Com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              available on GitHub
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}

export default TransparencySection;
