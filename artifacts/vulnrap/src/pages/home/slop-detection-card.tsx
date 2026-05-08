import { lazy, Suspense, useState } from "react";
import { Eye, ChevronDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { slopTiers } from "./data";
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
      style={{
        background:
          "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)",
      }}
      aria-hidden
    >
      <div className="w-5 h-5 border-2 border-cyan-400/60 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function SlopDetectionCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}
    >
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
            <ChevronDown
              className={`w-5 h-5 text-violet-400/60 group-hover/card:text-violet-400 transition-all duration-200 ${expanded ? "rotate-180 text-violet-400" : ""}`}
            />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Three engines vote — Technical Substance (60%), CWE Coherence
            (35%), and AI Authorship (5%) — and fuse into a single composite
            score plus a triage label. Tap for the pipeline diagram.
          </p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">
          <Suspense fallback={<DiagramFallback />}>
            <ScoringPipelineDiagram />
          </Suspense>

          <div className="rounded-lg bg-violet-500/5 border border-violet-500/20 px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground/85 leading-relaxed">
              <span className="text-violet-300 font-semibold">AVRI:</span>{" "}
              Engine 2 uses one of eight CWE-family-specific rubrics (memory
              corruption, injection, auth/access, crypto, DoS, info exposure,
              SSRF, hardware) with family-specific gold signals and absence
              penalties. Weights stay 5/60/35; only Engine 2's internals change.
            </p>
          </div>

          <div className="border-t border-border/50 pt-3 space-y-2">
            <h4 className="text-xs font-bold text-foreground">Score Tiers</h4>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {slopTiers.map((t) => (
                <div
                  key={t.tier}
                  className={`rounded-md ${t.bg} px-2.5 py-1.5 text-center`}
                >
                  <p className={`text-[11px] font-bold ${t.color}`}>{t.tier}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {t.range}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              A high score means the report shows patterns commonly seen in
              AI-generated text — not a proof that it's AI-written. A low score
              means the writing looks human, not that the vulnerability is
              real.
            </p>
          </div>

          <div className="border-t border-border/50 pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground mb-2">
              Want the full methodology?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Link
                to="/engines"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Engines overview & weights
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-violet-400 transition-colors" />
              </Link>
              <Link
                to="/how-it-works"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Pipeline walkthrough
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-violet-400 transition-colors" />
              </Link>
              <Link
                to="/whitepaper"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Whitepaper (calibration & limits)
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-violet-400 transition-colors" />
              </Link>
              <Link
                to="/signals"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Every detector signal
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-violet-400 transition-colors" />
              </Link>
            </div>
          </div>
          <MethodologySuggestionFooter topic="Slop Detection" />
        </div>
      )}
    </div>
  );
}
