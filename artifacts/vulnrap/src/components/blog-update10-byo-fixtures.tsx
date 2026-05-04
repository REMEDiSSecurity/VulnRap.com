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

export function BlogUpdate10ByoFixtures() {
  return (
    <article id="byo-fixtures" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge
            variant="outline"
            className="border-violet-500/30 text-violet-300 text-[10px]"
          >
            Update #10
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> May 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Bring Your Own Fixtures: Validating VulnRap Against Your Corpus
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #10 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <Link to="/blog/show-our-work" className="text-primary hover:underline">
            Showing Our Work
          </Link>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>
          The numbers we publish are ours, not yours
        </SectionHeading>

        <P>
          Update #9 put precision/recall chips on every signal so you can argue
          with the composite. The honest caveat at the bottom of that post was
          that those numbers come from <Bold>our</Bold> corpus &mdash; 312
          fixtures, hand-labeled, skewed toward the report shapes we've actually
          had to triage. Useful prior, not a guarantee.
        </P>

        <P>
          So this sprint we built the obvious next thing: a page that lets you
          run the same audit against <em>your</em> reports without sending us a
          single byte of raw text. If our precision on{" "}
          <code>fabricated_register_state</code> is 0.94 and yours is 0.71, you
          should know that. If our agreement-rate on{" "}
          <code>citation_without_evidence</code>
          falls apart on your intake mix, you should be the one telling us.
        </P>

        <SectionHeading>What the page does</SectionHeading>

        <P>
          The bring-your-own-fixtures page accepts a labeled batch &mdash; up to
          200 reports per run &mdash; with each report tagged LEGIT, SLOP, or
          MIXED. You can paste them in one at a time, drop a JSONL file, or POST
          to the API endpoint with the same shape. Every report goes through the
          standard redaction pipeline first; the raw text never touches our
          database, and you can run in "Keep it private" mode to suppress even
          redacted-text storage.
        </P>

        <P>
          When the run completes, you get an <Bold>F1 panel</Bold>: per-signal
          precision, recall, and F1 against your labels, side-by-side with the
          same numbers from our published corpus. Disagreements are highlighted.
          The composite verdict for each report is shown next to its label so
          you can audit individual misses, not just aggregates.
        </P>

        <div className="rounded-md border border-border/50 bg-muted/10 p-4 mb-4">
          <div className="text-[11px] text-muted-foreground/80 mb-2 font-mono">
            F1 panel &mdash; your corpus vs. ours
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/40 text-muted-foreground/80">
                  <th className="text-left py-1 pr-3 font-normal">signal</th>
                  <th className="text-right py-1 px-2 font-normal">
                    F1 (yours)
                  </th>
                  <th className="text-right py-1 px-2 font-normal">
                    F1 (ours)
                  </th>
                  <th className="text-right py-1 pl-2 font-normal">&Delta;</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr className="border-b border-border/20">
                  <td className="py-1 pr-3">fabricated_register_state</td>
                  <td className="text-right py-1 px-2">0.81</td>
                  <td className="text-right py-1 px-2">0.81</td>
                  <td className="text-right py-1 pl-2 text-muted-foreground">
                    &plusmn;0.00
                  </td>
                </tr>
                <tr className="border-b border-border/20">
                  <td className="py-1 pr-3">citation_without_evidence</td>
                  <td className="text-right py-1 px-2 text-amber-300">0.62</td>
                  <td className="text-right py-1 px-2">0.79</td>
                  <td className="text-right py-1 pl-2 text-amber-300">
                    &minus;0.17
                  </td>
                </tr>
                <tr>
                  <td className="py-1 pr-3">reflection_or_dom_proof</td>
                  <td className="text-right py-1 px-2 text-emerald-400">
                    0.91
                  </td>
                  <td className="text-right py-1 px-2">0.84</td>
                  <td className="text-right py-1 pl-2 text-emerald-400">
                    +0.07
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground/60">
            Example panel. The amber row is the one worth a conversation: our
            prior is too kind to citation-without-evidence on this intake.
          </div>
        </div>

        <SectionHeading>Why teams want this before adopting</SectionHeading>

        <P>
          Every PSIRT lead we've talked to asks the same question: "How do I
          know this works on my reports?" Our answer until this sprint was
          "trust the published battery, then run a pilot." That's not a great
          answer. A pilot takes weeks; the battery isn't your data. The F1 panel
          collapses that gap into one screen. Drop in a labeled sample of
          50&ndash;200 reports from your intake, see exactly which signals carry
          their weight on your corpus and which ones don't, decide whether to
          adopt with eyes open.
        </P>

        <P>
          The page also surfaces the worst three false positives and the worst
          three false negatives in your batch &mdash; redacted, with the
          override list and the signal chips visible. That gives you a concrete
          artifact to push back with: "Your detector fired on this one, and it
          shouldn't have, here's the redacted report." Those are the bug reports
          we want.
        </P>

        <SectionHeading>Rate limits and scope</SectionHeading>

        <P>A few constraints worth knowing about up front:</P>

        <ul className="list-disc pl-5 space-y-1 mb-4">
          <li>
            <Bold>200 reports per run</Bold>,{" "}
            <Bold>3 runs per IP per hour</Bold>. The audit is LLM-backed for the
            substance signals; the cap keeps the LLM bill from melting the
            project budget. If you need to validate against a larger corpus, the
            same audit is open source &mdash; clone the repo and run it locally
            with your own keys.
          </li>
          <li>
            <Bold>Labels required.</Bold> The F1 numbers don't exist without
            ground truth. If you're not sure about a label, mark it MIXED
            &mdash; the panel breaks out MIXED-only metrics separately so they
            don't poison the LEGIT/SLOP confusion matrices.
          </li>
          <li>
            <Bold>Redaction is non-negotiable.</Bold> Every report runs through
            the standard redactor before it's scored, before it's stored, and
            before any aggregate is published back to you. The raw text never
            lands.
          </li>
          <li>
            <Bold>Scope is detector validation, not detector training.</Bold> We
            don't fold your batch into the published corpus. If you want your
            reports to influence the shipping numbers, that's a separate, opt-in
            conversation.
          </li>
        </ul>

        <SectionHeading>What we expect to learn</SectionHeading>

        <P>
          Honestly, we expect at least one detector to look noticeably worse on
          real intake than it does on our battery. The fixtures we wrote are
          slop we already understood well enough to write. The slop you actually
          see is, by definition, slop we haven't seen yet. Every BYO run is a
          chance for a real-world report shape to push our numbers around
          &mdash; and that's the loop we want.
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
          </a>
          . The BYO runner lives under{" "}
          <code>artifacts/api-server/src/calibration/byo-runner.ts</code>; the
          F1 panel under{" "}
          <code>artifacts/vulnrap/src/pages/byo-fixtures.tsx</code>. If your run
          surfaces a signal whose F1 collapses on your data, that is the email
          we most want to receive this month.
        </P>
      </div>
    </article>
  );
}
