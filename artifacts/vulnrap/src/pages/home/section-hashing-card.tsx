import { useState } from "react";
import { Fingerprint, ChevronDown, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { similarityMethods } from "./data";
import { MethodologySuggestionFooter } from "./methodology-suggestion-footer";

export function SectionHashingCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card rounded-xl ring-1 ring-transparent hover:ring-cyan-400/30 focus-visible:ring-cyan-400/50 focus-visible:outline-none transition-all duration-200"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-cyan flex-shrink-0">
          <Fingerprint className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Section Hashing
            <ChevronDown
              className={`w-5 h-5 text-cyan-400/60 group-hover/card:text-cyan-400 transition-all duration-200 ${expanded ? "rotate-180 text-cyan-400" : ""}`}
            />
          </h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Each section is hashed independently, detecting partial matches
            across reports your team has received. Tap to see how.
          </p>
        </div>
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="rounded-lg bg-cyan-500/5 border border-cyan-500/20 px-3 py-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              We use five complementary algorithms to detect similarity. No
              single method catches everything — combining them reduces false
              negatives while keeping false positives low.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {similarityMethods.map((method) => (
              <div
                key={method.label}
                className="space-y-2 rounded-lg bg-muted/20 p-3"
              >
                <h4 className={`text-xs font-bold ${method.color}`}>
                  {method.label}
                </h4>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {method.description}
                </p>
                <ul className="space-y-1">
                  {method.details.map((detail, i) => (
                    <li
                      key={i}
                      className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5"
                    >
                      <span
                        className={`mt-1 w-1 h-1 rounded-full ${method.color.replace("text-", "bg-")} flex-shrink-0`}
                      />
                      {detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="border-t border-border/50 pt-3">
            <p className="text-[11px] font-semibold text-muted-foreground mb-2">
              Want the full methodology?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Link
                to="/how-it-works"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Pipeline walkthrough
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-cyan-400 transition-colors" />
              </Link>
              <Link
                to="/whitepaper"
                className="flex items-center justify-between gap-2 rounded-md bg-muted/20 hover:bg-muted/40 px-3 py-2 transition-colors group"
              >
                <span className="text-[11px] text-foreground">
                  Whitepaper (thresholds & match types)
                </span>
                <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-cyan-400 transition-colors" />
              </Link>
            </div>
          </div>
          <MethodologySuggestionFooter topic="Similarity Detection" />
        </div>
      )}
    </div>
  );
}
