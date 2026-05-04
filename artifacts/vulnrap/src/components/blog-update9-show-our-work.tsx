import { Calendar } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

export function BlogUpdate9ShowOurWork() {
  return (
    <article id="show-our-work" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge
            variant="outline"
            className="border-violet-500/30 text-violet-300 text-[10px]"
          >
            Update #9
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> May 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Showing Our Work: Per-Signal Precision/Recall in the UI
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #9 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <Link to="/blog/sprint14-rigor" className="text-primary hover:underline">
            Three Ways Slop Hid This Sprint
          </Link>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>One score isn't enough</SectionHeading>

        <P>
          A composite of 28 tells you the report is probably slop. It does not
          tell you <em>why</em>, and it definitely does not tell you which of
          the dozens of detectors underneath that number you should trust on
          this particular report. We've been publishing the audit telemetry on
          the back end for two sprints now. This sprint we surfaced it where you
          actually need it: on the result page, next to the signal that fired.
        </P>

        <P>
          Every detector that voted on a report now ships with a small chip
          showing its <Bold>precision</Bold> and <Bold>recall</Bold> against the
          labeled corpus, plus an <Bold>agreement-rate</Bold> number that
          summarises how often this signal lines up with the final composite
          verdict on reports of the same shape. Hover the chip and you get the
          full confusion matrix &mdash; true positives, false positives, true
          negatives, false negatives &mdash; computed against the most recent
          corpus snapshot and dated so you know how stale the number is.
        </P>

        <SectionHeading>How to read the chip</SectionHeading>

        <div className="rounded-md border border-border/50 bg-muted/10 p-4 mb-4 font-mono text-[11px] leading-relaxed">
          <div className="text-foreground mb-1">fabricated_register_state</div>
          <div className="grid grid-cols-3 gap-3 text-muted-foreground">
            <div>
              <span className="text-emerald-400">P 0.94</span> &middot;
              precision
            </div>
            <div>
              <span className="text-sky-400">R 0.71</span> &middot; recall
            </div>
            <div>
              <span className="text-amber-300">A 0.88</span> &middot; agreement
            </div>
          </div>
          <div className="mt-2 text-muted-foreground/70">
            n=312 fixtures &middot; updated 2026-05-02
          </div>
        </div>

        <P>
          <Bold>Precision</Bold> is the slice of fires that were correct. A
          precision of 0.94 means when this detector lights up, it's right 94%
          of the time on the labeled set. <Bold>Recall</Bold> is the slice of
          true positives that this detector caught &mdash; 0.71 means it catches
          71% of the reports that genuinely exhibit the pattern. The gap between
          them is the design intent: this particular detector is tuned to be
          conservative, so it misses some real cases (lower recall) in exchange
          for almost never crying wolf (high precision).
        </P>

        <P>
          The third number is the new one. <Bold>Agreement-rate</Bold> is the
          fraction of reports where this signal's vote matched the final
          composite's verdict on the same report. It's a different question from
          precision &mdash; precision asks "is the signal right against the
          labels," agreement asks "does the signal pull in the same direction as
          the rest of the pipeline." A signal can have high precision and low
          agreement, which is the most interesting case: it means the detector
          is correct in isolation but consistently outvoted by the ensemble.
          Those are the signals worth re-weighting.
        </P>

        <SectionHeading>Why we're showing this</SectionHeading>

        <P>
          Two reasons. The honest one: we want you to argue with us. If a signal
          has a precision of 0.62 and you can see that on the result page, you
          can also see that you should not trust it on this report. You can read
          the override list, you can look at the other detectors that fired, and
          you can decide for yourself whether the composite got this one right.
          That's the point of triage tooling &mdash; not to replace the
          analyst's judgment, but to give the analyst something to push against.
        </P>

        <P>
          The structural reason: detectors that we cannot show numbers for are
          detectors we should not be shipping. Forcing every signal to carry a
          current precision/recall/agreement triple means every signal has a
          fixture battery behind it, and every change to that signal has to
          defend itself against the battery before it lands. The chip on the
          result page is the visible end of a pipeline that runs the labeled
          corpus through every detector on every commit and refuses to merge if
          the numbers move the wrong way.
        </P>

        <SectionHeading>What's actually behind the number</SectionHeading>

        <P>
          The numbers are not opinions. They are computed nightly against the
          labeled fixture corpus &mdash; same corpus that drives the calibration
          audit &mdash; using a fixed pinning rule: a signal is "correct" on a
          fixture when the fixture's label (LEGIT/SLOP/MIXED) is in the set the
          signal was designed to vote for. The confusion-matrix counts, the
          corpus snapshot ID, and the run timestamp are all stamped on the
          chip's hover panel so you can reproduce the number from the public
          fixture battery if you want.
        </P>

        <P>
          The full per-signal numbers, including the agreement-rate breakdown by
          report family, live on the{" "}
          <Link to="/transparency" className="text-primary hover:underline">
            /transparency page
          </Link>{" "}
          alongside the existing drift widgets. The result-page chip is the
          one-glance view; the transparency page is the long-form view.
        </P>

        <SectionHeading>
          What we're <em>not</em> claiming
        </SectionHeading>

        <P>
          A precision of 0.94 on our corpus is a precision of 0.94 on{" "}
          <Bold>our corpus</Bold>. The corpus is 312 hand-labeled fixtures,
          weighted toward the report shapes we've actually seen. It is not a
          representative sample of all possible vulnerability reports, and it is
          definitely not a sample of <em>your</em> intake. Treat the chips as a
          useful prior, not a guarantee. Update #10 covers what to do about that
          &mdash; run the same audit against your own reports and see whether
          our priors hold on your intake.
        </P>

        <P>
          Open source on{" "}
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            GitHub
          </a>{" "}
          as always &mdash; the precision/recall computation lives under{" "}
          <code>artifacts/api-server/src/calibration/signal-stats.ts</code>, and
          the corpus snapshot rules live next to it.
        </P>
      </div>
    </article>
  );
}
