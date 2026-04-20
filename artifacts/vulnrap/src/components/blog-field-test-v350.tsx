import { Calendar } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import heroSrc from "@assets/generated_images/blog-field-test-v350-hero.png";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

export function BlogFieldTestV350() {
  return (
    <article id="field-test-v350" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 text-[10px]">Update #5</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          v3.5.0 Field Test: Three Engines, Seven Reports, and a Ceiling We Didn't Expect
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #5 in the VulnRap Sprint Series — Previous:{" "}
          <a href="#zero-detection" className="text-primary hover:underline">460K Reports and a 0% Detection Rate</a>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <figure className="space-y-2">
        <img
          src={heroSrc}
          alt="Three engines voting on a composite score, with slop reports clustered low and legitimate reports clustered mid-scale, separated by a visible gap"
          loading="lazy"
          className="w-full h-auto rounded border border-border/40"
        />
        <figcaption className="text-xs text-muted-foreground/80 italic">
          Three independent engines (E1 / E2 / E3, weighted 5% / 55% / 40%) feed a single composite score. v3.5.0 produces clean separation between slop (left cluster) and legit (right cluster) — but the legit cluster hits a ceiling around 55 instead of clearing 60+. Closing that gap is the v3.6.0 calibration sprint.
        </figcaption>
      </figure>

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <P>
          We shipped v3.5.0 this week. Three engines. Consensus scoring. A "Why this score?" diagnostics panel. The biggest architectural change since VulnRap launched.
        </P>

        <P>
          Then we tested it against the same kinds of reports that broke the old system. Here's what happened.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What Changed in v3.5.0</SectionHeading>

        <P>
          The old VulnRap ran a single scoring pipeline: linguistic analysis, template detection, spectral features, and an LLM pass, all blended into one number. In <a href="#zero-detection" className="text-primary hover:underline">Update #4</a>, we showed why that couldn't work &mdash; every curl report scored between 8 and 18 regardless of whether it was a confirmed CVE or confirmed AI slop.
        </P>

        <P>
          v3.5.0 replaces that with three independent engines that vote on a composite score:
        </P>

        <P>
          <Bold>Engine 1 &mdash; AI Authorship Detector (5% weight).</Bold> Lexical and behavioral signals. Informational only &mdash; AI involvement doesn't automatically mean a report is bad.
        </P>

        <P>
          <Bold>Engine 2 &mdash; Technical Substance Analyzer (55% weight).</Bold> The heavy hitter. Counts specific endpoints, line numbers, claim-to-evidence ratios, file path references, reproduction commands. These are the signals we identified in our 460K-record dataset analysis as having the highest discriminator power &mdash; claim:evidence ratio (9.0x between expert and slop reports), specific endpoints (8.9x), line numbers (6.0x).
        </P>

        <P>
          <Bold>Engine 3 &mdash; CWE Coherence Checker (40% weight).</Bold> When a report claims a CWE, does the described behavior actually match that weakness? When it doesn't claim one, what does that tell us?
        </P>

        <P>
          Each engine scores 0&ndash;100 independently, with its own confidence level. The composite is the weighted blend. Higher composite means stronger evidence of a real, reproducible issue.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Test</SectionHeading>

        <P>
          We submitted seven reports through the live system: four AI slop reports of varying sophistication, and three legitimate vulnerability reports with real technical substance. All reports were shared with the <Link to="/reports" className="text-primary hover:underline">community feed</Link>, and we left detailed feedback on each one.
        </P>

        <P>
          The slop reports ranged from obvious template jobs (a Generic XSS report with no specific endpoints and a cookie-cutter impact list) to more polished narratives (an HTTP/3 Connection Cycle DoS report that reads like a reasonable advisory if you don't notice it contains zero code).
        </P>

        <P>
          The legit reports included a real CVE (CVE-2025-0725, the curl gzip integer overflow with ASAN traces and exact line numbers), a Firefox use-after-free with a working PoC, and a curl HSTS bypass with a diff patch.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Results</SectionHeading>

        <P>The Technical Substance engine nailed the separation.</P>

        <P>
          Every slop report scored between 7 and 23 on Engine 2. Every legit report scored between 39 and 55. That's a 16-point gap with zero overlap. For context, the old system had <em>complete</em> overlap between categories &mdash; slop and legit reports were indistinguishable.
        </P>

        <P>The composite scores told a more nuanced story:</P>

        <P><Bold>Slop reports (target: below 40)</Bold></P>
        <ul className="space-y-2 list-disc pl-5 mb-4">
          <li>Generic XSS: <Bold>27</Bold> &mdash; correctly flagged. Engine 2 scored 7. No PoC, no endpoints, pure template.</li>
          <li>SSRF Template: <Bold>32</Bold> &mdash; correctly flagged. Engine 2 scored 17. Generic target.com, textbook structure.</li>
          <li>IPFS Path Traversal: <Bold>36</Bold> &mdash; correctly flagged. Engine 2 caught missing line numbers and no specific endpoints. Legacy system had scored this 12 (Clean) &mdash; it would have sailed through.</li>
        </ul>

        <P><Bold>Legit reports (target: above 55)</Bold></P>
        <ul className="space-y-2 list-disc pl-5 mb-4">
          <li>Firefox UAF: <Bold>55</Bold> &mdash; borderline. Engine 2 recognized the file paths and line numbers. CWE-416 correctly matched.</li>
          <li>CVE-2025-0725 curl: <Bold>54</Bold> &mdash; borderline. Active Verification confirmed file paths exist in the curl/curl repo and validated the CVE against NVD.</li>
          <li>curl HSTS bypass: <Bold>45</Bold> &mdash; too low. This report has source file paths, specific line numbers, a diff patch, and shell reproduction commands.</li>
        </ul>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What's Working</SectionHeading>

        <P>
          <Bold>The architecture is sound.</Bold> Engine 2 as the dominant scorer (55% weight) produces clean separation between categories. The old system scored the IPFS slop at 12 (Clean). The new system scores it at 36 (Needs Review). That's the difference between a slop report slipping through and a triager getting a heads-up.
        </P>

        <P>
          <Bold>Active Verification adds real value.</Bold> The system verified <code className="text-primary font-mono text-xs bg-primary/10 px-1 py-0.5 rounded">lib/content_encoding.c</code> exists in <code className="text-primary font-mono text-xs bg-primary/10 px-1 py-0.5 rounded">curl/curl</code> on GitHub and confirmed CVE-2025-0725 against NVD. When references check out, that's signal a triager can use.
        </P>

        <P>
          <Bold>Template-style slop gets caught consistently.</Bold> The Generic XSS and SSRF reports &mdash; the kind of boilerplate that floods real programs &mdash; scored 27 and 32. A triager seeing those numbers knows to look harder.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What's Not Working Yet</SectionHeading>

        <P>
          <Bold>Legit reports hit a ceiling around 55.</Bold> All three legitimate reports clustered between 45 and 55. A report with ASAN stack traces, exact source line numbers, a working PoC, and a confirmed CVE should score well above 55. We're leaving 20+ points on the table.
        </P>

        <P>The root causes:</P>

        <P>
          <Bold>Engine 3 defaults to neutral (50) when no CWE is claimed.</Bold> That pulls slop scores up and doesn't reward legit reports that properly cite their CWE. A slop report with no CWE gets the same Engine 3 score as a legit report that cites CWE-416 with matching behavior &mdash; that's wrong.
        </P>

        <P>
          <Bold>Evidence type weighting is too flat.</Bold> Engine 2 counts whether evidence exists, but doesn't differentiate between types. An ASAN stack trace with memory addresses and a call stack is far stronger evidence than a mention of a file path. A diff patch with specific line changes is stronger than a description of what to fix. Code diffs, crash output, shell reproduction commands &mdash; these should carry more weight.
        </P>

        <P>
          <Bold>Active Verification scope is too broad.</Bold> Report 55 referenced file paths in curl, but the verification engine also searched for those paths in openssl/openssl (not referenced), got "not found," and generated false challenge questions. The verifier should only check repositories the report actually mentions.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Triage Gap</SectionHeading>

        <P>
          One finding surprised us. The system recommended CHALLENGE_REPORTER for the Firefox UAF report &mdash; a report with an ASAN stack trace, exact source file paths, a working PoC in HTML, and a CVSS 9.8 vector. That's the kind of report a triager should <em>prioritize</em>, not challenge.
        </P>

        <P>
          The triage logic appears to trigger CHALLENGE when Active Verification returns any "not found" results, regardless of how many verifications succeeded. Two verified file paths plus one false negative from a misscoped lookup shouldn't override the technical evidence.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What's Next</SectionHeading>

        <P>
          We're not done. v3.5.0 proved the multi-engine architecture works &mdash; the separation between slop and legit on Engine 2 alone is better than anything the old system could produce. But the composite scoring and triage logic need calibration work.
        </P>

        <P>
          The next sprint focuses on three things: evidence-type weighting in Engine 2 (so crash output and diff patches count for more), CWE Engine penalties for missing CWE claims, and scoping Active Verification to only the repositories a report actually references.
        </P>

        <P>
          We're also expanding the test suite. Seven reports is a start, not a finish. We need 50+ ground-truth reports across all four quadrants (legit, slop, AI-assisted-but-valid, and human-written-but-low-quality) to properly calibrate the composite weights.
        </P>

        <P>
          If you've submitted reports through VulnRap and left feedback, thank you &mdash; that feedback directly shapes the calibration. Every star rating and suggestion gets reviewed.
        </P>

        <P>
          All seven test reports from this field test are live in the <Link to="/reports" className="text-primary hover:underline">community feed</Link>. Go look at them, disagree with our scores, leave your own feedback. That's the whole point.
        </P>

        <Separator className="bg-border/50 my-6" />

        <p className="mb-4 text-xs italic text-muted-foreground/70">
          VulnRap is free, anonymous, and open source. Built by the creators of <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">COMPLITT.com</a> and <a href="https://remedissecurity.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">REMEDISSecurity.com</a>.
        </p>
      </div>
    </article>
  );
}
