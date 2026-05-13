import { useState, useEffect } from "react";
import { X, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

const STORAGE_KEY = "vulnrap_slopdemic_dismissed";

export function SlopdemicInsight() {
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
  }, []);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
    }
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Security insight"
      className="fixed bottom-4 left-4 z-40 w-[calc(100vw-2rem)] max-w-sm"
      style={{ fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <div className="rounded-xl border border-border bg-card/95 shadow-2xl shadow-black/40 dark:shadow-black/60 backdrop-blur-md overflow-hidden">
        {/* Header row */}
        <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
          <div className="shrink-0 mt-0.5">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/20 text-primary text-[9px] font-bold leading-none">
              !
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-primary/80 uppercase tracking-widest leading-none mb-1">
              Security Insight
            </p>
            <p className="text-[13px] font-medium text-foreground leading-snug">
              Fighting the Slopdemic: Are AI&#x2011;generated junk reports slowing you down?
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 -mt-0.5 -mr-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Learn More toggle */}
        <div className="px-4 pb-3">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 transition-colors font-medium"
          >
            {expanded ? (
              <>
                Hide <ChevronUp className="w-3 h-3" />
              </>
            ) : (
              <>
                Learn More <ChevronDown className="w-3 h-3" />
              </>
            )}
          </button>
        </div>

        {/* Expandable body */}
        {expanded && (
          <div className="border-t border-white/8 px-4 py-3.5 space-y-3">
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              Bugcrowd founder{" "}
              <span className="text-foreground font-medium">Casey Ellis</span>{" "}
              recently warned of the{" "}
              <span className="text-primary font-medium">&ldquo;Slopdemic&rdquo;</span>
              {" "}— a flood of low-quality, AI-generated vulnerability reports.
              At VulnRap, we focus on high-signal remediation so you can fix
              real risks, not chase ghosts.
            </p>

            <div className="flex flex-col gap-1.5">
              <a
                href="https://youtu.be/QtcBhb_aqxk"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[11px] text-muted-foreground hover:text-primary transition-colors group"
              >
                <span className="shrink-0 w-4 h-4 rounded bg-red-600/80 flex items-center justify-center">
                  <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 fill-white">
                    <path d="M6 4l6 4-6 4V4z" />
                  </svg>
                </span>
                <span className="group-hover:underline underline-offset-2">
                  Watch: Casey Ellis on the Slopdemic
                </span>
                <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
              </a>

              <a
                href="https://www.linkedin.com/pulse/thoughts-slopdemic-casey-ellis-zi1xc/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[11px] text-muted-foreground hover:text-primary transition-colors group"
              >
                <span className="shrink-0 w-4 h-4 rounded bg-[#0a66c2]/80 flex items-center justify-center">
                  <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 fill-white">
                    <path d="M2 2h3v10H2V2zm1.5-1.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM6.5 6H9v1.1C9.4 6.4 10.2 6 11 6c2 0 3 1.2 3 3.5V12h-2.5V10c0-1-.4-1.5-1.1-1.5-.8 0-1.4.6-1.4 1.7V12H6.5V6z" />
                  </svg>
                </span>
                <span className="group-hover:underline underline-offset-2">
                  Read: Thoughts on the Slopdemic
                </span>
                <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
