import { useMemo, useState } from "react";
import { Cpu, Target, FileText, Brain, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ALL_ENGINES_ON,
  ENGINE_ORDER,
  refuseEngines,
  type EngineBreakdown,
  type EngineKey,
} from "@/lib/engine-fusion";

const ENGINE_META: Record<EngineKey, { label: string; icon: typeof Cpu; color: string; bg: string }> = {
  linguistic: { label: "Linguistic", icon: Cpu, color: "text-cyan-400", bg: "bg-cyan-400" },
  factual: { label: "Factual", icon: Target, color: "text-amber-400", bg: "bg-amber-400" },
  template: { label: "Template", icon: FileText, color: "text-violet-400", bg: "bg-violet-400" },
  llm: { label: "LLM", icon: Brain, color: "text-emerald-400", bg: "bg-emerald-400" },
};

interface EngineTogglePanelProps {
  breakdown: EngineBreakdown;
  /**
   * Server-canonical slop score. Shown alongside the toggle-recalc value
   * for transparency, but the +/- delta is computed against the
   * *all-engines-on* baseline of this same client-side fusion model so it
   * isolates the contribution of a toggled engine without mixing in the
   * server-vs-client model gap.
   */
  canonicalScore: number;
  className?: string;
}

export function EngineTogglePanel({ breakdown, canonicalScore, className }: EngineTogglePanelProps) {
  const [enabled, setEnabled] = useState<Record<EngineKey, boolean>>({ ...ALL_ENGINES_ON });

  const baseline = useMemo(() => refuseEngines(breakdown, ALL_ENGINES_ON), [breakdown]);
  const { score, contributions } = useMemo(() => refuseEngines(breakdown, enabled), [breakdown, enabled]);

  const allOn = ENGINE_ORDER.every((k) => enabled[k] || breakdown[k] == null);
  const reset = () => setEnabled({ ...ALL_ENGINES_ON });
  const delta = score - baseline.score;
  const maxContribution = Math.max(1, ...contributions.map((c) => c.contribution));

  return (
    <div className={cn("space-y-4", className)} data-testid="engine-toggle-panel">
      <div>
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Per-Engine On / Off</span>
          {!allOn && (
            <span
              className={cn(
                "font-mono",
                delta > 0 ? "text-destructive" : delta < 0 ? "text-green-400" : "text-muted-foreground",
              )}
              data-testid="engine-toggle-recalc-score"
            >
              recalc {score} ({delta >= 0 ? "+" : ""}{delta} vs all-on)
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
          Diagnostic only — disable an engine to see what the score would be without it. Does not affect stored reports.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2" data-testid="engine-toggle-checkboxes">
        {ENGINE_ORDER.map((key) => {
          const meta = ENGINE_META[key];
          const Icon = meta.icon;
          const available = breakdown[key] != null;
          const raw = available ? Number(breakdown[key]) : 0;
          const baseWeight = contributions.find((c) => c.key === key)?.baseWeight ?? 0;
          return (
            <label
              key={key}
              className={cn(
                "flex items-start gap-2 p-2.5 rounded-lg border border-border transition-colors group",
                available
                  ? "hover:border-primary/30 cursor-pointer"
                  : "opacity-50 cursor-not-allowed",
              )}
            >
              <input
                type="checkbox"
                checked={available && enabled[key]}
                disabled={!available}
                onChange={(e) => setEnabled((prev) => ({ ...prev, [key]: e.target.checked }))}
                className="rounded border-border accent-primary w-4 h-4 mt-0.5"
                data-testid={`engine-toggle-${key}`}
              />
              <div className="space-y-0.5 min-w-0 flex-1">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Icon className={cn("w-3.5 h-3.5", meta.color)} />
                  {meta.label}
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                    {available ? `${raw}` : "N/A"}
                  </span>
                </span>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {available ? `Base weight ${(baseWeight * 100).toFixed(0)}%` : "Not available for this report."}
                </p>
              </div>
            </label>
          );
        })}
      </div>

      <div className="space-y-2" data-testid="engine-contribution-bar">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Engine Contribution</span>
          <span className="font-mono">
            recalc <span className="text-foreground font-bold">{score}</span>
            <span className="text-muted-foreground/70"> · all-on baseline {baseline.score} · server canonical {canonicalScore}</span>
          </span>
        </div>
        <div
          className="flex h-3 w-full rounded-full overflow-hidden bg-muted/20 border border-border/30"
          data-testid="engine-contribution-stack"
        >
          {contributions
            .filter((c) => c.contribution > 0)
            .map((c) => {
              const meta = ENGINE_META[c.key];
              return (
                <div
                  key={c.key}
                  className={cn("h-full", meta.bg)}
                  style={{ width: `${Math.max(0, Math.min(100, c.contribution))}%` }}
                  title={`${meta.label}: ${c.contribution.toFixed(1)} pts (${(c.normalizedWeight * 100).toFixed(0)}% weight)`}
                  data-testid={`engine-contribution-segment-${c.key}`}
                />
              );
            })}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          {contributions.map((c) => {
            const meta = ENGINE_META[c.key];
            return (
              <div
                key={c.key}
                className="flex items-center gap-1.5"
                data-testid={`engine-contribution-row-${c.key}`}
              >
                <span className={cn("w-2 h-2 rounded-sm", meta.bg, !c.enabled && "opacity-30")} />
                <span className={cn("text-muted-foreground", !c.enabled && "line-through opacity-60")}>
                  {meta.label}
                </span>
                <span className="ml-auto font-mono text-foreground/80">
                  {c.available && c.enabled ? (
                    <>
                      {c.contribution.toFixed(1)}
                      <span className="text-muted-foreground/60"> · {(c.normalizedWeight * 100).toFixed(0)}%</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground/50">off</span>
                  )}
                </span>
                <span className="w-10 h-1 ml-1 rounded bg-muted/20 overflow-hidden">
                  <span
                    className={cn("block h-full", meta.bg)}
                    style={{
                      width: `${(c.contribution / maxContribution) * 100}%`,
                      opacity: c.enabled ? 1 : 0.3,
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {!allOn && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] gap-1"
          onClick={reset}
          data-testid="engine-toggle-reset"
        >
          <RefreshCw className="w-3 h-3" /> Reset all engines
        </Button>
      )}
    </div>
  );
}
