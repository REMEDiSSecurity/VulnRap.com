import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Copy,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export interface EngineSubScores {
  engine1?: number | null;
  engine2?: number | null;
  engine3?: number | null;
  avri?: number | null;
}

export interface SensitivityConfig {
  sensitivity: number;
  weights: { engine1: number; engine2: number; engine3: number; avri: number };
}

export const BALANCED_CONFIG: SensitivityConfig = {
  sensitivity: 0.5,
  weights: { engine1: 1, engine2: 1, engine3: 1, avri: 1 },
};

const ENGINES: Array<{
  key: keyof SensitivityConfig["weights"];
  label: string;
  subKey: keyof EngineSubScores;
}> = [
  { key: "engine1", label: "Engine 1", subKey: "engine1" },
  { key: "engine2", label: "Engine 2", subKey: "engine2" },
  { key: "engine3", label: "Engine 3", subKey: "engine3" },
  { key: "avri", label: "AVRI", subKey: "avri" },
];

const QUERY_KEYS = {
  sensitivity: "sens",
  engine1: "wE1",
  engine2: "wE2",
  engine3: "wE3",
  avri: "wAVRI",
} as const;

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

function roundTo(n: number, places: number) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function computeAdjustedScore(
  config: SensitivityConfig,
  subScores: EngineSubScores,
): number {
  const sens = clamp(config.sensitivity, 0, 1);
  let weightedSum = 0;
  let weightSum = 0;
  for (const e of ENGINES) {
    const w = clamp(Number(config.weights[e.key]) || 0, 0, 2);
    const raw = subScores[e.subKey];
    if (raw == null || Number.isNaN(raw)) continue;
    const s = clamp(Number(raw), 0, 100);
    weightedSum += w * s;
    weightSum += w;
  }
  const avg = weightSum > 0 ? weightedSum / weightSum : 0;
  return clamp(Math.round(2 * sens * avg), 0, 100);
}

export function parseConfigFromParams(
  params: URLSearchParams,
): SensitivityConfig {
  const readNum = (key: string, fallback: number, lo: number, hi: number) => {
    const raw = params.get(key);
    if (raw == null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, lo, hi);
  };
  return {
    sensitivity: readNum(
      QUERY_KEYS.sensitivity,
      BALANCED_CONFIG.sensitivity,
      0,
      1,
    ),
    weights: {
      engine1: readNum(QUERY_KEYS.engine1, 1, 0, 2),
      engine2: readNum(QUERY_KEYS.engine2, 1, 0, 2),
      engine3: readNum(QUERY_KEYS.engine3, 1, 0, 2),
      avri: readNum(QUERY_KEYS.avri, 1, 0, 2),
    },
  };
}

export function isBalanced(config: SensitivityConfig): boolean {
  return (
    roundTo(config.sensitivity, 4) === BALANCED_CONFIG.sensitivity &&
    config.weights.engine1 === 1 &&
    config.weights.engine2 === 1 &&
    config.weights.engine3 === 1 &&
    config.weights.avri === 1
  );
}

