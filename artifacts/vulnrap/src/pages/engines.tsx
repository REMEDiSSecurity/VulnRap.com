import { Link } from "react-router-dom";
import {
  Network,
  FlaskConical,
  Layers,
  Sparkles,
  ArrowRight,
  Eye,
  EyeOff,
  AlertTriangle,
  Gauge,
  CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface EngineSummary {
  id: string;
  number: string;
  name: string;
  slug: string;
  weight: string;
  weightDetail: string;
  icon: React.ReactNode;
  accent: string;
  accentSoft: string;
  oneLiner: string;
  measures: string[];
  blindSpots: string[];
  falsePositives: string[];
  worked: {
    headline: string;
    body: string;
    score: string;
    verdict: "RED" | "YELLOW" | "GREEN";
  };
  deepDive?: string;
}

const ENGINES: EngineSummary[] = [
  {
    id: "linguistic",
    number: "Engine 1",
    name: "AI Authorship",
    slug: "linguistic",
    weight: "5%",
    weightDetail: "0.05 of the composite",
    icon: <Sparkles className="w-5 h-5" />,
    accent: "text-amber-300",
    accentSoft: "border-amber-400/30 bg-amber-400/5",
    oneLiner:
      "Detects machine-generated prose patterns — burstiness, vocabulary, repetitive scaffolding.",
    measures: [
      "Sentence-length burstiness vs. expert baseline",
      "Vocabulary richness and rare-word density",
      "Stock LLM scaffolding phrases ('It is important to note that…')",
      "Inverted in the composite: high score → likely AI-written → penalised",
    ],
    blindSpots: [
      "A human reporter who writes blandly will look LLM-ish",
      "An LLM polishing genuine technical content can score low",
      "Non-native English writing is intentionally not penalised",
    ],
    falsePositives: [
      "Generated security templates from internal tooling",
      "Reports translated through a model from another language",
      "Highly repetitive but legitimate disclosures (mass-assignment lists)",
    ],
    worked: {
      headline: "GPT-style write-up · no PoC",
      body: "Burstiness 0.41 (baseline 0.78), 12 stock scaffolding hits, vocabulary entropy in the bottom decile.",
      score: "78 → contributes (100 − 78) × 0.05 = 1.1 to composite",
      verdict: "RED",
    },
    deepDive: undefined,
  },
  {
    id: "substance",
    number: "Engine 2",
    name: "Technical Substance",
    slug: "substance",
    weight: "60%",
    weightDetail: "0.60 of the composite — the dominant signal",
    icon: <FlaskConical className="w-5 h-5" />,
    accent: "text-cyan-300",
    accentSoft: "border-cyan-400/30 bg-cyan-400/5",
    oneLiner:
      "Counts concrete, verifiable artifacts — code blocks, file paths, line numbers, real URLs, repro steps.",
    measures: [
      "codeEvidence (35%) — language-tagged fenced code that's actually copy-pasteable",
      "references (30%) — file paths, line numbers, endpoints, version numbers",
      "reproducibility (20%) — explicit steps, environment, real working URLs",
      "pocIntegrity (10%) — does the claimed PoC actually exist in the body?",
      "claimEvidence (5%) — ratio of asserted claims to evidence backing them",
    ],
    blindSpots: [
      "A bug whose evidence is binary or visual (a video repro, a memory dump)",
      "Theoretical / design-flaw reports where there is no line number to point at",
      "Any vulnerability that can only be described prose-first (cryptographic protocol flaws)",
    ],
    falsePositives: [
      "Hardware bugs and side-channel research often lack file paths",
      "Race conditions where the only evidence is a timing trace",
      "Reports that link to a private repo the engine cannot read",
    ],
    worked: {
      headline: "Polished slop · CWE-89 cited · no PoC",
      body: "0 code blocks · 0 file paths · 0 line numbers · 2 placeholder URLs · claim:evidence 11.0",
      score: "17 → contributes 17 × 0.60 = 10.2 and trips the substance gate",
      verdict: "RED",
    },
    deepDive: "/engines/substance",
  },
  {
    id: "cwe-coherence",
    number: "Engine 3",
    name: "CWE Coherence",
    slug: "cwe-coherence",
    weight: "35%",
    weightDetail:
      "0.35 of the composite, gated to ≤ 42 when Engine 2 is below 30",
    icon: <Network className="w-5 h-5" />,
    accent: "text-violet-300",
    accentSoft: "border-violet-400/30 bg-violet-400/5",
    oneLiner:
      "Checks whether the body actually describes the CWE the title claims.",
    measures: [
      "Term-frequency classifier across the full CWE catalogue",
      "Soft citation: which CWE the body actually sounds like",
      "Parent ↔ child relationships count as soft matches, not mismatches",
      "Gated by Engine 2 — naming the right CWE is cheap when there is no evidence",
    ],
    blindSpots: [
      "Chained bugs that legitimately cross CWE boundaries (SSRF → RCE)",
      "Vendor-specific taxonomies that don't map cleanly to CWE language",
      "Reports too short for the classifier to commit to any CWE — abstains rather than guesses",
    ],
    falsePositives: [
      "A genuine cross-CWE chain where the title picks one link and the body emphasises another",
      "Family vs. specific drift (CWE-79 cited, CWE-80 described)",
      "In-house bug taxonomies translated into CWE numbers post-hoc",
    ],
    worked: {
      headline: "Wrong CWE · genuine bug",
      body: "Title claims CWE-89 (SQLi). Body, repro, and PoC all describe CWE-77 (command injection).",
      score: "raw 31 → no gate fires → contributes 31 × 0.35 = 10.9; soft citation flags CWE-77",
      verdict: "RED",
    },
    deepDive: "/engines/cwe-coherence",
  },
];

const AVRI = {
  number: "Layer",
  name: "AVRI — Adaptive Vulnerability Rubric Inference",
  slug: "avri",
  oneLiner:
    "Family-aware rubric layer that sits behind Engines 2 and 3. Picks a weakness family first, then judges the report against the rubric for that family rather than one flat checklist.",
  deepDive: "/engines/avri",
};

function VerdictPill({
  verdict,
}: {
  verdict: "RED" | "YELLOW" | "GREEN";
}) {
  const cls =
    verdict === "GREEN"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
      : verdict === "YELLOW"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
        : "border-rose-400/40 bg-rose-400/10 text-rose-300";
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}
    >
      {verdict}
    </span>
  );
}

