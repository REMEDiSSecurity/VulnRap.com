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

export function BlogAvriSprint11() {
  return (
    <article id="avri-sprint11" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 text-[10px]">Update #6</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          AVRI: One Rubric Wasn't Enough — Why v3.7.0 Scores Memory Bugs and XSS Slop on Different Yardsticks
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #6 in the VulnRap Sprint Series — Previous:{" "}
          <a href="#field-test-v350" className="text-primary hover:underline">v3.5.0 Field Test</a>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <P>
          v3.6.0 cleaned up the calibration mess from the v3.5.0 launch. The triage matrix stopped recommending CHALLENGE_REPORTER on reports with three confirmed sanitizer crashes. The slop-vs-legit composite gap moved from 18 points to 26. Good progress &mdash; but still half the gap we needed.
        </P>
        <P>
          When we looked at <em>why</em> the gap was stuck at 26, the answer was uncomfortable. Engine 2 was scoring every report against the same flat evidence rubric: count the endpoints, count the line numbers, count the file paths, weight by strength, normalize. That rubric works fine for web bugs, where endpoints and payloads <em>are</em> the evidence. It works terribly for memory-corruption reports, which earn most of their evidence from sanitizer dumps and stack traces and don't have endpoints at all.
        </P>
        <P>
          So legit Firefox UAF reports were ceiling at 55 (no endpoints to count) and templated XSS slop was floor-ing at 22 (lots of endpoints, no actual exploit). The flat rubric was the ceiling.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The AVRI Idea</SectionHeading>

        <P>
          v3.7.0 introduces <Bold>Adaptive Vulnerability Report Intelligence (AVRI)</Bold>: classify the report into a CWE rubric family <em>first</em>, then score it against family-specific evidence expectations.
        </P>
        <P>
          Eight families: memory corruption, injection, auth/access, crypto/protocol, DoS/resource, info exposure, request forgery, hardware. A flat fallback for the long tail. Each family has its own <Bold>gold-standard signals</Bold> (regex + point value), its own <Bold>absence penalties</Bold> (subtracted when an expected signal class is missing), and its own <Bold>contradiction phrases</Bold> (XSS payloads in a buffer-overflow report subtract points instead of adding them).
        </P>
        <P>
          Classification runs as a new Engine 0 ahead of Engines 1&ndash;3. We extract the cited CWE if any, look it up directly, walk the parent chain via a bundled MITRE CWE hierarchy when needed, and fall back to a keyword bank when no CWE was provided. Composite weights stay 5/55/40 &mdash; AVRI changes what each engine produces, not how their votes are combined.
        </P>

        <SectionHeading>What Changes for Each Family</SectionHeading>

        <P>
          A memory-corruption report now earns gold credit for an ASAN/UBSAN crash header, register state, a stack trace with addresses, and a CVE-class binary identifier. It is not penalized for the lack of an endpoint &mdash; that's not what memory-corruption reports look like.
        </P>
        <P>
          An injection report has the opposite expectations. Gold signals are an exact endpoint+payload pair, a parameterized URL, a working HTTP request showing the response. The absence penalty fires hard when an "XSS report" doesn't include a single HTTP request. This is the path that finally drops generic XSS slop below 20.
        </P>
        <P>
          Crypto/protocol reports get credit for NIST/RFC test vectors, version handshakes, and oracle padding details &mdash; signals that almost never show up in fabricated cryptography reports because the model can't generate plausible test vectors.
        </P>

        <SectionHeading>The Math Fix Buried in Engine 2</SectionHeading>

        <P>
          The original spec applied absence penalties to the raw weighted sum <em>before</em> dividing by the rubric's max possible. The trouble: with a max-possible of 60 for a small family, a single -10 absence penalty becomes a -16 normalized penalty. Two missing signals could swing the normalized score by 30+ points and produce wild results.
        </P>
        <P>
          v3.7.0 applies absence penalties as <Bold>absolute points after normalization</Bold>, capped at -25 total. The contradiction penalty caps at -24. The result is well-bounded and finally agrees with how analysts actually think about missing evidence.
        </P>

        <SectionHeading>Triage Matrix v2 — Gold Hits Get Express Lane</SectionHeading>

        <P>
          The triage matrix gains one new override at the top: <Bold>goldHits &ge; 2 AND composite &ge; 40 → PRIORITIZE</Bold>. A memory-corruption report with a sanitizer crash and a register dump should get analyst eyes immediately even at a moderate composite, because the gold signals are extraordinarily hard to fabricate. The override fires before the legacy matrix; the existing safeguard that &ge;3 strong-evidence signals can never produce CHALLENGE_REPORTER is preserved.
        </P>

        <SectionHeading>Submission Velocity, Without Persistent Identity</SectionHeading>

        <P>
          AVRI also detects same-day submission velocity and template campaigns &mdash; two of the strongest signals for the bulk-AI carpet-bomb pattern we saw in the 460K-report dataset. We deliberately did this <em>without</em> introducing persistent submitter tracking.
        </P>
        <P>
          The velocity signal reuses the daily-rotating visitor hash (HMAC over IP + user-agent + UTC day) shipped in v3.5.0. We count how many submissions arrive per hash within the current UTC day, in a per-process in-memory ring buffer that resets at midnight when the hash itself rotates. More than 10 in 60 minutes earns -15. Tight inter-submission gaps earn -10. Cap at -15 total. No DB writes, no cross-day correlation.
        </P>
        <P>
          Template fingerprinting hashes the <em>structure</em> of the report (lower-cased section headers, paragraph-length buckets, format flags) instead of the prose. Cosmetic edits don't break the match, but reports written from the same skeleton hit the same fingerprint. Three sightings within the rolling LRU window flags the submission as a template campaign and applies -20.
        </P>
        <P>
          Both signals are surfaced as typed entries in <code>compositeOverrides</code> &mdash; AVRI_VELOCITY and AVRI_TEMPLATE_CAMPAIGN &mdash; so analysts can see exactly why a score moved.
        </P>

        <SectionHeading>The Feature Flag</SectionHeading>

        <P>
          Everything AVRI ships behind <code>VULNRAP_USE_AVRI</code>. Default off in production for the first deploy. The v3.6.0 composite path runs unchanged when the flag is off. We will flip it on after the calibration battery (40 fixtures + the seven named reports from the spec) confirms the &ge;50-point composite gap target.
        </P>

        <SectionHeading>What's Still Manual</SectionHeading>

        <P>
          Cross-day, cross-IP carpet-bomb detection is intentionally out of scope &mdash; that would require persistent submitter identity that conflicts with the privacy posture we shipped in v3.5.0. Family-aware verification routing is wired into the classification but the verification subsystem is still picking strategies the v3.6.0 way; routing it by family is the next sprint's first ticket. The CWE hierarchy file ships ~100 entries; expanding to the full MITRE catalog is a quarterly refresh job.
        </P>

        <P>
          We'll publish the calibration-battery before/after numbers once the flag flips on. The bet is that one rubric was always the ceiling, and eight rubrics &mdash; with absence penalties that finally cap correctly &mdash; are how we get past it.
        </P>
      </div>
    </article>
  );
}
