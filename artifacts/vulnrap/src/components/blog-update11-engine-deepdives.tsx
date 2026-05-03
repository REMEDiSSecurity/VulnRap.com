import { Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

export function BlogUpdateEngineDeepDives() {
  return (
    <article id="engine-deep-dives" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-amber-500/30 text-amber-300 text-[10px]">Update #11</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> May 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Under the Hood: Introducing the VulnRap Engine Deep-Dive Series
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #11 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <a href="#byo-fixtures" className="text-primary hover:underline">Update #10</a>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>Why we built four engines instead of one</SectionHeading>

        <P>
          The single-pipeline approach we started with taught us the first hard lesson: blend
          enough signals together and they cancel each other out. A strong linguistic flag erased
          a weak evidence flag. A high LLM score dragged up reports that had no reproducible
          steps. The composite was smooth and useless &mdash; slop and real reports clustered in
          the same band.
        </P>

        <P>
          The multi-engine architecture we run today keeps the signals separated until the last
          possible moment. Each engine asks a different question, votes on its own scale, and only
          then do the weighted votes combine. That isolation is what makes the composite
          meaningful: when Engine 2 votes slop and Engine 3 votes legitimate, you have a real
          disagreement to investigate, not a washed-out middle score that tells you nothing.
        </P>

        <SectionHeading>The four engines, briefly</SectionHeading>

        <P>
          <Bold><Link to="/engines/engine-1" className="text-primary hover:underline">Engine 1 &mdash; AI Authorship Detector</Link> (5% weight).</Bold>{" "}
          Lexical entropy, function-word rates, bigram patterns, and code-block syntax sanity.
          Engine 1 is deliberately informational: AI involvement is a flag, not a verdict. A
          security researcher who edits an AI draft into a real report should not be penalized.
          Engine 1 tells you something happened; the other three tell you whether it matters.
        </P>

        <P>
          <Bold><Link to="/engines/engine-2" className="text-primary hover:underline">Engine 2 &mdash; Technical Substance Analyzer</Link> (55% weight).</Bold>{" "}
          The dominant vote. Counts specific endpoints, line numbers, file path references,
          reproduction commands, PoC artifacts, and claim-to-evidence ratios. These are the
          signals that separated slop from legitimate reports in our 460K-record dataset analysis
          &mdash; claim:evidence ratio shows a 9.0&times; gap between expert and slop reports;
          specific endpoints, 8.9&times;; line numbers, 6.0&times;. No amount of fluent prose
          moves this score if the evidence is absent.
        </P>

        <P>
          <Bold><Link to="/engines/engine-3" className="text-primary hover:underline">Engine 3 &mdash; CWE Coherence Checker</Link> (35% weight).</Bold>{" "}
          When a report claims a vulnerability class, does the described behavior actually match
          it? A stated XSS whose payload produces a database error, a buffer overflow with no
          memory-corruption indicators, a CVE citation that disagrees with NVD &mdash; all lower
          Engine 3 sharply. CWE coherence is one of the most reliable LLM-slop tells: the model
          knows the right CWE to cite, but it cannot consistently make the evidence fit the class.
        </P>

        <P>
          <Bold><Link to="/engines/engine-4" className="text-primary hover:underline">Engine 4 &mdash; Template &amp; Pattern Detector</Link> (5% weight).</Bold>{" "}
          Structural fingerprinting for report-generator artifacts: section-label sequences that
          match known submission templates, formulaic greeting and closing patterns, placeholder
          text left in severity fields, and fabricated response blocks with textbook power-of-two
          values. Engine 4 is narrow by design &mdash; it catches what it catches cleanly and
          does not try to generalize.
        </P>

        <SectionHeading>What the deep-dive series covers</SectionHeading>

        <P>
          The four posts that follow this one go one level deeper on each engine: the signals we
          use, the calibration data that drove the weights, the failure modes we have seen in the
          wild, and the open problems we have not solved yet. We are publishing them because the
          architecture is open source and reviewers who understand what each engine is actually
          measuring can give much better feedback than reviewers who treat the composite as a
          black box.
        </P>

        <P>
          If you want to read the code before the posts land, every engine lives under{" "}
          <code className="text-primary font-mono text-xs">artifacts/api-server/src/lib/engines/</code>{" "}
          in the{" "}
          <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            public repository
          </a>
          . The calibration fixtures that drove each weight are in{" "}
          <code className="text-primary font-mono text-xs">artifacts/api-server/docs/calibration/</code>.
          Start there if you want to run the disagreement audit yourself before the write-ups arrive.
        </P>
      </div>
    </article>
  );
}