export function applyConfigToParams(
  prev: URLSearchParams,
  config: SensitivityConfig,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (isBalanced(config)) {
    next.delete(QUERY_KEYS.sensitivity);
    next.delete(QUERY_KEYS.engine1);
    next.delete(QUERY_KEYS.engine2);
    next.delete(QUERY_KEYS.engine3);
    next.delete(QUERY_KEYS.avri);
    return next;
  }
  next.set(QUERY_KEYS.sensitivity, String(roundTo(config.sensitivity, 2)));
  next.set(QUERY_KEYS.engine1, String(roundTo(config.weights.engine1, 2)));
  next.set(QUERY_KEYS.engine2, String(roundTo(config.weights.engine2, 2)));
  next.set(QUERY_KEYS.engine3, String(roundTo(config.weights.engine3, 2)));
  next.set(QUERY_KEYS.avri, String(roundTo(config.weights.avri, 2)));
  return next;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy") === true;
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface AdvancedSensitivityPanelProps {
  subScores: EngineSubScores;
  canonicalScore: number;
  className?: string;
}

export function AdvancedSensitivityPanel({
  subScores,
  canonicalScore,
  className,
}: AdvancedSensitivityPanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialConfig = useMemo(() => parseConfigFromParams(searchParams), []);
  const [open, setOpen] = useState(() => !isBalanced(initialConfig));
  const [config, setConfig] = useState<SensitivityConfig>(initialConfig);
  const { toast } = useToast();

  useEffect(() => {
    setSearchParams((prev) => applyConfigToParams(prev, config), {
      replace: true,
    });
  }, [config, setSearchParams]);

  const adjusted = computeAdjustedScore(config, subScores);
  const delta = adjusted - canonicalScore;
  const balanced = isBalanced(config);

  const updateWeight = (
    key: keyof SensitivityConfig["weights"],
    value: number,
  ) => {
    setConfig((prev) => ({
      ...prev,
      weights: { ...prev.weights, [key]: clamp(value, 0, 2) },
    }));
  };

  const handleReset = () => {
    setConfig({
      sensitivity: BALANCED_CONFIG.sensitivity,
      weights: { ...BALANCED_CONFIG.weights },
    });
  };

  const handleShare = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const ok = await copyTextToClipboard(url);
    if (ok) {
      toast({
        title: "Link copied",
        description: "Share this URL to reproduce the config.",
      });
    } else {
      toast({
        title: "Copy failed",
        description:
          "Clipboard unavailable. Copy the URL from the address bar instead.",
        variant: "destructive",
      });
    }
  };

  return (
    <Card
      className={cn("glass-card rounded-xl", className)}
      data-testid="advanced-sensitivity-panel"
    >
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
        data-testid="advanced-sensitivity-toggle"
      >
        <CardTitle className="flex items-center gap-2 text-sm">
          <SlidersHorizontal className="w-4 h-4 text-primary" />
          Advanced sensitivity
          {!balanced && (
            <span
              className="text-[10px] font-mono uppercase tracking-wide text-yellow-400"
              data-testid="advanced-sensitivity-custom-badge"
            >
              custom
            </span>
          )}
          <span className="ml-auto">
            {open ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </span>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4 pt-0">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <label
                htmlFor="sensitivity-slider"
                className="text-muted-foreground"
              >
                Sensitivity
              </label>
              <span
                className="font-mono font-bold text-primary"
                data-testid="sensitivity-value"
              >
                {roundTo(config.sensitivity, 2).toFixed(2)}
              </span>
            </div>
            <input
              id="sensitivity-slider"
              data-testid="sensitivity-slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={config.sensitivity}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  sensitivity: clamp(Number(e.target.value), 0, 1),
                }))
              }
              className="w-full accent-primary"
              aria-label="Sensitivity"
            />
            <div className="flex justify-between text-[10px] text-muted-foreground/60 font-mono">
              <span>0.00 lenient</span>
              <span>0.50 balanced</span>
              <span>1.00 strict</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {ENGINES.map((e) => (
              <div key={e.key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label
                    htmlFor={`weight-${e.key}`}
                    className="text-muted-foreground"
                  >
                    {e.label} weight
                  </label>
                  <span
                    className="font-mono font-bold"
                    data-testid={`weight-${e.key}-value`}
                  >
                    {roundTo(config.weights[e.key], 2).toFixed(2)}×
                  </span>
                </div>
                <input
                  id={`weight-${e.key}`}
                  data-testid={`weight-${e.key}`}
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={config.weights[e.key]}
                  onChange={(ev) =>
                    updateWeight(e.key, Number(ev.target.value))
                  }
                  className="w-full accent-primary"
                  aria-label={`${e.label} weight`}
                />
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/20 px-3 py-2">
            <div className="text-xs text-muted-foreground">
              Adjusted score
              <span className="ml-2 text-[10px] font-mono">
                (canonical {canonicalScore})
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-xl font-mono font-bold text-primary glow-text"
                data-testid="adjusted-score"
              >
                {adjusted}
              </span>
              <span
                className={cn(
                  "text-[10px] font-mono",
                  delta > 0
                    ? "text-destructive"
                    : delta < 0
                      ? "text-green-400"
                      : "text-muted-foreground",
                )}
                data-testid="adjusted-score-delta"
              >
                {delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `${delta}`}
              </span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5 text-xs"
              onClick={handleReset}
              disabled={balanced}
              data-testid="advanced-sensitivity-reset"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reset to balanced
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5 text-xs"
              onClick={handleShare}
              data-testid="advanced-sensitivity-share"
            >
              <Copy className="w-3.5 h-3.5" />
              Share this config
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default AdvancedSensitivityPanel;
