import { lazy, Suspense, useState } from "react";
import { Eye, ChevronDown } from "lucide-react";
import { authenticitySignals, llmSubstanceDimensions, slopTiers } from "./data";
import { MethodologySuggestionFooter } from "./methodology-suggestion-footer";

// The worked-example diagram is the heaviest piece of this card (large
// inline SVGs + worked-example math). It only renders when the user
// expands the card, so we lazy-load it to keep it out of the home page's
// initial bundle.
const ScoringPipelineDiagram = lazy(() => import("./scoring-pipeline-diagram"));

function DiagramFallback() {
  return (
    <div
      className="relative rounded-xl border border-cyan-500/15 p-3 sm:p-5 min-h-[260px] flex items-center justify-center"
      style={{ background: "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)" }}
      aria-hidden
    >
      <div className="w-5 h-5 border-2 border-cyan-400/60 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function SlopDetectionCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card rounded-xl ring-1 ring-transparent hover:ring-violet-400/30 focus-visible:ring-violet-400/50 focus-visible:outline-none transition-all duration-200"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-violet flex-shrink-0">
          <Eye className="w-4 h-4 sm:w-5 sm:h-5 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Validity Scoring
            <ChevronDown className={`w-5 h-5 text-violet-400/60 group-hover/card:text-violet-400 transition-all duration-200 ${expanded ? "rotate-180 text-violet-400" : ""}`} />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">Three-engine composite scoring: Technical Substance (60%), CWE Coherence (35%), and AI Authorship (5%) vote with different weights and fuse into a single composite score and triage label. CWE Coherence is capped when Substance reports near-zero evidence, so a report can't earn 24 composite points just for naming the right CWE number. Tap to see how.</p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">

          <Suspense fallback={<DiagramFallback />}>
            <ScoringPipelineDiagram />
          </Suspense>

          <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground/85 leading-relaxed">
              <span className="text-violet-300 font-semibold">AVRI (default on as of v3.9.0, kill-switch <span className="font-mono">VULNRAP_USE_AVRI=false</span>):</span> swaps Engine 2's rubric for one of eight CWE-family-specific rubrics (memory corruption, injection, auth/access, crypto/protocol, DoS/resource, info exposure, request forgery, hardware) with family-specific gold signals and absence penalties. Weights stay 5/60/35; only Engine 2's internals change. Sprint 12 calibration confirmed the slop/legit gap holds at 31 points (slop ≤23, legit ≥54). The legacy <span className="font-mono">slopScore</span> API field is mapped from the composite for backward compatibility.
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
                          <span key={phrase} className="text-[10px] sm:text-[9px] bg-violet-500/10 text-violet-300 px-1.5 py-0.5 rounded font-mono">
                            {phrase}
                          </span>
                        ))}
                        <span className="text-[10px] sm:text-[9px] text-muted-foreground px-1.5 py-0.5">+18 more...</span>
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
                            <span className="text-[10px] sm:text-[9px] text-orange-400/80 font-mono whitespace-nowrap">{check.points}</span>
                          </div>
                          <p className="text-[10px] sm:text-[9px] text-muted-foreground mt-0.5 leading-snug">{check.example}</p>
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
