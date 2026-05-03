import {
  BookOpen,
  Calendar,
  ArrowRight,
  Users,
  Zap,
  Shield,
  Bug,
  Heart,
  Rss,
} from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import logoSrc from "@/assets/logo.png";
import firstPostHeroImg from "@/assets/blog-first-post-hero.png";
import { BlogBuildingVulnrap } from "@/components/blog-building-vulnrap";
import { BlogGradingAi } from "@/components/blog-grading-ai";
import { BlogDataIsThere } from "@/components/blog-data-is-there";
import { BlogZeroDetection } from "@/components/blog-zero-detection";
import { BlogFieldTestV350 } from "@/components/blog-field-test-v350";
import { BlogAvriSprint11 } from "@/components/blog-avri-sprint11";
import { BlogSubstanceGate } from "@/components/blog-substance-gate";
import { BlogSprint14Rigor } from "@/components/blog-sprint14-rigor";
import { BlogUpdate9ShowOurWork } from "@/components/blog-update9-show-our-work";
import { BlogUpdate10ByoFixtures } from "@/components/blog-update10-byo-fixtures";
import { BlogUpdate13McpLaunch } from "@/components/blog-update13-mcp-launch";

function FirstPost() {
  return (
    <article className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge
            variant="outline"
            className="border-primary/30 text-primary text-[10px]"
          >
            Launch
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> April 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          We Built the Tool We Wished Existed
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Why we created VulnRap, how it helps with triage, and why you should
          feel comfortable using it.
        </p>
      </div>

      <Separator className="bg-border/50" />

      <figure className="my-2">
        <img
          src={firstPostHeroImg}
          alt="A cascade of vulnerability reports streaming through a tall glowing prism that splits them into a clean stream of authentic reports and a dim stream of duplicate AI slop dissolving into pixels"
          loading="lazy"
          className="w-full rounded-lg border border-border/50 shadow-lg shadow-black/30"
        />
        <figcaption className="mt-2 text-xs text-muted-foreground/80 italic text-center">
          The tool we wished existed: a lens that separates real reports from
          the slop and duplicates.
        </figcaption>
      </figure>

      <div className="prose-invert space-y-6 text-sm leading-relaxed text-muted-foreground">
        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Bug className="w-4 h-4 text-primary" />
            The Problem
          </h3>
          <p>
            If you work in PSIRT, run a VDP, or manage a vulnerability program,
            you already know the pain. Your inbox is a mix of legitimate
            vulnerability reports, near-identical duplicates, and an increasing
            volume of reports that read like someone asked an AI to "write a
            critical vulnerability report about SQL injection" and submitted
            whatever came out.
          </p>
          <p>
            The AI-generated reports are the worst part. They are just plausible
            enough to require reading, but they waste your time because the
            submitter never actually found a vulnerability — they described a
            theoretical one. You read three paragraphs of "It is important to
            note that SQL injection vulnerabilities can have devastating
            consequences" before you realize there are no reproduction steps, no
            version numbers, and no proof of concept.
          </p>
          <p>
            Duplicates are the second problem. Someone finds a real bug, writes
            a solid report, and submits it. Then four more people find the same
            bug and submit slightly different versions of the same report. Your
            team reads all five, realizes they are the same thing, and closes
            four of them. Everyone wasted time.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            What We Built
          </h3>
          <p>VulnRap does two things well:</p>
          <p>
            <strong className="text-foreground">
              1. Report Validity Scoring.
            </strong>{" "}
            We run a multi-axis scoring system on every report to assess whether
            it describes a real, reproducible issue. Four independent axes —
            factual verification, linguistic analysis, LLM semantic analysis,
            and template detection — are fused via Bayesian combination into a
            single score. Factual verification checks whether the function
            names, file paths, CVE IDs, and code references in the report
            actually exist in the claimed project. The linguistic axis catches
            patterns common in fabricated reports. When available, the LLM
            evaluates specificity, originality, voice, coherence, and
            hallucination. A separate qualityScore measures report completeness
            independently. The result is a 0-100 score with a confidence
            indicator. Reports scoring low show strong evidence of verifiable
            claims. Reports scoring high have multiple indicators of fabricated
            or templated content.
          </p>
          <p>
            <strong className="text-foreground">
              2. Similarity Detection.
            </strong>{" "}
            We fingerprint every report using MinHash (Jaccard similarity
            estimation), SimHash (structural fingerprinting), and SHA-256
            hashing at both the document and section level. When you submit a
            report, we compare it against everything in the database. If your
            "Steps to Reproduce" section is identical to someone else's, we flag
            it — even if the rest of the report is different.
          </p>
          <p>
            Before any of this happens, we auto-redact PII, secrets, API keys,
            credentials, and identifying information. The raw text never touches
            the database. Only the redacted version is stored and compared.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Why You Should Trust It
          </h3>
          <p>
            We get it — the security community should be skeptical of tools that
            ask you to upload vulnerability reports. Here is why VulnRap is
            different:
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li>
              <strong className="text-foreground">No accounts.</strong> We do
              not know who you are. There are no user accounts, no email
              collection, no tracking cookies, no analytics. We literally could
              not identify you if we wanted to.
            </li>
            <li>
              <strong className="text-foreground">Auto-redaction first.</strong>{" "}
              Before anything is stored, we strip emails, IPs, API keys,
              credentials, phone numbers, company names, and other identifying
              information. The redaction engine uses deterministic regex
              patterns — same input always produces the same output.
            </li>
            <li>
              <strong className="text-foreground">Privacy modes.</strong> If you
              do not want even the redacted text stored, use "Keep it private"
              mode. We will only store mathematical fingerprints — enough for
              similarity comparison, but no text at all.
            </li>
            <li>
              <strong className="text-foreground">Open source.</strong> The
              entire codebase is{" "}
              <a
                href="https://github.com/REMEDiSSecurity/VulnRap.Com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                public on GitHub
              </a>
              . You can read the redaction patterns, the hashing algorithms, the
              slop detection heuristics, and the database schema. There is
              nothing hidden.
            </li>
            <li>
              <strong className="text-foreground">No business model.</strong>{" "}
              VulnRap is funded directly by REMEDiS Security and COMPLiTT
              because we use it ourselves. There are no investors, no ad
              revenue, no data monetization. If we can not keep funding it, the
              code is{" "}
              <a
                href="https://github.com/REMEDiSSecurity/VulnRap.Com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                open source
              </a>{" "}
              and someone else can run it.
            </li>
          </ul>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            Nothing Like This Exists Yet
          </h3>
          <p>
            We looked. There are plagiarism detectors (built for academic
            papers), AI content detectors (built for essays and blog posts), and
            code similarity tools (built for source code). None of them
            understand what a vulnerability report is supposed to look like.
          </p>
          <p>
            A plagiarism detector will tell you that two XSS reports are
            "similar" because they both mention{" "}
            <code className="text-primary font-mono text-xs">
              document.cookie
            </code>
            . That is not useful. VulnRap understands the structure of
            vulnerability reports — it knows that "Steps to Reproduce" sections
            should be unique, that "Impact" sections might reasonably overlap,
            and that technical terms are not plagiarism.
          </p>
          <p>
            An AI content detector trained on essays does not know that "The
            application fails to properly sanitize user input" is a perfectly
            normal thing for a human to write in a vulnerability report.
            VulnRap's slop detection is tuned specifically for vulnerability
            reports. It flags the filler, not the technical language.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Heart className="w-4 h-4 text-red-400" />
            How You Can Help
          </h3>
          <p>
            VulnRap only works if teams use it. The similarity detection gets
            better with every report in the database. If you run a PSIRT or
            triage team, use the Check page on incoming reports or integrate the
            API into your intake pipeline. Every report analyzed makes the
            system more useful for the entire community.
          </p>
          <p>
            If you are a developer, the{" "}
            <a
              href="https://github.com/REMEDiSSecurity/VulnRap.Com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              project is open source
            </a>{" "}
            and we welcome contributions. The validation heuristics can always
            be improved, the redaction patterns can always catch more edge
            cases, and the section parser can always handle more report formats.
          </p>
          <p>
            If you find a security vulnerability in VulnRap itself, please{" "}
            <Link to="/security" className="text-primary hover:underline">
              report it responsibly
            </Link>
            . We are security people — we will take it seriously and fix it
            quickly.
          </p>
        </div>
      </div>

      <Separator className="bg-border/50" />

      <div className="flex items-center gap-3">
        <img src={logoSrc} alt="" className="w-8 h-8 rounded-sm" />
        <div className="text-xs text-muted-foreground">
          <p className="text-foreground font-medium">The VulnRap Team</p>
          <p>
            Built by{" "}
            <a
              href="https://remedissecurity.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              REMEDiS Security
            </a>{" "}
            and{" "}
            <a
              href="https://complitt.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              COMPLiTT
            </a>
          </p>
        </div>
      </div>
    </article>
  );
}

