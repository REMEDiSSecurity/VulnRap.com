// Task #631 — Curated public preset library page.
//
// Lists the curated scoring presets returned by `GET /api/presets` so
// users can pick a starting profile (PSIRT-aggressive, Bounty-triage-
// conservative, etc.) and deep-link to `/check?preset=<id>`. The /check
// page reads the same query parameter and applies the preset's
// sensitivity + slop thresholds to local settings on mount.
import { Link } from "react-router-dom";
import { Library, Sparkles, Loader2, AlertCircle, ArrowRight, Gauge, Sliders } from "lucide-react";
import { useListPresets, type PresetEntry } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const SENSITIVITY_LABEL: Record<PresetEntry["sensitivity"], { label: string; tone: string }> = {
  lenient: { label: "Lenient", tone: "border-green-500/40 text-green-300/90 bg-green-500/5" },
  balanced: { label: "Balanced", tone: "border-primary/40 text-primary bg-primary/5" },
  strict: { label: "Strict", tone: "border-orange-500/40 text-orange-300/90 bg-orange-500/5" },
};

const ENGINE_LABEL: Record<keyof PresetEntry["engineWeights"], string> = {
  linguistic: "Linguistic",
  factual: "Factual",
  template: "Template",
  llm: "LLM",
};

function formatWeight(w: number): string {
  return w.toFixed(1);
}

function weightTone(w: number): string {
  if (w >= 1.3) return "text-orange-300";
  if (w >= 1.05) return "text-primary";
  if (w <= 0.7) return "text-muted-foreground";
  return "text-foreground/85";
}

function PresetCard({ preset }: { preset: PresetEntry }) {
  const sens = SENSITIVITY_LABEL[preset.sensitivity];
  return (
    <Card className="glass-card rounded-xl flex flex-col h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-tight">{preset.name}</CardTitle>
          <Badge variant="outline" className={`text-[9px] uppercase tracking-wider shrink-0 ${sens.tone}`}>
            {sens.label}
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {preset.description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 flex-1 flex flex-col">
        <div className="text-[11px] text-muted-foreground/80 leading-relaxed italic">
          For: {preset.audience}
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-md bg-muted/20 border border-border/40 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground/80 uppercase tracking-wider text-[9px] font-mono">
              <Gauge className="w-3 h-3" /> Slop low
            </div>
            <div className="font-mono text-sm font-bold text-foreground mt-0.5">
              {preset.slopThresholdLow}
            </div>
          </div>
          <div className="rounded-md bg-muted/20 border border-border/40 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 text-muted-foreground/80 uppercase tracking-wider text-[9px] font-mono">
              <Gauge className="w-3 h-3" /> Slop high
            </div>
            <div className="font-mono text-sm font-bold text-foreground mt-0.5">
              {preset.slopThresholdHigh}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80">
            <Sliders className="w-3 h-3" /> Engine weights
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {(Object.entries(preset.engineWeights) as [keyof PresetEntry["engineWeights"], number][]).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between">
                <span className="text-muted-foreground/80">{ENGINE_LABEL[k]}</span>
                <span className={`font-mono font-bold ${weightTone(v)}`}>×{formatWeight(v)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto pt-2">
          <Button asChild className="w-full glow-button" size="sm">
            <Link
              to={`/check?preset=${encodeURIComponent(preset.id)}`}
              data-testid={`use-preset-${preset.id}`}
            >
              Use on /check
              <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Presets() {
  const { data, isLoading, isError, error, refetch } = useListPresets();

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Library className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Preset Library
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Curated starting profiles bundling sensitivity calibration plus per-engine weights. Pick the one that matches your triage workflow and deep-link straight to the report checker.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" />
            How presets work
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Each preset captures a sensitivity profile (lenient / balanced / strict), the slop-tier thresholds the results page uses, and how heavily each detection engine should be weighted. Clicking <span className="font-mono text-primary">Use on /check</span> loads the preset into your local settings and opens the checker so you can validate a report under that calibration.
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Presets are curated by the VulnRap team — community-submitted presets are not accepted in v1. Your choice is stored only in your browser.
          </p>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading presets…
        </div>
      )}

      {isError && (
        <Card className="glass-card border-destructive/40">
          <CardContent className="py-6 flex flex-col sm:flex-row items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-destructive mb-1">Failed to load presets</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {data && data.presets.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-12">
          No presets configured yet.
        </div>
      )}

      {data && data.presets.length > 0 && (
        <>
          <div
            className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="preset-grid"
          >
            {data.presets.map((p) => (
              <PresetCard key={p.id} preset={p} />
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground/60 font-mono text-right">
            library v{data.version}
          </div>
        </>
      )}
    </div>
  );
}
