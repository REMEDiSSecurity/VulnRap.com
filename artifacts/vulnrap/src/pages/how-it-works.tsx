import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  Play,
  Pause,
  RotateCcw,
  ChevronDown,
  Shield,
  Languages,
  FlaskConical,
  Network,
  Gauge,
  Layers,
  ArrowRight,
  Sparkles,
  Loader2,
  AlertCircle,
  Type,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCheckReport } from "@workspace/api-client-react";
import pipelineHero from "@/assets/pipeline-cross-section-hero.webp";

type StepId = "redact" | "linguistic" | "substance" | "cwe" | "avri" | "fusion";

interface StepDef {
  id: StepId;
  title: string;
  oneLiner: string;
  icon: React.ReactNode;
  accent: string;
  body: React.ReactNode;
  blogTo?: string;
  blogLabel?: string;
}

interface SampleStepResult {
  fired: boolean;
  detail: string;
  score?: number;
}

type SampleId = "slop" | "legit" | "custom";

interface Sample {
  id: SampleId;
  label: string;
  blurb: string;
  text: string;
  steps: Record<StepId, SampleStepResult>;
  finalLabel: string;
  finalTier: "rejected" | "needs-review" | "accept";
  finalScore: number;
}

function mapTier(slopTier: string): Sample["finalTier"] {
  const t = slopTier.toLowerCase();
  if (t.includes("reject") || t.includes("ai") || t.includes("slop"))
    return "rejected";
  if (
    t.includes("review") ||
    t.includes("question") ||
    t.includes("borderline")
  )
    return "needs-review";
  return "accept";
}

function mapTierLabel(tier: Sample["finalTier"], score: number): string {
  if (tier === "rejected") return score < 25 ? "Likely AI slop" : "Suspicious";
  if (tier === "needs-review") return "Needs review";
  return "Looks real";
}

function buildRedactDetail(redactionSummary: {
  totalRedactions: number;
  categories: Record<string, number>;
}): string {
  const { totalRedactions, categories } = redactionSummary;
  if (totalRedactions === 0) return "0 PII tokens, 0 secrets — text passes through clean.";
  const parts = Object.entries(categories)
    .map(([cat, count]) => `${count} ${cat}`)
    .join(", ");
  return `${totalRedactions} redaction${totalRedactions !== 1 ? "s" : ""} (${parts}) — structure preserved.`;
}

function buildCustomSample(data: {
  slopScore: number;
  slopTier: string;
  breakdown: {
    linguistic: number;
    factual: number;
    template: number;
    quality: number;
    substanceScore?: number | null;
    coherenceScore?: number | null;
    pocValidity?: number | null;
    domainCoherence?: number | null;
  };
  redactionSummary: { totalRedactions: number; categories: Record<string, number> };
  text: string;
}): Sample {
  const { slopScore, slopTier, breakdown, redactionSummary, text } = data;
  const tier = mapTier(slopTier);

  const linguisticNorm = breakdown.linguistic / 100;
  const substanceRaw =
    breakdown.substanceScore != null
      ? breakdown.substanceScore / 100
      : breakdown.factual / 100;
  const cweRaw =
    breakdown.coherenceScore != null
      ? breakdown.coherenceScore / 100
      : breakdown.domainCoherence != null
        ? breakdown.domainCoherence / 100
        : breakdown.quality / 100;
  const avriRaw =
    breakdown.pocValidity != null
      ? breakdown.pocValidity / 100
      : 1 - breakdown.template / 100;

  const qualityScore = 100 - slopScore;

  return {
    id: "custom",
    label: "Your report",
    blurb: `${text.length} characters · scored live`,
    text,
    steps: {
      redact: {
        fired: redactionSummary.totalRedactions > 0,
        detail: buildRedactDetail(redactionSummary),
      },
      linguistic: {
        fired: breakdown.linguistic > 40,
        detail: `Linguistic AI-cadence score ${(breakdown.linguistic / 100).toFixed(2)}`,
        score: linguisticNorm,
      },
      substance: {
        fired: substanceRaw < 0.35,
        detail:
          breakdown.substanceScore != null
            ? `LLM substance score ${breakdown.substanceScore}/100 · factual density ${(breakdown.factual / 100).toFixed(2)}`
            : `Factual density ${(breakdown.factual / 100).toFixed(2)}`,
        score: substanceRaw,
      },
      cwe: {
        fired: cweRaw < 0.5,
        detail:
          breakdown.coherenceScore != null
            ? `Coherence score ${breakdown.coherenceScore}/100`
            : breakdown.domainCoherence != null
              ? `Domain coherence ${breakdown.domainCoherence}/100`
              : `Quality-based coherence estimate ${breakdown.quality}/100`,
        score: cweRaw,
      },
      avri: {
        fired: avriRaw < 0.5,
        detail:
          breakdown.pocValidity != null
            ? `PoC validity ${breakdown.pocValidity}/100 · template score ${breakdown.template}/100`
            : `Template pattern score ${breakdown.template}/100 — claim-vs-repro gap estimated`,
        score: avriRaw,
      },
      fusion: {
        fired: qualityScore < 50,
        detail: `Weighted fusion → ${qualityScore}/100 · tier: ${tier}.`,
        score: qualityScore,
      },
    },
    finalLabel: mapTierLabel(tier, qualityScore),
    finalTier: tier,
    finalScore: qualityScore,
  };
}

