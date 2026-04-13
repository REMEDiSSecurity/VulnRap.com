import { Target, Shield, Users, GitBranch, Zap, Building, Bug, Search, FileText, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";

const useCases = [
  {
    icon: <Shield className="w-6 h-6 text-green-400" />,
    iconBg: "icon-glow-green",
    title: "PSIRT / Triage Teams",
    subtitle: "Before you start reading",
    scenarios: [
      "Paste incoming reports into the Check page. Get a validity score, duplicate detection, verification results, and redaction analysis without storing anything in VulnRap's database.",
      "Flag reports scoring above 50 for closer scrutiny. These are the ones most likely to describe a theoretical attack rather than an actual finding — deprioritize them accordingly.",
      "Use the API to build a pre-screening step into your triage pipeline. POST to /api/reports/check and auto-tag reports before they hit your queue.",
    ],
  },
  {
    icon: <Bug className="w-6 h-6 text-cyan-400" />,
    iconBg: "icon-glow-cyan",
    title: "Incoming Report Screening",
    subtitle: "Catch low-validity reports before they waste triage hours",
    scenarios: [
      "Run every inbound report through VulnRap as a first-pass validity check. Reports with high scores (likely fabricated) can be batched for bulk review instead of getting individual analyst time.",
      "Detect cross-submission duplicates automatically. If a report matches an existing one at 80%+, your team can close it as a duplicate immediately instead of re-triaging the same issue.",
      "Use the section-level hash comparison to spot reports that copy-paste the same PoC or impact statement across different submissions — a common pattern in spray-and-pray campaigns.",
    ],
  },
  {
    icon: <Building className="w-6 h-6 text-purple-400" />,
    iconBg: "icon-glow-purple",
    title: "Platform Integration",
    subtitle: "Reduce noise at the gate",
    scenarios: [
      "Integrate VulnRap's check endpoint as an intake pre-filter. Automatically score and tag incoming reports before they reach your triage queue.",
      "Use content hash lookups to detect cross-platform duplicates. If the same report has already been analyzed on VulnRap, the hash match tells your team instantly — no manual comparison needed.",
      "Surface validity scores and similarity data alongside incoming submissions so triagers can prioritize high-quality, original reports first.",
    ],
  },
  {
    icon: <GitBranch className="w-6 h-6 text-orange-400" />,
    iconBg: "icon-glow-orange",
    title: "CI/CD & Pipeline Automation",
    subtitle: "Automated quality gates for your intake workflow",
    scenarios: [
      "Add a VulnRap check step to your intake pipeline. When vulnerability reports arrive through automated channels (Jira, email parsers, Slack bots), run them through the API before they create tickets.",
      "Set thresholds: auto-deprioritize reports scoring above 70 (likely fabricated), flag 30\u201370 for manual review, fast-track anything below 30 to an analyst.",
      "Use the lookup endpoint to deduplicate incoming reports against your historical submissions before they generate new work items.",
    ],
  },
  {
    icon: <Users className="w-6 h-6 text-yellow-400" />,
    iconBg: "icon-glow-yellow",
    title: "Report Quality Benchmarking",
    subtitle: "Measure and track submission quality over time",
    scenarios: [
      "Use VulnRap's stats page to monitor the overall quality of reports your team is receiving. Track average validity scores, duplicate rates, and submission volume trends.",
      "Identify repeat-offender patterns: if the same report structure keeps showing up with different target names swapped in, VulnRap's similarity detection catches it.",
      "Use the section-level analysis to understand which parts of incoming reports are original research vs. recycled boilerplate. This helps your team decide where to focus review effort.",
    ],
  },
  {
    icon: <Search className="w-6 h-6 text-pink-400" />,
    iconBg: "icon-glow-pink",
    title: "Vulnerability Disclosure Programs",
    subtitle: "Strengthen your intake process",
    scenarios: [
      "Add VulnRap as a pre-screening step in your disclosure policy. Incoming reports that have already been validated save your team time during initial triage.",
      "Use verification URLs to confirm report originality during your assessment process. The VulnRap verify link gives your team an independent quality signal alongside your own analysis.",
      "Monitor VulnRap's stats page to understand submission trends across your program — duplicate rates, average quality scores, and how report quality changes over time.",
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
          VulnRap works for anyone who receives or triages vulnerability reports. Here is how different teams use it.
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
