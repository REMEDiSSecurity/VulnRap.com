import { useState, useEffect } from "react";
import {
  Lightbulb,
  Calendar,
  ExternalLink,
  Youtube,
  Linkedin,
  Copy,
  Check,
  ArrowRight,
  Shield,
  Users,
  Zap,
  Quote,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { slopdemicHeroAsset } from "@/assets/hero-assets";
import { HeroImage } from "@/components/hero-image";

function SectionHeading({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <h2 className="text-xl font-bold tracking-tight text-foreground mt-10 mb-4 flex items-center gap-2">
      {icon}
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-4 text-muted-foreground leading-relaxed text-[15px]">
      {children}
    </p>
  );
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground font-semibold">{children}</strong>;
}

function ImpactCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card className="glass-card rounded-xl">
      <CardContent className="p-5 flex gap-4 items-start">
        <div className="shrink-0 mt-0.5 p-2 rounded-lg bg-primary/10">
          {icon}
        </div>
        <div>
          <p className="font-semibold text-foreground text-sm mb-1">{title}</p>
          <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function CopyApiButton() {
  const [copied, setCopied] = useState(false);
  const apiBase = "https://vulnrap.com/api";

  function handleCopy() {
    navigator.clipboard.writeText(apiBase).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-2 font-mono text-xs bg-background/60 border border-border rounded-md px-3 py-1.5 text-muted-foreground hover:text-primary hover:border-primary/50 transition-all"
      title="Copy API base URL"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
      ) : (
        <Copy className="w-3.5 h-3.5 shrink-0" />
      )}
      {apiBase}
    </button>
  );
}

