// Task #662 — /signals index page. Lists every known signal grouped by
// category with a short description and a link to the detail page.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Radar, ArrowRight } from "lucide-react";
import {
  ALL_SIGNALS,
  SIGNAL_CATEGORIES,
  getSignalsByCategory,
  type SignalMeta,
} from "@/lib/signal-metadata";

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

function MetricBadge({ stat }: { stat?: PerSignalEval["signals"][number] }) {
  if (!stat || stat.samples === 0) {
    return (
      <span className="text-[10px] font-mono text-muted-foreground/60 px-1.5 py-0.5 rounded border border-border/40">
        no samples
      </span>
    );
  }
  if (stat.precision === null) {
    return (
      <span className="text-[10px] font-mono text-muted-foreground/70 px-1.5 py-0.5 rounded border border-border/40">
        n={stat.samples}
      </span>
    );
  }
  const pct = Math.round(stat.precision * 100);
  const tone =
    pct >= 70 ? "text-rose-400 border-rose-400/40" :
    pct >= 40 ? "text-amber-400 border-amber-400/40" :
                "text-emerald-400 border-emerald-400/40";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${tone}`}>
      {pct}% slop · n={stat.samples}
    </span>
  );
}

function SignalCard({ signal, stat }: { signal: SignalMeta; stat?: PerSignalEval["signals"][number] }) {
  return (
    <Link
      to={`/signals/${signal.id}`}
      className="group block rounded-lg border border-border/60 bg-card/40 hover:border-primary/50 hover:bg-card/70 transition-all p-3"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="font-mono text-[12px] text-primary group-hover:glow-text-sm break-all">
          {signal.id}
        </div>
        <MetricBadge stat={stat} />
      </div>
      <div className="text-sm font-semibold text-foreground/95 mb-1">{signal.title}</div>
      <div className="text-[12px] text-muted-foreground leading-snug line-clamp-3">
        {signal.description}
      </div>
      {signal.family && (
        <div className="mt-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground/60">
          family · {signal.family}
        </div>
      )}
    </Link>
  );
}

export default function SignalsIndex() {
  const { data } = useQuery<PerSignalEval>({
    queryKey: ["per-signal-eval"],
    queryFn: async () => {
      const res = await fetch(`${apiBase()}/feedback/per-signal-eval`);
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
  });

  const statByType = new Map(
    (data?.signals ?? []).map((s) => [s.type, s]),
  );

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Radar className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Signal Reference
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-3xl leading-relaxed">
          Every detector that can fire on a report, what it looks for, why it matters, and how often
          its presence correlates with reviewer feedback marking the report as slop.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      {SIGNAL_CATEGORIES.map((cat) => {
        const signals = getSignalsByCategory(cat.id);
        if (signals.length === 0) return null;
        return (
          <section key={cat.id} className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-lg font-bold tracking-tight text-foreground uppercase flex items-center gap-2">
                {cat.label}
                <span className="text-[11px] font-mono text-muted-foreground/70 normal-case">
                  ({signals.length})
                </span>
              </h2>
              <p className="text-[13px] text-muted-foreground leading-snug">
                {cat.description}
              </p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {signals.map((s) => (
                <SignalCard key={s.id} signal={s} stat={statByType.get(s.id)} />
              ))}
            </div>
          </section>
        );
      })}

      <div className="text-[11px] text-muted-foreground/60 pt-4 border-t border-border/40">
        Total signals: {ALL_SIGNALS.length}.{" "}
        {data && (
          <>
            Per-signal precision computed across {data.totalFeedbackRows} rated reports. Open a
            signal page for full detail{" "}
            <ArrowRight className="inline w-3 h-3 -mt-0.5" />.
          </>
        )}
      </div>
    </div>
  );
}
