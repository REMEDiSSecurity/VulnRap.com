import { Link } from "react-router-dom";
import {
  FlaskConical,
  Code2,
  BookMarked,
  PlayCircle,
  ShieldCheck,
  ScanSearch,
  AlertTriangle,
  Gauge,
  ArrowRight,
  CheckCircle2,
  XCircle,
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
    key: "codeEvidence",
    label: "codeEvidence",
    weight: 0.35,
    icon: <Code2 className="w-4 h-4" />,
    measures:
      "Whether the report shows actual code — not screenshots of code, not 'imagine you call foo()', but copy-pasteable blocks tagged with a language.",
    rewards: [
      "Language-tagged fenced blocks (```python, ```c, ```http)",
      "Multiple distinct code blocks (a snippet for the bug, another for the PoC)",
      "Specific vulnerable code context (the exact lines being called out, not 'somewhere in auth.py')",
    ],
    punishes: [
      "Bare prose claiming 'a PoC exists' with no block at all",
      "Single untagged ``` block whose contents are pseudocode",
    ],
  },
  {
    key: "references",
    label: "references",
    weight: 0.3,
    icon: <BookMarked className="w-4 h-4" />,
    measures:
      "Whether the writer points at *specific* things in the codebase: file paths, line numbers, endpoints, version numbers, prior CVEs.",
    rewards: [
      "File paths (src/auth/session.py)",
      "Line number references (session.py:142)",
      "Specific endpoints (POST /api/v2/login)",
      "External CVE links to nvd.nist.gov / cve.org",
      "Up to three distinct version mentions (affected vs fixed)",
    ],
    punishes: [
      "Many invented function names with zero file paths to anchor them — the classic 'hallucinated API surface' shape (penalty scales with ratio)",
    ],
  },
  {
    key: "reproducibility",
    label: "reproducibility",
    weight: 0.2,
    icon: <PlayCircle className="w-4 h-4" />,
    measures:
      "Whether someone other than the reporter could actually reproduce the bug from what's written.",
    rewards: [
      "An explicit 'Steps to Reproduce' section",
      "Environment spec (OS, runtime version, build flags)",
      "Screenshot or asciicast references",
      "Real working URLs (the project's own GitHub, the live endpoint)",
      "An end-to-end repro recipe the AVRI pipeline could re-run",
    ],
    punishes: [
      "Placeholder URLs (https://example.com/vulnerable) — each one drops the score",
    ],
  },
  {
    key: "pocIntegrity",
    label: "pocIntegrity",
    weight: 0.1,
    icon: <ShieldCheck className="w-4 h-4" />,
    measures:
      "Whether the proof-of-concept the report claims to provide actually exists in the body.",
    rewards: [
      "Claims a PoC AND has language-tagged code AND no placeholder URLs → strong positive",
      "Specific vulnerable code context cited alongside the PoC → strongest positive",
    ],
    punishes: [
      "Claims a PoC, zero code blocks, only placeholder URLs → maximum negative",
      "Claims a PoC, zero code blocks, no real URLs → near-maximum negative",
    ],
  },
  {
    key: "claimEvidence",
    label: "claimEvidence",
    weight: 0.05,
    icon: <ScanSearch className="w-4 h-4" />,
    measures:
      "The ratio of asserted claims (severity, impact, exploitability statements) to concrete pieces of evidence backing them up.",
    rewards: [
      "Ratio at or below the expert baseline of 0.27 (one claim per ~4 evidence items)",
      "Zero claims with three or more pieces of evidence — pure show-don't-tell",
    ],
    punishes: [
      "Ratio above 1.0 → composite is hard-capped at 25",
      "Ratio under 0.01 with more than 5 claims → hard-capped at 20",
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
    title: "POC_MISMATCH",
    symptom:
      "The body says 'see the PoC below' but the body contains no code blocks.",
    signal:
      "Fired with HIGH strength; usually accompanies a sub-30 substance score.",
  },
  {
    title: "PLACEHOLDER_URLS",
    symptom:
      "Every URL in the report is example.com / target.com / 127.0.0.1 with no real working link.",
    signal: "Fires when placeholder count > 0 and real URL count = 0.",
  },
  {
    title: "FILE_PATHS / LINE_NUMBERS",
    symptom:
      "Zero file paths or zero line numbers in a report claiming a code-level bug.",
    signal:
      "Expert baseline is 13.91 file paths and 8.5 line numbers per report; absence is a 4–6× slop ratio.",
  },
  {
    title: "CLAIM_EVIDENCE_EXTREME",
    symptom:
      "Either wall-of-claims with no evidence (ratio > 1.0) or a flood of unmotivated evidence (ratio < 0.01 with > 5 claims).",
    signal:
      "Hard-caps the substance score regardless of the rest of the breakdown.",
  },
  {
    title: "SPECIFIC_ENDPOINTS",
    symptom: "Web vulnerability claim with no specific endpoint named.",
    signal: "Expert baseline 4.08 endpoints; absence is an 8.9× slop ratio.",
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

export default function EnginesSubstance() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">
          <Link
            to="/developers"
            className="hover:text-primary transition-colors"
          >
            Docs
          </Link>
          <span>/</span>
          <span>Engines</span>
          <span>/</span>
          <span className="text-primary">Substance</span>
        </div>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <FlaskConical className="w-8 h-8 text-primary" />
          Engine 2 — Technical Substance
        </h1>
        <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
          The gate that catches reports that <em>look</em> polished but contain
          nothing actionable. Engine 2 ignores how a report is written and asks
          one question:
          <span className="text-foreground font-medium">
            {" "}
            if I gave this to a developer right now, could they fix the bug?
          </span>
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline" className="border-primary/30">
            Composite weight: 60%
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            5 sub-components
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Verdict ≥ 61 = GREEN
          </Badge>
        </div>
      </div>

      {/* What it measures */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Gauge className="w-5 h-5" />
            What it measures
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Engine 2 is the{" "}
            <strong className="text-foreground">
              technical substance density
            </strong>{" "}
            analyzer. It runs a battery of deterministic extractors over the
            report body and asks whether the density of concrete, verifiable
            artifacts (code, paths, line numbers, real URLs, repro steps) is
            consistent with what an expert reporter actually produces.
          </p>
          <p>
            The companion{" "}
            <Link to="/developers" className="text-primary hover:underline">
              linguistic engine
            </Link>{" "}
            catches LLM-generated prose. Engine 2 catches the reverse failure
            mode: a human-sounding write-up that nonetheless contains no
            actionable evidence — a bug class we see constantly in bounty
            triage. A report can sail past the linguistic checks and still
            belly-flop here.
          </p>
          <p>
            The output is a 0–100 score, a verdict (RED/YELLOW/GREEN at
            thresholds 41 and 61), and a list of triggered indicators. The score
            is then weighted at{" "}
            <span className="font-mono text-foreground">0.60</span> in the
            composite — Engine 2 carries the most weight of any engine because
            we trust its signals are nearly impossible to fabricate.
          </p>
        </CardContent>
      </Card>

      {/* Sub-components */}
      <div>
        <h2 className="text-xl font-bold uppercase tracking-tight mb-4 flex items-center gap-2">
          <span className="text-primary">/</span> The 5 sub-components
        </h2>
        <p className="text-sm text-muted-foreground mb-6 max-w-3xl leading-relaxed">
          Each sub-component produces a 0–100 score and is combined as a
          weighted sum. Weights were calibrated against a labelled corpus of
          200+ expert and slop reports; see the{" "}
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
                    <span className="text-muted-foreground font-normal">
                      —{" "}
                      {c.label === "claimEvidence"
                        ? "claim:evidence ratio"
                        : c.label === "pocIntegrity"
                          ? "PoC integrity"
                          : c.label}
                    </span>
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
                      Rewards
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
                      Punishes
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

      {/* Substance gate */}
      <Card
        id="substance-gate"
        className="bg-card/40 backdrop-blur border-primary/20 scroll-mt-24"
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <ShieldCheck className="w-5 h-5" />
            The substance gate
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Engine 2 doesn't just contribute a weighted score — it also{" "}
            <em>gates</em> Engine 3 (CWE Coherence). The reason: a slop report
            that names the right CWE earns a generous score from E3 even when E2
            says there is no evidence at all. Without the gate, those phantom E3
            points let evidence-free reports reach borderline composites.
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs space-y-2">
            <div>
              <span className="text-muted-foreground">if</span> E2.score &lt;{" "}
              <span className="text-primary">30</span>{" "}
              <span className="text-muted-foreground">&amp;&amp;</span> E3.score
              &gt; <span className="text-primary">42</span> → cap E3 at{" "}
              <span className="text-primary">42</span>
            </div>
            <div>
              <span className="text-muted-foreground">if</span> E2.score &lt;{" "}
              <span className="text-primary">45</span>{" "}
              <span className="text-muted-foreground">&amp;&amp;</span> E3.score
              &gt; <span className="text-primary">55</span> → cap E3 at{" "}
              <span className="text-primary">55</span>
            </div>
            <div>
              <span className="text-muted-foreground">else</span> → no cap, E3
              speaks freely
            </div>
          </div>
          <p>
            The cap only ever lowers E3, never raises it, and the original
            per-engine score is preserved untouched in the diagnostics panel.
            The composite math gets the adjusted value, and an{" "}
            <span className="font-mono text-foreground">E3_SUBSTANCE_GATE</span>{" "}
            entry shows up in{" "}
            <span className="font-mono">overridesApplied</span> so it's
            auditable. The gate is on by default and can be disabled via the{" "}
            <span className="font-mono">VULNRAP_E3_SUBSTANCE_CAP</span> env
            flag.
          </p>
        </CardContent>
      </Card>

      {/* Worked example */}
      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRight className="w-5 h-5 text-primary" />
            Worked example
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            Consider a typical "polished slop" submission: a 600-word write-up
            that names a real CWE, claims a PoC, and reads cleanly. When
            extracted, the signals look like:
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed space-y-1">
            <div>
              <span className="text-muted-foreground">codeBlockCount</span>: 0
            </div>
            <div>
              <span className="text-muted-foreground">filePathCount</span>: 0
            </div>
            <div>
              <span className="text-muted-foreground">lineNumberCount</span>: 0
            </div>
            <div>
              <span className="text-muted-foreground">
                specificEndpointCount
              </span>
              : 0
            </div>
            <div>
              <span className="text-muted-foreground">realUrlCount</span>: 0
            </div>
            <div>
              <span className="text-muted-foreground">placeholderUrlCount</span>
              : 2
            </div>
            <div>
              <span className="text-muted-foreground">claimsPoCPresent</span>:
              true
            </div>
            <div>
              <span className="text-muted-foreground">claimCount</span>: 11,{" "}
              <span className="text-muted-foreground">evidenceCount</span>: 1
            </div>
          </div>
          <p>The five sub-components fall out as:</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono border border-border">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left p-2 border-b border-border">
                    component
                  </th>
                  <th className="text-right p-2 border-b border-border">
                    score
                  </th>
                  <th className="text-right p-2 border-b border-border">
                    × weight
                  </th>
                  <th className="text-right p-2 border-b border-border">
                    contribution
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="p-2">codeEvidence</td>
                  <td className="text-right p-2">0</td>
                  <td className="text-right p-2 text-muted-foreground">0.35</td>
                  <td className="text-right p-2">0.0</td>
                </tr>
                <tr>
                  <td className="p-2">references</td>
                  <td className="text-right p-2">0</td>
                  <td className="text-right p-2 text-muted-foreground">0.30</td>
                  <td className="text-right p-2">0.0</td>
                </tr>
                <tr>
                  <td className="p-2">reproducibility</td>
                  <td className="text-right p-2">0</td>
                  <td className="text-right p-2 text-muted-foreground">0.20</td>
                  <td className="text-right p-2">0.0</td>
                </tr>
                <tr>
                  <td className="p-2">pocIntegrity</td>
                  <td className="text-right p-2">0</td>
                  <td className="text-right p-2 text-muted-foreground">0.10</td>
                  <td className="text-right p-2">0.0</td>
                </tr>
                <tr>
                  <td className="p-2">claimEvidence</td>
                  <td className="text-right p-2">8</td>
                  <td className="text-right p-2 text-muted-foreground">0.05</td>
                  <td className="text-right p-2">0.4</td>
                </tr>
                <tr className="border-t border-border bg-muted/20">
                  <td className="p-2 font-bold text-foreground">base score</td>
                  <td
                    colSpan={2}
                    className="text-right p-2 text-muted-foreground"
                  >
                    →
                  </td>
                  <td className="text-right p-2 text-foreground">≈ 0</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            The claim:evidence ratio of 11.0 is also above 1.0, which triggers
            the
            <span className="font-mono text-foreground">
              {" "}
              CLAIM_EVIDENCE_EXTREME{" "}
            </span>
            override and hard-caps the final score at 25. POC_MISMATCH and
            PLACEHOLDER_URLS both fire at HIGH strength. Engine 2 returns:
          </p>
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-4 font-mono text-xs space-y-1">
            <div>
              <span className="text-muted-foreground">score</span>:{" "}
              <span className="text-rose-400">0</span>
            </div>
            <div>
              <span className="text-muted-foreground">verdict</span>:{" "}
              <span className="text-rose-400">RED</span>
            </div>
            <div>
              <span className="text-muted-foreground">indicators</span>:
              [POC_MISMATCH, PLACEHOLDER_URLS, FILE_PATHS, LINE_NUMBERS,
              CLAIM_EVIDENCE_EXTREME, SPECIFIC_ENDPOINTS]
            </div>
          </div>
          <p>
            And because E2 &lt; 30, the substance gate caps Engine 3 at 42 even
            if it wanted to award the full 68 for naming the right CWE. The
            composite lands deep in REJECT/AUTO_CLOSE territory rather than
            borderline MANUAL_REVIEW.
          </p>
        </CardContent>
      </Card>

      {/* Failure modes */}
      <Card className="bg-card/40 backdrop-blur border-amber-500/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="w-5 h-5" />
            Known failure modes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            These are the indicators Engine 2 emits most often, in roughly
            decreasing order of how punishing they are. They show up in the
            diagnostics panel of any scored report.
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
          <Separator />
          <p className="text-xs">
            Engine 2 also has a few <em>positive</em> indicators (GOLD_SIGNAL:
            real_crash_trace, real_raw_http, code_diff and a handful of
            category-specific ones) that unlock a small bonus of up to ~5 points
            each, capped overall. These are the signals that are nearly
            impossible to fabricate, so they earn the report a ceiling lift to
            95.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border pt-6">
        <Link
          to="/developers"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          ← Back to API docs
        </Link>
        <Link
          to="/stats"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          See engine stats <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
