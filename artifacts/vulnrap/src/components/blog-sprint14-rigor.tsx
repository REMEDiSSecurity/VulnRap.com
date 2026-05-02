import { Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

export function BlogSprint14Rigor() {
  return (
    <article id="sprint14-rigor" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-violet-500/30 text-violet-300 text-[10px]">Update #8</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> May 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Three Ways Slop Hid This Sprint (And How the Audit Caught Them)
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #8 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <a href="#substance-gate-sprint12" className="text-primary hover:underline">Substance Gate</a>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>Why we ran the disagreement audit in the first place</SectionHeading>

        <P>
          The substance gate that shipped in Sprint 12 capped Engine 3 when Engine 2 had nothing.
          That fixed a class of slop that scored too high because of CWE citation alone. But it
          told us nothing about the cases where Engine 2 itself was wrong &mdash; where the
          heuristic and the LLM disagreed on the same report, and one of them had to be lying.
        </P>

        <P>
          So we built a calibration audit. Run every fixture through the heuristic. Run it again
          through the substance LLM. Record the delta. When the delta is wide and they disagree
          on which side of the floor the report sits, surface it. The audit didn't tell us a
          score was wrong. It told us where to look.
        </P>

        <P>
          What we found, when we looked, was three different ways slop was hiding from us. None
          of them showed up on the benchmark battery. All three showed up in the audit.
        </P>

        <SectionHeading>Hide #1: borderline composites the cost gate skipped</SectionHeading>

        <P>
          The LLM cost gate exists to skip the call when the heuristic alone is decisive
          &mdash; very obviously slop, very obviously legit. The middle band, by design, gets
          the LLM. We assumed the heuristic was a good proxy for "is this in the middle band."
          It wasn't.
        </P>

        <P>
          Sixteen fixtures in our 74-fixture battery had heuristic scores near zero (so the gate
          skipped them, treating them as "obviously slop") but composite scores in the
          <Bold> 30&ndash;55 range</Bold> &mdash; exactly the band the gate was supposed to fire
          on. The composite knew they were borderline. The heuristic didn't. The gate listened
          to the wrong signal and spent ~10% of the LLM budget it should have spent.
        </P>

        <P>
          The fix was small: <code>evaluateLlmGate</code> now takes the composite alongside the
          heuristic and uses the composite as the primary signal, with the heuristic as a
          tiebreaker for borderline composites. New telemetry reasons (<code>fired_borderline_composite</code>,{" "}
          <code>skipped_above_borderline_composite</code>, etc.) make the decision auditable on
          every report. The composite-driven path now fires on all 16 calibration targets, with
          no regression on the legit cohort.
        </P>

        <SectionHeading>Hide #2: the LLM rated evidence-free reports above the heuristic</SectionHeading>

        <P>
          On 5 of 6 audited T3_SLOP fixtures, gpt-5-nano was scoring reports
          <Bold> +10 to +25 points above the heuristic</Bold>. The disagreement was wide enough
          to be interesting and consistent enough to be a pattern. We pulled the prompt and the
          per-fixture rationales together and read them.
        </P>

        <P>
          The pattern was clear: the prompt was rewarding plausibility-of-vulnerability-class
          without requiring evidence. Any fluent prose naming a real CWE landed at roughly 70 on{" "}
          <code>domainCoherence</code>. "No fabricated specifics" scored equivalently to
          "presence of real specifics." A report that said the right words about SQL injection
          got the same domain-coherence credit as a report that included a real injected payload
          and a captured response.
        </P>

        <P>
          The fix was two-part. First, the prompt itself: <code>domainCoherence</code> caps at
          60 when only the bug class is named; <code>pocValidity</code> caps at 25 for symbolless
          sanitizer traces; <code>validityScore</code> caps at 30 for reports with no PoC,
          sanitizer trace, file, function, CVE, or line. Second, defense-in-depth in scoring
          itself: the LLM raw score is capped at the heuristic when the LLM's own claim
          extraction confirms the report is evidence-free
          (<code>hasPoC=false</code> AND <code>pocValidity&le;20</code> AND no claimed
          files/functions/CVEs/lines AND <code>llmRaw &gt; heuristic</code>). The 6-condition
          AND-gate is mathematically unable to fire on a real legit report.
        </P>

        <P>
          Calibration result: T3_SLOP <code>llmHigherCount</code> dropped from 6 to 1 &mdash;
          <Bold> 83% reduction</Bold>. T1_LEGIT pass rate unchanged. The cap fired on 3 T3_SLOP
          fixtures and zero legit fixtures, exactly as the surgical-design intended.
        </P>

        <SectionHeading>Hide #3: payload code echoed only inside fake responses</SectionHeading>

        <P>
          We have a slop fixture (slop-13) that's a fabricated XSS report with a fabricated HTTP
          response block. When we wrote it, we noticed it had to use a bracketed{" "}
          <code>&lt;attackerPayload&gt;</code> placeholder instead of a real{" "}
          <code>&lt;script&gt;alert(1)&lt;/script&gt;</code> &mdash; otherwise the report
          floated back into YELLOW. We assumed at the time that was a quirk of fixture
          authoring. It wasn't. It was a hole.
        </P>

        <P>
          The WEB_CLIENT <code>concrete_payload</code> gold signal was matching from anywhere in
          the report &mdash; including from inside response bytes that the response-side
          validator had just flagged as fabricated. Only one signal
          (<code>reflection_or_dom_proof</code>) was wired into the response-side revocation
          map. A real-world slop XSS report pasting a fake <code>HTTP/1.1 200 OK</code> block
          containing a literal <code>&lt;script&gt;alert(1)&lt;/script&gt;</code> would float
          back into YELLOW the same way.
        </P>

        <P>
          The fix mirrors the request-side body-payload revocation pattern from earlier in the
          sprint: a strip-and-retest pass after the blanket response-side revocation. Body-
          payload gold signals are re-tested against text with the fake response bytes blanked
          via <code>stripFakeResponses</code>; revoked only when the pattern no longer matches,
          so prose-carried payloads survive. New fixture
          <code>slop-14-fabricated-xss-response-with-script</code> pastes a literal{" "}
          <code>&lt;script&gt;</code> inside the fake response and pins
          <code> expectMaxScore 35</code> so this can't regress.
        </P>

        <SectionHeading>The honorable mention: ARM64 register dumps and /proc/self/status</SectionHeading>

        <P>
          One more: the structural-fabrication pipeline that catches AI-padded crash reports
          (textbook power-of-two values, identical register fills, all-zero PIDs) was x86-only.
          Every ARM64 and RISC-V crash trace whose author padded with{" "}
          <code>X0..X30</code> / <code>W0..W30</code> / <code>PSTATE</code> or{" "}
          <code>x0..x31</code> register tables slipped through entirely. Crash reports padded
          with fabricated <code>/proc/self/status</code> excerpts (textbook{" "}
          <code>VmSize: 65536 kB</code>-style power-of-two values) also slipped through.
        </P>

        <P>
          Both are now caught. The register-dump regex was widened &mdash; the existing{" "}
          <code>fabricated_register_state</code> marker now fires on non-x86 dumps with no
          other changes. The <code>/proc/self/status</code> detector requires &ge;3 Vm-field
          lines with &ge;2 power-of-two kB values at or above 1 MiB (the floor avoids tripping
          on small processes whose <code>VmStk</code> / <code>VmExe</code> legitimately land
          on small powers of two). New marker <code>fabricated_proc_status</code>, new fixture{" "}
          <code>slop-15</code>.
        </P>

        <SectionHeading>The throughline</SectionHeading>

        <P>
          None of these were caught by the benchmark battery. All four were caught by looking
          at the audit telemetry and asking <em>why</em> &mdash; why did the LLM rate this
          higher than the heuristic; why did the gate skip these 16 fixtures; why did this
          fixture need a placeholder where a real payload should have been; why does the
          structural detector light up on x86 traces and stay quiet on ARM64.
        </P>

        <P>
          That's the data-science loop the audit was built for. Every detector we have today
          started as a category of report we couldn't explain. Every weight we have today
          started as a calibration disagreement that wouldn't go away. The audit isn't there
          to give us a score &mdash; it's there to give us the questions worth asking next.
        </P>

        <P>
          To make that loop reproducible, the audit itself shipped two improvements this sprint:{" "}
          <code>/api/test/run?withLlm=1&amp;runs=N</code> samples each fixture's LLM N times
          and surfaces the variance (mean, stddev, range, per-fixture
          always/sometimes/never-fired distribution) so reviewers can tell stable wins from
          lucky draws; and a 150-row labeled-corpus seed runs in CI globalSetup so the
          production-scan-window e2e actually exercises the cap on a fresh database instead of
          asserting against six hand-written rows.
        </P>

        <SectionHeading>What's next</SectionHeading>

        <P>
          The biggest gap we know about now is that our test battery is still <em>our</em> test
          battery. Seventy-four fixtures, hand-curated, slop carefully constructed to look like
          the slop we've actually seen. We need real reports &mdash; reports we didn't write,
          submitted by people we don't know, with whatever surface area the actual world
          generates. That's the next loop: source real reports, label them, fold them into the
          calibration battery, and watch the audit telemetry to see what new categories of
          hiding the real corpus surfaces.
        </P>

        <P>
          The audit is open source on{" "}
          <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>{" "}
          along with the calibration docs that drove each of these fixes (find them under
          <code> artifacts/api-server/docs/calibration/</code>). If you run a VDP and have a
          handful of reports you'd be willing to share for the test battery, or if you want to
          run the audit against your own intake to see what hides there, get in touch.
        </P>
      </div>
    </article>
  );
}
