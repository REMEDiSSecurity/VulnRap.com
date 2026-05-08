import { lazy, Suspense, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { BookOpen, ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const blogComponents: Record<
  string,
  {
    component: React.LazyExoticComponent<React.ComponentType>;
    title: string;
    description: string;
  }
> = {
  "update14-deploy-fix": {
    component: lazy(() =>
      import("@/components/blog-update14-deploy-fix").then((m) => ({
        default: m.BlogUpdate14DeployFix,
      })),
    ),
    title:
      "60 Seconds of Silence: What the Production Startup Hang Taught Us",
    description:
      "Update #14 — Every deploy was hanging silently for 60 seconds before being killed with nothing in the logs. The root cause, what the production DB confirmed, and the fix.",
  },
  "update13-mcp-launch": {
    component: lazy(() =>
      import("@/components/blog-update13-mcp-launch").then((m) => ({
        default: m.BlogUpdate13McpLaunch,
      })),
    ),
    title: "VulnRap Now Speaks MCP: Triage From Inside Your Agent",
    description:
      "Update #13 — VulnRap exposes its scoring, similarity, and diagnostics tooling over the Model Context Protocol so agents like Claude Desktop can triage reports without leaving the chat.",
  },
  "sprint14-rigor": {
    component: lazy(() =>
      import("@/components/blog-sprint14-rigor").then((m) => ({
        default: m.BlogSprint14Rigor,
      })),
    ),
    title:
      "Three Ways Slop Hid This Sprint (And How the Audit Caught Them)",
    description:
      "Sprint 14 — Three classes of slop slipped past the scorer this sprint.",
  },
  "substance-gate-sprint12": {
    component: lazy(() =>
      import("@/components/blog-substance-gate").then((m) => ({
        default: m.BlogSubstanceGate,
      })),
    ),
    title:
      "Closing the Slop Gap: Engine 3 Now Cross-Checks Engine 2 Before It Votes",
    description:
      "Sprint 12 — The substance LLM now refuses to outvote the heuristic on evidence-free reports.",
  },
  "avri-sprint11": {
    component: lazy(() =>
      import("@/components/blog-avri-sprint11").then((m) => ({
        default: m.BlogAvriSprint11,
      })),
    ),
    title:
      "AVRI: One Rubric Wasn't Enough — Why v3.7.0 Scores Memory Bugs and XSS Slop on Different Yardsticks",
    description:
      "Sprint 11 — The Adversarial Vulnerability Report Index splits scoring by family.",
  },
  "field-test-v350": {
    component: lazy(() =>
      import("@/components/blog-field-test-v350").then((m) => ({
        default: m.BlogFieldTestV350,
      })),
    ),
    title:
      "v3.5.0 Field Test: Three Engines, Seven Reports, and a Ceiling We Didn't Expect",
    description:
      "Field test of v3.5.0 across seven real-world reports surfaced a scoring ceiling we did not predict.",
  },
  "zero-detection": {
    component: lazy(() =>
      import("@/components/blog-zero-detection").then((m) => ({
        default: m.BlogZeroDetection,
      })),
    ),
    title:
      "460K Vulnerability Reports, 56 Sources, and a 0% Detection Rate",
    description:
      "The week we built the most diverse vulnerability report dataset we could find.",
  },
  "the-data-is-there": {
    component: lazy(() =>
      import("@/components/blog-data-is-there").then((m) => ({
        default: m.BlogDataIsThere,
      })),
    ),
    title: "The Data Is There, the Score Isn't Listening",
    description:
      "Sprint 8 results: the pipeline finally works, substance detection is live, and the scoring formula mathematically cannot use it.",
  },
  "grading-ai-with-ai": {
    component: lazy(() =>
      import("@/components/blog-grading-ai").then((m) => ({
        default: m.BlogGradingAi,
      })),
    ),
    title:
      "Grading AI with AI: What We Learned When Our Detection Model Met the Real World",
    description:
      "Six development sprints, a 20% real-world detection rate, and the fundamental rethinking that led us from style detection to substance verification.",
  },
  "building-vulnrap": {
    component: lazy(() =>
      import("@/components/blog-building-vulnrap").then((m) => ({
        default: m.BlogBuildingVulnrap,
      })),
    ),
    title:
      "Building VulnRap: How We're Making Vulnerability Report Validation Actually Work for PSIRT Teams",
    description:
      "A detailed walkthrough of four development sprints, what we built, what we learned, what works, and what's coming next.",
  },
  "first-post": {
    component: lazy(() =>
      import("@/pages/blog").then((m) => ({
        default: m.FirstPost,
      })),
    ),
    title: "We Built the Tool We Wished Existed",
    description:
      "Why we created VulnRap, how it helps with triage, and why you should feel comfortable using it.",
  },
  "engine-deep-dives": {
    component: lazy(() =>
      import("@/components/blog-update11-engine-deepdives").then((m) => ({
        default: m.BlogUpdateEngineDeepDives,
      })),
    ),
    title: "Under the Hood: Introducing the VulnRap Engine Deep-Dive Series",
    description:
      "Update #11 — A guided tour through each scoring engine: what it measures, how it votes, and where the boundaries are.",
  },
  "byo-fixtures": {
    component: lazy(() =>
      import("@/components/blog-update10-byo-fixtures").then((m) => ({
        default: m.BlogUpdate10ByoFixtures,
      })),
    ),
    title: "Bring Your Own Fixtures: Validating VulnRap Against Your Corpus",
    description:
      "Update #10 — Run VulnRap's scoring pipeline against your own labelled reports and compare precision/recall on your data.",
  },
  "show-our-work": {
    component: lazy(() =>
      import("@/components/blog-update9-show-our-work").then((m) => ({
        default: m.BlogUpdate9ShowOurWork,
      })),
    ),
    title: "Showing Our Work: Per-Signal Precision/Recall in the UI",
    description:
      "Update #9 — Every signal now surfaces its own precision and recall numbers so you can see exactly which detectors pull their weight.",
  },
};

export function getBlogPostMeta(slug: string) {
  return blogComponents[slug] ?? null;
}

export function getAllBlogSlugs() {
  return Object.keys(blogComponents);
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const entry = slug ? blogComponents[slug] : null;

  useEffect(() => {
    if (!entry) return;

    const prevTitle = document.title;
    document.title = `${entry.title} — VulnRap Blog`;

    const metaDesc = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const prevDesc = metaDesc?.content ?? null;
    let createdDesc = false;
    let descEl = metaDesc;
    if (!descEl) {
      descEl = document.createElement("meta");
      descEl.name = "description";
      document.head.appendChild(descEl);
      createdDesc = true;
    }
    descEl.content = entry.description;

    const canonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    const prevCanonical = canonical?.href ?? null;
    let createdCanonical = false;
    let canonicalEl = canonical;
    if (!canonicalEl) {
      canonicalEl = document.createElement("link");
      canonicalEl.rel = "canonical";
      document.head.appendChild(canonicalEl);
      createdCanonical = true;
    }
    canonicalEl.href = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, "")}/blog/${slug}`;

    return () => {
      document.title = prevTitle;
      if (createdDesc) {
        descEl?.remove();
      } else if (descEl && prevDesc !== null) {
        descEl.content = prevDesc;
      }
      if (createdCanonical) {
        canonicalEl?.remove();
      } else if (canonicalEl && prevCanonical !== null) {
        canonicalEl.href = prevCanonical;
      }
    };
  }, [slug, entry]);

  if (!entry) {
    return (
      <div className="max-w-3xl mx-auto space-y-6 py-12 text-center">
        <h1 className="text-2xl font-bold">Post not found</h1>
        <p className="text-muted-foreground">
          The blog post you're looking for doesn't exist.
        </p>
        <Link
          to="/blog"
          className="inline-flex items-center gap-2 text-primary hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Blog
        </Link>
      </div>
    );
  }

  const PostComponent = entry.component;

  return (
    <div className="max-w-3xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <Link
          to="/blog"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          All posts
        </Link>
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-primary" />
          Blog
        </h1>
      </div>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <Suspense
            fallback={
              <div className="flex items-center justify-center min-h-[20vh]">
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            }
          >
            <PostComponent />
          </Suspense>
        </CardContent>
      </Card>

      <div className="text-center">
        <Link
          to="/blog"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to all posts
        </Link>
      </div>
    </div>
  );
}
