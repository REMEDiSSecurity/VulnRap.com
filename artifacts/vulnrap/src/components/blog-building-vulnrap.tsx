import { Calendar, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>;
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-foreground font-semibold text-base mt-6 mb-2">{children}</h4>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-primary font-mono text-xs bg-primary/10 px-1 py-0.5 rounded">{children}</code>;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-background/80 border border-border/50 rounded-lg p-4 text-xs font-mono overflow-x-auto mb-4">
      {children}
    </pre>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-xs border border-border/50 rounded">
        <thead>
          <tr className="bg-muted/30">
            {headers.map((h, i) => (
              <th key={i} className="text-left p-2 font-semibold text-foreground border-b border-border/50">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/30 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="p-2">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BlogBuildingVulnrap() {
  return (
    <article className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="border-primary/30 text-primary text-[10px]">Deep Dive</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          Building VulnRap: How We're Making Vulnerability Report Validation Actually Work for PSIRT Teams
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          A detailed walkthrough of four development sprints, what we built, what we learned, what works, and what's coming next.
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">

        <P>
          If you run a PSIRT team or maintain an open-source project with a bug bounty program, you already know the problem. AI-generated vulnerability reports &mdash; "slop" &mdash; are flooding inboxes at an accelerating rate. The curl project reports that only about 5% of their 2025 submissions were genuine vulnerabilities, with roughly 20% being identifiable AI slop and a growing chunk being "human slop" that's indistinguishable in origin but equally useless. The Log4j team documented 60+ clear slop examples in their YesWeHack program. Node.js received over 30 AI slop reports during a single holiday period.
        </P>

        <P>
          Each one of these reports costs someone 3&ndash;4 hours to triage. For a team of volunteers who might only have three hours per week for the project, a single slop report consumes their entire weekly contribution. It's a denial-of-service attack on open source maintainership, and it's why curl ultimately shut down their bug bounty program in January 2026.
        </P>

        <P>
          VulnRap was built to help tackle this. Not by replacing human judgment, but by giving PSIRT teams a way to score, verify, and triage incoming vulnerability reports before burning hours on reports that turn out to be hallucinated nonsense. We've been through four major development sprints since launch, and this post is a detailed walkthrough of what we built, what we learned, what works, and what's coming next.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>How This Started: A Weekend Project That Wouldn't Let Go</SectionHeading>

        <P>
          VulnRap started as a weekend project. That's it &mdash; no funding round, no roadmap, no team. Just a frustrated PSIRT engineer who'd spent one too many Friday afternoons triaging a beautifully formatted report about a buffer overflow in a function that didn't exist.
        </P>

        <P>
          The initial idea was deliberately narrow: "What if I just grep for 'Dear Security Team' and 'I hope this message finds you well' and auto-flag those?" That prototype took about two hours. It caught maybe 30% of the slop in our queue. Good enough to be interesting. Not good enough to be useful.
        </P>

        <P>
          And that's where the nerd sniping happened.
        </P>

        <P>
          If you're unfamiliar with the term, "nerd sniping" is{" "}
          <a href="https://xkcd.com/356/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            the xkcd concept
            <ExternalLink className="w-3 h-3 inline ml-0.5" />
          </a>{" "}
          where you present someone with a problem so interesting that they can't stop thinking about it. AI slop detection is a textbook nerd snipe: it sits at the intersection of computational linguistics, information retrieval, adversarial machine learning, and the deeply human question of "what does it mean to actually understand a vulnerability?"
        </P>

        <P>
          It started with minutes of thinking &mdash; scribbling out "what if I just pattern-match the obvious AI phrases?" Then hours of trying things, testing against real slop from our queue, watching the detection rate climb from useless to interesting. Every time I addressed one detection problem, I'd find two more. "OK, I can catch AI phrases &mdash; but what about the slop that doesn't use AI phrases?" That led to statistical text analysis. "OK, I can detect abnormal sentence uniformity &mdash; but what about the slop that references real code?" That led to factual verification via GitHub API. "OK, I can check if functions exist &mdash; but what about the slop that references real functions but describes fake vulnerabilities?" That led to the LLM semantic analysis layer.
        </P>

        <P>
          Minutes became hours. Hours became days. Days became a whole weekend spent refining the idea, tearing apart what didn't work, rebuilding it better. Each new layer peeled back another layer of the problem. And each layer revealed that slop detection is fundamentally a game theory problem &mdash; you're not building a classifier, you're building a system where every bypass requires doing progressively more real work, until the effort to bypass the detector exceeds the effort to just find a real vulnerability.
        </P>

        <P>
          The stack reflects the rapid-prototype origin: Express, React, PostgreSQL, TailwindCSS. Nothing exotic. The entire thing runs on a single Replit instance. We open-sourced it because the problem isn't ours alone &mdash; every PSIRT team, every bug bounty program, every open-source maintainer is dealing with this. The more eyes on the detection logic, the better it gets.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Where We Started: The Brutal Baseline</SectionHeading>

        <P>
          Before we could improve anything, we needed to know how well (or poorly) the original system worked. We ran a blind test: 29 vulnerability reports submitted through the VulnRap API. 14 were known AI slop at varying sophistication levels. 15 were confirmed legitimate &mdash; sourced from HackerOne disclosed reports (with real bounty payouts), oss-security mailing list advisories written by researchers like Daniel Stenberg and Qualys, and Full Disclosure advisories from firms like SEC Consult.
        </P>

        <P>
          The results were sobering.
        </P>

        <P>
          The mean slop score was 32.6. The mean legitimate score was 32.1. That's a gap of 0.5 points &mdash; statistically indistinguishable. Cohen's d effect size was 0.06, which in statistical terms means "negligible." The best achievable accuracy was 58.6%, barely better than a coin flip.
        </P>

        <P>
          What was happening? The original scoring system was measuring report <em>quality</em> &mdash; not report <em>origin</em>. It checked for things like version numbers, code blocks, affected components, and expected-vs-observed behavior comparisons. A well-structured AI fabrication scored low (looked "good"), while a real but terse kernel developer's bug report scored high (looked "bad"). A fabricated Java deserialization report scored 18 &mdash; <em>lower</em> than an official libpng CVE advisory that scored 20. A real Alipay vulnerability chain affecting a billion users scored 46, dangerously close to the "highly suspicious" threshold.
        </P>

        <P>
          The system was penalizing style instead of substance. That had to change.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Sprint 1: Separating Quality from Slop</SectionHeading>

        <P>
          The single most important architectural decision we made was splitting "report quality" and "slop probability" into entirely separate scoring axes. A report can be well-written AND be AI slop. A report can be terse and informal AND contain a genuine zero-day. These are orthogonal dimensions.
        </P>

        <P>We built a four-axis scoring model:</P>

        <P>
          <strong className="text-foreground">Axis 1: Linguistic AI Fingerprinting.</strong>{" "}
          This axis looks for the specific patterns that AI language models produce when generating security reports. Not generic "good writing vs bad writing" &mdash; but the actual telltale markers. We compiled a weighted dictionary of AI-specific phrases drawn from hundreds of real slop submissions. Phrases like "Dear Security Team, I hope this message finds you well" (weight 20), "Certainly! Let me elaborate" (weight 30), "I apologize for any confusion in my previous report" (weight 25). These aren't phrases that real vulnerability researchers use. A human might open with "hey, found a bug in your parser" &mdash; they don't open with "I would like to bring to your attention a potential security vulnerability that I discovered during my thorough security assessment."
        </P>

        <P>
          Beyond phrase matching, we added statistical text analysis: sentence length coefficient of variation (real humans vary their sentence length; AI produces remarkably uniform ones) and bigram entropy (AI text has measurably lower entropy in its word-pair distributions). A passive voice ratio check flags the kind of stilted, overly formal construction that LLMs default to.
        </P>

        <P>
          <strong className="text-foreground">Axis 2: Structural Quality (separate from slop).</strong>{" "}
          This axis still evaluates report completeness &mdash; does it have version numbers, reproduction steps, a PoC, an impact statement? &mdash; but it now feeds into a separate <Code>qualityScore</Code> that does NOT inflate the slop score. A well-structured slop report gets quality=77 and slop=75. A terse but real report gets quality=45 and slop=12. The two numbers tell different stories, and triagers need both.
        </P>

        <P>
          <strong className="text-foreground">Axis 3: Factual Verification.</strong>{" "}
          Can we verify whether the claims in the report are actually true? We check for placeholder URLs (target.com, example.com, vulnerable-server.com in PoC curl commands), for non-existent CVE IDs, for severity inflation (claiming CVSS 9.8 critical for a self-DoS), and for known template patterns. A "Dear Security Team" opener followed by "Steps to Reproduce: 1. Navigate to... 2. Enter the following payload..." followed by "Impact: An attacker could potentially..." is a template. We hash these structures and match them.
        </P>

        <P>
          <strong className="text-foreground">Axis 4: LLM Deep Analysis.</strong>{" "}
          For reports that the heuristic axes can't confidently classify, we pass the text to a language model for semantic analysis. The LLM evaluates specificity, originality, voice consistency, coherence, and hallucination probability.
        </P>

        <SubHeading>Sprint 1 Results</SubHeading>

        <P>
          We retested with 16 completely fresh reports &mdash; no overlap with the original 29. Eight legitimate reports from the oss-security mailing list. Eight freshly crafted slop at varying sophistication.
        </P>

        <Table
          headers={["Metric", "Before (29 reports)", "After (16 reports)"]}
          rows={[
            ["Cohen's d effect size", "0.06 (negligible)", "1.63 (large)"],
            ["AUC-ROC", "~0.52 (random)", "0.781 (fair)"],
            ["Best accuracy", "58.6%", "87.5%"],
            ["Score gap between groups", "0.5 points", "3.6 points"],
          ]}
        />

        <P>
          Cohen's d went from "statistically indistinguishable" to "large effect size." At an optimal threshold of 36, the system correctly classified 14 of 16 reports. But two problems remained: the LLM axis was returning null on every report, and the score range was compressed into a 9-point band (34&ndash;43) because the fusion formula's midpoint anchor was pulling everything toward center.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Sprint 2: The Scoring Overhaul</SectionHeading>

        <SubHeading>Killing the Midpoint Anchor</SubHeading>

        <P>
          The original fusion formula was <Code>final = raw * confidence + 50 * (1 - confidence)</Code>. When confidence is 0.30, this maps everything to the 35&ndash;43 range regardless of how strong the signals are. The problem: 50 as a midpoint assumes the base rate of slop is 50%. It's not. Most vulnerability reports are not AI slop. The prior should be low, and evidence should push it up.
        </P>

        <P>We replaced the formula with an additive evidence model using Noisy-OR probability combination:</P>

        <CodeBlock>{`Base prior: 15 (assumption: most reports are legit)
Each axis converts to a probability signal (0.0 to 1.0)
Combined probability: 1 - product(1 - p_i) for all firing signals
Final score: 15 + combined_probability * 80`}</CodeBlock>

        <P>
          Multiple independent signals reinforce each other instead of averaging out. When nothing fires, the score stays at 15. The score range expanded from 5&ndash;95 instead of 34&ndash;43.
        </P>

        <SubHeading>Negative Evidence: The Human Indicators</SubHeading>

        <P>
          The system could only push scores UP. But reports with strong human signals should actively score below the baseline. We built a human indicator detection system:
        </P>

        <ul className="space-y-1 list-disc pl-5 mb-4">
          <li><strong className="text-foreground">Contractions present</strong> (weight -5): Real researchers write "don't" and "isn't." AI defaults to "do not."</li>
          <li><strong className="text-foreground">Terse, direct style</strong> (weight -4): Short sentences, no filler. Average sentence length under 15 words.</li>
          <li><strong className="text-foreground">Named researcher credited</strong> (weight -3): "Reported by Sarah Chen" vs. the AI default of "Security Researcher."</li>
          <li><strong className="text-foreground">Real commit/PR references</strong> (weight -6): A link to a specific GitHub commit means someone actually looked at the code.</li>
          <li><strong className="text-foreground">Specific fix version</strong> (weight -3): "Fixed in v2.4.7" means the reporter tracked the patch.</li>
          <li><strong className="text-foreground">Informal language</strong> (weight -4): Exclamation marks, sentence fragments, first-person observations.</li>
          <li><strong className="text-foreground">Advisory format without AI pleasantries</strong> (weight -3): Structured advisory without "Dear Security Team" or "I hope this helps."</li>
        </ul>

        <P>
          These negative weights pull the score down below the 15 baseline, creating maximum separation between "definitely human" (score 5&ndash;12) and "definitely slop" (score 75&ndash;95).
        </P>

        <SubHeading>Sensitivity Presets</SubHeading>

        <P>
          Different PSIRT teams have different tolerance levels. We added sensitivity presets that work as a post-processing overlay on top of the canonical score:
        </P>

        <ul className="space-y-1 list-disc pl-5 mb-4">
          <li><strong className="text-foreground">Strict</strong>: Linguistic and factual weights multiplied by 1.5, human indicator weights reduced to 0.7.</li>
          <li><strong className="text-foreground">Balanced</strong>: All weights at 1.0. The default.</li>
          <li><strong className="text-foreground">Lenient</strong>: Linguistic and factual weights reduced to 0.7, human indicators boosted to 1.5.</li>
        </ul>

        <P>
          Critically, the sensitivity adjustment does not change the stored canonical score. The stored score, the statistical data, and the report count all remain clean. No data pollution from repeated checks with different settings.
        </P>

        <SubHeading>Content-Hash Dedup</SubHeading>

        <P>
          Every report gets a SHA-256 hash of its normalized text. The first time we see a hash, we run the full scoring pipeline and store the result. Subsequent checks return the cached canonical score (adjusted by the current sensitivity setting) and increment a check counter &mdash; but don't re-run the pipeline or create a new database record.
        </P>

        <SubHeading>Recalibrated Tiers</SubHeading>

        <Table
          headers={["Score", "Tier", "Meaning"]}
          rows={[
            ["0-20", "Clean", "Strong human signals, no slop indicators"],
            ["21-35", "Likely Human", "Minor flags but probably legitimate"],
            ["36-55", "Questionable", "Mixed signals, manual review needed"],
            ["56-75", "Likely Slop", "Multiple AI indicators firing"],
            ["76-100", "Slop", "Near-certain AI generated"],
          ]}
        />

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Sprint 3: Active Content Validation</SectionHeading>

        <SubHeading>The Fundamental Problem with Style Detection</SubHeading>

        <P>
          Everything in Sprints 1 and 2 detects slop based on how the report is <em>written</em>. This works against lazy slop generators, but it has a fundamental shelf life: if a reporter can see the detection heuristics (or just reads this blog post), they tell their AI to avoid the triggers.
        </P>

        <P>
          Sprint 3 built the layer that can't be bypassed without doing real work: <strong className="text-foreground">factual verification</strong>. If VulnRap checks whether the function names, file paths, CVE IDs, and code references in your report actually exist in the claimed project, you can't fake that without finding real functions and real files &mdash; at which point you're doing actual security research, and the report isn't slop anymore.
        </P>

        <SubHeading>Function and File Verification via GitHub API</SubHeading>

        <P>
          When a report references a public open-source project, VulnRap identifies it via GitHub/GitLab URLs, npm/PyPI package references, or a lookup table of known projects. Then it checks the claims.
        </P>

        <P>
          When a report says "the vulnerability is in <Code>curl_parse_header_secure()</Code> in <Code>lib/header_parser.c</Code>," VulnRap queries the GitHub code search API for that function and checks the contents API for that file. If neither exists, those are strong slop signals. If they do, somebody actually looked at the code.
        </P>

        <SubHeading>CVE Cross-Referencing with Plagiarism Detection</SubHeading>

        <P>
          For each referenced CVE, VulnRap fetches the NVD entry and computes a phrase-overlap similarity score. We extract 5-word sequences from the NVD description and check how many appear in the report. If more than 30% of the NVD phrasing shows up, it's flagged as potential copy-paste plagiarism. This catches the common pattern where an AI reads the CVE description and paraphrases it as a "discovery." A fabricated CVE that doesn't exist in NVD at all gets flagged as a hallucination.
        </P>

        <SubHeading>PoC Plausibility Checking</SubHeading>

        <ul className="space-y-1 list-disc pl-5 mb-4">
          <li><strong className="text-foreground">Placeholder domains</strong>: Commands using <Code>target.com</Code>, <Code>example.com</Code>, <Code>vulnerable-server.com</Code> instead of actual endpoints.</li>
          <li><strong className="text-foreground">Textbook payloads + placeholders</strong>: <Code>alert(1)</Code> or <Code>' OR '1'='1'</Code> combined with placeholder domains is almost certainly a template, not a real test.</li>
          <li><strong className="text-foreground">Fabricated HTTP responses</strong>: Reports sometimes include "captured" HTTP responses. Missing realistic server headers suggests fabrication.</li>
        </ul>

        <SubHeading>The Verification Panel</SubHeading>

        <CodeBlock>{`Verification Results:
  Function exists: curl_parse_header_secure()    NOT FOUND
  Function exists: curl_easy_perform()            Verified (lib/easy.c)
  File exists: src/http/multipart.c               NOT FOUND
  CVE exists: CVE-2026-31790                      Verified in NVD
  NVD plagiarism: CVE-2026-31790                  42% phrase match
  PoC plausibility: curl command                  Placeholder domain`}</CodeBlock>

        <P>
          A triager can scan this in five seconds and know whether to dig deeper or close the ticket.
        </P>

        <SubHeading>The Layered Defense Model</SubHeading>

        <P>
          We designed the adversarial resistance around a principle: every bypass costs the attacker something.
        </P>

        <ul className="space-y-2 list-none pl-0 mb-4">
          <li><strong className="text-foreground">Layer 1 &mdash; Style Detection.</strong> Cost to bypass: modify the LLM prompt (~5 minutes). Catches about 80% of slop today because most generators are lazy.</li>
          <li><strong className="text-foreground">Layer 2 &mdash; Factual Verification.</strong> Cost to bypass: reference real code, real CVEs, real file paths. You can't fake a GitHub code search result.</li>
          <li><strong className="text-foreground">Layer 3 &mdash; Claim Depth Analysis.</strong> Cost to bypass: produce original analysis, not just NVD rewording.</li>
          <li><strong className="text-foreground">Layer 4 &mdash; Behavioral Signals.</strong> Cost to bypass: change submission patterns, build submission history.</li>
          <li><strong className="text-foreground">Layer 5 &mdash; LLM Semantic Judgment.</strong> Cost to bypass: unpredictable. Evolves as models improve.</li>
        </ul>

        <P>
          The key insight: if someone bypasses all five layers, they've done actual security research. At that point, the report probably isn't slop. VulnRap isn't anti-AI. It's anti-slop.
        </P>

        <SubHeading>Temporal Signals &amp; Mad-Libs Fingerprinting</SubHeading>

        <P>
          If a CVE is published at 14:00 UTC and VulnRap receives a "detailed analysis" at 14:07 UTC, that's 7 minutes. Nobody discovers, analyzes, and writes up a vulnerability in 7 minutes. Reports submitted within 2 hours of CVE publication get flagged.
        </P>

        <P>
          Slop generators often use the same template and swap out the project name, CVE ID, and URLs. We detect this by normalizing the report &mdash; replacing all variable entities with placeholders &mdash; and hashing the skeleton. If two reports produce the same skeleton hash, they're the same template with different names swapped in.
        </P>

        <SubHeading>Triage Recommendations &amp; Challenge Questions</SubHeading>

        <P>
          Based on the combined score and verification results, VulnRap recommends a specific action: AUTO_CLOSE, MANUAL_REVIEW, CHALLENGE_REPORTER, PRIORITIZE, or STANDARD_TRIAGE. For questionable reports, it generates specific questions the triager can send back. Real researchers answer these easily; slop generators can't.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Sprint 4: The AI Triage Assistant</SectionHeading>

        <SubHeading>Beyond "Is This Slop?"</SubHeading>

        <P>
          Detecting slop is necessary but not sufficient. The real danger for PSIRT teams isn't just wasting time on fake reports &mdash; it's accidentally dismissing a real vulnerability because it's buried in AI spam. Sprint 4 added a triage report to every submission: a complete guide that helps the security team actually do their job faster regardless of whether the report is slop or not.
        </P>

        <SubHeading>The Combined LLM Triage Analysis</SubHeading>

        <P>
          We expanded the LLM analysis to generate both slop assessment AND triage guidance in a single call:
        </P>

        <ul className="space-y-1 list-disc pl-5 mb-4">
          <li><strong className="text-foreground">Slop Assessment</strong>: Five-dimensional scoring (specificity, originality, voice consistency, coherence, hallucination probability) plus reasoning and red flags.</li>
          <li><strong className="text-foreground">Triage Guide</strong>: Specific reproduction steps, environment requirements, expected behavior, and testing tips.</li>
          <li><strong className="text-foreground">Gap Analysis</strong>: What's missing from the report, what scenarios weren't tested, what scope questions remain.</li>
          <li><strong className="text-foreground">Reporter Feedback</strong>: Strengths, improvements sorted by priority, a clarity score, and an actionability assessment.</li>
        </ul>

        <P>
          All of this comes from a single LLM call at approximately $0.005 per report. At 100 reports per day, that's $0.50. The triage guide alone saves a triager 15&ndash;30 minutes per report.
        </P>

        <SubHeading>Heuristic Reproduction Templates</SubHeading>

        <P>
          We also built structured reproduction templates for eight common vulnerability classes as both a fallback (when LLM is unavailable) and an enrichment layer: XSS, SQL injection, SSRF, deserialization, buffer overflow, path traversal, authentication bypass, and race conditions. Each includes detection patterns, structured reproduction steps, and environment-specific notes.
        </P>

        <P>
          For example, the buffer overflow template tells the triager: "Compile with AddressSanitizer: <Code>CFLAGS='-fsanitize=address' ./configure && make</Code>. Run the PoC. Check ASan output for crash location. Also run Valgrind as a second opinion." And the environment notes warn about 32-bit vs 64-bit differences, ASLR, and stack canaries.
        </P>

        <SubHeading>The "Don't Miss" Analysis</SubHeading>

        <P>
          This is the feature that prevents the worst outcome: throwing away a real bug. Even when the slop score is high, VulnRap runs a "what could go wrong if we dismiss this" check &mdash; flagging real vulnerability classes, verified CVE references, named source files, and ambiguous scores where AI-assisted writing is more likely than pure slop.
        </P>

        <SubHeading>UI Integration</SubHeading>

        <P>
          The triage report renders as a tabbed panel (Reproduce, Gaps, Don't Miss, Reporter Feedback) with a copy button that generates formatted markdown suitable for pasting into Jira, ServiceNow, or GitHub Issues.
        </P>

        <P>
          The results page also includes:
        </P>

        <ul className="space-y-1 list-disc pl-5 mb-4">
          <li><strong className="text-foreground">Confidence Gauge</strong>: A semicircular gauge showing analysis certainty, color-coded from orange (low) through yellow (medium) to green (high).</li>
          <li><strong className="text-foreground">LLM Radar Chart</strong>: The five semantic dimensions render as a radar/spider chart. The polygon shape tells an immediate visual story &mdash; legitimate reports produce small, even polygons; slop produces large, spiky ones.</li>
          <li><strong className="text-foreground">Evidence-Highlighted Report Text</strong>: The redacted report text is displayed with inline citations &mdash; AI phrases in red, human signals in green. Hovering over any highlight shows the evidence type and weight.</li>
          <li><strong className="text-foreground">Analysis Progress Stepper</strong>: During submission, a multi-step stepper shows the pipeline progressing through Upload, Redact, Linguistic, Factual, Template, LLM, and Triage.</li>
        </ul>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What We Learned from the OpenSSF Community</SectionHeading>

        <P>
          We've been following the OpenSSF Vulnerability Disclosures Working Group's discussions on AI slop (GitHub issues{" "}
          <a href="https://github.com/ossf/wg-vulnerability-disclosures/issues/178" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#178</a> and{" "}
          <a href="https://github.com/ossf/wg-vulnerability-disclosures/issues/179" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">#179</a>
          ).
        </P>

        <P>
          <strong className="text-foreground">"Discovery without validation is slop."</strong> The consensus is that requiring proof-of-work &mdash; a functional PoC and demonstrated understanding &mdash; is the most effective defense. VulnRap's PoC plausibility checking and factual verification implement this principle.
        </P>

        <P>
          <strong className="text-foreground">"3&ndash;4 people, 3 hours each, per report."</strong> This cost estimate from both curl and Log4j validates VulnRap's entire product thesis. If we can cut triage time from 3 hours to 30 minutes, the ROI is immediate and massive.
        </P>

        <P>
          <strong className="text-foreground">"Refusing reports does not make potential findings go away."</strong> CRob's note in the OpenSSF discussion captures why VulnRap includes the "Don't Miss" feature. The goal is not to block reports &mdash; it's to prioritize them so real vulnerabilities don't get lost in the noise.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Hard Cases: What Still Beats Us</SectionHeading>

        <P>
          We believe in being transparent about limits. Two reports in our 16-report retest evaded detection:
        </P>

        <P>
          <strong className="text-foreground">The professional SSRF report (S03)</strong>: Scored 34, same as legitimate reports. It avoided AI catchphrases, used a professional tone, and was structurally well-organized. The only signal was <Code>target.com</Code> in a curl command.
        </P>

        <P>
          <strong className="text-foreground">The sophisticated race condition (S08)</strong>: Scored 34. Well-written slop with no AI fingerprints, realistic technical depth, and plausible-sounding analysis.
        </P>

        <P>
          Both require either the LLM analysis axis or the factual verification layer to catch. When someone puts effort into making slop look real, the style detection layers can't catch it. That's by design. Style detection has a shelf life. Factual verification doesn't.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Where We're Going: Sprint 5</SectionHeading>

        <ul className="space-y-3 list-none pl-0 mb-4">
          <li><strong className="text-foreground">Reporter Reputation Scoring.</strong> Track submission history by reporter identifier. Fingerprint submission patterns rather than relying on account IDs.</li>
          <li><strong className="text-foreground">Internal Consistency Checking.</strong> Cross-validate the CVSS vector string, CWE classification, described impact, stated prerequisites, and report narrative.</li>
          <li><strong className="text-foreground">Self-Contradiction Detection.</strong> Explicitly flag reports where the reasoning undermines the conclusion.</li>
          <li><strong className="text-foreground">Configurable Project Threat Model.</strong> Allow PSIRT teams to define out-of-scope vulnerability classes for their project.</li>
        </ul>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>By the Numbers</SectionHeading>

        <Table
          headers={["Metric", "Baseline", "Current", "Improvement"]}
          rows={[
            ["Cohen's d (effect size)", "0.06", "1.63", "27x increase"],
            ["AUC-ROC", "0.52", "0.781", "From random to fair"],
            ["Best accuracy", "58.6%", "87.5%", "+28.9 percentage points"],
            ["Mean score gap", "0.5 pts", "3.6 pts", "7x wider"],
            ["False positive rate", "47%", "12.5%", "-34.5 percentage points"],
            ["Detection axes", "1 (quality)", "4 (ling, fact, tmpl, LLM)", "4x coverage"],
          ]}
        />

        <P>
          The LLM axis is now active and integrated into the scoring pipeline, adding semantic depth to the heuristic signals. We expect the AUC to continue climbing above 0.85 as we gather more data.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Philosophy</SectionHeading>

        <P>
          VulnRap's job is not to be a wall. It's not a CAPTCHA. It's not designed to punish reporters or prevent submissions. It's designed to be the triager's first pass &mdash; the 30-second scan that tells a security team "this needs your attention" vs "this can wait" vs "send these challenge questions back."
        </P>

        <P>
          The world where AI-assisted security research exists alongside AI-generated slop is the world we live in now. A good triaging tool needs to handle both: catch the slop, surface the real findings, and &mdash; critically &mdash; never be so aggressive that a genuine vulnerability gets lost in the filter.
        </P>

        <P>
          Daniel Stenberg wrote that the slop problem is "death by a thousand cuts." We're building the armor. It's not perfect yet &mdash; we're honest about what still beats us &mdash; but it's getting meaningfully better with every sprint.
        </P>

        <P>
          If you're a PSIRT team, a bug bounty program, or an open-source maintainer dealing with this problem, try VulnRap. Submit a report and see how it scores. The check endpoint is free, read-only, and doesn't store your data unless you want it to. And if you find a report that beats our detection, tell us &mdash; that's how this gets better.
        </P>
      </div>

      <Separator className="bg-border/50" />

      <div className="text-center text-xs text-muted-foreground/70 italic">
        <p>
          VulnRap is free and open. The API is at <Code>POST /api/reports/check</Code>. The source is on{" "}
          <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            GitHub
            <ExternalLink className="w-3 h-3 inline ml-0.5" />
          </a>.
        </p>
      </div>
    </article>
  );
}