export default function Engines() {
  return (
    <div className="max-w-5xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">
          <Link
            to="/architecture"
            className="hover:text-primary transition-colors"
          >
            Architecture
          </Link>
          <span>/</span>
          <span className="text-primary">Engines</span>
        </div>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Layers className="w-8 h-8 text-primary" />
          Scoring engines
        </h1>
        <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
          Three engines vote on every report. Each one looks at the body through
          a different lens, returns a 0–100 score, and is combined as a weighted
          sum. This page is the landing point for the{" "}
          <Link to="/architecture" className="text-primary hover:underline">
            Score Fusion
          </Link>{" "}
          stage of the pipeline — a single index of every engine, what it sees,
          what it can't see, and where it's known to misfire.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline" className="border-primary/30">
            3 engines · weights sum to 100%
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Engine 2 gates Engine 3 below substance 30
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            AVRI rubric layer sits behind E2 + E3
          </Badge>
        </div>
      </div>

      {/* Composite formula */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Gauge className="w-5 h-5" />
            How the composite is built
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed">
            <div>
              composite = 0.05 × (100 − E1) + 0.60 × E2 + 0.35 × E3*
            </div>
            <div className="text-muted-foreground/70 pt-1">
              where E3* = E3 capped at 42 if E2 &lt; 30, else E3
            </div>
          </div>
          <p>
            E1 (AI Authorship) is inverted — a high score means the prose looks
            machine-generated, which lowers the composite. E2 (Substance)
            carries the most weight because its signals are nearly impossible to
            fabricate. E3 (CWE Coherence) is{" "}
            <em>gated</em> by E2 so that naming the right CWE in an
            evidence-free report can't lift the composite into borderline
            territory.
          </p>
        </CardContent>
      </Card>

      {/* Per-engine cards */}
      {ENGINES.map((eng) => (
        <Card
          key={eng.id}
          id={eng.id}
          className={`bg-card/40 backdrop-blur ${eng.accentSoft}`}
        >
          <CardHeader>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-start gap-3">
                <span className={eng.accent}>{eng.icon}</span>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                    {eng.number}
                  </div>
                  <CardTitle className="text-lg leading-tight">
                    {eng.name}
                  </CardTitle>
                </div>
              </div>
              <div className="text-right">
                <div
                  className={`font-mono text-2xl font-bold ${eng.accent}`}
                >
                  {eng.weight}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground">
                  {eng.weightDetail}
                </div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground pt-2">
              {eng.oneLiner}
            </p>
          </CardHeader>
          <CardContent className="space-y-5 text-sm leading-relaxed">
            <div className="grid sm:grid-cols-2 gap-5">
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-emerald-400/80">
                  <Eye className="w-3.5 h-3.5" />
                  What it measures
                </div>
                <ul className="space-y-1.5 list-disc pl-5 text-xs text-muted-foreground">
                  {eng.measures.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-slate-400/80">
                  <EyeOff className="w-3.5 h-3.5" />
                  What it can't see
                </div>
                <ul className="space-y-1.5 list-disc pl-5 text-xs text-muted-foreground">
                  {eng.blindSpots.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-amber-400/80">
                <AlertTriangle className="w-3.5 h-3.5" />
                Known false-positive patterns
              </div>
              <ul className="space-y-1.5 list-disc pl-5 text-xs text-muted-foreground">
                {eng.falsePositives.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>

            <div className="rounded-md border border-border bg-background/40 p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-foreground/80">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                Worked example
                <VerdictPill verdict={eng.worked.verdict} />
              </div>
              <div className="text-xs text-foreground/90 font-medium">
                {eng.worked.headline}
              </div>
              <div className="text-xs text-muted-foreground font-mono leading-relaxed">
                {eng.worked.body}
              </div>
              <div className="text-xs text-muted-foreground font-mono leading-relaxed">
                → {eng.worked.score}
              </div>
            </div>

            {eng.deepDive && (
              <div className="pt-1">
                <Link
                  to={eng.deepDive}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  Full deep-dive · sub-components, gates, indicators
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {/* AVRI sidebar card */}
      <Card className="bg-card/40 backdrop-blur border-fuchsia-400/20">
        <CardHeader>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <Layers className="w-5 h-5 text-fuchsia-300" />
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                  Rubric {AVRI.number}
                </div>
                <CardTitle className="text-lg leading-tight">
                  {AVRI.name}
                </CardTitle>
              </div>
            </div>
          </div>
          <p className="text-sm text-muted-foreground pt-2">{AVRI.oneLiner}</p>
        </CardHeader>
        <CardContent>
          <Link
            to={AVRI.deepDive}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            AVRI deep-dive · 9 weakness families, gold signals, absence
            penalties
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border pt-6">
        <Link
          to="/architecture"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          ← Back to architecture
        </Link>
        <Link
          to="/transparency"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          Engine transparency report <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
