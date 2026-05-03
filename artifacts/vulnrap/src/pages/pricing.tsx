import { Link } from "react-router-dom";
import {
  Tag,
  Check,
  Sparkles,
  Mail,
  Clock,
  Building2,
  ShieldCheck,
  Zap,
  ArrowRight,
  HelpCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const IP_DAILY_LIMIT = 30;
const ACCOUNT_MONTHLY_LIMIT = 500;
const BATCH_MAX_REPORTS = 50;

const ENTERPRISE_EMAIL = "remedisllc@gmail.com";

function enterpriseMailto() {
  const subject = encodeURIComponent("VulnRap Enterprise Quota Request");
  const body = encodeURIComponent(
    [
      "Hi VulnRap team,",
      "",
      "We'd like to request enterprise quota for our organization.",
      "",
      "Organization:",
      "Approximate reports / month:",
      "Use case (PSIRT, bounty triage, vendor program, etc.):",
      "Preferred integration (API, webhooks, SSO, on-prem):",
      "Contact name & role:",
      "",
      "Thanks!",
    ].join("\n"),
  );
  return `mailto:${ENTERPRISE_EMAIL}?subject=${subject}&body=${body}`;
}

function FeatureRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm leading-relaxed">
      <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
      <span className="text-foreground/90">{children}</span>
    </li>
  );
}

function ComingSoonRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm leading-relaxed">
      <Clock className="w-4 h-4 text-amber-400/80 shrink-0 mt-0.5" />
      <span className="text-muted-foreground">{children}</span>
    </li>
  );
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold text-foreground flex items-start gap-2">
        <HelpCircle className="w-4 h-4 text-primary/80 shrink-0 mt-0.5" />
        <span>{q}</span>
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground pl-6">{a}</p>
    </div>
  );
}

