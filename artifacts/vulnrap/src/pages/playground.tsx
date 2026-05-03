// Task #651 — Scoring Playground page.
//
// Purely client-side educational tool. Loads one of 5 baked-in
// pre-scored example reports, lets the user toggle individual signals
// on/off and adjust per-engine weights, and shows the recomputed
// overall slop score + tier badge live. No API calls.
import { useMemo, useState } from "react";
import { FlaskConical, RotateCcw, Sparkles, Sliders, Power } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type EngineKey = "linguistic" | "factual" | "template" | "llm";

interface PlaygroundSignal {
  id: string;
  label: string;
  description: string;
  /** 0-100; higher = more slop-like. */
  score: number;
}

interface PlaygroundEngine {
  key: EngineKey;
  label: string;
  defaultWeight: number;
  signals: PlaygroundSignal[];
}

interface PlaygroundExample {
  id: string;
  title: string;
  blurb: string;
  engines: PlaygroundEngine[];
}

const EXAMPLES: PlaygroundExample[] = [
  {
    id: "human-xss",
    title: "Hand-written XSS in /search",
    blurb: "A specific reflected-XSS report with concrete payload, repro steps, and screenshots. Looks human.",
    engines: [
      {
        key: "linguistic", label: "Linguistic", defaultWeight: 1.0,
        signals: [
          { id: "burstiness", label: "Burstiness", description: "Variance in sentence length. Humans vary more.", score: 18 },
          { id: "perplexity", label: "Perplexity", description: "How predictable token-by-token. Low = AI-like.", score: 22 },
          { id: "ai-cliches", label: "AI clichés", description: "“In conclusion”, “it’s important to note”, etc.", score: 10 },
        ],
      },
      {
        key: "factual", label: "Factual", defaultWeight: 1.0,
        signals: [
          { id: "cwe-coherence", label: "CWE coherence", description: "Does the named CWE match the described bug?", score: 15 },
          { id: "cve-realism", label: "CVE realism", description: "Plausible CPE, version range, and impact?", score: 20 },
        ],
      },
      {
        key: "template", label: "Template", defaultWeight: 1.0,
        signals: [
          { id: "boilerplate", label: "Boilerplate match", description: "Overlap with known templated-report skeletons.", score: 25 },
          { id: "section-shape", label: "Section shape", description: "Symmetric H1/H2 padding typical of generators.", score: 20 },
        ],
      },
      {
        key: "llm", label: "LLM", defaultWeight: 1.0,
        signals: [
          { id: "llm-judge", label: "Judge verdict", description: "Independent LLM judge verdict score.", score: 12 },
        ],
      },
    ],
  },
  {
    id: "padded-prototype",
    title: "Padded prototype-pollution writeup",
    blurb: "Long, well-formatted, structurally perfect — but the actual technical density is thin.",
    engines: [
      {
        key: "linguistic", label: "Linguistic", defaultWeight: 1.0,
        signals: [
          { id: "burstiness", label: "Burstiness", description: "Variance in sentence length.", score: 60 },
          { id: "perplexity", label: "Perplexity", description: "Token-level predictability.", score: 55 },
          { id: "ai-cliches", label: "AI clichés", description: "Common AI phrasing markers.", score: 70 },
        ],
      },
      {
        key: "factual", label: "Factual", defaultWeight: 1.0,
        signals: [
          { id: "cwe-coherence", label: "CWE coherence", description: "CWE vs. described bug.", score: 35 },
          { id: "cve-realism", label: "CVE realism", description: "Plausible impact wording.", score: 40 },
        ],
      },
      {
        key: "template", label: "Template", defaultWeight: 1.0,
        signals: [
          { id: "boilerplate", label: "Boilerplate match", description: "Overlap with templated skeletons.", score: 75 },
          { id: "section-shape", label: "Section shape", description: "Symmetric formatting padding.", score: 80 },
        ],
      },
      {
        key: "llm", label: "LLM", defaultWeight: 1.0,
        signals: [
          { id: "llm-judge", label: "Judge verdict", description: "LLM judge verdict.", score: 65 },
        ],
      },
    ],
  },
  {
    id: "pure-slop",
    title: "Pure-slop fabricated SQLi",
    blurb: "Generated end-to-end. Fake CVE, vague repro, hallucinated payload.",
    engines: [
      {
        key: "linguistic", label: "Linguistic", defaultWeight: 1.0,
        signals: [
          { id: "burstiness", label: "Burstiness", description: "Sentence-length variance.", score: 85 },
          { id: "perplexity", label: "Perplexity", description: "Token-level predictability.", score: 88 },
          { id: "ai-cliches", label: "AI clichés", description: "Generator-typical phrasing.", score: 90 },
        ],
      },
      {
        key: "factual", label: "Factual", defaultWeight: 1.0,
        signals: [
          { id: "cwe-coherence", label: "CWE coherence", description: "CWE vs. actual described bug.", score: 80 },
          { id: "cve-realism", label: "CVE realism", description: "Plausible CVE / CPE / version range.", score: 92 },
        ],
      },
      {
        key: "template", label: "Template", defaultWeight: 1.0,
        signals: [
          { id: "boilerplate", label: "Boilerplate match", description: "Templated-report overlap.", score: 78 },
          { id: "section-shape", label: "Section shape", description: "Symmetric padding.", score: 82 },
        ],
      },
      {
        key: "llm", label: "LLM", defaultWeight: 1.0,
        signals: [
          { id: "llm-judge", label: "Judge verdict", description: "LLM judge verdict.", score: 90 },
        ],
      },
    ],
  },
  {
    id: "edge-mixed",
    title: "Edge case: human report, AI-polished",
    blurb: "Real bug, but the author cleaned it up with an LLM. Linguistic flags, factual is solid.",
    engines: [
      {
        key: "linguistic", label: "Linguistic", defaultWeight: 1.0,
        signals: [
          { id: "burstiness", label: "Burstiness", description: "Sentence-length variance.", score: 65 },
          { id: "perplexity", label: "Perplexity", description: "Token-level predictability.", score: 70 },
          { id: "ai-cliches", label: "AI clichés", description: "Generator phrasing markers.", score: 55 },
        ],
      },
      {
        key: "factual", label: "Factual", defaultWeight: 1.0,
        signals: [
          { id: "cwe-coherence", label: "CWE coherence", description: "CWE vs. described bug.", score: 12 },
          { id: "cve-realism", label: "CVE realism", description: "Plausible impact / version.", score: 18 },
        ],
      },
      {
        key: "template", label: "Template", defaultWeight: 1.0,
        signals: [
          { id: "boilerplate", label: "Boilerplate match", description: "Templated-report overlap.", score: 40 },
          { id: "section-shape", label: "Section shape", description: "Section-padding symmetry.", score: 45 },
        ],
      },
      {
        key: "llm", label: "LLM", defaultWeight: 1.0,
        signals: [
          { id: "llm-judge", label: "Judge verdict", description: "LLM judge verdict.", score: 25 },
        ],
      },
    ],
  },
  {
    id: "low-effort-dupe",
    title: "Low-effort duplicate of public PoC",
    blurb: "Copy-pasted from a public GitHub PoC with minimal additions.",
    engines: [
      {
        key: "linguistic", label: "Linguistic", defaultWeight: 1.0,
        signals: [
          { id: "burstiness", label: "Burstiness", description: "Sentence-length variance.", score: 35 },
          { id: "perplexity", label: "Perplexity", description: "Token-level predictability.", score: 40 },
          { id: "ai-cliches", label: "AI clichés", description: "Generator phrasing markers.", score: 30 },
        ],
      },
      {
        key: "factual", label: "Factual", defaultWeight: 1.0,
        signals: [
          { id: "cwe-coherence", label: "CWE coherence", description: "CWE vs. described bug.", score: 30 },
          { id: "cve-realism", label: "CVE realism", description: "Plausible CPE / impact.", score: 35 },
        ],
      },
      {
        key: "template", label: "Template", defaultWeight: 1.0,
        signals: [
          { id: "boilerplate", label: "Boilerplate match", description: "Templated-report overlap.", score: 60 },
          { id: "section-shape", label: "Section shape", description: "Section padding.", score: 55 },
        ],
      },
      {
        key: "llm", label: "LLM", defaultWeight: 1.0,
        signals: [
          { id: "llm-judge", label: "Judge verdict", description: "LLM judge verdict.", score: 50 },
        ],
      },
    ],
  },
];

