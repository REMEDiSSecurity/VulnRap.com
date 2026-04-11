import { Scale, Heart, AlertTriangle, FileText, Users, Shield, Server, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";

export default function Terms() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Scale className="w-8 h-8 text-primary" />
          Terms of Service
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          The short version: VulnRap is a free tool built by security practitioners for security practitioners. There are no hidden motives. Here are the ground rules.
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Heart className="w-5 h-5" />
            How This Gets Funded
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            VulnRap is directly funded by <a href="https://remedissecurity.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">REMEDiS Security</a> and <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">COMPLiTT</a>. There are no investors, no venture capital, no advertising revenue, and no plans to monetize user data.
          </p>
          <p>
            We built this because we work in PSIRT and vulnerability disclosure ourselves. We got tired of wading through AI-generated garbage and duplicate reports. We figured if we were frustrated, other people were too. So we built the tool we wished existed and made it free.
          </p>
          <p>
            The project is open source. If it turns out we can not keep funding it forever, the code is there for anyone to run their own instance.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            What You Are Agreeing To
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">By using VulnRap, you agree that:</p>
          <ul className="space-y-2 list-disc pl-5">
            <li>You will not upload content that you do not have the right to share. If a report contains proprietary information from a private vulnerability program, make sure your program's rules allow external analysis tools.</li>
            <li>Reports submitted in "Share with the community" mode will be auto-redacted and made available for similarity comparison by other users. That is the whole point — this only works if people contribute.</li>
            <li>You will not use automated tools to flood the platform. We have rate limits (100 requests per 15 minutes) and we will block abusive traffic.</li>
            <li>You understand that auto-redaction is regex-based and not perfect. If your report contains sensitive information in unusual formats, the redactor might miss it. When in doubt, pre-sanitize your report before uploading.</li>
            <li>You will not use VulnRap to harass, track, or de-anonymize other users.</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            What We Promise
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <ul className="space-y-2 list-disc pl-5">
            <li>We will never sell, license, or share your data with third parties. Not advertisers, not data brokers, not anyone.</li>
            <li>We will never add tracking, analytics cookies, or advertising to VulnRap.</li>
            <li>We will never require user accounts, email verification, or any form of identification.</li>
            <li>We will keep the core functionality free. If we ever add premium features, the analysis, comparison, and redaction tools will remain free and open.</li>
            <li>We will keep the project open source so anyone can verify these claims or run their own instance.</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            Disclaimers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <ul className="space-y-2 list-disc pl-5">
            <li><strong className="text-foreground">No guarantees.</strong> VulnRap is provided as-is. Slop detection is heuristic-based and can produce false positives and false negatives. A low slop score does not guarantee a report is legitimate. A high score does not guarantee it is AI-generated.</li>
            <li><strong className="text-foreground">Not legal advice.</strong> VulnRap's analysis is a technical assessment, not a legal determination of originality, plagiarism, or fraud.</li>
            <li><strong className="text-foreground">No liability.</strong> We are not responsible for decisions made based on VulnRap's analysis. If you reject a valid report because of a high slop score, or accept a fraudulent one because of a low score, that is on you.</li>
            <li><strong className="text-foreground">Uptime.</strong> We do our best to keep VulnRap available, but we do not guarantee uptime. This is a community tool, not a paid SaaS product with an SLA.</li>
            <li><strong className="text-foreground">Data persistence.</strong> We may need to reset the database for major upgrades. While we will try to preserve data when possible, do not treat VulnRap as permanent storage for your reports.</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-primary" />
            Content Removal
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            If you submitted a report and want it removed, email us at <a href="mailto:remedisllc@gmail.com" className="text-primary hover:underline font-mono text-xs">remedisllc@gmail.com</a> with the report ID or content hash. We will remove it. No questions asked.
          </p>
          <p>
            If you believe someone uploaded content that violates your rights, contact us with the details and we will investigate.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5 text-primary" />
            Changes to These Terms
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            If we change these terms, we will update this page. We are not going to bury changes in fine print or send you emails you did not ask for (we do not have your email anyway).
          </p>
          <p className="text-xs text-muted-foreground/50">Last updated: April 2026</p>
        </CardContent>
      </Card>

      <div className="text-center text-xs text-muted-foreground/50 pb-4 space-y-1">
        <p>See also: <Link to="/privacy" className="text-primary/60 hover:text-primary">Privacy Policy</Link> · <Link to="/security" className="text-primary/60 hover:text-primary">Security</Link></p>
      </div>
    </div>
  );
}
