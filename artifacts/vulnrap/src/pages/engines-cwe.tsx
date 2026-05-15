import { Link } from "react-router-dom";
import {
  Network,
  Tag,
  Quote,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Gauge,
  ScanSearch,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import cwePortrait from "@/assets/engines-cwe-portrait.webp";

interface FailureMode {
  title: string;
  symptom: string;
  signal: string;
}

const FAILURE_MODES: FailureMode[] = [
  {
    title: "Legitimate cross-CWE writeups",
    symptom:
      "A real chained bug — e.g. an SSRF (CWE-918) used to reach an internal endpoint that then deserializes attacker JSON (CWE-502). The submitted CWE is one link of the chain; the body emphasises the other.",
    signal:
      "Engine 3 sees a mismatch and the soft-citation badge points at the dominant inferred CWE. Reviewers should treat the badge as a hint, not a verdict, and check whether both CWEs are described together.",
  },
  {
    title: "Family vs. specific CWE drift",
    symptom:
      "Reporter cites CWE-79 (XSS, generic) but the body unambiguously describes CWE-80 (basic XSS) or CWE-87 (alternate XSS syntax).",
    signal:
      "We treat parent ↔ child relationships in the same family as soft matches, not hard mismatches. The composite isn't penalised, but the inferred-CWE badge still surfaces so triage knows the tighter label.",
  },
  {
    title: "Vendor-specific phrasing",
    symptom:
      "A report uses an in-house bug taxonomy ('Type-Confusion in IPC Bridge') instead of CWE language. The classifier finds no strong term match and emits no soft citation.",
    signal:
      "Engine 3 falls back to the submitted CWE rather than guessing. Look for low classifier confidence in the diagnostics panel; this is an abstain, not a contradiction.",
  },
  {
    title: "Empty / placeholder body",
    symptom:
      "Body has too little prose for the term-frequency classifier to commit to any CWE.",
    signal:
      "No soft citation is emitted; Engine 3 can't form an opinion. The substance gate from Engine 2 typically catches these reports first.",
  },
];

export default function EnginesCwe() {
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
          <span className="text-primary">CWE Coherence</span>
        </div>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Network className="w-8 h-8 text-primary" />
          Engine 3 — CWE Coherence
        </h1>
        <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
          The check that catches reports claiming one weakness while the body
          describes a completely different one. A strong slop tell — a generator
          picks a plausible CWE for the title and writes prose that drifts into
          another category entirely.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline" className="border-primary/30">
            Composite weight: ~15%
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Soft-citation aware
          </Badge>
          <Badge variant="outline" className="border-primary/30">
            Gated by Engine 2 substance
          </Badge>
        </div>
        <figure className="mt-6 rounded-xl overflow-hidden border border-border/60 bg-[#08090c] max-w-2xl">
          <img
            src={cwePortrait}
            alt="Two parallel translucent ribbons of glowing characters — one cyan on the left, one violet on the right — flowing inward and meeting at small bright sparks down the center, suggesting alignment between two vocabularies."
            width={1280}
            height={960}
            loading="lazy"
            className="w-full h-auto block"
          />
        </figure>
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
            Engine 3 asks one question:{" "}
            <strong className="text-foreground">
              does the body of the report actually describe the CWE the reporter
              selected?
            </strong>{" "}
            A genuine researcher rarely files a report titled "SQL Injection"
            whose body talks entirely about open redirects. Slop generators do
            it constantly, because the CWE field and the prose are produced by
            separate prompts.
          </p>
          <p>
            The engine runs a deterministic, term-frequency CWE classifier over
            the prose and compares its top inference to the submitted CWE. A
            clean match contributes positively to the composite; a mismatch with
            a confidently inferred alternative (the "soft citation") drags the
            score down and surfaces a badge on the report so reviewers see what
            the body actually looks like.
          </p>
          <p>
            Engine 3 is intentionally gated. The{" "}
            <Link
              to="/engines/substance"
              className="text-primary hover:underline"
            >
              substance gate
            </Link>{" "}
            caps Engine 3 whenever Engine 2 reports near-zero evidence — naming
            the right CWE doesn't earn credit for an evidence-free report.
          </p>
        </CardContent>
      </Card>

      {/* Inferred-CWE classifier */}
      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanSearch className="w-5 h-5 text-primary" />
            The inferred-CWE classifier
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            For every CWE we care about, we keep a small fingerprint of expected
            terms: characteristic verbs, sinks, vulnerable APIs,
            attacker-controlled inputs, and common payload shapes. A report body
            is tokenised, normalised, and scored against each fingerprint. The
            CWE with the highest weighted overlap — provided it clears a
            confidence floor — becomes the <em>inferred CWE</em>.
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed space-y-1">
            <div>
              <span className="text-muted-foreground">submitted</span>: CWE-79
              (Cross-Site Scripting)
            </div>
            <div>
              <span className="text-muted-foreground">inferred</span>: CWE-601
              (Open Redirect) — confidence 0.82
            </div>
            <div>
              <span className="text-muted-foreground">match</span>:{" "}
              <span className="text-rose-400">false</span>
            </div>
            <div>
              <span className="text-muted-foreground">badge</span>: "Body reads
              as Open Redirect, not XSS"
            </div>
          </div>
          <p>
            The same logic powers the{" "}
            <span className="font-mono text-foreground">
              deriveInferredCwe()
            </span>{" "}
            helper that the reports feed and the per-report triage panel both
            consume, so the badge shown on the row matches the badge shown on
            the detail page. The classifier is deterministic — same body in,
            same inferred CWE out — which keeps the public corpus reproducible.
          </p>
        </CardContent>
      </Card>

      {/* Soft-citation logic */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Quote className="w-5 h-5" />
            Soft-citation logic
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            A "soft citation" is the engine's polite way of saying{" "}
            <em>
              "the body is really about this other CWE, but I'm not going to
              overwrite the reporter's choice."
            </em>
            It is emitted into the engine result blob under{" "}
            <span className="font-mono text-foreground">
              signalBreakdown.avri.softCitation
            </span>{" "}
            (or, on legacy reports scored before AVRI rolled out,{" "}
            <span className="font-mono text-foreground">
              signalBreakdown.softCitation
            </span>
            ).
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-emerald-500/80">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Soft citation fires when…
              </div>
              <ul className="space-y-1.5 list-disc pl-5 text-xs">
                <li>Inferred CWE clears the confidence floor</li>
                <li>Inferred CWE differs from the submitted CWE</li>
                <li>
                  The two CWEs are not in the same family / parent-child pair
                </li>
                <li>The body has enough prose for the classifier to commit</li>
              </ul>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-rose-500/80">
                <XCircle className="w-3.5 h-3.5" />
                Suppressed when…
              </div>
              <ul className="space-y-1.5 list-disc pl-5 text-xs">
                <li>
                  Confidence is below the floor — abstain rather than guess
                </li>
                <li>
                  Inferred CWE is a parent / child / sibling of the submitted
                  one
                </li>
                <li>Body too short for stable term-frequency scoring</li>
                <li>Submitted CWE itself is missing or malformed</li>
              </ul>
            </div>
          </div>
          <p>
            Where it lands in the UI: the{" "}
            <Link to="/reports" className="text-primary hover:underline">
              reports feed
            </Link>{" "}
            renders a small <Tag className="inline w-3 h-3 align-text-bottom" />{" "}
            badge for any row with a soft citation, and the per-report triage
            view shows the inferred CWE alongside the submitted one with an
            explanation of the mismatch.
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
            A submission lands titled{" "}
            <em>"Stored XSS in user profile (CWE-79)"</em>. The body, however,
            talks entirely about a <span className="font-mono">Location</span>{" "}
            header being set from an unvalidated{" "}
            <span className="font-mono">?next=</span> query parameter, with
            phrases like "redirected to attacker-controlled domain" and
            "phishing landing page". The classifier extracts:
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed space-y-1">
            <div>
              <span className="text-muted-foreground">submittedCwe</span>:
              CWE-79
            </div>
            <div>
              <span className="text-muted-foreground">topInference</span>:
              CWE-601 (Open Redirect)
            </div>
            <div>
              <span className="text-muted-foreground">confidence</span>: 0.79 ≥
              0.55 floor → emit soft citation
            </div>
            <div>
              <span className="text-muted-foreground">familyMatch</span>: false
              (601 is not in the 79 sub-tree)
            </div>
            <div>
              <span className="text-muted-foreground">e3.score</span>: 24 / 100
              (mismatch penalty)
            </div>
            <div>
              <span className="text-muted-foreground">indicator</span>:
              CWE_BODY_MISMATCH
            </div>
          </div>
          <p>
            Engine 3 returns a low score and a soft citation pointing at
            CWE-601. The reports feed renders an{" "}
            <span className="font-mono">
              "Inferred: CWE-601 / Open Redirect"
            </span>{" "}
            badge so a triager skimming the queue can see at a glance that the
            title and body disagree — without having to open the report.
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
            Engine 3 isn't trying to grade CWE labelling — it's trying to flag{" "}
            <em>internal contradiction</em>. There are real reports where the
            body legitimately reads as a different CWE than the one selected.
            The patterns below are the ones we see most often; treat the
            soft-citation badge as a prompt to look closer, not a verdict.
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
                  <span className="text-foreground/70">How E3 handles it:</span>{" "}
                  {m.signal}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border pt-6">
        <Link
          to="/engines/substance"
          className="hover:text-primary transition-colors inline-flex items-center gap-1"
        >
          ← Substance engine
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