const ENGINE_ORDER: EngineKey[] = ["linguistic", "factual", "template", "llm"];

function tierFor(score: number): { label: string; badge: string; bar: string } {
  if (score >= 75) return { label: "Slop", badge: "border-red-500/50 text-red-400 bg-red-500/10", bar: "bg-red-500" };
  if (score >= 55) return { label: "Likely Slop", badge: "border-orange-500/50 text-orange-400 bg-orange-500/10", bar: "bg-orange-500" };
  if (score >= 35) return { label: "Questionable", badge: "border-amber-500/50 text-amber-400 bg-amber-500/10", bar: "bg-amber-500" };
  return { label: "Likely Human", badge: "border-green-500/50 text-green-400 bg-green-500/10", bar: "bg-green-500" };
}

function buildDefaultEnabled(example: PlaygroundExample): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  example.engines.forEach((engine) => {
    engine.signals.forEach((sig) => {
      next[`${engine.key}:${sig.id}`] = true;
    });
  });
  return next;
}

function buildDefaultWeights(example: PlaygroundExample): Record<EngineKey, number> {
  const next = {} as Record<EngineKey, number>;
  example.engines.forEach((engine) => {
    next[engine.key] = engine.defaultWeight;
  });
  return next;
}

export default function PlaygroundPage() {
  const [exampleId, setExampleId] = useState<string>(EXAMPLES[0].id);
  const example = useMemo(
    () => EXAMPLES.find((e) => e.id === exampleId) ?? EXAMPLES[0],
    [exampleId],
  );

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    buildDefaultEnabled(EXAMPLES[0]),
  );
  const [weights, setWeights] = useState<Record<EngineKey, number>>(() =>
    buildDefaultWeights(EXAMPLES[0]),
  );

  function applyExample(id: string) {
    const next = EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
    setExampleId(next.id);
    setEnabled(buildDefaultEnabled(next));
    setWeights(buildDefaultWeights(next));
  }

  function resetDefaults() {
    setEnabled(buildDefaultEnabled(example));
    setWeights(buildDefaultWeights(example));
  }

  // Per-engine recompute: average of enabled signals' scores. Engines with
  // zero enabled signals contribute nothing (and their weight is dropped
  // from the denominator) so toggling everything off doesn't divide by 0.
  const { engineScores, finalScore } = useMemo(() => {
    const perEngine: Partial<Record<EngineKey, number | null>> = {};
    let weightedSum = 0;
    let weightTotal = 0;
    example.engines.forEach((engine) => {
      const active = engine.signals.filter((s) => enabled[`${engine.key}:${s.id}`]);
      if (active.length === 0) {
        perEngine[engine.key] = null;
        return;
      }
      const avg = active.reduce((acc, s) => acc + s.score, 0) / active.length;
      perEngine[engine.key] = avg;
      const w = weights[engine.key] ?? 1;
      weightedSum += avg * w;
      weightTotal += w;
    });
    const final = weightTotal === 0 ? 0 : weightedSum / weightTotal;
    return { engineScores: perEngine, finalScore: Math.round(final) };
  }, [example, enabled, weights]);

  const tier = tierFor(finalScore);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-primary">
          <FlaskConical className="w-5 h-5" />
          <span className="text-[10px] font-mono uppercase tracking-[0.18em]">Scoring Playground</span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          See exactly how each lever moves the score
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          Pick a pre-scored sample report. Toggle individual signals off to remove them from
          their engine's average. Drag a per-engine weight slider to change how much that
          engine matters in the final score. Everything is recomputed live, in your browser —
          no API calls.
        </p>
      </header>

      {/* Sample picker */}
      <Card className="glass-card rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> Sample report
          </CardTitle>
          <CardDescription className="text-xs">
            Five pre-scored examples covering the common shapes we see in the wild.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block">
            <span className="sr-only">Choose a sample report</span>
            <select
              value={exampleId}
              onChange={(e) => applyExample(e.target.value)}
              data-testid="playground-example-select"
              className="w-full bg-muted/30 border border-border/60 rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary/60"
            >
              {EXAMPLES.map((ex) => (
                <option key={ex.id} value={ex.id}>{ex.title}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground/80 leading-relaxed">{example.blurb}</p>
        </CardContent>
      </Card>

      {/* Live score */}
      <Card className="glass-card rounded-xl">
        <CardContent className="pt-6 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 font-mono">
                Live overall slop score
              </div>
              <div className="flex items-baseline gap-3 mt-1">
                <span
                  data-testid="playground-final-score"
                  className="text-5xl font-bold font-mono text-foreground tabular-nums"
                >
                  {finalScore}
                </span>
                <span className="text-sm text-muted-foreground">/ 100</span>
              </div>
            </div>
            <Badge
              variant="outline"
              data-testid="playground-tier-badge"
              className={cn("text-xs uppercase tracking-wider px-3 py-1", tier.badge)}
            >
              {tier.label}
            </Badge>
          </div>
          <Progress value={finalScore} className="h-2" indicatorClassName={tier.bar} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ENGINE_ORDER.map((key) => {
              const engine = example.engines.find((e) => e.key === key);
              if (!engine) return null;
              const raw = engineScores[key];
              const display = raw == null ? "—" : Math.round(raw);
              return (
                <div
                  key={key}
                  data-testid={`playground-engine-score-${key}`}
                  className="rounded-md bg-muted/20 border border-border/40 px-3 py-2"
                >
                  <div className="text-[9px] uppercase tracking-wider font-mono text-muted-foreground/80">
                    {engine.label}
                  </div>
                  <div className="font-mono text-base font-bold text-foreground mt-0.5 tabular-nums">
                    {display}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">
                    weight {weights[key].toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={resetDefaults}
              data-testid="playground-reset"
              className="text-xs"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> Reset to defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Engine weights */}
      <Card className="glass-card rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sliders className="w-4 h-4 text-primary" /> Per-engine weights
          </CardTitle>
          <CardDescription className="text-xs">
            Each engine contributes its average enabled-signal score, weighted by these sliders.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          {example.engines.map((engine) => (
            <div key={engine.key} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{engine.label}</span>
                <span className="font-mono text-muted-foreground tabular-nums">
                  {weights[engine.key].toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={weights[engine.key]}
                onChange={(e) =>
                  setWeights((w) => ({ ...w, [engine.key]: parseFloat(e.target.value) }))
                }
                data-testid={`playground-weight-${engine.key}`}
                className="w-full accent-primary"
                aria-label={`${engine.label} weight`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Per-signal toggles */}
      <Card className="glass-card rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Power className="w-4 h-4 text-primary" /> Signal toggles
          </CardTitle>
          <CardDescription className="text-xs">
            Turn a signal off to drop it from its engine's average. Off signals show muted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {example.engines.map((engine) => (
            <div key={engine.key} className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider font-mono text-primary/80">
                {engine.label}
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {engine.signals.map((sig) => {
                  const key = `${engine.key}:${sig.id}`;
                  const on = enabled[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setEnabled((e) => ({ ...e, [key]: !e[key] }))}
                      data-testid={`playground-toggle-${engine.key}-${sig.id}`}
                      aria-pressed={on}
                      className={cn(
                        "text-left rounded-md border px-3 py-2 transition-colors",
                        on
                          ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                          : "border-border/40 bg-muted/10 hover:bg-muted/20 opacity-60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium leading-tight">{sig.label}</span>
                        <span
                          className={cn(
                            "font-mono text-xs tabular-nums",
                            on ? "text-foreground" : "text-muted-foreground/60 line-through",
                          )}
                        >
                          {sig.score}
                        </span>
                      </div>
                      <div className="text-[11px] leading-snug text-muted-foreground/80 mt-1">
                        {sig.description}
                      </div>
                      <div className="mt-1 text-[10px] uppercase tracking-wider font-mono">
                        <span className={on ? "text-primary" : "text-muted-foreground/60"}>
                          {on ? "On" : "Off"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
        This page is a teaching aid. The math here is a simplified mirror of the production
        pipeline (per-engine signal averages combined by weighted mean) — real reports route
        through additional normalization and AVRI sub-rubric steps.
      </p>
    </div>
  );
}