const SAMPLES: Sample[] = [
  {
    id: "slop",
    label: "AI-generated slop",
    blurb: "Confident-sounding but evidence-free.",
    text: "Critical RCE in api/login. The endpoint suffers from a classic deserialization flaw which a sophisticated attacker could leverage to execute arbitrary code on the server, leading to a complete compromise of the underlying system. CVSS 9.8.",
    steps: {
      redact: {
        fired: true,
        detail: "0 PII tokens, 0 secrets — text passes through clean.",
      },
      linguistic: {
        fired: true,
        detail:
          '5 hype phrases ("classic", "sophisticated attacker", "complete compromise", "leveraged", "arbitrary code") · LLM-cadence score 0.81',
        score: 0.78,
      },
      substance: {
        fired: true,
        detail:
          "0 code blocks · 0 stack traces · 0 HTTP requests · density 0.04",
        score: 0.12,
      },
      cwe: {
        fired: true,
        detail:
          'Claims "deserialization" but no class names, no payload, no sink — CWE-502 incoherent.',
        score: 0.18,
      },
      avri: {
        fired: true,
        detail:
          "Asserter-vs-Reproducer gap = 0.71 (lots of claims, nothing reproduced).",
        score: 0.22,
      },
      fusion: {
        fired: true,
        detail: "Weighted fusion → 14/100 · tier: rejected.",
        score: 14,
      },
    },
    finalLabel: "Likely AI slop",
    finalTier: "rejected",
    finalScore: 14,
  },
  {
    id: "legit",
    label: "Real reproducible bug",
    blurb: "Short, evidence-dense, reproducible.",
    text: "POST /api/v2/reset accepts an external `redirect_uri` without allow-listing. Reproduce: curl -X POST host/api/v2/reset -d 'email=a@b&redirect_uri=//evil.tld' → 302 Location: //evil.tld . Stack: src/auth/reset.ts:48 (buildRedirect). Affects v3.4.0–v3.6.2.",
    steps: {
      redact: {
        fired: true,
        detail:
          "1 email redacted (a@b → ⟨email⟩), 0 secrets — preserved structure.",
      },
      linguistic: {
        fired: false,
        detail: "0 hype phrases · LLM-cadence 0.12 (human-engineer pattern).",
        score: 0.08,
      },
      substance: {
        fired: false,
        detail:
          "1 curl repro · 1 file:line ref · 1 version range · density 0.71",
        score: 0.78,
      },
      cwe: {
        fired: false,
        detail:
          "CWE-601 (Open Redirect) coherent: sink + payload + observed effect all present.",
        score: 0.86,
      },
      avri: {
        fired: false,
        detail: "Asserter-vs-Reproducer gap = 0.06 (claims match repro steps).",
        score: 0.91,
      },
      fusion: {
        fired: false,
        detail: "Weighted fusion → 84/100 · tier: accept.",
        score: 84,
      },
    },
    finalLabel: "Looks real",
    finalTier: "accept",
    finalScore: 84,
  },
];

