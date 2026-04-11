import { Shield, Mail, AlertTriangle, Bug, GitBranch, CheckCircle, Clock, FileText, Heart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";

export default function Security() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary" />
          Security
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          We build tools for the security community. If you find a vulnerability in VulnRap itself, we want to hear about it and we will fix it.
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Bug className="w-5 h-5" />
            Reporting a Vulnerability
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            If you discover a security vulnerability in VulnRap, please report it responsibly. Do not open a public <a href="https://github.com/REMEDiSSecurity/VulnRapcom/issues" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub issue</a> for security vulnerabilities.
          </p>
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-foreground font-medium">
              <Mail className="w-4 h-4 text-primary" />
              Contact
            </div>
            <p>
              Email: <a href="mailto:remedisllc@gmail.com" className="text-primary hover:underline font-mono text-xs">remedisllc@gmail.com</a>
            </p>
            <p>
              Subject line: <span className="font-mono text-xs text-foreground">VulnRap Security Report</span>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            What to Include in Your Report
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>Help us reproduce and fix the issue quickly by including:</p>
          <ul className="space-y-2 list-disc pl-5">
            <li><strong className="text-foreground">Description:</strong> Clear summary of the vulnerability and its potential impact.</li>
            <li><strong className="text-foreground">Steps to Reproduce:</strong> Detailed, step-by-step instructions to trigger the issue.</li>
            <li><strong className="text-foreground">Affected Component:</strong> Which part of VulnRap is affected — the API, frontend, redaction engine, similarity matching, etc.</li>
            <li><strong className="text-foreground">Environment:</strong> Browser, OS, or tools used to discover the issue.</li>
            <li><strong className="text-foreground">Proof of Concept:</strong> Screenshots, request/response logs, or a minimal script demonstrating the vulnerability.</li>
            <li><strong className="text-foreground">Suggested Fix:</strong> If you have ideas on how to address it, we would genuinely appreciate hearing them.</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" />
            What to Expect
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <div className="space-y-3">
            {[
              { step: "Acknowledgment", time: "Within 48 hours", desc: "We will confirm we received your report and are reviewing it." },
              { step: "Assessment", time: "Within 1 week", desc: "We will evaluate the severity, determine the scope, and share our initial findings with you." },
              { step: "Fix", time: "Varies by severity", desc: "Critical issues will be patched as fast as possible. We will keep you updated on progress." },
              { step: "Disclosure", time: "After the fix is deployed", desc: "We will coordinate with you on public disclosure timing. We believe in transparency." },
            ].map((item) => (
              <div key={item.step} className="flex items-start gap-3 bg-card/60 rounded-lg p-3 border border-border/50">
                <CheckCircle className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <div className="text-foreground font-medium">{item.step} <span className="text-xs text-muted-foreground font-normal ml-2">{item.time}</span></div>
                  <p className="text-xs mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            Scope
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">In scope:</p>
          <ul className="space-y-1 list-disc pl-5">
            <li>The VulnRap web application at <span className="font-mono text-xs">vulnrap.com</span></li>
            <li>The VulnRap REST API at <span className="font-mono text-xs">vulnrap.com/api/*</span></li>
            <li>The auto-redaction engine (bypasses that leak PII/secrets)</li>
            <li>The similarity/hashing pipeline (collision attacks, data leakage)</li>
            <li>Authentication or authorization flaws (even though there are no user accounts, access control matters)</li>
            <li>Server-side vulnerabilities (SSRF, injection, path traversal, etc.)</li>
          </ul>
          <Separator />
          <p className="font-medium text-foreground">Out of scope:</p>
          <ul className="space-y-1 list-disc pl-5">
            <li>Denial of service attacks (we have rate limiting; please do not test this on production)</li>
            <li>Social engineering of the team</li>
            <li>Issues in third-party dependencies that do not have a demonstrated exploit path in VulnRap</li>
            <li>Self-XSS or issues requiring physical access to the user's device</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Contributing Fixes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            VulnRap is <a href="https://github.com/REMEDiSSecurity/VulnRapcom" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">open source</a>. If you find an issue and have a fix, we welcome pull requests. For security issues, please email us first so we can coordinate the fix and disclosure responsibly.
          </p>
          <p>
            For non-security bugs and feature requests, feel free to <a href="https://github.com/REMEDiSSecurity/VulnRapcom/issues" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">open a GitHub issue</a> directly.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur border-primary/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Heart className="w-5 h-5 text-red-400" />
            Thank You
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm leading-relaxed text-muted-foreground">
          <p>
            We are building VulnRap for the security community. If you take the time to find and report an issue, you are making the tool better for everyone. We appreciate it and we will acknowledge your contribution (with your permission) after the fix is deployed.
          </p>
        </CardContent>
      </Card>

      <div className="text-center text-xs text-muted-foreground/50 pb-4 space-y-1">
        <p>Our full <a href="/.well-known/security.txt" target="_blank" rel="noopener noreferrer" className="text-primary/60 hover:text-primary">security.txt</a> is available at the standard RFC 9116 location.</p>
        <p>See also: <Link to="/privacy" className="text-primary/60 hover:text-primary">Privacy Policy</Link> · <Link to="/terms" className="text-primary/60 hover:text-primary">Terms of Service</Link></p>
      </div>
    </div>
  );
}
