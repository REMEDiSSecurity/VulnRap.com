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

export function BlogSubstanceGate() {
  return (
    <article id="substance-gate-sprint12" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge
            variant="outline"
            className="border-violet-500/30 text-violet-300 text-[10px]"
          >
            Update #7
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> April 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Closing the Slop Gap: Engine 3 Now Cross-Checks Engine 2 Before It
          Votes
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #7 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <Link to="/blog/avri-sprint11" className="text-primary hover:underline">
            AVRI Sprint 11
          </Link>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>The Problem We Found</SectionHeading>

        <P>
          We ran an expanded test battery against the Sprint 11 build &mdash;
          ten reports, five slop and five legitimate, balanced across CWE
          families. The headline number wasn't pretty: the gap between the
          highest-scoring slop (composite <Bold>44</Bold>) and the
          lowest-scoring legit report (composite <Bold>48</Bold>) was just{" "}
          <Bold>four points</Bold>. That's a gap a triage analyst can't act on.
        </P>

        <P>
          Engine 2 (Technical Substance) was doing its job &mdash; the slop
          reports cleanly scored 7 to 26 on substance, the legit ones scored 44
          to 87, an 18-point separation. The leak was Engine 3 (CWE Coherence).
          It was handing out scores around <Bold>68/100</Bold> to reports that
          did nothing more than name the right CWE number, even when Engine 2
          was screaming "no evidence here." With Engine 3 weighted at 40% of the
          composite, those phantom 68s contributed roughly{" "}
          <Bold>27 points</Bold> of free credit to reports that had no business
          getting them.
        </P>

        <SectionHeading>The Fix: A Substance Gate</SectionHeading>

        <P>
          Engine 3 now cross-references Engine 2 before its score is folded into
          the composite. The rule is simple:
        </P>

        <ul className="list-disc pl-5 space-y-1 mb-4">
          <li>
            Engine 2 score below 30 (no substance) &rarr; Engine 3 capped at{" "}
            <Bold>42</Bold>
          </li>
          <li>
            Engine 2 score below 45 (weak substance) &rarr; Engine 3 capped at{" "}
            <Bold>55</Bold>
          </li>
          <li>Engine 2 at 45 or above &rarr; no cap; Engine 3 votes freely</li>
        </ul>

        <P>
          Citing the right CWE number is necessary but not sufficient. The
          report still has to show the evidence that goes with that CWE. When
          the cap fires, it surfaces in the override list as{" "}
          <code>E3_SUBSTANCE_GATE</code> on the result page so analysts can see
          exactly why a score moved. The cap can be flipped off in an emergency
          via the
          <code> VULNRAP_E3_SUBSTANCE_CAP</code> environment variable without a
          redeploy.
        </P>

        <SectionHeading>What the Numbers Did</SectionHeading>

        <P>We re-scored the same ten reports through the new pipeline:</P>

        <div className="overflow-x-auto mb-4">
          <table className="w-full text-xs border border-border/50 rounded-md">
            <thead className="bg-muted/20">
              <tr>
                <th className="text-left p-2 border-b border-border/50">
                  &nbsp;
                </th>
                <th className="text-right p-2 border-b border-border/50">
                  Highest slop
                </th>
                <th className="text-right p-2 border-b border-border/50">
                  Lowest legit
                </th>
                <th className="text-right p-2 border-b border-border/50">
                  Gap
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-2 border-b border-border/30">
                  Sprint 11 (gate off)
                </td>
                <td className="text-right p-2 border-b border-border/30 font-mono">
                  44
                </td>
                <td className="text-right p-2 border-b border-border/30 font-mono">
                  48
                </td>
                <td className="text-right p-2 border-b border-border/30 font-mono">
                  4
                </td>
              </tr>
              <tr>
                <td className="p-2">Sprint 12 A1 (gate on)</td>
                <td className="text-right p-2 font-mono text-emerald-400">
                  34
                </td>
                <td className="text-right p-2 font-mono">48</td>
                <td className="text-right p-2 font-mono text-emerald-400">
                  14
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <P>
          The two highest-scoring slop reports (a fake HTTP/2 DoS and an Auth
          Bypass template, each scoring 43 and 44 before) dropped by 11 and 10
          points respectively. Every legit report stayed exactly where it was.
          That's the shape we wanted: the cap fires surgically against reports
          that lean on CWE-citation alone, and is invisible to reports that
          bring real evidence.
        </P>

        <SectionHeading>What's Still Pending</SectionHeading>

        <P>
          The Sprint 12 end-state target is a 15-point gap with the highest slop
          below 35. A1 alone delivers most of that &mdash; the highest slop is
          now at 34, and the gap is one point shy of target. Two follow-up
          tweaks are queued:
        </P>

        <ul className="list-disc pl-5 space-y-1 mb-4">
          <li>
            <Bold>A2:</Bold> reward Engine 3 when a report cites a CWE{" "}
            <em>and</em> shows the family-specific gold evidence that goes with
            it. This is the inverse of the gate we just shipped &mdash; the gate
            punishes citation-without-evidence; A2 will celebrate
            citation-with-evidence.
          </li>
          <li>
            <Bold>A3:</Bold> a small reweighting from 5/55/40 to 5/60/35. Five
            points moves from CWE Coherence (still slightly over-rewarded) to
            Technical Substance (still slightly under-rewarded for deep
            evidence).
          </li>
        </ul>

        <P>
          Looking further out, the bigger architectural question is{" "}
          <em>active execution verification</em>: actually running the
          proof-of-concept commands a report claims and checking the output
          matches. That's a separate engine and a separate piece of
          infrastructure (Replit doesn't run untrusted Docker containers, so it
          needs an external worker pool). We'll write that one up properly when
          we're ready to commit to the infra.
        </P>

        <P>
          For now, the substance gate is live and you can see it on the result
          page whenever it fires. Same caveat as always: open source on{" "}
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            GitHub
          </a>
          , read the override list on every result, and let us know if the gate
          fires somewhere it shouldn't.
        </P>
      </div>
    </article>
  );
}