const STEPS: StepDef[] = [
  {
    id: "redact",
    title: "1 · Redact",
    oneLiner:
      "Strip PII, secrets, and tokens before anything else touches the text.",
    icon: <Shield className="w-4 h-4" />,
    accent: "rgba(167,139,250,0.55)",
    blogTo: "/privacy",
    blogLabel: "Privacy & redaction",
    body: (
      <>
        <p>
          Every report is run through a redaction pass <em>before</em> it
          reaches any engine, model, or storage layer. Emails, IPs, JWTs, AWS
          keys, GitHub tokens, and a curated list of secret-shaped strings are
          replaced with structural placeholders like{" "}
          <code className="text-primary">⟨email⟩</code> or{" "}
          <code className="text-primary">⟨jwt⟩</code>.
        </p>
        <p className="mt-2">
          The placeholders preserve <em>shape</em> so downstream engines can
          still tell that "a token was here" without ever seeing the token. This
          is also what we hash and store — the original text is dropped on the
          floor.
        </p>
      </>
    ),
  },
  {
    id: "linguistic",
    title: "2 · Linguistic",
    oneLiner:
      "Looks for AI-cadence: hype phrases, hedging, and that 'confidently vague' tone.",
    icon: <Languages className="w-4 h-4" />,
    accent: "rgba(34,211,238,0.55)",
    blogTo: "/blog",
    blogLabel: "Methodology blog",
    body: (
      <>
        <p>
          A pattern bank of hype phrases ("sophisticated attacker", "complete
          compromise", "leverages a classic flaw"), hedge-stacking, and pacing
          markers feeds a small classifier that scores how much the text reads
          like a generated security writeup vs. a human one.
        </p>
        <p className="mt-2">
          High score here is suspicious but never sufficient — plenty of real
          engineers write in formal English. It only earns weight when the next
          two engines agree something is off.
        </p>
      </>
    ),
  },
  {
    id: "substance",
    title: "3 · Substance",
    oneLiner:
      "Counts the concrete stuff: code, requests, stack traces, file:line refs.",
    icon: <FlaskConical className="w-4 h-4" />,
    accent: "rgba(52,211,153,0.55)",
    blogTo: "/engines/substance",
    blogLabel: "Substance engine deep-dive",
    body: (
      <>
        <p>
          The substance engine is a structural reader: it counts code fences,
          HTTP request lines, stack frames, file paths with line numbers,
          version ranges, and CVE/CWE/CVSS strings — and divides by total tokens
          to get a density score.
        </p>
        <p className="mt-2">
          Low density on a long report is the single strongest "this is hot air"
          signal we have. A short report with high density is fine.
        </p>
      </>
    ),
  },
  {
    id: "cwe",
    title: "4 · CWE Coherence",
    oneLiner: "Does the claimed weakness actually match what the report shows?",
    icon: <Network className="w-4 h-4" />,
    accent: "rgba(251,191,36,0.55)",
    blogTo: "/blog",
    blogLabel: "CWE coherence write-up",
    body: (
      <>
        <p>
          For each CWE the reporter claims (or that we infer), this engine
          checks whether the surrounding evidence makes sense for that weakness
          class. CWE-502 (deserialization) without a sink, payload, or class
          name is incoherent. CWE-601 (open redirect) with a curl repro and
          observed 302 is coherent.
        </p>
        <p className="mt-2">
          Each CWE family has its own checklist of "what should be present if
          this is real." Mismatches dock the score; clean matches reinforce it.
        </p>
      </>
    ),
  },
  {
    id: "avri",
    title: "5 · AVRI",
    oneLiner:
      "Asserter-vs-Reproducer Index: how much of what's claimed is actually reproduced?",
    icon: <Gauge className="w-4 h-4" />,
    accent: "rgba(244,114,182,0.55)",
    blogTo: "/transparency",
    blogLabel: "Transparency report",
    body: (
      <>
        <p>
          AVRI splits the report into <strong>assertions</strong> ("RCE", "any
          user", "complete compromise") and <strong>reproductions</strong>{" "}
          (commands, requests, observed responses, version constraints). The gap
          between the two is the AVRI score.
        </p>
        <p className="mt-2">
          A wide gap (lots of claims, little repro) is the classic shape of
          generated reports. A narrow gap is a healthy "I claim X and here's
          exactly how to see X."
        </p>
      </>
    ),
  },
  {
    id: "fusion",
    title: "6 · Fusion",
    oneLiner:
      "Weighted combination of all engines, with sensitivity preset applied.",
    icon: <Layers className="w-4 h-4" />,
    accent: "rgba(96,165,250,0.55)",
    blogTo: "/presets",
    blogLabel: "Sensitivity presets",
    body: (
      <>
        <p>
          The four engine scores are combined with per-engine weights from the
          active sensitivity preset (e.g.{" "}
          <code className="text-primary">strict-triage</code> upweights
          substance and AVRI; <code className="text-primary">research</code> is
          more permissive). The output is a 0–100 score and a tier:{" "}
          <em>rejected</em>, <em>needs-review</em>, or <em>accept</em>.
        </p>
        <p className="mt-2">
          Fusion is intentionally boring: it's a transparent weighted sum, not a
          black-box model. You can replay any score by hand from the four
          sub-scores and the preset weights.
        </p>
      </>
    ),
  },
];

function tierStyle(tier: Sample["finalTier"]) {
  switch (tier) {
    case "rejected":
      return {
        color: "hsl(var(--chart-3))",
        bg: "hsl(var(--chart-3) / 0.12)",
        border: "hsl(var(--chart-3) / 0.45)",
      };
    case "needs-review":
      return {
        color: "hsl(var(--chart-4))",
        bg: "hsl(var(--chart-4) / 0.12)",
        border: "hsl(var(--chart-4) / 0.45)",
      };
    case "accept":
      return {
        color: "hsl(var(--chart-5))",
        bg: "hsl(var(--chart-5) / 0.12)",
        border: "hsl(var(--chart-5) / 0.45)",
      };
  }
}

const ANIM_STEP_MS = 700;

export default function HowItWorks() {
  const [sampleId, setSampleId] = useState<SampleId>("slop");
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [playing, setPlaying] = useState(false);
  const [openId, setOpenId] = useState<StepId | null>("redact");

  const [customText, setCustomText] = useState("");
  const [customSample, setCustomSample] = useState<Sample | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  const checkMutation = useCheckReport({
    mutation: {
      onSuccess: (data, variables) => {
        const built = buildCustomSample({
          slopScore: data.slopScore,
          slopTier: data.slopTier,
          breakdown: data.breakdown,
          redactionSummary: data.redactionSummary,
          text: (variables.data.rawText ?? "").trim(),
        });
        setCustomSample(built);
        setCustomError(null);
        setActiveIdx(-1);
        setTimeout(() => {
          setActiveIdx(0);
          setPlaying(true);
        }, 150);
      },
      onError: (err: unknown) => {
        let msg = "Scoring unavailable — try again later or use a pre-built sample.";
        if (err && typeof err === "object") {
          const e = err as Record<string, unknown>;
          if (
            "data" in e &&
            e.data &&
            typeof e.data === "object" &&
            "error" in (e.data as Record<string, unknown>)
          ) {
            msg = String((e.data as Record<string, unknown>).error);
          } else if ("message" in e && typeof e.message === "string") {
            msg = e.message;
          }
        }
        setCustomError(msg);
      },
    },
  });

  const handleCustomSubmit = useCallback(() => {
    const trimmed = customText.trim();
    if (trimmed.length === 0) return;
    setCustomError(null);
    setPlaying(false);
    setActiveIdx(-1);
    setCustomSample(null);
    checkMutation.mutate({ data: { rawText: trimmed } });
  }, [customText, checkMutation]);

  const isCustomMode = sampleId === "custom";
  const sample = useMemo(() => {
    if (isCustomMode && customSample) return customSample;
    return SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0];
  }, [sampleId, customSample, isCustomMode]);

  useEffect(() => {
    if (!playing) return;
    if (activeIdx >= STEPS.length - 1) {
      const t = setTimeout(() => setPlaying(false), ANIM_STEP_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setActiveIdx((i) => i + 1), ANIM_STEP_MS);
    return () => clearTimeout(t);
  }, [playing, activeIdx]);

  function handlePlay() {
    if (isCustomMode && !customSample) return;
    if (activeIdx >= STEPS.length - 1) setActiveIdx(-1);
    setPlaying(true);
    if (activeIdx < 0) setActiveIdx(0);
  }
  function handlePause() {
    setPlaying(false);
  }
  function handleReset() {
    setPlaying(false);
    setActiveIdx(-1);
  }
  function handleSwitchSample(id: SampleId) {
    setSampleId(id);
    setPlaying(false);
    setActiveIdx(-1);
  }

  const showPipeline = !isCustomMode || customSample != null;
  const tier = tierStyle(sample.finalTier);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Hero */}
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-primary/70 font-mono">
          <BookOpen className="w-3.5 h-3.5" />
          How it works
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight glow-text">
          From paste to tier — every step, transparently.
        </h1>
        <p className="text-muted-foreground max-w-3xl leading-relaxed">
          VulnRap doesn't score reports with a single black-box model. It runs
          them through a small pipeline of focused engines, each one cheap to
          explain and cheap to audit. Pick a sample below and hit{" "}
          <strong>Play</strong> to watch each step light up.
        </p>
        <figure className="mt-4 rounded-xl overflow-hidden border border-border/60 bg-[#08090c]">
          <img
            src={pipelineHero}
            alt="A side cross-section of a glowing transparent conduit with a glowing document travelling left-to-right through five colored chambers, suggesting a multi-stage refinement pipeline."
            width={1792}
            height={768}
            loading="eager"
            fetchPriority="high"
            className="w-full h-auto block"
          />
        </figure>
      </header>

      {/* Live example */}
      <section className="rounded-xl border border-primary/25 bg-card/40 backdrop-blur-sm overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-primary/15 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-primary/80">
            <Sparkles className="w-3.5 h-3.5" />
            Live walkthrough
          </div>
          <div className="flex items-center gap-1">
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleSwitchSample(s.id)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md font-medium transition-colors",
                  sampleId === s.id
                    ? "bg-primary/15 text-primary border border-primary/40"
                    : "text-muted-foreground hover:text-primary border border-transparent",
                )}
              >
                {s.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleSwitchSample("custom")}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md font-medium transition-colors inline-flex items-center gap-1",
                sampleId === "custom"
                  ? "bg-primary/15 text-primary border border-primary/40"
                  : "text-muted-foreground hover:text-primary border border-transparent",
              )}
            >
              <Type className="w-3 h-3" />
              Try your own
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {isCustomMode ? (
            <>
              <div className="text-xs text-muted-foreground">
                Paste a vulnerability report below and hit <strong>Score &amp; animate</strong> to watch the pipeline light up with real scores.
              </div>
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder={"Paste your vulnerability report here…\n\ne.g. \"POST /api/v2/reset accepts an external redirect_uri without allow-listing…\""}
                className="w-full min-h-[140px] max-h-[320px] text-xs sm:text-[13px] leading-relaxed font-mono whitespace-pre-wrap rounded-lg border border-primary/15 bg-black/40 p-3 sm:p-4 text-foreground/90 placeholder:text-muted-foreground/40 resize-y focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-colors"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleCustomSubmit}
                  disabled={customText.trim().length === 0 || checkMutation.isPending}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors",
                    customText.trim().length === 0 || checkMutation.isPending
                      ? "bg-muted/20 text-muted-foreground/50 border-border/30 cursor-not-allowed"
                      : "bg-primary/15 text-primary border-primary/40 hover:bg-primary/25",
                  )}
                >
                  {checkMutation.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Scoring…
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      Score &amp; animate
                    </>
                  )}
                </button>
                {customSample && (
                  <>
                    {!playing ? (
                      <button
                        type="button"
                        onClick={handlePlay}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary border border-transparent transition-colors"
                      >
                        <Play className="w-3.5 h-3.5" />
                        {activeIdx >= STEPS.length - 1 ? "Replay" : "Resume"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handlePause}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary border border-transparent transition-colors"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        Pause
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleReset}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary border border-transparent transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset
                    </button>
                  </>
                )}
                <span className="text-[11px] text-muted-foreground/70 ml-auto font-mono">
                  {checkMutation.isPending
                    ? "analyzing…"
                    : customSample
                      ? activeIdx < 0
                        ? "ready"
                        : `step ${Math.min(activeIdx + 1, STEPS.length)} / ${STEPS.length}`
                      : "paste & score"}
                </span>
              </div>
              {customError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 flex items-start gap-2 text-xs text-red-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{customError}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">{sample.blurb}</div>
              <pre className="text-xs sm:text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words rounded-lg border border-primary/15 bg-black/40 p-3 sm:p-4 text-foreground/90">
                {sample.text}
              </pre>

              {/* Controls */}
              <div className="flex flex-wrap items-center gap-2">
                {!playing ? (
                  <button
                    type="button"
                    onClick={handlePlay}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25 transition-colors"
                  >
                    <Play className="w-3.5 h-3.5" />
                    {activeIdx >= STEPS.length - 1
                      ? "Replay"
                      : activeIdx < 0
                        ? "Play pipeline"
                        : "Resume"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handlePause}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-muted/40 text-foreground/80 border border-border hover:bg-muted/60 transition-colors"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    Pause
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary border border-transparent transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
                <span className="text-[11px] text-muted-foreground/70 ml-auto font-mono">
                  {activeIdx < 0
                    ? "idle"
                    : `step ${Math.min(activeIdx + 1, STEPS.length)} / ${STEPS.length}`}
                </span>
              </div>
            </>
          )}

          {/* Step lights */}
          {showPipeline && (
            <>
          {/* Step light cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {STEPS.map((step, i) => {
              const lit = activeIdx >= i;
              const result = sample.steps[step.id];
              const fired = lit && result.fired;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setOpenId(step.id)}
                  className={cn(
                    "relative text-left rounded-lg border p-2.5 transition-all duration-300 group",
                    lit
                      ? "bg-card/70 border-primary/40 shadow-[0_0_18px_-4px_rgba(34,211,238,0.5)]"
                      : "bg-card/20 border-border/40 opacity-60",
                  )}
                  style={lit ? { borderColor: step.accent } : undefined}
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    <span
                      className={cn(
                        "inline-block w-1.5 h-1.5 rounded-full transition-all",
                        lit ? "scale-110" : "scale-90",
                      )}
                      style={{
                        backgroundColor: lit
                          ? step.accent
                          : "hsl(var(--muted-foreground) / 0.25)",
                        boxShadow: lit ? `0 0 8px ${step.accent}` : "none",
                      }}
                    />
                    step {i + 1}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-sm font-semibold text-foreground/90">
                    {step.icon}
                    {step.title.replace(/^\d+\s·\s/, "")}
                  </div>
                  <div
                    className={cn(
                      "mt-1 text-[10.5px] leading-snug transition-opacity",
                      lit ? "opacity-100" : "opacity-0",
                    )}
                  >
                    <span
                      className={
                        fired ? "text-amber-300/90" : "text-emerald-300/90"
                      }
                    >
                      {fired ? "fired" : "clean"}
                    </span>
                    {typeof result.score === "number" && (
                      <span className="text-muted-foreground/70 font-mono ml-1.5">
                        {step.id === "fusion"
                          ? `${result.score}/100`
                          : result.score.toFixed(2)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active step detail */}
          {activeIdx >= 0 && (
            <div className="rounded-lg border border-primary/20 bg-black/30 p-3 text-xs sm:text-[13px] text-foreground/85 leading-relaxed">
              <span className="text-primary font-mono uppercase tracking-wider text-[10px] mr-2">
                {STEPS[Math.min(activeIdx, STEPS.length - 1)].title}
              </span>
              {
                sample.steps[STEPS[Math.min(activeIdx, STEPS.length - 1)].id]
                  .detail
              }
            </div>
          )}

          {/* Final verdict */}
          <div
            className={cn(
              "rounded-lg border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2 transition-opacity duration-500",
              activeIdx >= STEPS.length - 1 ? "opacity-100" : "opacity-40",
            )}
            style={{ borderColor: tier.border, backgroundColor: tier.bg }}
          >
            <div
              className="flex items-center gap-2 text-sm font-semibold"
              style={{ color: tier.color }}
            >
              <ArrowRight className="w-4 h-4" />
              Verdict: {sample.finalLabel}
            </div>
            <div className="text-xs font-mono text-muted-foreground">
              score{" "}
              <span style={{ color: tier.color }} className="font-bold">
                {sample.finalScore}
              </span>
              /100 · tier{" "}
              <span style={{ color: tier.color }} className="font-bold">
                {sample.finalTier}
              </span>
            </div>
          </div>
            </>
          )}
        </div>
      </section>

      {/* Accordion */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight text-foreground/90">
          Each step, in plain English
        </h2>
        <div className="space-y-2">
          {STEPS.map((step) => {
            const isOpen = openId === step.id;
            return (
              <div
                key={step.id}
                className="rounded-lg border border-primary/20 bg-card/30 overflow-hidden transition-colors"
                style={isOpen ? { borderColor: step.accent } : undefined}
              >
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : step.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-primary/5 transition-colors"
                  aria-expanded={isOpen}
                >
                  <span
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0"
                    style={{
                      backgroundColor: `${step.accent.replace("0.55", "0.15")}`,
                      color: step.accent.replace("0.55", "1"),
                    }}
                  >
                    {step.icon}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground/95">
                      {step.title}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {step.oneLiner}
                    </span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "w-4 h-4 text-muted-foreground transition-transform shrink-0",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>
                <div
                  className={cn(
                    "grid transition-all duration-300 ease-out",
                    isOpen
                      ? "grid-rows-[1fr] opacity-100"
                      : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="overflow-hidden">
                    <div className="px-4 pb-4 pt-1 text-sm text-foreground/85 leading-relaxed border-t border-primary/10">
                      {step.body}
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                        <div className="rounded-md border border-primary/15 bg-black/30 px-2.5 py-1 font-mono text-muted-foreground">
                          on this sample:{" "}
                          <span
                            className={
                              sample.steps[step.id].fired
                                ? "text-amber-300"
                                : "text-emerald-300"
                            }
                          >
                            {sample.steps[step.id].fired ? "fired" : "clean"}
                          </span>
                          {typeof sample.steps[step.id].score === "number" && (
                            <span className="ml-1.5">
                              (
                              {step.id === "fusion"
                                ? `${sample.steps[step.id].score}/100`
                                : sample.steps[step.id].score!.toFixed(2)}
                              )
                            </span>
                          )}
                        </div>
                        {step.blogTo && (
                          <Link
                            to={step.blogTo}
                            className="inline-flex items-center gap-1 text-primary hover:text-primary/80 transition-colors"
                          >
                            {step.blogLabel ?? "Deep dive"}
                            <ArrowRight className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer CTAs */}
      <section className="rounded-xl border border-primary/20 bg-card/30 p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-foreground/95">
            Ready to try it on a real report?
          </div>
          <div className="text-xs text-muted-foreground">
            Paste your own — or browse the public corpus to see scored examples.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/15 text-primary border border-primary/40 hover:bg-primary/25 transition-colors"
          >
            Submit a report
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link
            to="/reports"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-primary border border-border hover:border-primary/40 transition-colors"
          >
            Browse reports
          </Link>
        </div>
      </section>
    </div>
  );
}