export default function Pricing() {
  return (
    <div className="max-w-5xl mx-auto space-y-12" data-testid="page-pricing">
      {/* Hero */}
      <header className="border-b border-border pb-6 space-y-3">
        <h1 className="text-3xl sm:text-4xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Tag className="w-8 h-8 text-primary" />
          Pricing
        </h1>
        <p className="text-muted-foreground max-w-3xl leading-relaxed">
          VulnRap is free during the public beta. We're publishing pricing
          intent here so enterprise prospects know there's a clear plan for what
          comes next — no surprise meter starting on a quiet Tuesday.
        </p>
      </header>

      {/* Hero card: Free during beta */}
      <section data-testid="section-free-beta">
        <Card className="glass-card border-primary/40 overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          <CardHeader className="pb-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge className="bg-primary/15 text-primary border-primary/40 uppercase tracking-wider text-[10px] font-mono">
                <Sparkles className="w-3 h-3 mr-1" />
                Public beta
              </Badge>
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wider border-emerald-500/40 text-emerald-300/90"
              >
                No credit card
              </Badge>
            </div>
            <CardTitle className="text-3xl sm:text-4xl font-bold tracking-tight pt-3">
              Free during beta
            </CardTitle>
            <CardDescription className="text-base leading-relaxed pt-1">
              Score reports, run batches, query the API, embed badges. Anonymous
              and account-backed usage are both free for the duration of the
              beta.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/60 bg-background/40 p-4 space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Per IP / day
                </div>
                <div className="text-2xl font-bold text-primary font-mono">
                  {IP_DAILY_LIMIT}
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  Anonymous report submissions, rolling 24h window.
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-4 space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Per account / month
                </div>
                <div className="text-2xl font-bold text-primary font-mono">
                  {ACCOUNT_MONTHLY_LIMIT}
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  Signed-in submissions across web, API, and batch.
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-4 space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Batch size
                </div>
                <div className="text-2xl font-bold text-primary font-mono">
                  {BATCH_MAX_REPORTS}
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  Reports per batch upload, scored in parallel.
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
              Hit a limit and need more? See the enterprise section below — we
              approve almost every reasonable request during the beta.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* What's free / what's coming */}
      <section
        className="grid md:grid-cols-2 gap-4"
        data-testid="section-included"
      >
        <Card className="bg-card/40 backdrop-blur border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="w-5 h-5 text-primary" />
              What's free today
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              Everything the platform currently ships, with no feature gates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              <FeatureRow>
                Unlimited{" "}
                <Link to="/check" className="text-primary hover:underline">
                  report lookups
                </Link>{" "}
                by ID
              </FeatureRow>
              <FeatureRow>
                Single-report scoring with full signal breakdown
              </FeatureRow>
              <FeatureRow>
                <Link to="/batch" className="text-primary hover:underline">
                  Batch uploads
                </Link>{" "}
                up to {BATCH_MAX_REPORTS} reports per submission
              </FeatureRow>
              <FeatureRow>
                <Link to="/compare" className="text-primary hover:underline">
                  Side-by-side comparison
                </Link>{" "}
                of two reports
              </FeatureRow>
              <FeatureRow>
                Public{" "}
                <Link to="/developers" className="text-primary hover:underline">
                  REST API
                </Link>{" "}
                with the same scoring engine the UI uses
              </FeatureRow>
              <FeatureRow>
                Embeddable result badges and signed verify URLs
              </FeatureRow>
              <FeatureRow>
                <Link
                  to="/transparency"
                  className="text-primary hover:underline"
                >
                  Transparency metrics
                </Link>
                , corpus stats, and signal reference
              </FeatureRow>
              <FeatureRow>
                Reviewer feedback channel — every disagreement helps calibration
              </FeatureRow>
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-card/40 backdrop-blur border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Zap className="w-5 h-5 text-amber-400" />
              What's coming (paid plans)
            </CardTitle>
            <CardDescription className="text-xs leading-relaxed">
              Once the beta ends, the platform stays free at low volumes. Higher
              tiers will unlock the items below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              <ComingSoonRow>
                Higher monthly quotas (10k+ scored reports / month)
              </ComingSoonRow>
              <ComingSoonRow>
                SSO (SAML / OIDC) and team accounts with role-based access
              </ComingSoonRow>
              <ComingSoonRow>
                Webhook delivery for score events and feedback resolution
              </ComingSoonRow>
              <ComingSoonRow>
                Private fixtures and per-tenant calibration baselines
              </ComingSoonRow>
              <ComingSoonRow>
                Audit log export with retention beyond the public window
              </ComingSoonRow>
              <ComingSoonRow>
                Bring-your-own-CWE families and tenant-scoped detection signals
              </ComingSoonRow>
              <ComingSoonRow>
                SLA-backed uptime, dedicated rate limits, priority support
              </ComingSoonRow>
              <ComingSoonRow>
                On-prem / VPC deployment for regulated PSIRTs
              </ComingSoonRow>
            </ul>
          </CardContent>
        </Card>
      </section>

      {/* Enterprise quota */}
      <section data-testid="section-enterprise">
        <Card className="glass-card border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Building2 className="w-5 h-5 text-primary" />
              Need more than the beta limits?
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              If you're triaging hundreds of reports a week, running a bounty
              program, or evaluating VulnRap for procurement, we'll lift your
              quota for the duration of the beta. No contract required — we just
              want to know who's using it heavily so we can size the calibration
              corpus accordingly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                  Typical turnaround
                </div>
                <div className="text-sm font-semibold text-foreground">
                  Same business day
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                  What we'll ask
                </div>
                <div className="text-sm font-semibold text-foreground">
                  Org, volume, use case
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                  Cost during beta
                </div>
                <div className="text-sm font-semibold text-emerald-300">$0</div>
              </div>
            </div>
            <a
              href={enterpriseMailto()}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20"
              data-testid="link-enterprise-quota"
            >
              <Mail className="w-4 h-4" />
              Request enterprise quota
              <ArrowRight className="w-4 h-4" />
            </a>
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
              Opens your mail client with a pre-filled draft to{" "}
              <span className="font-mono text-foreground/80">
                {ENTERPRISE_EMAIL}
              </span>
              . Prefer a different channel? Ping us via{" "}
              <Link to="/community" className="text-primary hover:underline">
                community
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      {/* FAQ */}
      <section className="space-y-4" data-testid="section-faq">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-bold uppercase tracking-tight">FAQ</h2>
        </div>
        <Card className="bg-card/40 backdrop-blur border-border/60">
          <CardContent className="p-6 grid md:grid-cols-2 gap-x-8 gap-y-5">
            <FaqItem
              q="Is anything actually free, or is this a free trial?"
              a="It's free, not a trial. There's no credit card on file and no clock counting down. The beta will run until we're confident the calibration is stable enough to commit to a paid SLA."
            />
            <FaqItem
              q="What happens to free usage when paid plans launch?"
              a="A free tier will stay. The exact limits will be set so that hobbyists, researchers, and small PSIRTs never hit a paywall for normal use. We'll announce final numbers at least 30 days before any plan change."
            />
            <FaqItem
              q="Will my historical reports stay accessible?"
              a="Yes. Reports submitted during the beta keep their stable URLs, signed verify links, and badge embeds regardless of which plan you end up on."
            />
            <FaqItem
              q="Do you sell the data we submit?"
              a={
                <>
                  No. See the{" "}
                  <Link to="/privacy" className="text-primary hover:underline">
                    privacy page
                  </Link>{" "}
                  — submissions are stored to support scoring, calibration, and
                  abuse prevention only.
                </>
              }
            />
            <FaqItem
              q="Can I self-host?"
              a="On-prem deployment is on the roadmap for enterprise plans. If you have a specific compliance requirement (FedRAMP, EU-only data residency, air-gapped), tell us in the quota request and we'll prioritize accordingly."
            />
            <FaqItem
              q="What counts as a 'report' against my quota?"
              a="Each successful submission to /score (single or batched) decrements your quota by one. Lookups, badge fetches, and feedback submissions don't count."
            />
          </CardContent>
        </Card>
      </section>

      {/* Footer note */}
      <p className="text-center text-[11px] text-muted-foreground/60 max-w-2xl mx-auto leading-relaxed">
        Questions about pricing, procurement, or security review? Email{" "}
        <a
          href={`mailto:${ENTERPRISE_EMAIL}`}
          className="text-primary/80 hover:text-primary underline-offset-2 hover:underline"
        >
          {ENTERPRISE_EMAIL}
        </a>{" "}
        and we'll route it to the right person.
      </p>
    </div>
  );
}
