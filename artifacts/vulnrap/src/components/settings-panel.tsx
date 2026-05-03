import { useState } from "react";
import { Settings, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getSettings,
  saveSettings,
  resetSettings,
  type VulnRapSettings,
} from "@/lib/settings";

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<VulnRapSettings>(getSettings());

  const handleChange = (key: keyof VulnRapSettings, value: number) => {
    const clamped = Math.max(0, Math.min(100, value));
    const next = { ...values, [key]: clamped };
    setValues(next);
    saveSettings(next);
  };

  const handleReset = () => {
    resetSettings();
    setValues(getSettings());
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="p-2 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
        title="Threshold Settings"
      >
        <Settings className="w-4 h-4" />
      </button>
    );
  }

  return (
    <div className="glass-card rounded-xl border border-primary/15 p-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Settings className="w-4 h-4 text-primary" />
          Threshold Settings
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleReset}
            title="Reset to defaults"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(false)}
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Customize how scores are categorized. These are stored in your browser
        and apply only to your view.
      </p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">
              Slop Score — <span className="text-green-500">Clean</span>{" "}
              threshold
            </label>
            <span className="text-xs font-mono text-muted-foreground">
              &lt; {values.slopThresholdLow}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={values.slopThresholdLow}
            onChange={(e) =>
              handleChange("slopThresholdLow", parseInt(e.target.value))
            }
            className="w-full accent-green-500 h-1.5"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/50">
            <span>0</span>
            <span>Scores below {values.slopThresholdLow} show as green</span>
            <span>100</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">
              Slop Score — <span className="text-destructive">Danger</span>{" "}
              threshold
            </label>
            <span className="text-xs font-mono text-muted-foreground">
              &ge; {values.slopThresholdHigh}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={values.slopThresholdHigh}
            onChange={(e) =>
              handleChange("slopThresholdHigh", parseInt(e.target.value))
            }
            className="w-full accent-red-500 h-1.5"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/50">
            <span>0</span>
            <span>
              Scores at or above {values.slopThresholdHigh} show as red
            </span>
            <span>100</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">
              Similarity — <span className="text-destructive">Duplicate</span>{" "}
              threshold
            </label>
            <span className="text-xs font-mono text-muted-foreground">
              &ge; {values.similarityThreshold}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={values.similarityThreshold}
            onChange={(e) =>
              handleChange("similarityThreshold", parseInt(e.target.value))
            }
            className="w-full accent-red-500 h-1.5"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/50">
            <span>0%</span>
            <span>
              Matches at or above {values.similarityThreshold}% flagged as
              duplicates
            </span>
            <span>100%</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-green-500" /> &lt;{" "}
          {values.slopThresholdLow}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />{" "}
          {values.slopThresholdLow}–{values.slopThresholdHigh - 1}
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-2 h-2 rounded-full bg-destructive" /> &ge;{" "}
          {values.slopThresholdHigh}
        </div>
      </div>
    </div>
  );
}
