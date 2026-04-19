import { Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import heroSrc from "@assets/generated_images/blog-zero-detection-hero.png";
import scoreDistributionSrc from "@assets/blog_chart_score_distribution_1776565915390.png";
import specVsRealitySrc from "@assets/blog_chart_spec_vs_reality_1776565915390.png";
import signalStrengthSrc from "@assets/blog_chart_signal_strength_1776565915390.png";
import datasetCompositionSrc from "@assets/blog_chart_dataset_composition_1776565915389.png";
import textCoverageSrc from "@assets/blog_chart_text_coverage_1776565915390.png";

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

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

function ChartImage({ src, title, subtitle, alt }: { src: string; title: string; subtitle: string; alt: string }) {
  return (
    <div className="bg-card/80 border border-border/50 rounded-lg p-3 sm:p-6 my-6">
      <h4 className="text-foreground font-semibold text-sm mb-1 leading-snug">{title}</h4>
      <p className="text-muted-foreground text-xs mb-4 leading-snug">{subtitle}</p>
      <img src={src} alt={alt} loading="lazy" className="w-full h-auto rounded border border-border/40" />
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: (string | React.ReactNode)[][] }) {
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
            <tr key={i} className="border-b border-border/30 last:border-0 align-top">
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

export function BlogZeroDetection() {
  return (
    <article id="zero-detection" className="space-y-4">
      <div className="-mx-8 -mt-8 mb-2 relative overflow-hidden rounded-t-xl">
        <img
          src={heroSrc}
          alt="A glowing red zero pierces a wall of cascading neon-cyan numerals reading 460,590 — visualizing a six-digit dataset undone by a zero-percent detection rate"
          className="w-full h-44 sm:h-64 object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent pointer-events-none" />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 text-[10px]">Update #4</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          460K Vulnerability Reports, 56 Sources, and a 0% Detection Rate
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          The week we built the most diverse vulnerability report dataset we could find, ran our scoring system against it, and watched it score AI slop and real CVEs identically. Plus: what the data taught us about evidence over style, and the eleven-engine architecture replacing the formula.
        </p>
        <p className="text-xs text-muted-foreground/80">
          Update #4 in the VulnRap Sprint Series — Previous:{" "}
          <a href="#building-vulnrap" className="text-primary hover:underline">Building VulnRap</a>{" · "}
          <a href="#grading-ai-with-ai" className="text-primary hover:underline">Grading AI With AI</a>{" · "}
          <a href="#the-data-is-there" className="text-primary hover:underline">The Data Is There, the Score Isn't Listening</a>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">

        <P>
          There's a moment in every data project where you open a spreadsheet, see a six-digit row count, and feel briefly invincible. We had that moment. We are over it now.
        </P>

        <P>
          This post is about what happened when we set out to build the most diverse vulnerability report dataset we could find, what the data actually told us when we analyzed it, and how it's reshaping VulnRap's next sprint. If you're building anything in the ML-for-security space, some of these lessons might save you months.
        </P>

        <P>But first: the test that made all of this necessary.</P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Test That Broke the Formula</SectionHeading>

        <P>
          We tested VulnRap against 12 real vulnerability reports from HackerOne's curl security program. Eight were confirmed AI slop &mdash; flagged by Daniel Stenberg, curl's creator, who eventually shut down the program entirely because of AI-generated garbage. Three were legitimate, including CVE-2025-0725 (a gzip integer overflow with exact line numbers and a working crash PoC).
        </P>

        <P>
          Detection rate: <Bold>zero percent.</Bold>
        </P>

        <P>
          Every single report &mdash; slop and legitimate &mdash; scored between 8 and 18. All classified "Clean." The AI slop averaged 13.9. The legitimate reports averaged 11.7. The distributions overlap completely.
        </P>

        <P>
          The worst inversion: the HTTP Request Smuggling report that Stenberg explicitly called "AI rubbish style with bullet point overload" scored 8. The real CVE scored 9. The slop scored <em>better</em> than the legitimate finding.
        </P>

        <ChartImage
          src={scoreDistributionSrc}
          title="Score Distribution: AI Slop vs Legitimate"
          subtitle="All 12 reports scored between 8 and 18 — nowhere near the detection threshold of 60. AI slop and real CVEs are statistically indistinguishable."
          alt="Score distribution chart showing AI slop and legitimate reports clustered together between 8 and 18, with the detection threshold at 60 far above both groups"
        />

        <P>
          We predicted this ceiling mathematically in <a href="#the-data-is-there" className="text-primary hover:underline">Update #3</a>. The scoring formula is built from linguistic analysis (40%), template detection (35%), and spectral analysis (25%). Substance signals &mdash; fabricated functions, wrong PoC targets &mdash; are additive boosts capped at +32. The detection threshold is 60. Even if every substance red flag fires simultaneously, the score lands around 38. The gap is structural, not parametric.
        </P>

        <P>
          We stopped trying to fix the formula. Instead, we spent the next week building something that could make a different kind of formula possible: better data.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What VulnRap Is Trying to Do</SectionHeading>

        <P>Before the data story makes sense, the problem statement has to make sense.</P>

        <P>
          VulnRap is a multi-engine analysis system for vulnerability reports. Researchers submit a report; eleven independent engines analyze it; two scores come out: <Bold>AI Likelihood (0&ndash;100)</Bold> and <Bold>Validity (0&ndash;100)</Bold>. Think VirusTotal, but instead of malware hashes going through AV engines, it's a bug bounty submission going through specialized analyzers.
        </P>

        <P>
          Each engine needs training data. But the data requirements are <em>completely different</em> depending on the engine. A CWE Coherence Checker needs NVD CVEs with well-formed CWE assignments. A Claim Verifier needs matched pairs of (report claim, ground truth from GitHub/NVD). An AI Authorship Detector needs confirmed human-written reports alongside confirmed AI-generated slop. Conflating these into "the dataset" was the source of several of our biggest mistakes.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Phase 1: The Obvious Sources</SectionHeading>

        <P>We started where many people might start &mdash; HackerOne's publicly disclosed reports.</P>

        <P>
          HackerOne publishes a dataset on HuggingFace containing <Bold>13,831 reports</Bold> with structured metadata: reporter name, bounty amount (if any), disclosure timestamp to the millisecond, severity, asset type, and &mdash; crucially &mdash; the triage outcome: <em>resolved</em>, <em>informative</em>, <em>not-applicable</em>, <em>spam</em>, or <em>duplicate</em>. That outcome label is the closest thing to a ground-truth validity label available anywhere in the public domain. No other platform publishes triage decisions at this scale. That makes it our primary benchmark &mdash; not because it's perfect, but because it's the richest labeled set we could find.
        </P>

        <P>
          We also pulled from <Bold>Bugcrowd CrowdStream</Bold> (892 publicly disclosed reports with minimal metadata) and <Bold>Huntr AI/ML Security advisories</Bold> (1,856 disclosures focused on AI/ML systems &mdash; a niche that's exploding and largely absent from older datasets).
        </P>

        <P>Total from Phase 1: roughly 16,600 actual vulnerability reports with varying label quality.</P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Phase 2: The Reference Corpus</SectionHeading>

        <P>
          Next we pulled from every structured vulnerability database we could access: NVD (179,548 CVEs via the 2.0 REST API in 2,000-entry batches), OSV across 25 ecosystems (~134,000 advisories via Google Cloud Storage bulk downloads), ExploitDB (31,061 from the GitLab mirror), MSRC (21,641 via CVRF/CSAF API), plus Red Hat CSAF, CERT/CC, ZDI, CISA, and GHSA.
        </P>

        <P>
          The corpus hit <Bold>437,000 entries</Bold>. But here's the thing &mdash; only <Bold>~18,847</Bold> of those are actual vulnerability <em>reports</em>, the kind a security researcher writes and submits to a bug bounty platform. The other ~420,000 are reference data: vendor advisories, CVE summaries, exploit code, patch notes. A vendor advisory saying "Microsoft addresses a remote code execution vulnerability in Windows DNS Server" isn't a vulnerability report &mdash; it's a patch announcement.
        </P>

        <P>
          That reference data is still essential. The Exploit Maturity Assessor needs ExploitDB. The Product/Vendor KB needs NVD and MSRC. The CWE Coherence Checker needs the full NVD corpus. But we learned early to keep these categories separate: <Bold>"How many entries match your actual training objective?"</Bold> is a better question than <Bold>"How many entries do you have?"</Bold>
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Phase 3: The AI Slop Problem</SectionHeading>

        <P>
          Here's the uncomfortable reality that VulnRap exists to address: bug bounty platforms are drowning in AI-generated reports. Bugcrowd reported a 334% increase in submission queues. HackerOne received over 1,100 submissions from a single automated "hackbot" actor. Daniel Stenberg published a gist documenting 24 AI-generated reports so bad he shut down curl's bug bounty entirely.
        </P>

        <P>
          We collected those 24 confirmed samples along with 234 more from public disclosures and post-mortems. Total: <Bold>258 real-world confirmed AI slop examples.</Bold> That's not enough for ML on its own, so we generated <Bold>2,000 synthetic samples</Bold> across four tiers: T1 (obvious template slop), T2 (mentions real products but hallucinates versions), T3 (references real CVEs with plausible steps but fabricated claims), and T4 &mdash; genuine vulnerability research where AI improved the writing.
        </P>

        <P>
          T4 is the one that keeps us up at night. A skilled researcher who uses AI to clean up their technical writing is not submitting a fake report. The vulnerability is real. The claim is verifiable. But the prose will look AI-assisted because it is. Any system that penalizes AI writing style as a proxy for invalidity will systematically disadvantage non-native English speakers and researchers who use writing tools. This is why VulnRap produces an <em>AI Likelihood</em> score separately from a <em>Validity</em> score &mdash; they measure different things.
        </P>

        <P>
          We know the synthetic data is a temporary crutch &mdash; real-world slop patterns are more creative and adaptive than our four tiers. But 258 confirmed samples plus 2,000 synthetic is the best starting point we could build from public data, and it gives every engine something to calibrate against while we work on getting more real examples.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Phase 4: Hunting for Report Narratives</SectionHeading>

        <P>
          With the reference corpus solid, we pivoted to the data type we actually needed most: actual report narratives &mdash; security researchers writing up real vulnerabilities in their own words.
        </P>

        <P>This phase turned out to be the most productive and most surprising part of the project.</P>

        <P>
          <Bold>Pentester Land</Bold> maintains a JSON-downloadable index of <Bold>6,421 curated bug bounty writeups</Bold> spanning 1,213 programs and 670 distinct bug types &mdash; a community resource running since 2017. <Bold>Awesome-Bugbounty-Writeups</Bold> on GitHub added <Bold>601 categorized writeup links</Bold>. <Bold>Google VRP Writeups</Bold> contributed <Bold>268 curated reports</Bold> with disclosed bounty amounts. <Bold>Immunefi web3 writeups</Bold> added <Bold>147 blockchain and DeFi vulnerability report URLs</Bold> &mdash; a category with zero overlap with CVE databases, where some reports earned $1M+ bounties.
        </P>

        <P>
          The surprise was <Bold>CERT/CC's Vulnerability Data Archive</Bold> &mdash; 66,673 files across decades of vulnerability tracking, of which <Bold>4,675</Bold> contain substantial narrative content written by human analysts. Expert-written vulnerability documentation from one of the oldest CSIRTs in the world.
        </P>

        <P>
          We also pulled <Bold>Mozilla Bugzilla security bugs</Bold> (9,480 spanning 2000&ndash;2026), <Bold>Chromium Security Bugs</Bold> (2,278 via fragile browser automation of Google Issue Tracker &mdash; no public API exists), and <Bold>Google Project Zero issues</Bold> (2,264 via Buganizer redirect mapping &mdash; the hardest extraction of the project, requiring redirect chain following and JSPB protocol parsing). We enriched <Bold>1,494 ZDI advisories</Bold> with disclosure timeline data: median 128 days to disclosure, 20.7% zero-days.
        </P>

        <P>
          After deduplicating across all writeup sources, we had <Bold>6,401 unique writeup URLs</Bold>. We visited <Bold>756 of them</Bold> to extract actual report text. Success rate: <Bold>92% (693 usable narratives)</Bold>. The 8% failure rate was mostly dead links &mdash; Medium articles deleted by their authors, personal blogs that went offline. The 693 narratives had a median text length of <Bold>2,493 characters</Bold>, compared to 200 for a typical NVD description. Rich, detailed, structured the way a researcher naturally writes.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Phase 5: Timestamp Enrichment</SectionHeading>

        <P>
          Submission timing is a real signal: coordinated slop campaigns show volume spikes; time-to-disclosure distributions differ between valid and invalid paths. We re-fetched the HackerOne dataset specifically to get <Code>disclosed_at</Code> timestamps &mdash; <Bold>median 71 days, mean 184 days</Bold> to disclosure, with heavy right skew. The ZDI timeline data confirmed this pattern from the vendor side.
        </P>

        <P>
          The timestamp situation across sources is, to put it charitably, heterogeneous. HackerOne: millisecond precision. NVD: full ISO 8601. ExploitDB: date-only. Many OSV entries: publication date only. A significant chunk: no timestamp at all. We didn't solve this problem. We documented it and moved on.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Two Things the Data Made Obvious</SectionHeading>

        <P>
          Before we get to the signal analysis, two patterns in the dataset are worth calling out because they shaped everything that came after.
        </P>

        <P>
          <Bold>The class imbalance is severe.</Bold> The validity breakdown across the full corpus: 407,396 valid/accepted (88.5%), 23,180 invalid/rejected/spam (5.0%), 30,014 unlabeled/ambiguous (6.5%). That's roughly a 17.5:1 ratio. In real-world PSIRT triage queues post-AI-slop-era, it's closer to 2:1 or 3:1. Public sources are publication-biased &mdash; rejected reports almost never become public. An arXiv paper (2511.18608) confirmed this problem independently: LLMs tested on 9,942 HackerOne reports consistently over-accept, with strong bias toward predicting "valid" regardless of quality. Their best result came from taxonomy-based RAG, not direct LLM judgment &mdash; which validates our multi-engine approach.
        </P>

        <P>
          <Bold>Style-based detection has a hard ceiling.</Bold> We hit it at <Bold>31.7% recall</Bold> with 8,608 weighted n-grams. Bounty-paid reports scored 21.3 on average; rejected reports scored 20.3 &mdash; a 1-point difference on a 0&ndash;100 scale. That's noise, not a classifier. The reason is straightforward: a well-written AI-generated report about a real vulnerability can be grammatically indistinguishable from a human-written one. The tell isn't the prose &mdash; it's whether the claims are true.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What We Found When We Actually Analyzed the Data</SectionHeading>

        <P>
          We ran 1,554 labeled reports (621 expert-written bounty-paid, 204 confirmed AI slop, plus lower-quality tiers) through the design spec's signal extraction. Our theoretical signal ratios &mdash; computed against a hypothetical 437K-entry corpus &mdash; met reality.
        </P>

        <P>Some of them survived. Most didn't.</P>

        <ChartImage
          src={specVsRealitySrc}
          title="Design Spec vs. Reality"
          subtitle="Most predicted signal ratios collapsed against curated data — only executive summaries and sentence-length variability survived contact with the real corpus."
          alt="Bar chart comparing predicted signal ratios from the design spec against measured ratios from real labeled data, showing most predicted signals failed"
        />

        <SubHeading>What the design spec predicted vs. what we measured</SubHeading>

        <DataTable
          headers={["Signal", "Predicted Ratio", "Measured Ratio", "Verdict"]}
          rows={[
            ["Executive summaries", "—", "AI: 15.2%, Human: 0%", <Bold key="ok1">Confirmed strong</Bold>],
            ["Sentence length CV", "—", "AI: 0.71, Human: 0.84", <Bold key="ok2">Directionally correct</Bold>],
            ["Placeholder URLs", "14x", "2x", "Real but weaker"],
            ["Section headers", "3.8x", "1.2x", <Bold key="f1">Failed</Bold>],
            ["Filler phrases", "36x", "~1x", <Bold key="f2">Failed</Bold>],
            ["Hedging language", "28x", "~1x", <Bold key="f3">Failed</Bold>],
            ["Numbered steps", "2.9x", "0.9x (inverted)", <Bold key="f4">Failed</Bold>],
          ]}
        />

        <P>
          The explanation is important: our curated dataset is enriched for expert-quality reports. When you hand-select 621 detailed, bounty-paid HackerOne reports, they look structurally similar to AI slop &mdash; lots of headers, numbered steps, professional prose. The spec's ratios were computed against the full population, which is dominated by short, informal submissions. The raw 10,094-report HackerOne feed averages 1.51 section headers per report. Our curated human_quality subset averages 4.88. AI slop: 4.55.
        </P>

        <P>
          Signals that separate AI slop from <em>average</em> reports are useless for the actual problem &mdash; because the reports that need the most scrutiny look exactly like the reports that deserve the most trust.
        </P>

        <P>So we looked for signals that work at the top of the quality distribution.</P>

        <SubHeading>What a triager actually sees in 30 seconds</SubHeading>

        <DataTable
          headers={["Signal", "Expert Reports", "AI Slop", "Ratio"]}
          rows={[
            ["Claim-to-evidence ratio", "0.27", "0.03", <Bold key="r1">9.0x</Bold>],
            ["Specific API endpoints", "4.08/report", "0.46/report", <Bold key="r2">8.9x</Bold>],
            ["Real URLs", "8.54/report", "1.12/report", <Bold key="r3">7.6x</Bold>],
            ["Line numbers cited", "8.50/report", "1.42/report", <Bold key="r4">6.0x</Bold>],
            ["File paths mentioned", "13.91/report", "3.38/report", <Bold key="r5">4.1x</Bold>],
            ["Environment details", "1.38/report", "0.33/report", <Bold key="r6">4.2x</Bold>],
            ["Generic remediation language", "1%", "22%", <Bold key="r7">22x</Bold>],
          ]}
        />

        <P>
          <Bold>The claim-to-evidence ratio is the strongest composite discriminator.</Bold> Expert reports make claims and back them up. AI slop makes claims and moves on.
        </P>

        <P>And then the inversions &mdash; the signals where AI slop has <em>more</em> than expert reports:</P>

        <DataTable
          headers={["Signal", "Expert", "AI Slop", "What It Means"]}
          rows={[
            ["Function references", "21.03", "26.25", "Hallucination — more names, fewer real"],
            ["Memory addresses", "2.70", "4.71", "Fabricated crash output"],
            ["Structural completeness", "3.49/6", "4.12/6", "Over-structured = suspicious"],
            ["Executable commands", "35%", "58%", "Over-claiming without evidence"],
          ]}
        />

        <P>
          More function names and memory addresses, but fewer real endpoints and line numbers. That's the hallucination signature: quantity without verifiability. And over-completeness &mdash; hitting every section of a perfect template &mdash; is itself a signal.
        </P>

        <ChartImage
          src={signalStrengthSrc}
          title="Signal Discriminator Strength"
          subtitle="Evidence-based signals dominate. Style-based signals fail at the top of the quality distribution where it matters most."
          alt="Horizontal bar chart ranking discriminator strength of signals; evidence-based signals like claim-to-evidence ratio, real URLs, and line numbers dominate the top of the chart"
        />

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What the Dataset Looks Like Now</SectionHeading>

        <P>
          Here's an honest accounting of the final corpus &mdash; <Bold>460,590 entries across 56 sources</Bold>, built over the course of a week using AI-agent-driven automation:
        </P>

        <DataTable
          headers={["Category", "Count", "Role"]}
          rows={[
            [<Bold key="t">Total entries</Bold>, "460,590", "Full corpus"],
            ["HackerOne reports", "13,831", "Primary benchmark — triage labels, full metadata"],
            ["Mozilla Bugzilla", "9,480", "Expert bug reports with timestamps, severity, resolution"],
            ["Chromium Security Bugs", "2,278", "Browser security bugs via Buganizer automation"],
            ["Google Project Zero", "2,264", "Elite root-cause analyses (75% have CVE IDs)"],
            ["CERT/CC vulnerability notes", "4,675", "Expert narratives with structured fields"],
            ["ZDI enriched", "1,494", "Coordinated disclosure timelines (20.7% zero-days)"],
            ["Curated writeup narratives", "693", "From 6,401 URLs (Pentester Land, Immunefi, Google VRP, etc.)"],
            ["Kaggle Bug Bounty Writeups", "11,973", "Community-curated writeup collection"],
            ["Huntr AI/ML", "1,856", "Emerging AI/ML attack surface"],
            ["Bugcrowd CrowdStream", "892", "Platform triage signal"],
            ["NVD CVEs", "179,548", "Reference — CWE/product/version KB"],
            ["NVD Rejected", "17,459", "Critical negative examples"],
            ["OSV ecosystems", "~134,000", "Reference — 25 package ecosystems"],
            ["ExploitDB", "31,061", "Reference — exploit maturity"],
            ["MSRC", "21,641", "Reference — enterprise patching"],
            ["Other reference", "~24,000", "Red Hat, CISA, ZDI bulk, GHSA, Cisco"],
            ["Synthetic AI slop", "2,180", "Training negatives (4 tiers + confirmed samples)"],
          ]}
        />

        <ChartImage
          src={datasetCompositionSrc}
          title="Dataset Composition"
          subtitle="460K entries across reports, reference, and synthetic data — a roughly 20:1 ratio of reference to actual report training data, by design."
          alt="Stacked composition chart of the 460,590-entry corpus broken down by category: reports, reference data, and synthetic data"
        />

        <P>
          The ratio of reference data to actual report training data is roughly 20:1. That ratio is by design &mdash; each engine type has different data requirements, and the reference corpus feeds engines that need product knowledge, CWE mappings, and exploit maturity data.
        </P>

        <P>
          One thing changed dramatically between our first and second pass: <Bold>text coverage.</Bold> The v1 corpus had full vulnerability text for only 4.5% of entries (20,936 reports). After the agent re-extracted text from every source, v2 has text for <Bold>99% of entries</Bold> &mdash; 455,856 entries with vulnerability text over 50 characters, totaling 389 million characters. That's the difference between NLP on a sample and NLP on the whole corpus.
        </P>

        <ChartImage
          src={textCoverageSrc}
          title="Text Coverage: v1 vs. v2"
          subtitle="From 4.5% to 99% — a re-extraction pass turned a sample into a whole-corpus dataset."
          alt="Comparison chart showing v1 corpus text coverage at 4.5 percent versus v2 at 99 percent, highlighting the order-of-magnitude jump in usable narrative content"
        />

        <P>
          Every count in the table above is verifiable against our published data dictionary (<Code>vulnrap_unified_corpus_v2_DATA_DICTIONARY.md</Code>) and provenance documentation, which includes the acquisition method, API endpoint or scraping approach, and reproducibility assessment for all 56 sources. We're publishing these alongside the dataset so anyone can audit the numbers or reproduce the collection.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>How This Was Actually Built</SectionHeading>

        <P>This is the part that's different from what a traditional security team would do.</P>

        <P>
          The entire corpus was assembled using AI agents &mdash; Perplexity Computer doing web scraping, REST API calls, and browser automation. No human directly called an API, wrote a scraper, or manually downloaded a file. The agent researched sources, wrote and executed collection scripts, iterated on failures, and made judgment calls that we reviewed.
        </P>

        <P>
          For sources with stable APIs (NVD, HackerOne, OSV, MSRC), this was straightforward. For sources without APIs, it got creative. Bugcrowd CrowdStream: paginated DOM navigation because no API exists. Chromium security bugs: reverse-engineering Buganizer's pagination and dynamically loaded metadata. Project Zero: mapping old Monorail IDs through redirect chains to new Buganizer IDs, then extracting JSPB-encoded data from action endpoints. ZDI timelines: individual advisory page scraping to get vendor-reported and public-release dates.
        </P>

        <P>
          What didn't work: HackerOne rate-limited after ~200 individual page requests (pivot to GraphQL). SecurityFocus/BugTraq is offline and Wayback copies are incomplete. Intigriti and YesWeHack are dead ends &mdash; no bulk access. Vendor PSIRTs beyond MSRC and Cisco require partnership agreements. 5,645 writeup URLs remain unfetched due to Medium paywalls, deleted blogs, and Cloudflare blocks.
        </P>

        <P>
          It's worth noting the irony: VulnRap's entire thesis is about detecting AI involvement in vulnerability reports, and the training dataset was built with heavy AI assistance. We believe this is a feature, not a bug. The agent's role was collection and engineering, not labeling or judgment about vulnerability validity. The ground-truth labels come from the sources themselves &mdash; HackerOne's triage decisions, NVD's acceptance/rejection, Project Zero's bug status.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Competitive Landscape</SectionHeading>

        <P>Nothing exactly like VulnRap exists publicly.</P>

        <P>
          <Bold>HackerOne Hai Triage</Bold> is an internal AI triage system trained on proprietary data &mdash; including rejected reports we'll never access. Not available as a service. <Bold>Bugcrowd's AI Triage Assistant</Bold> claims 98% duplicate detection confidence. Also internal, also proprietary. <Bold>EPSS</Bold> predicts exploitation probability for existing CVEs &mdash; a different problem than evaluating whether a submitted report describes a real vulnerability. <Bold>BugWrite</Bold> helps researchers write better reports &mdash; complementary, and a well-written AI-assisted report is the exact T4 case we're trying to handle gracefully. <Bold>Shannon AI</Bold> generates bug bounty reports from vulnerability descriptions &mdash; exactly what the AI Authorship Detector is calibrated against.
        </P>

        <P>
          The closest academic work is arXiv paper 2511.18608: 9,942 HackerOne reports, validity prediction. Key finding: LLMs over-accept (strong bias toward "valid" regardless of quality), and taxonomy-based RAG outperforms direct LLM judgment. Their result validates our multi-engine philosophy &mdash; a single model isn't robust enough.
        </P>

        <P>
          VulnRap's differentiators are the multi-engine architecture (eleven independent assessments vs. one LLM call), active claim verification, the separation of AI Likelihood from Validity, and the design as a public service rather than an internal triage tool.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What We'd Tell Someone Starting This Tomorrow</SectionHeading>

        <P>
          <Bold>Start with your training objective, then collect data.</Bold> We collected first. It would have saved time to define "what does each engine actually need?" before writing a single scraper.
        </P>

        <P>
          <Bold>Reference data and training data serve different purposes.</Bold> 179K NVD CVEs are essential for feature engineering and lookup tables. They're not training examples for a report validity classifier. Keep the categories clear from the start.
        </P>

        <P>
          <Bold>The class you care about most is the hardest to collect.</Bold> Invalid reports are rare in public datasets by design &mdash; rejected reports almost never get published. Budget time for this specifically.
        </P>

        <P>
          <Bold>Timestamps are a real signal.</Bold> Coordinated slop campaigns show volume spikes. Time-to-disclosure distributions differ between valid and invalid paths. Build timestamp requirements into your collection from the start.
        </P>

        <P>
          <Bold>Active verification beats linguistic analysis.</Bold> 31.7% recall on style-based detection tells you something. Verification engines that check external ground truth will outperform linguistic pattern matching on the hard cases.
        </P>

        <P>
          <Bold>Bug bounty writeups are underexploited.</Bold> Thousands of curated, technically detailed reports are publicly available. If you're building anything in the bug bounty adjacent space, Pentester Land's JSON index, Immunefi's writeup collection, and Google VRP disclosures should be in your dataset.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What's Next: Eleven Engines, Evidence Over Style</SectionHeading>

        <P>
          The raw collection phase is reaching diminishing returns. Every obvious source is in the corpus. The next phases are about using this data to build something the formula never could.
        </P>

        <P>
          The eleven-engine architecture weights evidence over style. Technical Substance Analyzer (22%) and Claim Verifier (20%) together account for 42% of the composite score. AI Authorship Detector accounts for 2%. That's deliberate &mdash; because a well-written AI-assisted report about a real vulnerability should score well on evidence and poorly on authorship, and the evidence should win. The T4 problem demands it.
        </P>

        <P>
          Phase 1 ships in 90 days: Technical Substance, CWE Coherence, and the Linguistic Baseline Profiler &mdash; calibrated against the actual signal ratios from our data analysis, not the theoretical ratios from the design spec. Success criteria: the same 12 curl reports that scored 0%. All 8 confirmed slop must score &le;35 on the composite. All 3 legitimate reports must score &ge;55. If we can't beat 0% on our test set, the entire architecture is wrong.
        </P>

        <P>
          Phase 2 (months 4&ndash;8) adds reporter profiles, similarity detection, and the product knowledge base &mdash; when VulnRap starts remembering across submissions. Phase 3 (months 9&ndash;14) brings the Claim Verifier &mdash; the engine we're most excited about and the one we've built the least of. Verifying that a named function exists in the claimed version of a codebase requires API calls to GitHub, package registries, NVD. It's operationally complex. But a report claiming a buffer overflow in <Code>curl_easy_perform()</Code> at line 423 of <Code>lib/easy.c</Code> can be verified programmatically, and that verification is infinitely more signal than any linguistic pattern.
        </P>

        <P>
          Before we write a single line of engine code, we're running a regression baseline: the same 12 curl reports, the same 1,554 labeled dataset, scored by the current system. We want to know exactly how much better the new engines perform against a fixed benchmark. The next post in this series will report whether our predictions held up &mdash; or didn't.
        </P>

        <P>
          The goal isn't 500K entries. It's 500 correctly labeled hard cases, a defensible evaluation methodology, and engines that can do what linguistic pattern matching can't.
        </P>
      </div>

      <Separator className="bg-border/50" />

      <div className="text-center text-xs text-muted-foreground/70 italic">
        <p>
          VulnRap is built by REMEDiS Security. This is part of our ongoing sprint series documenting the real engineering work behind the product. If you're working on adjacent problems in security ML &mdash; dataset construction, triage automation, report quality assessment &mdash; we'd like to compare notes. Source on{" "}
          <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>.
        </p>
      </div>
    </article>
  );
}
