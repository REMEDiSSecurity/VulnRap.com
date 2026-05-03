// Task #650 — Compare-detectors page.
//
// Side-by-side capability comparison: VulnRap vs. Generic LLM Detector vs.
// Plagiarism Checker vs. Manual Triage. The goal is to make the
// security-domain-specific differentiator obvious in ~5 seconds for
// prospective users who have asked "why not just use a generic LLM
// detector?" Categories use generic labels (no competitor product names).
import { Link } from "react-router-dom";
import {
  GitCompare,
  Check,
  X,
  Minus,
  ArrowRight,
  BookOpen,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Mark = "yes" | "no" | "partial";

interface Row {
  capability: string;
  vulnrap: { mark: Mark; note: string };
  llm: { mark: Mark; note: string };
  plagiarism: { mark: Mark; note: string };
  manual: { mark: Mark; note: string };
}

const ROWS: Row[] = [
  {
    capability: "Detects fabricated ASan/sanitizer traces",
    vulnrap: {
      mark: "yes",
      note: "Structural validation of frames + offsets.",
    },
    llm: { mark: "no", note: "Treats trace as opaque text." },
    plagiarism: { mark: "no", note: "Only flags copied text." },
    manual: { mark: "partial", note: "Possible but slow; reviewer-dependent." },
  },
  {
    capability: "CWE coherence check (claim ↔ evidence)",
    vulnrap: { mark: "yes", note: "Per-CWE archetype rules + evidence match." },
    llm: { mark: "no", note: "No CWE taxonomy awareness." },
    plagiarism: { mark: "no", note: "Out of scope." },
    manual: { mark: "yes", note: "Reliable but expensive per report." },
  },
  {
    capability: "Hallucinated function / API signatures",
    vulnrap: { mark: "yes", note: "Cross-checks against known symbol shapes." },
    llm: { mark: "partial", note: "Sometimes flags; often misses." },
    plagiarism: { mark: "no", note: "Cannot evaluate code validity." },
    manual: { mark: "yes", note: "If reviewer knows the codebase." },
  },
  {
    capability: "Generic AI-text patterns (perplexity, burstiness)",
    vulnrap: { mark: "yes", note: "Linguistic engine plus stylistic signals." },
    llm: { mark: "yes", note: "Core competence — but only this." },
    plagiarism: { mark: "partial", note: "Some bolt-on AI checks." },
    manual: {
      mark: "partial",
      note: "Gut feel; not consistent across reviewers.",
    },
  },
  {
    capability: "Technical substance density",
    vulnrap: {
      mark: "yes",
      note: "Substance engine: code, refs, repro depth.",
    },
    llm: { mark: "no", note: "Word-shape only; no substance scoring." },
    plagiarism: { mark: "no", note: "Out of scope." },
    manual: { mark: "yes", note: "Subjective and slow." },
  },
  {
    capability: "Per-engine, per-signal explainability",
    vulnrap: { mark: "yes", note: "Every signal exposed in the report + API." },
    llm: { mark: "no", note: "Single opaque score." },
    plagiarism: { mark: "partial", note: "Match list, no scoring rationale." },
    manual: { mark: "partial", note: "Depends on reviewer notes." },
  },
  {
    capability: "Open methodology",
    vulnrap: { mark: "yes", note: "Public docs, blog, and architecture page." },
    llm: { mark: "no", note: "Closed model + closed scoring." },
    plagiarism: { mark: "no", note: "Proprietary corpora and weights." },
    manual: { mark: "partial", note: "Internal SOPs vary by team." },
  },
  {
    capability: "Public transparency reports",
    vulnrap: { mark: "yes", note: "Live impact + corpus stats pages." },
    llm: { mark: "no", note: "Marketing claims only." },
    plagiarism: { mark: "no", note: "No public scoring metrics." },
    manual: { mark: "no", note: "Not applicable." },
  },
  {
    capability: "Tuned for vulnerability-report shape",
    vulnrap: { mark: "yes", note: "Trained on real PSIRT/bounty corpora." },
    llm: { mark: "no", note: "Generic prose detector." },
    plagiarism: { mark: "no", note: "Generic document matcher." },
    manual: { mark: "yes", note: "If the reviewer is a security engineer." },
  },
  {
    capability: "Reproducible scoring (same input → same output)",
    vulnrap: {
      mark: "yes",
      note: "Deterministic engines + versioned weights.",
    },
    llm: { mark: "no", note: "Probabilistic; drifts across runs." },
    plagiarism: { mark: "yes", note: "Deterministic match." },
    manual: { mark: "no", note: "Reviewer-to-reviewer variance." },
  },
  {
    capability: "Throughput at PSIRT scale",
    vulnrap: { mark: "yes", note: "Batch + API; sub-second per report." },
    llm: { mark: "yes", note: "Fast but noisy." },
    plagiarism: { mark: "yes", note: "Fast." },
    manual: { mark: "no", note: "Hours per report; doesn't scale." },
  },
  {
    capability: "Free & anonymous to use",
    vulnrap: { mark: "yes", note: "No account, no API key required." },
    llm: { mark: "no", note: "Paid SaaS, account required." },
    plagiarism: { mark: "no", note: "Paid SaaS, account required." },
    manual: { mark: "no", note: "Reviewer time has a cost." },
  },
];

const COLUMNS = [
  { key: "vulnrap", label: "VulnRap", emphasis: true },
  { key: "llm", label: "Generic LLM Detector", emphasis: false },
  { key: "plagiarism", label: "Plagiarism Checker", emphasis: false },
  { key: "manual", label: "Manual Triage", emphasis: false },
] as const;

function MarkIcon({ mark }: { mark: Mark }) {
  if (mark === "yes") {
    return (
      <Check className="w-4 h-4 text-green-400 shrink-0" aria-label="Yes" />
    );
  }
  if (mark === "no") {
    return <X className="w-4 h-4 text-red-400/80 shrink-0" aria-label="No" />;
  }
  return (
    <Minus
      className="w-4 h-4 text-amber-300/80 shrink-0"
      aria-label="Partial"
    />
  );
}

function Cell({
  mark,
  note,
  emphasis,
}: {
  mark: Mark;
  note: string;
  emphasis: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 p-3 rounded-md border h-full",
        emphasis
          ? "border-primary/30 bg-primary/5"
          : "border-border/40 bg-muted/10",
      )}
    >
      <MarkIcon mark={mark} />
      <span
        className={cn(
          "text-[11px] leading-snug",
          emphasis ? "text-foreground/90" : "text-muted-foreground",
        )}
      >
        {note}
      </span>
    </div>
  );
}