export default function Insights() {
  useEffect(() => {
    const prev = document.title;
    document.title =
      "The Slopdemic: Why High-Signal Security Is the Only Way Forward — VulnRap Insights";
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <div className="max-w-3xl mx-auto space-y-2 pb-16">
      {/* Page header */}
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Lightbulb className="w-8 h-8 text-primary" />
          Insights
        </h1>
        <p className="text-muted-foreground mt-2">
          Perspectives on vulnerability intelligence, triage quality, and the
          fight against AI-generated noise.
        </p>
      </div>

      {/* Editorial hero */}
      <figure className="mt-2 rounded-xl overflow-hidden border border-border/60 bg-[#08090c]">
        <HeroImage
          asset={slopdemicHeroAsset}
          alt="A tide of faint, translucent vulnerability reports washing toward the foreground, with a single sharper report standing upright in the center, lit by a warm amber glow."
          loading="eager"
          fetchPriority="high"
          className="w-full h-auto block"
        />
      </figure>

      {/* Article card */}
      <Card className="glass-card rounded-xl">
        <CardContent className="p-8 space-y-2">
          {/* Article meta */}
          <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground mb-1">
            <Badge
              variant="outline"
              className="border-primary/30 text-primary text-[10px]"
            >
              Industry Analysis
            </Badge>
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" /> May 2026
            </span>
            <span>by the REMEDiS Security team</span>
          </div>

          <h2 className="text-2xl font-bold tracking-tight leading-snug">
            The Slopdemic: Why High-Signal Security is the Only Way Forward
          </h2>
          <p className="text-muted-foreground leading-relaxed text-[15px] pb-2">
            In the last year, the cybersecurity community has been hit by a new
            kind of DDoS attack. It isn't targeting servers or bandwidth —
            it's targeting{" "}
            <Bold>human attention</Bold>.
          </p>

          <Separator className="bg-border/50 my-4" />

          {/* Pullquote */}
          <blockquote className="border-l-2 border-primary/50 pl-4 py-1 my-6">
            <div className="flex items-start gap-2">
              <Quote className="w-4 h-4 text-primary/60 shrink-0 mt-0.5" />
              <p className="text-foreground/90 italic text-[15px] leading-relaxed">
                "As Bugcrowd founder Casey Ellis recently detailed in his viral
                breakdown of the 'Slopdemic,' the industry is being flooded by
                'Vuln Slop' — a wave of low-quality, unverified, AI-generated
                vulnerability reports."
              </p>
            </div>
          </blockquote>

          <P>
            At VulnRap.com, we've watched this trend closely. It validates
            exactly why we built our platform and our real-time API: because in
            a world of infinite noise,{" "}
            <Bold>signal is the only currency that matters</Bold>.
          </P>

          {/* Embedded media cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-6">
            <a
              href="https://youtu.be/QtcBhb_aqxk"
              target="_blank"
              rel="noopener noreferrer"
              className="group block"
            >
              <Card className="border-red-500/20 bg-red-950/10 hover:border-red-500/40 hover:bg-red-950/20 transition-all rounded-xl cursor-pointer">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-red-600 flex items-center justify-center shadow-lg">
                    <Youtube className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground group-hover:text-red-300 transition-colors leading-snug">
                      Casey Ellis on the Slopdemic
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      YouTube · Bugcrowd
                    </p>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                </CardContent>
              </Card>
            </a>

            <a
              href="https://www.linkedin.com/pulse/thoughts-slopdemic-casey-ellis-zi1xc/"
              target="_blank"
              rel="noopener noreferrer"
              className="group block"
            >
              <Card className="border-[#0a66c2]/20 bg-[#0a66c2]/5 hover:border-[#0a66c2]/40 hover:bg-[#0a66c2]/10 transition-all rounded-xl cursor-pointer">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="shrink-0 w-10 h-10 rounded-lg bg-[#0a66c2] flex items-center justify-center shadow-lg">
                    <Linkedin className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground group-hover:text-[#5aabff] transition-colors leading-snug">
                      Thoughts on the Slopdemic
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      LinkedIn Pulse · Casey Ellis
                    </p>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
                </CardContent>
              </Card>
            </a>
          </div>

          {/* What is the Slopdemic */}
          <SectionHeading>What is the "Slopdemic"?</SectionHeading>

          <P>
            Casey Ellis describes this phenomenon as{" "}
            <Bold>"Sloptimism"</Bold> — a state where researchers (or automated
            "sock-puppet" accounts) use LLMs to generate plausible-sounding
            security reports without any manual validation.
          </P>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-5">
            <ImpactCard
              icon={<Zap className="w-4 h-4 text-yellow-400" />}
              title="Queue Bloat"
              body="Triage teams are seeing 300%+ increases in report volume, 95% of which is hallucinated junk."
            />
            <ImpactCard
              icon={<Users className="w-4 h-4 text-rose-400" />}
              title="Maintainer Burnout"
              body="Open-source maintainers spend weekends debunking AI-generated nonsense instead of writing secure code."
            />
            <ImpactCard
              icon={<Shield className="w-4 h-4 text-primary" />}
              title="Signal Crisis"
              body="When the cost of a fake bug drops to zero, the value of a real bug gets buried under the slop."
            />
          </div>

          {/* How VulnRap fights it */}
          <SectionHeading>How VulnRap.com Fights the Slop</SectionHeading>

          <P>
            Casey's central point is that we need to move from{" "}
            <Bold>Finding</Bold> to <Bold>Fixing</Bold>. This is where VulnRap
            comes in. We didn't build VulnRap to be another noise generator. We
            built it to be a{" "}
            <Bold>remediation accelerator</Bold>.
          </P>

          <div className="space-y-5 my-4">
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-5">
              <h3 className="font-bold text-foreground text-sm mb-2 flex items-center gap-2">
                <span className="text-primary font-mono">1.</span>
                High-Signal by Design
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Unlike AI agents that guess at vulnerabilities, VulnRap focuses
                on{" "}
                <Bold>actionable, verifiable security data</Bold>. We prioritize
                a human-in-the-loop philosophy — when an alert hits your
                dashboard, it represents a real risk that requires a real fix.
              </p>
            </div>

            <div className="rounded-xl border border-cyan-500/10 bg-cyan-950/10 p-5">
              <h3 className="font-bold text-foreground text-sm mb-2 flex items-center gap-2">
                <span className="text-cyan-400 font-mono">2.</span>
                Real-Time API for the Ecosystem
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                The "Slopdemic" moves fast, so your defense has to move faster.
                VulnRap is available as a{" "}
                <Bold>free, open real-time API</Bold> so platforms, developers,
                and security teams can integrate high-signal filtering directly
                into their workflows.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <span className="text-cyan-400 shrink-0 mt-0.5">→</span>
                  <span>
                    <Bold>For maintainers:</Bold> Cross-reference incoming
                    reports against known-good remediation patterns.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-cyan-400 shrink-0 mt-0.5">→</span>
                  <span>
                    <Bold>For enterprises:</Bold> Feed internal scans through
                    VulnRap to strip slop before it reaches your engineering
                    team's backlog.
                  </span>
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-emerald-500/10 bg-emerald-950/10 p-5">
              <h3 className="font-bold text-foreground text-sm mb-2 flex items-center gap-2">
                <span className="text-emerald-400 font-mono">3.</span>
                Community-First Remediation
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Security is a team sport. By filtering out the AI junk, we help
                the community reclaim their time. Every hour saved from triaging
                a hallucinated vulnerability is an hour spent on{" "}
                <Bold>actual defense</Bold>.
              </p>
            </div>
          </div>

          {/* Bottom line */}
          <SectionHeading>The Bottom Line: Stop the Slop</SectionHeading>

          <P>
            As Casey Ellis says, AI is a force multiplier — but it can multiply
            the bad just as easily as the good.
          </P>

          <P>
            VulnRap.com is here to ensure that AI is used to solve problems, not
            create them. Whether you are using our web interface or integrating
            via our API, our mission is simple:{" "}
            <Bold>Less slop. More signal. Faster fixes.</Bold>
          </P>

          <Separator className="bg-border/50 my-8" />

          {/* CTA */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-4">
            <p className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">
              Stop chasing ghosts
            </p>
            <h3 className="text-xl font-bold text-foreground">
              Integrate the VulnRap API Today
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Free, open, and anonymous. No API keys, no accounts, no
              rate-limit hurdles. Just high-signal vulnerability scoring for
              your workflows.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-1">
              <CopyApiButton />
              <Link to="/developers">
                <Button className="glow-button gap-2">
                  Explore the API Docs
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
            </div>

            <p className="text-[11px] text-muted-foreground/50 pt-1">
              100 requests / 15 min · No authentication required ·{" "}
              <Link
                to="/quickstart"
                className="text-primary/60 hover:text-primary transition-colors"
              >
                Quickstart guide
              </Link>
            </p>
          </div>

          <Separator className="bg-border/50 mt-8 mb-4" />

          {/* Tags */}
          <div className="flex flex-wrap gap-2">
            {[
              "#AppSec",
              "#BugBounty",
              "#AISecurity",
              "#Slopdemic",
              "#VulnerabilityManagement",
              "#API",
            ].map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-[10px] border-border/50 text-muted-foreground/60"
              >
                {tag}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Back to more reading */}
      <div className="text-center pt-4">
        <Link
          to="/blog"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          More from the VulnRap blog
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
}
