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
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import logoSrc from "@/assets/logo.png";
import firstPostHeroImg from "@/assets/blog-first-post-hero.png";

interface BlogIndexEntry {
  slug: string;
  title: string;
  date: string;
  summary: string;
  badge?: string;
  badgeClass?: string;
}

const posts: BlogIndexEntry[] = [
  {
    slug: "update14-deploy-fix",
    title:
      "60 Seconds of Silence: What the Production Startup Hang Taught Us",
    date: "2026-05-08",
    summary:
      "Update #14 — Every deploy was hanging silently for 60 seconds before being killed with nothing in the logs. The root cause, what the production DB confirmed, and the two-line fix.",
    badge: "Update #14",
    badgeClass: "border-yellow-500/30 text-yellow-300",
  },
  {
    slug: "update13-mcp-launch",
    title: "VulnRap Now Speaks MCP: Triage From Inside Your Agent",
    date: "2026-05-15",
    summary:
      "Update #13 — VulnRap exposes its scoring, similarity, and diagnostics tooling over the Model Context Protocol so agents like Claude Desktop can triage reports without leaving the chat.",
    badge: "Update #13",
    badgeClass: "border-emerald-500/30 text-emerald-300",
  },
  {
    slug: "engine-deep-dives",
    title: "Under the Hood: Introducing the VulnRap Engine Deep-Dive Series",
    date: "2026-05-10",
    summary:
      "Update #11 — A guided tour through each scoring engine: what it measures, how it votes, and where the boundaries are.",
    badge: "Update #11",
    badgeClass: "border-amber-500/30 text-amber-300",
  },
  {
    slug: "byo-fixtures",
    title: "Bring Your Own Fixtures: Validating VulnRap Against Your Corpus",
    date: "2026-05-08",
    summary:
      "Update #10 — Run VulnRap's scoring pipeline against your own labelled reports and compare precision/recall on your data.",
    badge: "Update #10",
    badgeClass: "border-violet-500/30 text-violet-300",
  },
  {
    slug: "show-our-work",
    title: "Showing Our Work: Per-Signal Precision/Recall in the UI",
    date: "2026-05-06",
    summary:
      "Update #9 — Every signal now surfaces its own precision and recall numbers so you can see exactly which detectors pull their weight.",
    badge: "Update #9",
    badgeClass: "border-violet-500/30 text-violet-300",
  },
  {
    slug: "sprint14-rigor",
    title: "Three Ways Slop Hid This Sprint (And How the Audit Caught Them)",
    date: "2026-05-02",
    summary:
      "Sprint 14 — Three classes of slop slipped past the scorer this sprint. Here is how the disagreement-floor audit, response-body strip-and-retest, and ARM64 register-dump detector pulled them back into the red zone.",
    badge: "Sprint 14",
    badgeClass: "border-sky-500/30 text-sky-300",
  },
  {
    slug: "substance-gate-sprint12",
    title:
      "Closing the Slop Gap: Engine 3 Now Cross-Checks Engine 2 Before It Votes",
    date: "2026-04-25",
    summary:
      "Sprint 12 — The substance LLM now refuses to outvote the heuristic on evidence-free reports.",
    badge: "Sprint 12",
    badgeClass: "border-sky-500/30 text-sky-300",
  },
  {
    slug: "avri-sprint11",
    title:
      "AVRI: One Rubric Wasn't Enough — Why v3.7.0 Scores Memory Bugs and XSS Slop on Different Yardsticks",
    date: "2026-04-18",
    summary:
      "Sprint 11 — The Adversarial Vulnerability Report Index splits scoring by family so a memory-corruption report and an XSS report no longer share the same gold-signal yardstick.",
    badge: "Sprint 11",
    badgeClass: "border-sky-500/30 text-sky-300",
  },
  {
    slug: "field-test-v350",
    title:
      "v3.5.0 Field Test: Three Engines, Seven Reports, and a Ceiling We Didn't Expect",
    date: "2026-04-11",
    summary:
      "Field test of v3.5.0 across seven real-world reports surfaced a scoring ceiling we did not predict. What the three engines agreed on, where they disagreed, and what the next sprint changes.",
    badge: "Field Test",
    badgeClass: "border-orange-500/30 text-orange-300",
  },
  {
    slug: "zero-detection",
    title: "460K Vulnerability Reports, 56 Sources, and a 0% Detection Rate",
    date: "2026-04-04",
    summary:
      "The week we built the most diverse vulnerability report dataset we could find, ran our scoring system against it, and watched it score AI slop and real CVEs identically.",
    badge: "Deep Dive",
    badgeClass: "border-rose-500/30 text-rose-300",
  },
  {
    slug: "the-data-is-there",
    title: "The Data Is There, the Score Isn't Listening",
    date: "2026-03-28",
    summary:
      "Sprint 8 results: the pipeline finally works, substance detection is live, and the scoring formula mathematically cannot use it.",
    badge: "Sprint 8",
    badgeClass: "border-sky-500/30 text-sky-300",
  },
  {
    slug: "grading-ai-with-ai",
    title:
      "Grading AI with AI: What We Learned When Our Detection Model Met the Real World",
    date: "2026-03-21",
    summary:
      "Six development sprints, a 20% real-world detection rate, and the fundamental rethinking that led us from style detection to substance verification.",
    badge: "Deep Dive",
    badgeClass: "border-rose-500/30 text-rose-300",
  },
  {
    slug: "building-vulnrap",
    title:
      "Building VulnRap: How We're Making Vulnerability Report Validation Actually Work for PSIRT Teams",
    date: "2026-03-14",
    summary:
      "A detailed walkthrough of four development sprints, what we built, what we learned, what works, and what's coming next.",
    badge: "Deep Dive",
    badgeClass: "border-rose-500/30 text-rose-300",
  },
  {
    slug: "first-post",
    title: "We Built the Tool We Wished Existed",
    date: "2026-03-07",
    summary:
      "Why we created VulnRap, how it helps with triage, and why you should feel comfortable using it.",
    badge: "Launch",
    badgeClass: "border-primary/30 text-primary",
  },
];

function formatDate(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function FirstPost() {
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

      <div className="space-y-4">
        {posts.map((post) => (
          <Link key={post.slug} to={`/blog/${post.slug}`} className="block group">
            <Card className="glass-card rounded-xl transition-colors group-hover:border-primary/40">
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      {post.badge && (
                        <Badge
                          variant="outline"
                          className={`${post.badgeClass} text-[10px]`}
                        >
                          {post.badge}
                        </Badge>
                      )}
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {formatDate(post.date)}
                      </span>
                    </div>
                    <h2 className="text-lg font-bold tracking-tight group-hover:text-primary transition-colors">
                      {post.title}
                    </h2>
                    <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">
                      {post.summary}
                    </p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-muted-foreground/50 group-hover:text-primary transition-colors shrink-0 mt-6" />
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

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
