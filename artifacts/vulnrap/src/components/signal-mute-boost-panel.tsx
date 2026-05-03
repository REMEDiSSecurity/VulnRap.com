import { useMemo } from "react";
import { Sliders, RotateCcw, VolumeX, Volume2, Equal } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type SignalMode = "mute" | "normal" | "boost";

export interface SignalMuteBoostEvidence {
  type: string;
  weight: number;
}

export interface SignalAdjustments {
  [signalType: string]: SignalMode;
}

const URL_PARAM = "signals";

const MODE_MULTIPLIERS: Record<SignalMode, number> = {
  mute: 0,
  normal: 1,
  boost: 2,
};

export function parseSignalAdjustments(raw: string | null): SignalAdjustments {
  if (!raw) return {};
  const out: SignalAdjustments = {};
  for (const piece of raw.split(",")) {
    const [type, mode] = piece.split(":");
    if (!type || !mode) continue;
    if (mode === "mute" || mode === "boost") {
      out[type] = mode;
    }
  }
  return out;
}

export function serializeSignalAdjustments(adj: SignalAdjustments): string {
  const parts: string[] = [];
  for (const [type, mode] of Object.entries(adj)) {
    if (mode === "mute" || mode === "boost") parts.push(`${type}:${mode}`);
  }
  return parts.join(",");
}

export function applySignalAdjustments(
  baselineScore: number,
  evidence: SignalMuteBoostEvidence[] | undefined,
  adjustments: SignalAdjustments,
): number {
  if (!evidence || evidence.length === 0) return baselineScore;
  let delta = 0;
  for (const ev of evidence) {
    const mode = adjustments[ev.type] ?? "normal";
    if (mode === "normal") continue;
    delta += ev.weight * (MODE_MULTIPLIERS[mode] - 1);
  }
  return Math.max(0, Math.min(100, Math.round(baselineScore + delta)));
}

interface AggregatedSignal {
  type: string;
  totalWeight: number;
  count: number;
}

function aggregate(evidence: SignalMuteBoostEvidence[]): AggregatedSignal[] {
  const map = new Map<string, AggregatedSignal>();
  for (const ev of evidence) {
    const cur = map.get(ev.type);
    if (cur) {
      cur.totalWeight += ev.weight;
      cur.count += 1;
    } else {
      map.set(ev.type, { type: ev.type, totalWeight: ev.weight, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.totalWeight - a.totalWeight);
}

interface Props {
  evidence: SignalMuteBoostEvidence[];
  adjustments: SignalAdjustments;
  onChange: (next: SignalAdjustments) => void;
  baselineScore: number;
  adjustedScore: number;
  signalLabels?: Record<string, string>;
}

export function SignalMuteBoostPanel({
  evidence,
  adjustments,
  onChange,
  baselineScore,
  adjustedScore,
  signalLabels,
}: Props) {
  const aggregated = useMemo(() => aggregate(evidence), [evidence]);
  const hasOverrides = Object.keys(adjustments).length > 0;

  if (aggregated.length === 0) return null;

  const setMode = (type: string, mode: SignalMode) => {
    const next: SignalAdjustments = { ...adjustments };
    if (mode === "normal") {
      delete next[type];
    } else {
      next[type] = mode;
    }
    onChange(next);
  };

  const reset = () => onChange({});

  const delta = adjustedScore - baselineScore;

  return (
    <Card className="glass-card rounded-xl" data-testid="signal-mute-boost-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sliders className="w-4 h-4 text-primary" />
          Signal Control
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
            {aggregated.length} signal{aggregated.length === 1 ? "" : "s"}
          </Badge>
          {hasOverrides && (
            <span
              className={cn(
                "ml-auto text-[10px] font-mono",
                delta > 0 ? "text-destructive" : delta < 0 ? "text-green-400" : "text-muted-foreground",
              )}
              data-testid="signal-mute-boost-delta"
            >
              {baselineScore} → {adjustedScore} ({delta > 0 ? "+" : ""}{delta})
            </span>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Mute or boost individual signals to test scoring sensitivity. State is shared via URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {aggregated.map((sig) => {
          const mode: SignalMode = adjustments[sig.type] ?? "normal";
          const label = signalLabels?.[sig.type] ?? sig.type;
          return (
            <div
              key={sig.type}
              className="flex items-center gap-2 rounded-lg glass-card p-2"
              data-testid={`signal-mute-boost-row-${sig.type}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground truncate">
                  {label}
                </div>
                <div className="text-[10px] text-muted-foreground/80 font-mono">
                  weight {sig.totalWeight}
                  {sig.count > 1 && <> · {sig.count}×</>}
                </div>
              </div>
              <div className="flex rounded-md overflow-hidden border border-border/40 flex-shrink-0">
                {(
                  [
                    { key: "mute", icon: VolumeX, title: "Mute (0×)" },
                    { key: "normal", icon: Equal, title: "Normal (1×)" },
                    { key: "boost", icon: Volume2, title: "Boost (2×)" },
                  ] as const
                ).map(({ key, icon: Icon, title }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMode(sig.type, key)}
                    title={title}
                    aria-label={title}
                    aria-pressed={mode === key}
                    data-testid={`signal-mute-boost-${sig.type}-${key}`}
                    className={cn(
                      "px-2 py-1 text-[10px] font-medium transition-colors flex items-center gap-1",
                      mode === key
                        ? key === "mute"
                          ? "bg-muted text-muted-foreground"
                          : key === "boost"
                            ? "bg-destructive/20 text-destructive"
                            : "bg-primary text-primary-foreground"
                        : "text-muted-foreground/60 hover:bg-muted/30",
                    )}
                  >
                    <Icon className="w-3 h-3" />
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {hasOverrides && (
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={reset}
              data-testid="signal-mute-boost-reset"
              className="h-7 text-[10px] gap-1"
            >
              <RotateCcw className="w-3 h-3" /> Reset
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { URL_PARAM as SIGNAL_ADJUSTMENTS_URL_PARAM };
