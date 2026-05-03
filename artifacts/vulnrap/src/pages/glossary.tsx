import { useMemo } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface Term {
  term: string;
  short: string;
  long: string;
  link?: { to: string; label: string };
}

const TERMS: Term[] = [
  {
    term: "Absence Penalty",
    short: "A score deduction applied when an expected signal is missing from a report.",
    long: "Many CWE families have a small set of evidence types that a credible report is expected to include — for example, a memory-corruption report should mention an offset, a register, or a crash trace. When those expected markers are absent, the engine applies a calibrated absence penalty rather than passively ignoring the gap. Penalties are bounded so a single missing signal cannot dominate a score.",
    link: { to: "/engines/substance", label: "Substance Engine" },
  },
  {
    term: "Archetype",
    short: "A canonical shape that real reports of a given CWE family tend to take.",
    long: "Archetypes are reference patterns derived from the public corpus — the typical sections, evidence ordering, and proof-of-concept density seen in legitimate reports for a CWE. A submitted report is compared against the archetype for its claimed CWE; large structural deviations contribute to the slop score. Archetypes are versioned alongside the corpus.",
    link: { to: "/architecture", label: "Architecture" },
  },
  {
    term: "AVRI",
    short: "Aggregate Vulnerability Report Index — the headline 0–100 score.",
    long: "AVRI is the composite index produced by combining the per-engine outputs (linguistic, substance, CWE coherence, and others) under the active preset's weights. Higher AVRI means more credible; lower AVRI flags the report for slop. AVRI is intentionally bounded and monotonic so triagers can set a single numeric cutoff for a queue.",
    link: { to: "/engines/substance", label: "Engine deep-dive" },
  },
  {
    term: "AVRI Drift",
    short: "Movement of AVRI for the same input over time, usually from engine recalibration.",
    long: "When models, weights, or signal definitions change, previously scored reports can shift score. Drift is monitored on the golden corpus and surfaced as a per-release metric so consumers can decide whether to re-score historical reports or freeze on a specific engine version.",
    link: { to: "/changelog", label: "Changelog" },
  },
  {
    term: "Citation Density",
    short: "Citations per 1000 words of report body.",
    long: "A substance signal that counts inline references to CVEs, CWE IDs, RFCs, advisories, source files, line numbers, or commit hashes. Low density on a report claiming high severity is a slop indicator; very high density without surrounding analysis is also flagged as 'citation stuffing.'",
  },
  {
    term: "Cooldown",
    short: "A minimum time-between-firings for a signal to prevent score thrash.",
    long: "Some signals — particularly drift- and trend-based ones — are stateful. A cooldown prevents the same condition from re-triggering scoring penalties on every refresh. Cooldowns are recorded in the audit log so operators can see why an expected signal did not fire.",
    link: { to: "/audit-log", label: "Audit Log" },
  },
  {
    term: "Coherence",
    short: "Whether the body of a report actually describes the CWE it claims.",
    long: "The CWE Coherence Engine extracts what the report is technically describing and compares it against the claimed CWE ID. A mismatch (e.g. a body describing path traversal filed as CWE-89 SQL injection) is one of the strongest single slop signals.",
    link: { to: "/engines/cwe-coherence", label: "CWE Coherence Engine" },
  },
  {
    term: "Corpus",
    short: "The labeled set of public reports used for calibration and regression.",
    long: "The corpus is a curated, versioned snapshot of public vulnerability reports with labels for CWE, severity, and slop status. It is used to fit weights, derive archetypes, and run regression checks before each engine release.",
    link: { to: "/corpus-stats", label: "Corpus Stats" },
  },
  {
    term: "CWE Family",
    short: "A grouping of related CWEs that share signals and archetypes.",
    long: "Rather than treating every CWE-N identifier in isolation, the engine groups closely related weaknesses (e.g. memory-safety variants, injection variants) into families that share substance signals and absence penalties. This keeps calibration tractable for less common CWEs.",
    link: { to: "/cwe", label: "CWE Reference" },
  },
  {
    term: "Evidence Marker",
    short: "A concrete artifact in the report — a stack trace, payload, screenshot, or command.",
    long: "Evidence markers are the smallest unit of substance the engine recognizes. Each marker has a type (trace, payload, request, screenshot, repro command, log line) and contributes differently to the substance score depending on the CWE family.",
  },
  {
    term: "Fingerprint",
    short: "A normalized representation of a report used for duplicate and similarity checks.",
    long: "Fingerprints are content-derived hashes of normalized text and structure. They are used to detect resubmissions, near-duplicates across reporters, and corpus contamination. Fingerprints are not reversible — they cannot reconstruct the original report.",
  },
  {
    term: "Gold Signal",
    short: "A high-confidence signal that, on its own, strongly classifies a report.",
    long: "Most signals contribute fractionally. A small set of gold signals — for example, a verifiable working PoC against a pinned commit, or a confirmed CWE-coherence violation — are weighted high enough to dominate the AVRI on their own. Gold signals are reviewed manually before promotion.",
    link: { to: "/signals", label: "Signal Reference" },
  },
  {
    term: "Golden Corpus",
    short: "A frozen subset of the corpus used for release-gating regression tests.",
    long: "Before any engine release, the new build is run against the golden corpus and its scores are compared against the previous build's. A delta beyond a published threshold blocks the release. The golden corpus is intentionally small and stable.",
  },
  {
    term: "Headroom",
    short: "How far the current score sits from the next classification boundary.",
    long: "Headroom expresses, for a given report, how many additional positive (or negative) signal points would be needed to push it across the next decision threshold (e.g. from T2 into T3). It is shown in the result view to help triagers understand fragile classifications.",
  },
  {
    term: "Hit Rate",
    short: "How often a signal fires across the public corpus.",
    long: "Each signal has a published hit rate measured on the corpus. Very low hit rates can indicate the signal is overly specific; very high hit rates can indicate it has lost discriminative power. Hit rates are recomputed per release.",
    link: { to: "/signals", label: "Signal Reference" },
  },
  {
    term: "Linguistic Engine",
    short: "Engine 1 — measures stylistic markers of LLM-generated prose.",
    long: "The linguistic engine looks at sentence rhythm, transition patterns, vocabulary distribution, and other surface features that distinguish written-by-a-human security reports from common LLM output. It is one input to AVRI and is intentionally weighted lower than substance.",
  },
  {
    term: "Preset",
    short: "A named bundle of engine weights and thresholds for a workflow.",
    long: "Presets package per-engine weights, the AVRI cutoff, and which signals are required vs. advisory into a single profile (e.g. 'Bug bounty triage,' 'CNA intake,' 'Internal red team'). Presets are versioned and can be pinned per request.",
    link: { to: "/presets", label: "Presets" },
  },
  {
    term: "Proof-of-Concept (PoC)",
    short: "A reproducible demonstration that the vulnerability exists.",
    long: "A PoC ranges from a textual repro recipe to a working exploit payload. The substance engine scores PoC quality by checking pinning (commit, version, environment), determinism markers, and whether the PoC actually exercises the claimed weakness.",
  },
  {
    term: "Redaction",
    short: "Automatic removal of secrets and PII before storage or display.",
    long: "Submitted reports pass through a redaction pass that masks tokens, keys, internal hostnames, and personally identifying information. Redacted spans are preserved as length-only placeholders so structure is not lost.",
    link: { to: "/redaction-examples", label: "Redaction Examples" },
  },
  {
    term: "Score Bands (T1–T4)",
    short: "Four classification tiers derived from AVRI.",
    long: "T1 (likely slop), T2 (suspect), T3 (credible), T4 (high-confidence). Bands are derived from AVRI thresholds set by the active preset. Tier transitions are conservative — the engine prefers leaving a borderline report in the lower tier and surfacing headroom.",
  },
  {
    term: "Signal",
    short: "A single named detector that contributes a delta to AVRI.",
    long: "Signals are the atomic unit of scoring. Each has a definition, an owning engine, a hit-rate on the corpus, and a calibrated weight. A report's score breakdown lists every signal that fired, how much it contributed, and a citation back to the spans of text that triggered it.",
    link: { to: "/signals", label: "Signal Reference" },
  },
  {
    term: "Slop",
    short: "Low-quality, often LLM-generated, vulnerability reports that waste triage time.",
    long: "Slop is the category VulnRap exists to detect: reports that look superficially like a real vulnerability disclosure but lack substance, coherence, or reproducibility. Slop is not always intentional — well-meaning reporters using AI assistance can produce it too — and the engine tries to be diagnostic rather than punitive.",
    link: { to: "/how-it-works", label: "How It Works" },
  },
  {
    term: "Span",
    short: "A character range in the report that triggered a signal.",
    long: "When a signal fires, it records the span(s) of source text responsible. The result view highlights spans inline so reviewers can audit why each signal contributed. Spans survive redaction by referring to post-redaction offsets.",
  },
  {
    term: "Structural Fabrication",
    short: "Invented but plausible-sounding artifacts — fake CVE IDs, hallucinated line numbers, non-existent functions.",
    long: "A subclass of slop where the report contains specific, citable-looking details that do not actually exist in the target software. Structural fabrication is detected by cross-referencing claims against the cited source, advisories, or CVE records when available.",
  },
  {
    term: "Substance Engine",
    short: "Engine 2 — measures technical density and evidence per claim.",
    long: "The substance engine quantifies how much real, verifiable technical content the report carries: evidence markers, citations, PoC quality, and per-CWE expected signals. It is the single highest-weight engine in most presets.",
    link: { to: "/engines/substance", label: "Substance Engine" },
  },
  {
    term: "Threshold",
    short: "A configured AVRI cutoff that maps to a triage action.",
    long: "Thresholds are preset-defined AVRI values that determine band assignment and downstream actions (auto-close, queue, escalate). Operators can override thresholds per request without forking a preset.",
  },
  {
    term: "Triage Queue",
    short: "An ordered list of reports awaiting human review.",
    long: "VulnRap does not auto-close reports. Its job is to score, cite, and order the queue so human triagers spend their time on the credible end. Queue ordering uses AVRI plus tiebreakers (recency, CWE severity, headroom).",
  },
  {
    term: "Verification",
    short: "A signed, time-stamped record that a specific report received a specific score.",
    long: "Each scored report receives a verification token so consumers (program owners, CNAs, downstream tools) can confirm later that the displayed score was actually produced by the engine and has not been tampered with.",
    link: { to: "/check", label: "Check a verification" },
  },
  {
    term: "Weight",
    short: "The multiplier applied to a signal's contribution to AVRI.",
    long: "Weights are fit on the corpus per preset. They are visible — every report's breakdown shows the per-signal weight in effect — and tunable in the playground for what-if analysis.",
    link: { to: "/playground", label: "Scoring Playground" },
  },
  {
    term: "Whitepaper",
    short: "The long-form, citation-style document of the full methodology.",
    long: "Where this glossary gives you the working vocabulary, the whitepaper gives you the math, the corpus methodology, the calibration procedure, and the references. It is the canonical specification of the engine.",
    link: { to: "/whitepaper", label: "Whitepaper" },
  },
];