export default function Blog() {
  // Task #712 — auto-discovery <link> for the Atom feed at /blog/feed.xml.
  // Mutates document.head directly (no react-helmet) to match the pattern
  // used by results.tsx for OG tags. Cleans up on unmount so other pages
  // do not advertise a feed they do not own.
  useEffect(() => {
    const selector =
      'link[rel="alternate"][type="application/atom+xml"][data-blog-feed="1"]';
    let el = document.head.querySelector<HTMLLinkElement>(selector);
    if (!el) {
      el = document.createElement("link");
      el.rel = "alternate";
      el.type = "application/atom+xml";
      el.setAttribute("data-blog-feed", "1");
      document.head.appendChild(el);
    }
    el.title = "VulnRap Blog";
    el.href = "/blog/feed.xml";
    return () => {
      const existing = document.head.querySelector<HTMLLinkElement>(selector);
      if (existing) existing.remove();
    };
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-primary" />
          Blog
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Updates, technical deep-dives, and the occasional rant about
          vulnerability report quality.
        </p>
        <p className="text-xs text-muted-foreground mt-3">
          <a
            href="/blog/feed.xml"
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
          >
            <Rss className="w-3.5 h-3.5" />
            Subscribe via Atom feed
          </a>
        </p>
      </div>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogUpdate13McpLaunch />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogUpdate10ByoFixtures />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogUpdate9ShowOurWork />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogSprint14Rigor />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogSubstanceGate />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogAvriSprint11 />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogFieldTestV350 />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogZeroDetection />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogDataIsThere />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogGradingAi />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <BlogBuildingVulnrap />
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <FirstPost />
        </CardContent>
      </Card>

      <div className="text-center text-xs text-muted-foreground/50 pb-4">
        <p>
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Follow the project on GitHub
          </a>{" "}
          to stay updated.
        </p>
      </div>
    </div>
  );
}
