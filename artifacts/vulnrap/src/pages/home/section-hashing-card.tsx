import { useState } from "react";
import { Fingerprint, ChevronDown } from "lucide-react";
import { similarityMethods, matchTypes } from "./data";
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

          <div className="border-t border-border/50 pt-3 space-y-2">
            <h4 className="text-xs font-bold text-foreground">
              Match Classification
            </h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {matchTypes.map((mt) => (
                <div
                  key={mt.type}
                  className="rounded-md bg-muted/30 px-2.5 py-1.5"
                >
                  <p className={`text-[11px] font-medium ${mt.color}`}>
                    {mt.type}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {mt.threshold}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              The final similarity score is the maximum of Jaccard and SimHash
              scores. Only reports exceeding the 15% threshold appear in
              results. Top 10 matches are returned, sorted by similarity.
            </p>
          </div>
          <MethodologySuggestionFooter topic="Similarity Detection" />
        </div>
      )}
    </div>
  );
}
