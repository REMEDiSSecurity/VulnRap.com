import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Code,
  Terminal,
  Bot,
  Shield,
  Zap,
  Lock,
  FileText,
  ExternalLink,
  ChevronDown,
} from "lucide-react";

export function DevelopersAndAgentsSection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      id="section-developers"
      className="glass-card rounded-xl overflow-hidden scroll-mt-20"
      data-scroll-fade
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 sm:p-6 flex items-center justify-between text-left cursor-pointer group/card rounded-xl ring-1 ring-transparent hover:ring-primary/30 focus-visible:ring-primary/50 focus-visible:outline-none transition-all duration-200"
        aria-expanded={expanded}
      >
        <div className="space-y-1">
          <span className="eyebrow-label">
            Section 06 · Developers &amp; Agents
          </span>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Code className="w-5 h-5 text-primary" />
            Public API &amp; AI Agent Manual
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl pt-1">
            Free, no-account REST API for security tools, triage bots, and AI
            coding agents. Tap to see the three-call integration and the
            dedicated agents.md manual.
          </p>
        </div>
        <ChevronDown
          className={`w-5 h-5 text-primary/60 group-hover/card:text-primary transition-all duration-200 flex-shrink-0 ${expanded ? "rotate-180 text-primary" : ""}`}
        />
      </button>

      {expanded && (
        <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-primary/5 border border-primary/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-primary flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                Three calls, full integration
              </h3>
              <ol className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-primary font-mono mt-0.5">1.</span>
                  <span>
                    <span className="font-mono text-foreground">
                      POST /api/reports
                    </span>{" "}
                    — submit raw text, a file, or a URL (allowlisted hosts).
                    Get back a slop score, quality score, validity score,
                    section-hash matches, and an integer report id.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-primary font-mono mt-0.5">2.</span>
                  <span>
                    <span className="font-mono text-foreground">
                      GET /api/reports/&#123;id&#125;/triage-report
                    </span>{" "}
                    — Markdown summary you can paste straight into a Jira /
                    ServiceNow / chat reply.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-primary font-mono mt-0.5">3.</span>
                  <span>
                    <span className="font-mono text-foreground">
                      POST /api/feedback
                    </span>{" "}
                    — one short note about what actually happened (real / dup
                    / fabricated). This is how the engines recalibrate.
                  </span>
                </li>
              </ol>
              <div className="pt-1">
                <pre className="text-[10px] sm:text-[11px] font-mono bg-background/50 border border-border/50 rounded-md p-2.5 overflow-x-auto leading-relaxed">
                  {`curl -X POST https://vulnrap.com/api/reports \\
  -F "file=@./report.md" \\
  -F "contentMode=full" \\
  -F "showInFeed=true"`}
                </pre>
              </div>
            </div>

            <div className="rounded-xl bg-violet-500/5 border border-violet-500/20 p-4 space-y-3">
              <h3 className="text-sm font-bold text-violet-300 flex items-center gap-2">
                <Bot className="w-4 h-4" />
                For AI agents specifically
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                We publish an{" "}
                <span className="font-mono text-foreground">agents.md</span> at
                the site root — the same convention coding agents already look
                for. It's the integration manual: recommended defaults, a
                30-second loop, what to surface to your human, and (importantly)
                how to send feedback so VulnRap learns from every triage
                decision your agent makes.
              </p>
              <ul className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">&#8226;</span>Default
                  to{" "}
                  <span className="font-mono text-foreground">
                    showInFeed=true
                  </span>{" "}
                  +{" "}
                  <span className="font-mono text-foreground">
                    contentMode=full
                  </span>{" "}
                  so the analysis is enriched and benefits the community.
                </li>
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">&#8226;</span>Always
                  call{" "}
                  <span className="font-mono text-foreground">
                    POST /api/feedback
                  </span>{" "}
                  after the human acts — that ground truth is how scoring
                  weights improve.
                </li>
                <li className="flex gap-2">
                  <span className="text-violet-400 mt-0.5">&#8226;</span>No
                  account, no API key. PII scrubbing happens before storage.
                </li>
              </ul>
              <div className="pt-1">
                <pre className="text-[10px] sm:text-[11px] font-mono bg-background/50 border border-border/50 rounded-md p-2.5 overflow-x-auto leading-relaxed">
                  {`# Recommended defaults — use these unless user opts out
showInFeed=true   # community learns from every report
contentMode=full  # richest verdict back

# After the human acts:
POST /api/feedback { reportId, rating, helpful, comment }`}
                </pre>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <a
                  href="/agents.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 hover:border-violet-400/60 text-xs font-medium text-violet-200 transition-colors"
                  data-testid="link-agents-md"
                >
                  <Bot className="w-3.5 h-3.5" />
                  Read /agents.md
                </a>
                <Link
                  to="/developers"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/30 hover:border-primary/60 text-xs font-medium text-primary transition-colors"
                  data-testid="link-api-docs"
                >
                  <Code className="w-3.5 h-3.5" />
                  Full API docs
                </Link>
                <a
                  href="/api/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border hover:border-primary/40 text-xs font-medium text-foreground transition-colors"
                  data-testid="link-openapi-spec"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  OpenAPI spec
                </a>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground/70 pt-1">
            <span className="inline-flex items-center gap-1.5">
              <Shield className="w-3 h-3 text-primary/60" />
              No auth required
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Zap className="w-3 h-3 text-amber-400/70" />
              30 analyses / 15 min / IP
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Lock className="w-3 h-3 text-cyan-400/70" />
              PII scrubbed before storage
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileText className="w-3 h-3 text-violet-400/70" />
              Markdown triage export
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default DevelopersAndAgentsSection;
