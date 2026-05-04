import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  GitCompare,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  adjustScore,
  adjustTier,
  SENSITIVITY_PRESETS,
  getAbPresets,
  saveAbPresets,
  type SensitivityPreset,
  type BreakdownData,
  type HumanIndicatorData,
} from "@/lib/settings";

const PRESETS: SensitivityPreset[] = ["lenient", "balanced", "strict"];

const TIER_COLOR: Record<string, string> = {
  Clean: "text-green-500",
  "Likely Human": "text-emerald-400",
  Questionable: "text-yellow-500",
  "Likely Slop": "text-orange-500",
  Slop: "text-destructive",
};

interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

interface PresetOutcome {
  preset: SensitivityPreset;
  score: number;
  tier: string;
  topSignals: EvidenceItem[];
}

function computeOutcome(
  preset: SensitivityPreset,
  canonicalScore: number,
  breakdown: BreakdownData | undefined,
  humanIndicators: HumanIndicatorData[],
  evidence: EvidenceItem[],
  low: number,
  high: number,
): PresetOutcome {
  const score = adjustScore(canonicalScore, preset, breakdown, humanIndicators);
  const tier = adjustTier(score, low, high);
  const { axisMultiplier } = SENSITIVITY_PRESETS[preset];
  const filtered = evidence
    .filter((e) => e.weight * axisMultiplier >= 1)
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  return { preset, score, tier, topSignals: filtered };
}

function PresetCard({ outcome, slot }: { outcome: PresetOutcome; slot: "a" | "b" }) {
  const meta = SENSITIVITY_PRESETS[outcome.preset];
  const tierClass = TIER_COLOR[outcome.tier] ?? "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border/40 bg-muted/10 p-3 flex-1 min-w-0" data-testid={`preset-card-${slot}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {meta.label}
        </div>
        <Badge
          variant="outline"
          className="text-[9px] px-1.5 py-0 h-4 font-mono"
        >
          ×{meta.axisMultiplier.toFixed(1)}
        </Badge>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-3xl font-mono font-bold tracking-tight" data-testid={`preset-score-${slot}`}>
          {outcome.score}
        </div>
        <div className="text-[10px] text-muted-foreground">/ 100</div>
      </div>
      <div className={`text-sm font-bold ${tierClass} mb-3`} data-testid={`preset-tier-${slot}`}>
        {outcome.tier}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Top Signals After Filter
      </div>
      {outcome.topSignals.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          No signals fire under this preset.
        </div>
      ) : (
        <ul className="space-y-1">
          {outcome.topSignals.map((s, i) => (
            <li
              key={i}
              className="text-[11px] font-mono text-muted-foreground truncate"
            >
              · {s.type.replace(/_/g, " ")}{" "}
              <span className="text-primary/70">({s.weight})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AbPresetComparison({
  canonicalScore,
  breakdown,
  humanIndicators,
  evidence,
  thresholdLow,
  thresholdHigh,
}: {
  canonicalScore: number;
  breakdown: BreakdownData | undefined;
  humanIndicators: HumanIndicatorData[];
  evidence: EvidenceItem[];
  thresholdLow: number;
  thresholdHigh: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [presetA, setPresetA] = useState<SensitivityPreset>(() => getAbPresets().presetA);
  const [presetB, setPresetB] = useState<SensitivityPreset>(() => getAbPresets().presetB);

  const updatePresetA = (p: SensitivityPreset) => {
    setPresetA(p);
    saveAbPresets(p, presetB);
  };
  const updatePresetB = (p: SensitivityPreset) => {
    setPresetB(p);
    saveAbPresets(presetA, p);
  };

  const outcomeA = computeOutcome(
    presetA,
    canonicalScore,
    breakdown,
    humanIndicators,
    evidence,
    thresholdLow,
    thresholdHigh,
  );
  const outcomeB = computeOutcome(
    presetB,
    canonicalScore,
    breakdown,
    humanIndicators,
    evidence,
    thresholdLow,
    thresholdHigh,
  );
  const tierDiverges = outcomeA.tier !== outcomeB.tier;

  return (
    <Card className="glass-card rounded-xl" data-testid="ab-preset-comparison">
      <CardHeader
        className="cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <CardTitle className="flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-primary" />
          Compare Presets
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
            A/B
          </Badge>
          <span className="ml-auto">
            {expanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </span>
        </CardTitle>
        <CardDescription>
          What would this report score under preset A vs preset B?
        </CardDescription>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label
                htmlFor="ab-preset-a"
                className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 block"
              >
                Preset A
              </label>
              <select
                id="ab-preset-a"
                value={presetA}
                onChange={(e) =>
                  updatePresetA(e.target.value as SensitivityPreset)
                }
                className="w-full rounded-md border border-border/40 bg-background/50 px-2 py-1.5 text-sm font-mono"
                data-testid="select-preset-a"
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {SENSITIVITY_PRESETS[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label
                htmlFor="ab-preset-b"
                className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 block"
              >
                Preset B
              </label>
              <select
                id="ab-preset-b"
                value={presetB}
                onChange={(e) =>
                  updatePresetB(e.target.value as SensitivityPreset)
                }
                className="w-full rounded-md border border-border/40 bg-background/50 px-2 py-1.5 text-sm font-mono"
                data-testid="select-preset-b"
              >
                {PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {SENSITIVITY_PRESETS[p].label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <PresetCard outcome={outcomeA} slot="a" />
            <PresetCard outcome={outcomeB} slot="b" />
          </div>
          {tierDiverges && (
            <div
              className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 flex items-start gap-2"
              data-testid="tier-divergence-callout"
            >
              <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs">
                <strong className="text-yellow-400">Tier diverges:</strong>{" "}
                <span className="font-mono">{outcomeA.tier}</span> under{" "}
                {SENSITIVITY_PRESETS[presetA].label} vs{" "}
                <span className="font-mono">{outcomeB.tier}</span> under{" "}
                {SENSITIVITY_PRESETS[presetB].label}. Triage outcome is
                preset-sensitive for this report.
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
