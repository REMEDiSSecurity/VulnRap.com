import { Target, Shield, Users, GitBranch, Zap, Building, Bug, Search, FileText, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";

const useCases = [
  {
    icon: <Bug className="w-6 h-6 text-cyan-400" />,
    iconBg: "icon-glow-cyan",
    title: "Security Researchers",
    subtitle: "Before you hit Submit",
    scenarios: [
      "Run your report through VulnRap before submitting to any program. Get a slop score to make sure your report reads like a human wrote it — not like you asked ChatGPT to pad it out.",
      "Check if someone already submitted the same vulnerability. If your report matches an existing one at 80%+, you are probably going to get a duplicate response anyway. Save yourself the wait.",
      "Copy the VulnRap verification badge into your submission. It shows the triager that you care enough to pre-validate your work.",
    ],
  },
  {
    icon: <Shield className="w-6 h-6 text-green-400" />,
    iconBg: "icon-glow-green",
    title: "PSIRT / Triage Teams",
    subtitle: "Before you start reading",
    scenarios: [
      "Paste incoming reports into the Check page. You get a slop score, duplicate detection, and redaction analysis without storing anything in VulnRap's database.",
      "Flag reports scoring above 50 as potentially AI-generated. These are the ones where the researcher probably did not actually find the vulnerability — they described a theoretical attack they read about.",
      "Use the API to build a pre-screening step into your triage pipeline. POST to /api/reports/check and auto-tag reports before they hit your queue.",
    ],
  },
  {
    icon: <Building className="w-6 h-6 text-purple-400" />,
    iconBg: "icon-glow-purple",
    title: "Vulnerability Platforms",
    subtitle: "Reduce noise at the gate",
    scenarios: [
      "Integrate VulnRap's check endpoint as a submission pre-filter. Show researchers their slop score before they submit and let them improve their report first.",
      "Use content hash lookups to detect cross-platform duplicates. If the same report was already analyzed on VulnRap, the hash match tells you instantly.",
      "Surface VulnRap verification badges on submissions. Triagers can see at a glance whether the researcher pre-validated their report.",
    ],
  },
  {
    icon: <GitBranch className="w-6 h-6 text-orange-400" />,
    iconBg: "icon-glow-orange",
    title: "CI/CD Integration",
    subtitle: "Automated quality gates",
    scenarios: [
      "Add a VulnRap check step to your security pipeline. When vulnerability reports come in through automated channels (Jira, email parsers, Slack bots), run them through the API first.",
      "Set thresholds: reject reports with slop scores above 70 automatically, flag 30-70 for manual review, fast-track anything below 30.",
      "Use the lookup endpoint to deduplicate incoming reports against your historical submissions before they create tickets.",
    ],
  },
  {
    icon: <Users className="w-6 h-6 text-yellow-400" />,
    iconBg: "icon-glow-yellow",
    title: "Security Researchers (Training)",
    subtitle: "Learn what good looks like",
    scenarios: [
      "Submit your practice reports and study the feedback. VulnRap tells you specifically what is missing: no reproduction steps? No version info? No code blocks? Fix those.",
      "Compare your slop scores over time. As you write better reports, your scores should drop. If they are climbing, you might be leaning too hard on AI assistance.",
      "Look at the section-level analysis. VulnRap tells you which sections are unique and which match other reports. The unique sections are where your real research lives.",
    ],
  },
  {
    icon: <Search className="w-6 h-6 text-pink-400" />,
    iconBg: "icon-glow-pink",
    title: "Vulnerability Disclosure Programs",
    subtitle: "Public-facing validation",
    scenarios: [
      "Link to VulnRap in your disclosure policy as a recommended pre-submission step. Researchers who use it submit better, more unique reports.",
      "Use verification URLs in your acknowledgment process. When you confirm a vulnerability, the VulnRap verify link provides independent proof that the report was original.",
      "Point to VulnRap's stats page to show researchers the current state of submissions — how many duplicates are being caught and what the average quality looks like.",
    ],
  },
];

export default function UseCases() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Target className="w-8 h-8 text-primary" />
          Use Cases
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          VulnRap works for anyone who writes, receives, or triages vulnerability reports. Here is how different teams use it.
        </p>
      </div>

      <div className="space-y-6">
        {useCases.map((uc, i) => (
          <Card key={i} className="glass-card rounded-xl">
            <CardHeader className="pb-3">
              <div className="flex items-start gap-4">
                <div className={`p-2.5 rounded-lg shrink-0 ${uc.iconBg}`}>
                  {uc.icon}
                </div>
                <div>
                  <CardTitle className="text-lg">{uc.title}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5 italic">{uc.subtitle}</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pl-[4.25rem]">
              {uc.scenarios.map((scenario, j) => (
                <div key={j} className="flex items-start gap-2.5 text-sm text-muted-foreground leading-relaxed">
                  <ArrowRight className="w-3.5 h-3.5 text-primary mt-1 shrink-0" />
                  <span>{scenario}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardContent className="p-6 text-center space-y-3">
          <Zap className="w-6 h-6 text-primary mx-auto" />
          <p className="text-sm text-muted-foreground">
            Have a use case we have not covered? We would love to hear about it.
          </p>
          <div className="flex items-center justify-center gap-4 text-xs">
            <Link to="/" className="text-primary hover:underline">Try it now</Link>
            <span className="text-muted-foreground/30">|</span>
            <Link to="/developers" className="text-primary hover:underline">See the API</Link>
            <span className="text-muted-foreground/30">|</span>
            <a href="mailto:remedisllc@gmail.com" className="text-primary hover:underline">Tell us yours</a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