function slug(term: string) {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default function GlossaryPage() {
  const sorted = useMemo(
    () => [...TERMS].sort((a, b) => a.term.localeCompare(b.term)),
    []
  );

  const byLetter = useMemo(() => {
    const map = new Map<string, Term[]>();
    for (const t of sorted) {
      const letter = t.term[0].toUpperCase();
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(t);
    }
    return map;
  }, [sorted]);

  const letters = Array.from(byLetter.keys());

  return (
    <div className="max-w-5xl mx-auto space-y-8 scroll-smooth">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-primary" />
          Glossary
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Working vocabulary for VulnRap — the scoring engine, the signals, and the report-quality
          concepts that show up across the docs and blog. Each entry links to the deeper reference
          where one exists.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-3 font-mono">
          {TERMS.length} terms · alphabetical
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-1.5" aria-label="Jump to letter">
            {letters.map(l => (
              <a
                key={l}
                href={`#letter-${l}`}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-sm font-mono font-semibold border border-primary/20 text-primary/80 hover:bg-primary/10 hover:text-primary hover:border-primary/50 transition-colors"
              >
                {l}
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-10">
        {letters.map(letter => (
          <section
            key={letter}
            id={`letter-${letter}`}
            className="scroll-mt-20 space-y-4"
          >
            <h2 className="text-2xl font-bold font-mono text-primary border-b border-primary/20 pb-2">
              {letter}
            </h2>
            <div className="space-y-4">
              {byLetter.get(letter)!.map(term => (
                <article
                  key={term.term}
                  id={slug(term.term)}
                  className="scroll-mt-20 rounded-lg border border-border bg-card/30 backdrop-blur p-5 hover:border-primary/40 transition-colors"
                >
                  <header className="flex items-baseline justify-between gap-3 flex-wrap">
                    <h3 className="text-lg font-semibold tracking-tight">
                      <a
                        href={`#${slug(term.term)}`}
                        className="hover:text-primary transition-colors"
                      >
                        {term.term}
                      </a>
                    </h3>
                    {term.link && (
                      <Link
                        to={term.link.to}
                        className="text-xs font-mono inline-flex items-center gap-1 text-primary/70 hover:text-primary"
                      >
                        {term.link.label}
                        <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    )}
                  </header>
                  <p className="mt-1 text-sm text-foreground/90">{term.short}</p>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{term.long}</p>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="text-center text-xs text-muted-foreground/50 pt-4 pb-2">
        Missing a term?{" "}
        <a
          href="mailto:remedisllc@gmail.com?subject=VulnRap%20Glossary"
          className="text-primary/70 hover:text-primary"
        >
          Suggest one
        </a>
        .
      </div>
    </div>
  );
}
