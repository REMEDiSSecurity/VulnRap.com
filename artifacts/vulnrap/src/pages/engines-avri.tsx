import { Link } from "react-router-dom";
import {
  Layers, Gauge, Target, ShieldOff, Compass, Activity,
  ArrowRight, AlertTriangle, CheckCircle2, XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface FamilySummary {
  id: string;
  name: string;
  oneLiner: string;
  verification: string;
  cwes: string;
}

const FAMILIES: FamilySummary[] = [
  {
    id: "MEMORY_CORRUPTION",
    name: "Memory corruption / unsafe C",
    oneLiner: "Sanitizer/valgrind traces, allocator calls, struct field writes — the C/C++ crash story.",
    verification: "SOURCE_CODE",
    cwes: "119, 120, 121, 122, 125, 416, 590, 672, 762, 787, 806",
  },
  {
    id: "INJECTION",
    name: "Injection (SQLi / Command / LDAP / NoSQL)",
    oneLiner: "Concrete payloads, vulnerable query construction, named endpoint and parameter.",
    verification: "ENDPOINT",
    cwes: "77, 78, 89, 90, 91, 94, 624, 917, 943",
  },
  {
    id: "WEB_CLIENT",
    name: "Web client (XSS / CSRF / SSRF / open redirect / traversal)",
    oneLiner: "JS payload + DOM sink, or SSRF metadata target, or path-traversal reaching a sensitive file.",
    verification: "ENDPOINT",
    cwes: "22, 79, 80, 83, 352, 451, 601, 611, 918, 1021",
  },
  {
    id: "AUTHN_AUTHZ",
    name: "Authentication / Authorization / Session",
    oneLiner: "Two distinct accounts, the request crossing the boundary, and the policy/check function.",
    verification: "ENDPOINT",
    cwes: "284, 285, 287, 306, 522, 639, 640, 862, 863",
  },
  {
    id: "CRYPTO",
    name: "Cryptography",
    oneLiner: "Algorithm/mode/library named, specific misuse pattern, ideally a KAT or observable break.",
    verification: "SOURCE_CODE",
    cwes: "310, 326, 327, 328, 330, 338, 759, 760, 798, 916, 1240",
  },
  {
    id: "DESERIALIZATION",
    name: "Insecure deserialization / unsafe parsing",
    oneLiner: "Gadget/payload, the deserialization sink with library, RCE/exfil evidence; XXE entity declarations.",
    verification: "SOURCE_CODE",
    cwes: "502, 611, 776, 827, 915",
  },
  {
    id: "RACE_CONCURRENCY",
    name: "Race condition / TOCTOU / concurrency",
    oneLiner: "Two interleaved actors, a TSan/Helgrind trace or measurable observable (double-spend, dup row).",
    verification: "MANUAL_ONLY",
    cwes: "362, 363, 364, 367, 820, 821, 833, 843",
  },
  {
    id: "REQUEST_SMUGGLING",
    name: "HTTP request smuggling / desync",
    oneLiner: "Raw HTTP/1.1 bytes, TE/CL conflict, the smuggled second request, named proxy/server combo.",
    verification: "MANUAL_ONLY",
    cwes: "113, 115, 116, 436, 444",
  },
  {
    id: "FLAT",
    name: "Generic / unclassified (fallback)",
    oneLiner: "No specific family matched — falls back to generic evidence accumulation (the legacy v3.6 rubric).",
    verification: "GENERIC",
    cwes: "—",
  },
];

export default function EnginesAvri() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground mb-3">
          <Link to="/developers" className="hover:text-primary transition-colors">Docs</Link>
          <span>/</span>
          <span>Engines</span>
          <span>/</span>
          <span className="text-primary">AVRI</span>
        </div>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Layers className="w-8 h-8 text-primary" />
          AVRI — Adaptive Vulnerability Rubric Inference
        </h1>
        <p className="text-muted-foreground mt-3 max-w-3xl leading-relaxed">
          AVRI is the family-aware rubric layer that sits behind Engines 2 and 3. Instead
          of one flat checklist applied to every report, AVRI first detects which weakness
          family a submission belongs to (memory corruption? injection? authn?), then
          scores it against rubric tuned to <em>that</em> family — the gold signals a real
          report in that class always carries, and the absence penalties for the things it
          cannot plausibly omit.
        </p>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline" className="border-primary/30">9 families</Badge>
          <Badge variant="outline" className="border-primary/30">Gold signals + absence penalties</Badge>
          <Badge variant="outline" className="border-primary/30">Per-family verification mode</Badge>
          <Badge variant="outline" className="border-primary/30">Drift-monitored</Badge>
        </div>
      </div>

      {/* What family-aware scoring means */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Gauge className="w-5 h-5" />
            What family-aware scoring means
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            A flat rubric ("does the report contain code? a URL? a CWE?") rewards generic
            slop almost as much as it rewards a real finding. A real heap-buffer-overflow
            writeup looks nothing like a real CSRF writeup — the evidence shapes are
            different, the verification path is different, and the things you'd be
            <em> alarmed</em> not to see are different.
          </p>
          <p>
            AVRI captures that asymmetry. Each family carries:
          </p>
          <ul className="space-y-1.5 list-disc pl-5 text-xs">
            <li><strong className="text-foreground">Gold signals</strong> — patterns that, if present, strongly indicate authentic evidence (e.g. an AddressSanitizer crash for memory corruption; a concrete <span className="font-mono">UNION SELECT</span> payload for SQLi).</li>
            <li><strong className="text-foreground">Absence penalties</strong> — patterns whose <em>missing</em> deducts points (no sanitizer/valgrind output in a memory bug; no payload in an injection bug; no two-account proof in an authz bug).</li>
            <li><strong className="text-foreground">Contradiction phrases</strong> — phrases from <em>other</em> families that demote the score (an "alert(1)" inside a memory-corruption report).</li>
            <li><strong className="text-foreground">Reproduction expectation</strong> — a one-liner describing what a credible repro for this family looks like.</li>
            <li><strong className="text-foreground">Verification mode</strong> — <span className="font-mono">SOURCE_CODE</span>, <span className="font-mono">ENDPOINT</span>, <span className="font-mono">MANUAL_ONLY</span>, or <span className="font-mono">GENERIC</span> — picked up by Engine 4.</li>
          </ul>
        </CardContent>
      </Card>

      {/* The 9 families */}
      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-primary" />
            The nine families
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            Eight active families plus a <span className="font-mono">FLAT</span> fallback
            for reports that don't classify confidently. Member CWEs come from the rubric
            itself — see <Link to="/cwe" className="text-primary hover:underline">the CWE reference</Link>
            {" "}for per-CWE detail.
          </p>
          <div className="space-y-2">
            {FAMILIES.map((f) => (
              <div
                key={f.id}
                className="rounded-md border border-border bg-background/40 p-3 space-y-1"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="font-mono text-foreground text-xs">{f.id}</div>
                  <Badge variant="outline" className="text-[10px] border-primary/30">
                    {f.verification}
                  </Badge>
                </div>
                <div className="text-sm text-foreground">{f.name}</div>
                <div className="text-xs">{f.oneLiner}</div>
                <div className="text-[11px] font-mono text-muted-foreground/70">
                  CWE: {f.cwes}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Gold signals vs absence penalties */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Target className="w-5 h-5" />
            Gold signals vs. absence penalties
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-emerald-500/80">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Gold signals (additive)
              </div>
              <p className="text-xs">
                Each gold signal is a regex tied to a point value. When the body matches,
                points are awarded. They cap out per family, so a report can't farm a
                single signal — you need the <em>combination</em> of evidence a real
                writeup carries.
              </p>
              <p className="text-xs">
                Examples: AddressSanitizer trace (+22), Valgrind output (+18), allocator
                call with size (+8), CWE family-correct mention (+4).
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-rose-500/80">
                <XCircle className="w-3.5 h-3.5" />
                Absence penalties (subtractive)
              </div>
              <p className="text-xs">
                Each absence penalty is also a regex — but it subtracts points when the
                pattern <em>fails</em> to match. A memory-corruption report with no crash
                output, no size/offset, and no <span className="font-mono">.c</span> file
                reference accumulates penalties even if it has lots of generic prose.
              </p>
              <p className="text-xs">
                This is what stops a generator from earning a respectable score by writing
                long, fluent, evidence-free paragraphs.
              </p>
            </div>
          </div>
          <Separator />
          <p className="text-xs">
            Together with the <Link to="/engines/substance" className="text-primary hover:underline">substance gate</Link>,
            this gives AVRI an asymmetric incentive structure: real evidence is hard to
            fabricate, missing evidence is cheap to detect.
          </p>
        </CardContent>
      </Card>

      {/* Family detection */}
      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="w-5 h-5 text-primary" />
            Family detection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            AVRI picks a family in two stages:
          </p>
          <ol className="space-y-1.5 list-decimal pl-5 text-xs">
            <li>
              <strong className="text-foreground">CWE → family lookup.</strong> If the
              submitted CWE belongs to a family's <span className="font-mono">memberCwes</span>,
              that family is the starting hypothesis.
            </li>
            <li>
              <strong className="text-foreground">Body classifier override.</strong> The
              same term-frequency classifier that powers {" "}
              <Link to="/engines/cwe-coherence" className="text-primary hover:underline">CWE coherence</Link>
              {" "}runs over the prose. If it confidently disagrees with the submitted CWE
              and the inferred CWE belongs to a different family, AVRI scores against
              <em> both</em> rubrics and surfaces the disagreement to Engine 3.
            </li>
          </ol>
          <p>
            Reports that classify under the confidence floor fall back to the{" "}
            <span className="font-mono">FLAT</span> family — the legacy v3.6 generic
            rubric. The fallback is intentional: AVRI would rather abstain on
            classification than score a memory-corruption report against the injection
            rubric.
          </p>
        </CardContent>
      </Card>

      {/* Drift monitoring */}
      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Activity className="w-5 h-5" />
            Drift monitoring
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Per-family rubrics are powerful but brittle: a regex that perfectly catches
            today's payloads can quietly stop firing as attacker tooling evolves. AVRI is
            wired to the drift monitor so each family's gold-signal hit rate, mean score,
            and "no signals fired" rate are tracked over time.
          </p>
          <p>
            When a family's distribution shifts beyond its threshold, the {" "}
            <Link to="/feedback-analytics" className="text-primary hover:underline">feedback analytics</Link>
            {" "}page raises a drift flag with cooldown and re-arm logic so reviewers
            aren't paged by the same wobble twice. Drift events also surface on the {" "}
            <Link to="/incidents" className="text-primary hover:underline">incidents</Link>
            {" "}timeline when they correlate with calibration changes.
          </p>
        </CardContent>
      </Card>

      {/* Worked example */}
      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRight className="w-5 h-5 text-primary" />
            Worked example — <span className="font-mono">memory_corruption</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            A submission lands titled <em>"Heap-buffer-overflow in
            <span className="font-mono"> png_handle_iCCP</span> (CWE-122)"</em>. The body
            includes an AddressSanitizer trace, a stack with hex offsets, an allocator
            call, and a small diff against <span className="font-mono">pngrutil.c</span>.
            AVRI walks the rubric:
          </p>
          <div className="rounded-md border border-border bg-background/40 p-4 font-mono text-xs leading-relaxed space-y-1">
            <div><span className="text-muted-foreground">family</span>:                MEMORY_CORRUPTION  (CWE-122 → member)</div>
            <div><span className="text-muted-foreground">verificationMode</span>:      SOURCE_CODE</div>
            <div className="pt-1 text-emerald-400">+ asan_or_sanitizer       (+22)</div>
            <div className="text-emerald-400">+ stack_trace_with_offset (+12)</div>
            <div className="text-emerald-400">+ specific_alloc_function (+8)</div>
            <div className="text-emerald-400">+ specific_struct_field   (+6)</div>
            <div className="text-emerald-400">+ code_diff_in_c          (+12)</div>
            <div className="text-emerald-400">+ cwe_correct_class       (+4)</div>
            <div className="pt-1 text-muted-foreground">absence penalties:       none triggered</div>
            <div className="text-muted-foreground">contradiction phrases:   none matched</div>
            <div className="pt-1"><span className="text-muted-foreground">avri.score</span>:            64 / 100</div>
            <div><span className="text-muted-foreground">composite contribution</span>: high — gates open, Engine 3 confirms CWE alignment</div>
          </div>
          <p>
            Compare against the same body submitted as CWE-79 (XSS): family detection
            would put it in <span className="font-mono">WEB_CLIENT</span>, none of those
            gold signals would match, several absence penalties would fire ("no payload",
            "no URL"), and the contradiction phrases ("addresssanitizer", "memcpy(")
            would <em>further</em> demote the score. The same prose, scored against the
            wrong family, lands near zero — which is exactly the behaviour we want when a
            generator picks a CWE label at random.
          </p>
        </CardContent>
      </Card>

      {/* Failure modes / caveats */}
      <Card className="bg-card/40 backdrop-blur border-amber-500/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-500">
            <AlertTriangle className="w-5 h-5" />
            Caveats
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <ul className="space-y-2 list-disc pl-5 text-xs">
            <li>AVRI's rubrics are deliberately conservative. A novel-but-real bug class with no family yet falls through to <span className="font-mono">FLAT</span>; the score won't be wrong, but it won't get the family's targeted boost either.</li>
            <li>Gold signals are regex, not semantic. A copy-paste of someone else's sanitizer trace earns the points; that's why AVRI is one engine of several, not a verdict on its own.</li>
            <li>Family detection trusts the body over the title when they disagree confidently — but only when the classifier clears its floor. Borderline reports keep the submitted CWE.</li>
            <li>Per-family thresholds are recalibrated against the public corpus. Calibration changes ship in the <Link to="/changelog" className="text-primary hover:underline">changelog</Link> with the affected families called out by name.</li>
          </ul>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border pt-6">
        <Link to="/engines/cwe-coherence" className="hover:text-primary transition-colors inline-flex items-center gap-1">
          ← CWE coherence engine
        </Link>
        <Link to="/stats" className="hover:text-primary transition-colors inline-flex items-center gap-1">
          See engine stats <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}