export default function CompareDetectors() {
  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <GitCompare className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Compare detectors
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-3xl leading-relaxed">
          A common question:{" "}
          <em>"Why not just use a generic AI-text detector?"</em> The short
          answer is that vulnerability reports are a domain, not a writing
          style. Generic detectors look at prose shape; plagiarism checkers look
          at copied text; reviewers look at everything but don't scale. VulnRap
          is purpose-built for the vuln-report shape — CWE coherence, fabricated
          sanitizer traces, hallucinated function signatures, and substance
          density — on top of the generic AI-text signals.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card rounded-xl overflow-hidden">
        <CardHeader>
          <CardTitle className="text-base">Capability matrix</CardTitle>
          <CardDescription className="text-xs">
            <span className="inline-flex items-center gap-1 mr-3">
              <Check className="w-3 h-3 text-green-400" /> supported
            </span>
            <span className="inline-flex items-center gap-1 mr-3">
              <Minus className="w-3 h-3 text-amber-300/80" /> partial
            </span>
            <span className="inline-flex items-center gap-1">
              <X className="w-3 h-3 text-red-400/80" /> not supported
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="px-2 sm:px-4 pb-4">
          <div className="overflow-x-auto">
            <div className="min-w-[820px]">
              <div
                className="grid gap-2 px-2 pb-2 sticky top-14 bg-background/80 backdrop-blur-sm z-10"
                style={{ gridTemplateColumns: "1.4fr repeat(4, 1fr)" }}
              >
                <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 px-1">
                  Capability
                </div>
                {COLUMNS.map((col) => (
                  <div
                    key={col.key}
                    className={cn(
                      "text-[11px] uppercase tracking-wider font-bold px-1",
                      col.emphasis
                        ? "text-primary glow-text-sm"
                        : "text-muted-foreground",
                    )}
                  >
                    {col.label}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-2 px-2">
                {ROWS.map((row) => (
                  <div
                    key={row.capability}
                    className="grid gap-2 items-stretch"
                    style={{ gridTemplateColumns: "1.4fr repeat(4, 1fr)" }}
                  >
                    <div className="flex items-center text-xs sm:text-sm font-medium text-foreground/90 px-1">
                      {row.capability}
                    </div>
                    {COLUMNS.map((col) => {
                      const c = row[col.key];
                      return (
                        <Cell
                          key={col.key}
                          mark={c.mark}
                          note={c.note}
                          emphasis={col.emphasis}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl border-primary/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            Why domain-specific matters
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Want the long version? Our methodology blog series walks through
            each engine, the signals it produces, and the corpora used to
            calibrate weights.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/blog"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:glow-text-sm transition-all"
          >
            Read the methodology series
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
