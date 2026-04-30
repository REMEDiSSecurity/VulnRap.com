import { useState } from "react";
import { ShieldCheck, ChevronDown, AlertTriangle } from "lucide-react";
import { redactionCategories } from "./data";
import { MethodologySuggestionFooter } from "./methodology-suggestion-footer";

export function AutoRedactionCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`feature-card rounded-xl glass-card transition-all duration-300 ${expanded ? "sm:col-span-3" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-3 p-4 sm:p-5 w-full text-left cursor-pointer group/card rounded-xl ring-1 ring-transparent hover:ring-green-400/30 focus-visible:ring-green-400/50 focus-visible:outline-none transition-all duration-200"
        aria-expanded={expanded}
      >
        <div className="p-2 sm:p-2.5 rounded-lg icon-glow-green flex-shrink-0">
          <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold mb-1 flex items-center gap-2">
            Auto-Redaction
            <ChevronDown className={`w-5 h-5 text-green-400/60 group-hover/card:text-green-400 transition-all duration-200 ${expanded ? "rotate-180 text-green-400" : ""}`} />
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
