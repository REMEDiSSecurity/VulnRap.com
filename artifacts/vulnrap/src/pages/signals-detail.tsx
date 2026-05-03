// Task #662 — /signals/:id detail page. Renders the full explainer for one
// signal, plus its per-signal precision/recall numbers fetched from
// /api/feedback/per-signal-eval.
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Radar, Info, AlertTriangle, FileWarning } from "lucide-react";
import { SIGNALS_BY_ID, SIGNAL_CATEGORIES, type SignalMeta } from "@/lib/signal-metadata";
import NotFound from "@/pages/not-found";

interface PerSignalEval {
  totalFeedbackRows: number;
  signals: Array<{
    type: string;
    samples: number;
    firesAndSlop: number;
    firesAndNotSlop: number;
    precision: number | null;
  }>;
}

function apiBase() {
  const b = import.meta.env.BASE_URL || "/";
  return `${b.replace(/\/$/, "")}/api`;
}

function MetricsPanel({ id }: { id: string }) {
  const { data, isLoading, isError } = useQuery<PerSignalEval>({
    queryKey: ["per-signal-eval"],
    queryFn: async () => {
      const res = await fetch(`${apiBase()}/feedback/per-signal-eval`);
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const stat = data?.signals.find((s) => s.type === id);

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-2.5">
      <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/70">
        <Info className="w-3.5 h-3.5" />
        Hit rate from reviewer feedback
      </div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {isError && (
        <div className="text-sm text-amber-400/80">Could not load metrics.</div>
      )}
      {data && !stat && (
        <div className="text-sm text-muted-foreground">
          This signal has not fired on any rated report yet.
        </div>
      )}
      {stat && stat.precision === null && (
        <div className="text-sm text-muted-foreground">
          Only {stat.samples} sample{stat.samples === 1 ? "" : "s"} so far — needs ≥5 to compute a stable
          precision.
        </div>
      )}
      {stat && stat.precision !== null && (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums text-primary glow-text-sm">
              {Math.round(stat.precision * 100)}%
            </span>
            <span className="text-sm text-muted-foreground">
              of reports where this signal fired were rated slop
            </span>
          </div>
          <div className="text-[12px] text-muted-foreground font-mono">
            n = {stat.samples} rated reports · {stat.firesAndSlop} slop · {stat.firesAndNotSlop} not slop
          </div>
          <div className="text-[11px] text-muted-foreground/70 leading-snug">
            Computed across the full feedback set, not the holdout split. Use
            the <Link to="/feedback-analytics" className="text-primary hover:underline">Feedback
            Analytics</Link> page for the honest holdout numbers.
          </div>
        </div>
      )}
    </div>
  );
}

function ExampleBlock({ ex }: { ex: SignalMeta["examples"][number] }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/40 overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/80 border-b border-border/40 bg-card/30">
        {ex.title}
      </div>
      <pre className="p-3 text-[12px] font-mono text-foreground/90 whitespace-pre-wrap break-all overflow-x-auto">
{ex.snippet}
      </pre>
      <div className="px-3 py-2 text-[12px] text-muted-foreground border-t border-border/40 leading-snug">
        <span className="font-semibold text-foreground/80">Why it fires: </span>
        {ex.why}
      </div>
    </div>
  );
}

export default function SignalsDetail() {
  const { id } = useParams<{ id: string }>();
  const signal = id ? SIGNALS_BY_ID[id] : undefined;

  if (!signal) {
    return <NotFound />;
  }

  const category = SIGNAL_CATEGORIES.find((c) => c.id === signal.category);
  const CategoryIcon =
    signal.category === "hallucination" ? FileWarning :
    signal.category === "substance" ? AlertTriangle :
                                       Radar;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="space-y-2 pt-2 sm:pt-4">
        <Link
          to="/signals"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3 h-3" /> All signals
        </Link>
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide text-muted-foreground/70">
          <CategoryIcon className="w-3.5 h-3.5" />
          {category?.label}
          {signal.family && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>family · {signal.family}</span>
            </>
          )}
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase glow-text leading-tight">
          {signal.title}
        </h1>
        <div className="font-mono text-[12px] text-muted-foreground break-all">
          id · {signal.id}
        </div>
        <p className="text-sm sm:text-base text-foreground/85 leading-relaxed pt-2">
          {signal.description}
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <MetricsPanel id={signal.id} />

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
          Why it matters
        </h2>
        <p className="text-[14px] text-foreground/85 leading-relaxed">
          {signal.whyItMatters}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
          Technical detail
        </h2>
        <p className="text-[14px] text-foreground/85 leading-relaxed">
          {signal.technicalDetail}
        </p>
      </section>

      {signal.citations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
            Citations
          </h2>
          <ul className="space-y-1.5">
            {signal.citations.map((c) => (
              <li key={c.href}>
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
                >
                  {c.label}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
          Examples that fire it
        </h2>
        {signal.examples.length === 0 ? (
          <div className="text-[13px] text-muted-foreground italic">
            No public example fixtures attached yet — see the detector source for the regex patterns
            it matches.
          </div>
        ) : (
          <div className="space-y-3">
            {signal.examples.map((ex, i) => (
              <ExampleBlock key={i} ex={ex} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
