import { Link } from "react-router-dom";
import {
  Users,
  Github,
  MessageCircle,
  Code,
  FileText,
  Sparkles,
  Heart,
  ArrowRight,
  BookOpen,
  Bug,
  Zap,
  Award,
  GitBranch,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const GITHUB_URL = "https://github.com/REMEDiSSecurity/VulnRap.Com";

function ChannelCard({
  icon,
  title,
  description,
  href,
  cta,
  status,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href?: string;
  cta: string;
  status?: "live" | "soon";
}) {
  const isExternal = href && /^https?:\/\//.test(href);
  const wrapperClass =
    "glass-card rounded-xl p-5 flex flex-col gap-3 h-full transition-all hover:border-primary/40";
  const inner = (
    <>
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
          {icon}
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-base font-bold tracking-tight truncate">
            {title}
          </h3>
          {status === "soon" && (
            <Badge
              variant="outline"
              className="text-[9px] uppercase tracking-wider border-amber-500/40 text-amber-300/90 shrink-0"
            >
              Soon
            </Badge>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed flex-1">
        {description}
      </p>
      <div className="flex items-center gap-1.5 text-xs font-mono text-primary/90 group-hover:text-primary transition-colors">
        {cta}
        <ArrowRight className="w-3 h-3" />
      </div>
    </>
  );
  if (!href) {
    return <div className={`${wrapperClass} group opacity-90`}>{inner}</div>;
  }
  if (isExternal) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${wrapperClass} group`}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link to={href} className={`${wrapperClass} group`}>
      {inner}
    </Link>
  );
}

function ContributionCard({
  icon,
  title,
  description,
  examples,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  examples: string[];
  href?: string;
}) {
  return (
    <Card className="bg-card/40 backdrop-blur border-border/60 hover:border-primary/30 transition-colors h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="text-primary">{icon}</span>
          {title}
        </CardTitle>
        <CardDescription className="text-xs leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {examples.map((ex) => (
            <li key={ex} className="flex items-start gap-2">
              <span className="mt-1 w-1 h-1 rounded-full bg-primary/60 shrink-0" />
              <span className="leading-relaxed">{ex}</span>
            </li>
          ))}
        </ul>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-mono text-primary/90 hover:text-primary transition-colors mt-2"
          >
            How to contribute
            <ArrowRight className="w-3 h-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}


export default function Community() {
  return (
    <div className="max-w-5xl mx-auto space-y-12" data-testid="page-community">
      {/* Hero */}
      <header className="border-b border-border pb-6 space-y-3">
        <h1 className="text-3xl sm:text-4xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Users className="w-8 h-8 text-primary" />
          Community
        </h1>
        <p className="text-muted-foreground max-w-3xl leading-relaxed">
          VulnRap is built in the open by and for triagers tired of low-validity
          reports. The detection corpus, the scoring rubric, and the platform
          itself all get better when more eyes look at them. Here's where to
          plug in.
        </p>
      </header>

      {/* Get involved */}
      <section className="space-y-4" data-testid="section-get-involved">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold uppercase tracking-tight">
            Get involved
          </h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="glass-card rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Bug className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-bold">Found a bug</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Report misclassifications, false positives, or platform glitches
              via GitHub issues — or use the in-app feedback button next to any
              score.
            </p>
          </div>
          <div className="glass-card rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-bold">Contributed a fixture</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Sanitized real-world reports — both legit and slop — keep our
              calibration honest. Pull requests welcome.
            </p>
          </div>
          <div className="glass-card rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-violet-400" />
              <h3 className="text-sm font-bold">Wrote a signal</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              New heuristics, hand-wavy phrases, or rubric refinements ship to
              production every sprint. We credit every accepted contribution.
            </p>
          </div>
        </div>
      </section>

      {/* Channels */}
      <section className="space-y-4" data-testid="section-channels">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold uppercase tracking-tight">
            Channels
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <ChannelCard
            icon={<Github className="w-5 h-5" />}
            title="GitHub"
            description="Source, issue tracker, sprint plan. Open a discussion before a large change so we can sanity-check the approach together."
            href={GITHUB_URL}
            cta="Open repo"
            status="live"
          />
        </div>
      </section>

      {/* Contribution paths */}
      <section className="space-y-4" data-testid="section-contribution-paths">
        <div className="flex items-center gap-2">
          <GitBranch className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold uppercase tracking-tight">
            Contribution paths
          </h2>
        </div>
        <p className="text-sm text-muted-foreground max-w-3xl leading-relaxed">
          Every part of VulnRap accepts pull requests. Pick the path that
          matches how you like to help — most contributors start with one
          fixture and end up writing their own signals a sprint later.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          <ContributionCard
            icon={<FileText className="w-5 h-5" />}
            title="Fixtures"
            description="Sanitized real-world reports labeled by tier (T1_LEGIT through T3_SLOP). The calibration battery runs against these on every commit, so a single new fixture can flip a regression from invisible to red."
            examples={[
              "Strip identifiers, keep the structural shape (PoC, sanitizer trace, claimed CVEs, prose voice).",
              "Pin an expected score range (expectMaxScore / expectMinScore) so calibration drift is caught early.",
              "Add a short note explaining why this report belongs in the labeled tier.",
            ]}
            href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}
          />
          <ContributionCard
            icon={<Sparkles className="w-5 h-5" />}
            title="Hand-wavy phrases"
            description="The hand-wavy detector catches the prose tells of fabricated reports — phrases like 'could potentially allow' or 'theoretically exploitable.' Reviewers can add, edit, and reinstate phrases through the calibration UI."
            examples={[
              "Open the Calibration page and use the phrase manager — every change is audited and reversible.",
              "Group phrases by category (vague_claim, theoretical, marketing_speak) so weights stay calibrated per cohort.",
              "Run the dry-run preview before applying — it shows which fixtures the change would re-classify.",
            ]}
          />
          <ContributionCard
            icon={<Zap className="w-5 h-5" />}
            title="Detection signals"
            description="Each engine emits structured signals (impossible_http_response, fabricated_crash_trace, evidence_free_overshoot, …). New signals plug into the AVRI rubric and get weighted automatically once they pass calibration."
            examples={[
              "Add a detector module under api-server/src/lib/engines/ with structured marker IDs.",
              "Wire it into the rubric's per-family weight map so scoring respects the bug class.",
              "Add fixture coverage that exercises the signal in isolation before opening the PR.",
            ]}
            href={`${GITHUB_URL}/tree/main/artifacts/api-server/src/lib/engines`}
          />
          <ContributionCard
            icon={<Code className="w-5 h-5" />}
            title="Code"
            description="The platform is a pnpm monorepo: an Express + Drizzle API server, a React + Vite frontend, and a small handful of shared libraries. TypeScript end-to-end, OpenAPI codegen for the client."
            examples={[
              "Pick an open issue tagged good-first-issue or help-wanted to get started.",
              "Run pnpm test and pnpm typecheck before pushing — CI gates on both.",
              "Update OpenAPI + run codegen for any new endpoint so the React client stays in sync.",
            ]}
            href={`${GITHUB_URL}/issues`}
          />
        </div>
        <Card className="bg-card/40 backdrop-blur border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="w-4 h-4 text-primary" />
              Before you open a PR
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground leading-relaxed">
            <p>
              We try to keep the project boring to contribute to: clear labels
              on issues, small reviewable PRs, and a bias toward shipping
              calibration evidence with every detection change. If something is
              unclear, open a discussion before sinking time into the code.
            </p>
            <p>
              The{" "}
              <Link
                to="/changelog"
                className="text-primary/90 hover:text-primary underline-offset-2 hover:underline"
              >
                changelog
              </Link>{" "}
              is the best place to see how previous contributions landed and
              what we're working on this sprint.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Recognition */}
      <section className="space-y-4" data-testid="section-recognition">
        <div className="flex items-center gap-2">
          <Award className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold uppercase tracking-tight">
            Recognition
          </h2>
        </div>
        <Card className="glass-card border-primary/20">
          <CardContent className="p-6 space-y-4">
            <div className="flex items-start gap-3">
              <Heart className="w-5 h-5 text-pink-400 shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm leading-relaxed">
                <p className="text-foreground">
                  Every accepted PR shows up in the changelog with author
                  attribution. Significant detection contributions also earn a
                  callout on the{" "}
                  <Link
                    to="/transparency"
                    className="text-primary hover:underline"
                  >
                    impact page
                  </Link>{" "}
                  alongside the calibration delta they unlocked.
                </p>
                <p className="text-muted-foreground">
                  We're a small team: contributions get reviewed quickly and
                  credited prominently. If you'd prefer to stay anonymous (lots
                  of PSIRT folks do), tell us in the PR description and we'll
                  redact accordingly.
                </p>
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 pt-2 border-t border-border/40">
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Changelog
                </div>
                <Link
                  to="/changelog"
                  className="text-sm font-bold text-primary hover:underline"
                >
                  Per-release credits
                </Link>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Impact report
                </div>
                <Link
                  to="/transparency"
                  className="text-sm font-bold text-primary hover:underline"
                >
                  Public-good metrics
                </Link>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Repo
                </div>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-bold text-primary hover:underline inline-flex items-center gap-1"
                >
                  GitHub contributors
                  <Github className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
