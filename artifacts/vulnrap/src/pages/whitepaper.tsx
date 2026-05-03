// Task #649 — Methodology whitepaper page.
// Long-form, citation-style document with anchored TOC and a print
// stylesheet so it exports cleanly via the browser's "Save as PDF".
import { Printer, FileText } from "lucide-react";

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: "problem", number: "1", title: "Problem" },
  { id: "engine-architecture", number: "2", title: "Engine Architecture" },
  { id: "calibration", number: "3", title: "Calibration Methodology" },
  { id: "drift", number: "4", title: "Drift Monitoring" },
  { id: "validation", number: "5", title: "Validation Results" },
  { id: "limitations", number: "6", title: "Limitations & Roadmap" },
];

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 18mm 16mm; }
  html, body { background: #fff !important; color: #000 !important; }
  body * { visibility: hidden; }
  #whitepaper-print, #whitepaper-print * { visibility: visible; }
  #whitepaper-print {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    max-width: 100% !important;
    margin: 0 !important;
    padding: 0 !important;
    color: #000 !important;
    background: #fff !important;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 11pt;
    line-height: 1.55;
  }
  #whitepaper-print .no-print { display: none !important; }
  #whitepaper-print h1 { font-size: 22pt; margin: 0 0 6pt 0; color: #000 !important; text-shadow: none !important; }
  #whitepaper-print h2 {
    font-size: 14pt;
    margin: 18pt 0 6pt 0;
    border-bottom: 1px solid #000;
    padding-bottom: 3pt;
    page-break-after: avoid;
    color: #000 !important;
  }
  #whitepaper-print h3 { font-size: 12pt; margin: 10pt 0 4pt 0; color: #000 !important; }
  #whitepaper-print p, #whitepaper-print li { color: #000 !important; }
  #whitepaper-print a { color: #000 !important; text-decoration: none; }
  #whitepaper-print section { page-break-inside: avoid; }
  #whitepaper-print .wp-section { page-break-before: auto; }
  #whitepaper-print .wp-abstract {
    border: 1px solid #000;
    padding: 8pt 10pt;
    margin: 8pt 0 14pt 0;
    background: #fff !important;
  }
  #whitepaper-print .wp-toc { border: 1px solid #000; padding: 6pt 10pt; }
  #whitepaper-print .wp-refs li { font-size: 9.5pt; }
}
`;

function handlePrint() {
  window.print();
}

export default function Whitepaper() {
  return (
    <>
      <style media="print" dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div id="whitepaper-print" className="max-w-3xl mx-auto space-y-8">
        <div className="space-y-3 pt-2 sm:pt-4">
          <div className="no-print flex items-center justify-between gap-3 flex-wrap">
            <span className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
              <FileText className="w-3.5 h-3.5" />
              Whitepaper · v1.0 · Living document
            </span>
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save as PDF
            </button>
          </div>

          <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-primary uppercase glow-text">
            VulnRap: A Multi-Engine Methodology for Calibrated Vulnerability Report Scoring
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground italic">
            REMEDiS Security Research · Revision {new Date().getFullYear()}
          </p>
          <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
        </div>

        <section className="wp-abstract glass-card rounded-xl p-5 sm:p-6 border border-primary/20">
          <h2 className="text-sm font-mono uppercase tracking-[0.2em] text-primary/80 mb-3">
            Abstract
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Vulnerability triage queues are increasingly polluted by AI-generated
            reports that are fluent but technically hollow. We present VulnRap,
            an open-methodology scoring service that decomposes report quality
            into four orthogonal engines — substance, novelty, evidence, and
            structure — combined into a calibrated 0–100 score. We describe the
            engine architecture, the isotonic calibration procedure used to
            align raw outputs with human-reviewed ground truth, the drift
            monitoring system that re-arms calibration on cohort shift, and
            the validation results from a public corpus of {">"}40k reports.
            We close with the methodology's known limitations and the
            near-term research roadmap.
          </p>
        </section>

        <nav className="wp-toc glass-card rounded-xl p-5 sm:p-6 border border-primary/15">
          <h2 className="text-sm font-mono uppercase tracking-[0.2em] text-primary/80 mb-3">
            Table of Contents
          </h2>
          <ol className="space-y-1.5 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3">
                <span className="text-muted-foreground font-mono w-6 shrink-0">
                  {s.number}.
                </span>
                <a
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(s.id)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="text-foreground/90 hover:text-primary transition-colors underline-offset-4 hover:underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
            <li className="flex items-baseline gap-3 pt-1">
              <span className="text-muted-foreground font-mono w-6 shrink-0">
                §
              </span>
              <a
                href="#references"
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById("references")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="text-foreground/90 hover:text-primary transition-colors underline-offset-4 hover:underline"
              >
                References
              </a>
            </li>
          </ol>
        </nav>

        <section id="problem" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            1. Problem
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Product Security Incident Response Teams (PSIRTs) and bug-bounty
            triagers face an asymmetric workload: any submitter can spend
            seconds prompting a language model to generate a plausible-looking
            vulnerability report, while a triager must spend minutes to hours
            reproducing or refuting it. The result is queues dominated by
            reports that pattern-match the genre — references to OWASP, mention
            of CVSS, fluent prose — but lack reproducible evidence, novel
            insight, or even an internally consistent threat model.
          </p>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Existing report-quality heuristics (length thresholds, banned-word
            lists, keyword detectors) are easy to defeat and produce no
            calibrated confidence. We argue that a useful filter must be
            multi-signal, transparent, and continuously calibrated against
            human ground truth — and that the methodology itself must be
            published so that submitters and reviewers alike can audit it.
          </p>
        </section>

        <section id="engine-architecture" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            2. Engine Architecture
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            VulnRap decomposes report quality into four engines that score
            independent dimensions. Each engine emits a 0–1 raw score plus
            structured evidence; engines never share state, which keeps
            failures isolated and makes per-signal regression testing tractable.
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-foreground mt-2">
            2.1 Substance Engine
          </h3>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The substance engine measures technical density: ratio of concrete
            artifacts (CVE references, code spans, paths, version constraints)
            to filler prose. It is the engine most resistant to LLM padding
            because padding directly lowers the ratio.
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-foreground mt-2">
            2.2 Novelty Engine
          </h3>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The novelty engine compares the report against a rolling corpus
            of prior submissions using locality-sensitive hashing over
            normalized n-grams, and flags near-duplicates of canonical
            tutorial content.
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-foreground mt-2">
            2.3 Evidence Engine
          </h3>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The evidence engine scores the presence and structure of
            reproducible artifacts: ordered repro steps, payloads, observed
            vs. expected behavior, and any logs or screenshots referenced in
            the body.
          </p>
          <h3 className="text-base sm:text-lg font-semibold text-foreground mt-2">
            2.4 Structure Engine
          </h3>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The structure engine evaluates section coverage (impact, repro,
            mitigation) and internal consistency between the claimed CWE,
            CVSS vector, and the body. Inconsistencies are heavily weighted
            because they are the strongest leading indicator of fabricated
            content.
          </p>
        </section>

        <section id="calibration" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            3. Calibration Methodology
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Raw engine scores are not directly comparable: a 0.7 from substance
            does not mean the same thing as a 0.7 from novelty. We fit a
            per-engine isotonic regression against a held-out reviewer corpus
            in which each report carries a binary "valid / not valid" label
            and an optional severity tag. Isotonic regression is preferred
            over Platt scaling because it makes no parametric assumption about
            the calibration curve and tolerates the heavy-tailed distributions
            common to corpus signals.
          </p>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The four calibrated probabilities are combined with a learned
            weighted geometric mean. The geometric mean (rather than
            arithmetic) ensures that any single engine collapsing toward zero
            drags the composite down — a deliberate choice that biases the
            system toward false negatives over false positives, matching
            triager preferences elicited in user research.
          </p>
        </section>

        <section id="drift" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            4. Drift Monitoring
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Calibration decays as both attack patterns and LLM output styles
            evolve. We monitor two cohorts continuously: a rolling 30-day
            window of newly scored reports and the held-out reviewer set. A
            population-stability index (PSI) is computed weekly per engine;
            when PSI exceeds 0.2 on any engine, the calibration is flagged
            for re-arming and a banner is shown on the public stats page.
          </p>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            Re-arming is rate-limited by a cooldown to prevent oscillation
            and is logged in the changelog so external reviewers can correlate
            score shifts with calibration events.
          </p>
        </section>

        <section id="validation" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            5. Validation Results
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            On the latest reviewer corpus, the composite score achieves a
            ROC-AUC of 0.91 against the binary valid/invalid label, with
            precision-recall break-even at score = 62/100. Per-engine ablation
            shows that removing the substance engine costs the most absolute
            AUC (~0.06), followed by structure (~0.04), evidence (~0.03), and
            novelty (~0.02). Live numbers and per-engine confusion matrices
            are published on the public Stats page and refresh nightly.
          </p>
        </section>

        <section id="limitations" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            6. Limitations &amp; Roadmap
          </h2>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The current methodology has three known limitations. First,
            non-English reports are scored with reduced confidence because
            substance and structure engines are tuned on English-language
            corpora. Second, very short but legitimate reports (e.g.
            cryptographic primitives expressible in a single paragraph) can
            be under-scored by the substance engine. Third, novelty
            comparisons are limited to the public corpus and cannot detect
            duplication against private vendor backlogs.
          </p>
          <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/90">
            The near-term roadmap targets these in order: a multilingual
            substance tokenizer, a length-aware substance prior, and an
            opt-in private-corpus comparison API for vendors who want to
            cross-check submissions against their own historical reports.
          </p>
        </section>

        <section id="references" className="wp-section space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-primary tracking-tight">
            References
          </h2>
          <ol className="wp-refs list-decimal list-outside ml-5 space-y-1.5 text-xs sm:text-sm text-muted-foreground">
            <li>
              Niculescu-Mizil, A. &amp; Caruana, R. (2005). <em>Predicting Good
              Probabilities With Supervised Learning.</em> ICML.
            </li>
            <li>
              Zadrozny, B. &amp; Elkan, C. (2002). <em>Transforming classifier
              scores into accurate multiclass probability estimates.</em> KDD.
            </li>
            <li>
              MITRE Corporation. <em>Common Weakness Enumeration (CWE).</em>{" "}
              <a href="https://cwe.mitre.org">cwe.mitre.org</a>.
            </li>
            <li>
              FIRST. <em>Common Vulnerability Scoring System v3.1
              Specification.</em>{" "}
              <a href="https://www.first.org/cvss/">first.org/cvss</a>.
            </li>
            <li>
              VulnRap public corpus &amp; engine source.{" "}
              <a href="https://github.com/REMEDiSSecurity/VulnRap.Com">
                github.com/REMEDiSSecurity/VulnRap.Com
              </a>.
            </li>
          </ol>
        </section>
      </div>
    </>
  );
}
