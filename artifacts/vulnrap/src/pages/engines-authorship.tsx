import { Link } from "react-router-dom";
import {
  Sparkles,
  FileText,
  Type,
  BarChart3,
  Activity,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Gauge,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface SubComponent {
  key: string;
  label: string;
  weight: number;
  icon: React.ReactNode;
  measures: string;
  rewards: string[];
  punishes: string[];
}

const SUBCOMPONENTS: SubComponent[] = [
  {
    key: "lexical",
    label: "lexical",
    weight: 0.3,
    icon: <Type className="w-4 h-4" />,
    measures:
      "How much the vocabulary and phrasing resemble known LLM output patterns — hedging phrases, filler, generic remediations, and overclaims versus vocabulary richness.",
    rewards: [
      "High vocabulary richness (unique-word ratio approaching expert baseline of 0.756)",
      "Absence of stock hedging phrases ('It is important to note that…')",
      "Low filler-phrase rate per 1,000 words",
    ],
    punishes: [
      "Generic remediation phrases (expert ~1%, AI ~22% — strongest single lexical indicator)",
      "Overclaim density (asserting severity without evidence)",
      "Hedging and filler phrases at high per-word rates",
      "Low vocabulary richness (repetitive word choice)",
    ],
  },
  {
    key: "structural",
    label: "structural",
    weight: 0.25,
    icon: <FileText className="w-4 h-4" />,
    measures:
      "Whether the report's skeleton follows the rigid template shape LLMs produce — executive summaries, over-complete section headings, formal salutations — versus the looser structure human reporters use.",
    rewards: [
      "Organic section structure without a rigid executive-summary / impact / remediation scaffold",
      "Depth indicators present (debugger output, assembly, syscalls) alongside section completeness",
    ],
    punishes: [
      "Executive summary present (15.2% of AI reports vs 0% of expert reports in the calibration corpus)",
      "High completeness score (≥5/6 sections) without any depth indicators — the 'all sections, no substance' pattern",
      "High section-header density relative to body length (normalised against H1 10K corpus: 1.51 headers/report)",
      "Formal salutations ('Dear Security Team') — rare in expert bug reports",
      "Placeholder URLs (example.com, target.com) contribute a small structural penalty",
    ],
  },
  {
    key: "uniformity",
    label: "uniformity",
    weight: 0.25,
    icon: <BarChart3 className="w-4 h-4" />,
    measures:
      "How uniform the sentence and paragraph lengths are. LLMs produce metronomically even prose; human writers vary naturally.",
    rewards: [
      "High sentence-length coefficient of variation (expert baseline CV ≈ 0.895)",
      "Varied paragraph lengths (CV > 0.5)",
      "Natural burstiness score — alternating short and long sentences",
    ],
    punishes: [
      "Low sentence-length CV (AI baseline CV ≈ 0.711) — the strongest uniformity signal",
      "Paragraph-length CV below 0.3 — wall-of-text or cookie-cutter paragraphs",
      "Low burstiness — every sentence is roughly the same length, no natural rhythm",
    ],
  },
  {
    key: "behavioral",
    label: "behavioral",
    weight: 0.2,
    icon: <Activity className="w-4 h-4" />,
    measures:
      "Whether the report's artifacts — URLs, code blocks, file paths, function references — are consistent with someone who actually found a bug versus someone who fabricated the write-up.",
    rewards: [
      "Real working URLs (expert baseline 8.54 per report)",
      "Multiple code blocks (expert baseline 2.81 per report)",
      "Specific file paths (expert baseline 13.91 per report)",
    ],
    punishes: [
      "PoC mismatch — claims a proof-of-concept but includes zero code blocks and no real URLs",
      "Hallucination density — many function references (>20) with very few file paths (<2)",
      "Absence of real URLs, code blocks, or file paths below expert baselines",
    ],
  },
];

interface FailureMode {
  title: string;
  symptom: string;
  signal: string;
}

const FAILURE_MODES: FailureMode[] = [
  {
    title: "EXECUTIVE_SUMMARY",
    symptom:
      "The report opens with a formal executive summary — a section heading that no expert reporter in the calibration corpus used.",
    signal:
      "Fired with HIGH strength. Carries 40% of the structural sub-score.",
  },
  {
    title: "OVER_COMPLETE_NO_DEPTH",
    symptom:
      "The report hits ≥5 of 6 expected sections (Impact, Steps, Remediation, etc.) but contains no depth indicators — no debugger output, no assembly, no syscalls.",
    signal:
      "Fired with MEDIUM strength. The 'all sections, no substance' shape is characteristic of template-generated reports.",
  },
  {
    title: "SENTENCE_LENGTH_CV",
    symptom:
      "Sentence lengths are unusually uniform — CV below the AI baseline of 0.711 (expert baseline is 0.895).",
    signal:
      "Fired with MEDIUM strength. Drives 60% of the uniformity sub-score.",
  },
  {
    title: "GENERIC_REMEDIATION",
    symptom:
      "Two or more generic remediation phrases detected ('implement proper input validation', 'follow the principle of least privilege').",
    signal:
      "Fired with HIGH strength. Expert reports contain these ~1% of the time; AI reports ~22%.",
  },
  {
    title: "POC_MISMATCH",
    symptom:
      "The report says 'see the PoC below' but there are zero code blocks in the body.",
    signal:
      "Fired with HIGH strength. Also triggers in Engine 2 (substance), so the two engines cross-confirm.",
  },
  {
    title: "HALLUCINATION_DENSITY",
    symptom:
      "More than 20 function-call references with fewer than 2 file paths — the 'hallucinated API surface' pattern.",
    signal:
      "Fired with HIGH strength. Drives the hallucination component of the behavioral sub-score.",
  },
];

function WeightBar({ weight }: { weight: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary"
          style={{ width: `${weight * 100}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {Math.round(weight * 100)}%
      </span>
    </div>
  );
}

export default function EnginesAuthorship() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">
          <Link
            to="/engines"
            className="hover:text-primary transition-colors"
          >
            Engines
          </Link>
          <span>/</span>
          <span className="text-primary">AI Authorship</span>
        </div>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Sparkles className="w-8 h-8 text-primary" />
          Engine 1 — AI Authorship Detector
        </h1>
        <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
          The linguistic fingerprint engine. It asks one question:{" "}
          <span className="text-foreground font-medium">
            does this prose read like it was generated by an LLM?
          </span>{" "}
          The answer is informational — a high AI-authorship score does not
          disqualify a report, but it tells triage teams to look more carefully
          at the substance underneath the polish.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline" className="border-primary/30">
            Composite weight: 5%
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            4 sub-components
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Inverted: high = more AI-like
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Verdict ≤ 25 = GREEN
          </Badge>
        </div>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Gauge className="w-5 h-5" />
            What it measures
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Engine 1 is the{" "}
            <strong className="text-foreground">AI authorship detector</strong>.
            It runs four independent sub-analyses over the report body — lexical
            patterns, structural templates, sentence uniformity, and behavioral
            artifacts — and combines them into a single 0–100 score where{" "}
            <em>higher means more likely AI-generated</em>.
          </p>
          <p>
            Because the score semantics are inverted relative to the other
            engines (higher = worse), the composite formula contributes{" "}
            <span className="font-mono text-foreground">(100 − E1) × 0.05</span>.
            A perfectly human-sounding report adds 5 points to the composite; a
            flagrantly LLM-generated one adds close to zero.
          </p>
          <p>
            Engine 1 is deliberately weighted low (5%) because linguistic style
            is easy to game. A generator that tweaks its temperature and adds
            contractions can dodge most of these signals. The real gatekeeping
            comes from{" "}
            <Link
              to="/engines/substance"
              className="text-primary hover:underline"
            >
              Engine 2 (Substance)
            </Link>{" "}
            — but Engine 1 still provides useful triage signal when the other
            engines are borderline.
          </p>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-xl font-bold uppercase tracking-tight mb-4 flex items-center gap-2">
          <span className="text-primary">/</span> The 4 sub-components
        </h2>
        <p className="text-sm text-muted-foreground mb-6 max-w-3xl leading-relaxed">
          Each sub-component produces a 0–100 score and is combined as a
          weighted sum. Calibration baselines come from a labelled corpus of
          AI-generated and expert-written reports; see the{" "}
          <Link to="/transparency" className="text-primary hover:underline">
            transparency page
          </Link>{" "}
          for the methodology.
        </p>

        <div className="space-y-4">
          {SUBCOMPONENTS.map((c) => (
            <Card key={c.key} className="bg-card/40 backdrop-blur">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="text-primary">{c.icon}</span>
                    <span className="font-mono">{c.label}</span>
                  </CardTitle>
                  <WeightBar weight={c.weight} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground pt-0">
                <p>{c.measures}</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-emerald-500/80">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Lowers AI score (good)
                    </div>
                    <ul className="space-y-1.5 list-disc pl-5 text-xs">
                      {c.rewards.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-rose-500/80">
                      <XCircle className="w-3.5 h-3.5" />
                      Raises AI score (bad)
                    </div>
                    <ul className="space-y-1.5 list-disc pl-5 text-xs">
                      {c.punishes.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Gauge className="w-5 h-5" />
            Score inversion in the composite
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Every other engine uses "higher = better for the report." Engine 1
            is the opposite: higher = more AI-like = worse. The composite
            handles this by inverting before weighting:
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs space-y-2">
            <div>
              <span className="text-muted-foreground">contribution</span> = (100
              − E1.score) × <span className="text-primary">0.05</span>
            </div>
            <div className="text-muted-foreground pt-1">
              E1 = 20 (likely human) → contribution = 80 × 0.05 = 4.0
            </div>
            <div className="text-muted-foreground">
              E1 = 78 (likely AI) → contribution = 22 × 0.05 = 1.1
            </div>
          </div>
          <p>
            The same inversion applies in the{" "}
            <Link to="/showcase" className="text-primary hover:underline">
              per-engine radar
            </Link>{" "}
            — the "Engine 1" axis plots{" "}
            <span className="font-mono text-foreground">100 − raw score</span>{" "}
            so that all five axes point in the same direction (higher = better).
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRight className="w-5 h-5 text-primary" />
            Worked example
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            A 900-word submission opens with "Executive Summary" and closes with
            "Recommended Remediation." It reads fluently, uses no contractions,
            and every paragraph is roughly the same length. The extracted signals
            look like:
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed space-y-1">
            <div>
              <span className="text-muted-foreground">hasExecutiveSummary</span>: true
            </div>
            <div>
              <span className="text-muted-foreground">completenessScore</span>: 6/6,{" "}
              <span className="text-muted-foreground">hasDepthIndicators</span>: false
            </div>
            <div>
              <span className="text-muted-foreground">sentenceLengthCV</span>: 0.41
            </div>
            <div>
              <span className="text-muted-foreground">genericRemediationCount</span>: 4
            </div>
            <div>
              <span className="text-muted-foreground">vocabularyRichness</span>: 0.52
            </div>
            <div>
              <span className="text-muted-foreground">burstinessScore</span>: 12
            </div>
          </div>
          <p>The four sub-components fall out as:</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border border-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left p-2 border-b border-border">component</th>
                  <th className="text-right p-2 border-b border-border">score</th>
                  <th className="text-right p-2 border-b border-border">× weight</th>
                  <th className="text-right p-2 border-b border-border">contribution</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-2">lexical</td>
                  <td className="text-right p-2">72</td>
                  <td className="text-right p-2 text-muted-foreground">0.30</td>
                  <td className="text-right p-2">21.6</td>
                </tr>
                <tr>
                  <td className="p-2">structural</td>
                  <td className="text-right p-2">85</td>
                  <td className="text-right p-2 text-muted-foreground">0.25</td>
                  <td className="text-right p-2">21.3</td>
                </tr>
                <tr>
                  <td className="p-2">uniformity</td>
                  <td className="text-right p-2">78</td>
                  <td className="text-right p-2 text-muted-foreground">0.25</td>
                  <td className="text-right p-2">19.5</td>
                </tr>
                <tr>
                  <td className="p-2">behavioral</td>
                  <td className="text-right p-2">65</td>
                  <td className="text-right p-2 text-muted-foreground">0.20</td>
                  <td className="text-right p-2">13.0</td>
                </tr>
                <tr className="border-t border-border bg-muted/20">
                  <td className="p-2 font-bold text-foreground">E1 score</td>
                  <td colSpan={2} className="text-right p-2 text-muted-foreground">→</td>
                  <td className="text-right p-2 text-foreground">≈ 75</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Four HIGH-strength indicators fire: EXECUTIVE_SUMMARY,
            OVER_COMPLETE_NO_DEPTH, GENERIC_REMEDIATION, and SENTENCE_LENGTH_CV.
            Confidence is HIGH (≥2 high-strength indicators). Engine 1 returns:
          </p>
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-4 font-mono text-xs space-y-1">
            <div>
              <span className="text-muted-foreground">score</span>:{" "}
              <span className="text-rose-400">75</span>
            </div>
            <div>
              <span className="text-muted-foreground">verdict</span>:{" "}
              <span className="text-rose-400">RED</span>
            </div>
            <div>
              <span className="text-muted-foreground">composite contribution</span>:{" "}
              (100 − 75) × 0.05 = 1.25
            </div>
            <div>
              <span className="text-muted-foreground">note</span>: "AI authorship is informational, not disqualifying."
            </div>
          </div>
          <p>
            The report loses nearly all of the 5 composite points Engine 1 can
            contribute, but the real question is what Engine 2 (Substance) says.
            If the body also lacks code blocks and file paths, the report lands
            deep in reject territory. If the body is full of real evidence
            despite the AI-like prose, the composite stays healthy — which is
            exactly the design intent.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur border-amber-500/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="w-5 h-5" />
            Known failure modes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            These are the indicators Engine 1 emits most often. They appear in
            the diagnostics panel of any scored report.
          </p>
          <Separator />
          <ul className="space-y-4">
            {FAILURE_MODES.map((m) => (
              <li key={m.title} className="space-y-1">
                <div className="font-mono text-foreground text-sm">
                  {m.title}
                </div>
                <div className="text-xs">
                  <span className="text-foreground/70">Symptom:</span>{" "}
                  {m.symptom}
                </div>
                <div className="text-xs">
                  <span className="text-foreground/70">Signal:</span> {m.signal}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Human counter-signals
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Engine 1 also detects positive human-authorship signals that push
            the score <em>down</em> (toward human). These are patterns LLMs
            almost never produce on their own:
          </p>
          <ul className="space-y-1.5 list-disc pl-5 text-xs">
            <li>
              <span className="font-mono text-foreground">human_contractions</span>{" "}
              — contractions like "don't", "it's", "we've" (LLMs default to formal style)
            </li>
            <li>
              <span className="font-mono text-foreground">human_terse_style</span>{" "}
              — short, direct sentences without hedging or elaboration
            </li>
            <li>
              <span className="font-mono text-foreground">human_informal_language</span>{" "}
              — colloquial phrases, slang, or shorthand
            </li>
            <li>
              <span className="font-mono text-foreground">human_commit_refs</span>{" "}
              — references to specific git commits or patch hashes
            </li>
            <li>
              <span className="font-mono text-foreground">human_patched_version</span>{" "}
              — mentions of specific patched versions
            </li>
            <li>
              <span className="font-mono text-foreground">human_no_pleasantries</span>{" "}
              — advisory-style format without greetings or social niceties
            </li>
          </ul>
          <p className="text-xs">
            These counter-signals are surfaced in the evidence panel under the
            "Human Signal" label. They don't override a high AI score on their
            own, but they provide context when the other sub-components are
            borderline.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <AlertTriangle className="w-5 h-5" />
            Why 5% and not more?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Linguistic detection is inherently an arms race. Today's signals
            (burstiness, vocabulary richness, generic remediations) catch
            default-temperature ChatGPT output reliably. But a generator that
            adds contractions, varies sentence length, and drops the executive
            summary can dodge most of these checks.
          </p>
          <p>
            Engine 1 is weighted at 5% because we don't want triage decisions
            to depend on whether the attacker's generator is slightly better
            than our detector. The real signal is{" "}
            <Link
              to="/engines/substance"
              className="text-primary hover:underline"
            >
              substance
            </Link>
            : code blocks, file paths, line numbers, and real URLs are much
            harder to fabricate than natural-sounding prose.
          </p>
          <p>
            That said, Engine 1 is valuable as a <em>triage prioritiser</em>.
            When Engine 2 and Engine 3 are borderline, a high AI-authorship
            score tips the recommendation toward manual review. And the
            indicators themselves (EXECUTIVE_SUMMARY, GENERIC_REMEDIATION) give
            reviewers specific things to look for when they open the report.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border pt-6">
        <Link
          to="/engines"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          ← Back to engines
        </Link>
        <Link
          to="/engines/substance"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          Substance engine <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
