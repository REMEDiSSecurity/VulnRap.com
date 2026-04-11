import { Shield, Lock, FileText, Database, Server, Eye, Fingerprint, Users, Globe, Trash2, Scale, ShieldCheck, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";
import logoSrc from "@/assets/logo.png";

export default function Privacy() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary" />
          Privacy Policy & Data Practices
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          VulnRap is built on transparency. Here is exactly what we do with your data, how we protect it, and what other users can see. No fine print, no surprises.
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <img src={logoSrc} alt="" className="w-6 h-6 rounded-sm" />
            Why VulnRap Exists
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            Vulnerability programs are drowning in low-quality, duplicate, and AI-generated reports. Triage teams waste hours filtering noise while legitimate researchers wait longer for their reports to be reviewed. VulnRap exists to help both sides:
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li><strong className="text-foreground">For researchers:</strong> Check if your report has been submitted before, get an honest assessment of quality, and improve your report before submission.</li>
            <li><strong className="text-foreground">For the ecosystem:</strong> Every report analyzed improves our fingerprint corpus. When a researcher discovers their report matches an existing one, that saves everyone time.</li>
            <li><strong className="text-foreground">For trust:</strong> Platforms can point researchers here as a pre-submission check, reducing duplicate submissions and AI slop before they clog the pipeline.</li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur border-yellow-500/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-yellow-500">
            <Eye className="w-5 h-5" />
            What You Should Know Upfront
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">
            VulnRap stores and compares report data. That is the whole point of the platform.
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li>When you upload a report, we <strong className="text-foreground">auto-redact</strong> sensitive information (PII, secrets, credentials, company names) and store only the redacted version.</li>
            <li>Your redacted report is <strong className="text-foreground">compared against all other reports</strong> in our database. Other users' reports are compared against yours.</li>
            <li>Similarity scores, section-level hash matches, and AI sloppiness results are <strong className="text-foreground">visible to anyone with the report link</strong>.</li>
            <li>We do <strong className="text-foreground">not</strong> share your report with vulnerability programs, vendors, or third parties. The comparison happens only within VulnRap.</li>
          </ul>
          <p>
            If you do not want your report stored and compared, do not upload it. There is no "view only" mode -- comparison is the core function of this platform.
          </p>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-green-500" />
          Auto-Redaction Engine
        </h2>

        <Card className="bg-card/40 backdrop-blur border-border">
          <CardContent className="pt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              Before your report is stored or analyzed, it passes through our deterministic auto-redaction engine. This is not optional -- it runs on every upload. The same input always produces the same output.
            </p>
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <h4 className="text-sm font-bold text-foreground">What gets redacted:</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Email addresses</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> IP addresses (IPv4 and IPv6)</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> API keys and access tokens</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> JWT tokens and bearer tokens</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> AWS access keys</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Passwords and credentials</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Database connection strings</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Private keys (RSA, EC)</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Phone numbers and SSNs</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Credit card numbers</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Company names (Inc, LLC, Corp, etc.)</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Usernames and author attributions</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> Internal hostnames and URLs</div>
                <div className="flex items-start gap-2"><span className="text-green-500 mt-0.5 flex-shrink-0">--</span> UUIDs and hex secrets</div>
              </div>
            </div>
            <p>
              Redacted items are replaced with tagged placeholders like <code className="text-primary text-xs bg-muted px-1 py-0.5 rounded">[REDACTED_EMAIL]</code> or <code className="text-primary text-xs bg-muted px-1 py-0.5 rounded">[REDACTED_API_KEY]</code>. Your results page shows a breakdown of exactly what was redacted and how many of each type.
            </p>
            <p className="text-xs italic">
              Auto-redaction is regex-based and deterministic. It may not catch every possible sensitive value. Do not rely on it as your only protection -- if your report contains highly sensitive information, <strong className="text-yellow-500 not-italic">pre-sanitize it yourself</strong> before uploading. Remove or replace any details you would not want stored, even in redacted form.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Lock className="w-5 h-5 text-primary" />
          Data Collection & Storage
        </h2>

        <Card className="bg-card/40 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              <Fingerprint className="w-4 h-4" />
              Similarity Only Mode
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">
              In this mode, we generate mathematical fingerprints from the redacted version of your report. The redacted text is not stored -- only the hashes. The original raw text is never stored in any mode.
            </p>
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <h4 className="text-sm font-bold">What we store:</h4>
              <ul className="text-sm space-y-1.5 text-muted-foreground">
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> SHA-256 content hash of redacted text (for exact-match deduplication)</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> MinHash signature (128 hash values for fuzzy matching)</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Simhash fingerprint (64-bit structural hash)</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Section-level SHA-256 hashes (each section hashed independently)</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> AI sloppiness score, tier, and feedback</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Redaction summary (counts of what was redacted, not the values)</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> File name and size (metadata only)</li>
              </ul>
            </div>
            <p className="text-xs text-muted-foreground italic">
              The stored hashes cannot be reverse-engineered to recover your original report content. They are one-way mathematical transformations.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card/40 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
              <Database className="w-4 h-4" />
              Full Storage Mode
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">
              In this mode, we store everything from Similarity Only mode <strong>plus</strong> the auto-redacted text of your report. The original (pre-redaction) text is never stored. This helps build a richer comparison corpus for future users.
            </p>
            <div className="bg-muted/50 rounded-lg p-4 space-y-2">
              <h4 className="text-sm font-bold">How stored content helps the ecosystem:</h4>
              <ul className="text-sm space-y-1.5 text-muted-foreground">
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Enables richer semantic matching beyond structural fingerprints</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Improves sloppiness scoring with real-world examples</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Builds a larger corpus so future researchers get better duplicate detection</li>
                <li className="flex items-start gap-2"><span className="text-primary mt-1 flex-shrink-0">--</span> Helps identify common patterns in AI-generated reports</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" />
          How Comparison Works
        </h2>

        <Card className="bg-card/40 backdrop-blur border-border">
          <CardContent className="pt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              When you upload a report, it is compared against every other report in our database. Here is what that means:
            </p>
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4">
                <h4 className="font-bold text-foreground mb-2">Full-Document Similarity</h4>
                <p>MinHash signatures (128 permutations) and Simhash fingerprints measure overall similarity. LSH (Locality-Sensitive Hashing) with 16 bands narrows candidates before full comparison. Results above 15% similarity are shown.</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-4">
                <h4 className="font-bold text-foreground mb-2">Section-Level Hashing</h4>
                <p>Your report is split into logical sections (by markdown headers or paragraph breaks). Each section is hashed independently with SHA-256. If any section hash matches a section in another report exactly, that match is flagged -- even if the overall documents are different.</p>
              </div>
              <div className="bg-muted/50 rounded-lg p-4">
                <h4 className="font-bold text-foreground mb-2">What Other Users See</h4>
                <p>When another user uploads a report that matches yours, they see: the similarity percentage, the match type, section-level matches, and your anonymized report ID. They do <strong>not</strong> see your report content, file name, or any identifying information.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Eye className="w-5 h-5 text-primary" />
          Anonymity & Tracking
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="bg-card/40 backdrop-blur border-border">
            <CardHeader>
              <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
                <Users className="w-4 h-4" />
                No User Accounts
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3 text-muted-foreground leading-relaxed">
              <p>VulnRap does not require registration, login, or any form of identification. There are no user accounts, no email collection, and no OAuth flows.</p>
              <p>Every submission is treated as an independent, anonymous event. We cannot correlate multiple submissions to the same person.</p>
            </CardContent>
          </Card>

          <Card className="bg-card/40 backdrop-blur border-border">
            <CardHeader>
              <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground flex items-center gap-2">
                <Globe className="w-4 h-4" />
                No Analytics or Tracking
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3 text-muted-foreground leading-relaxed">
              <p>We do not use Google Analytics, Mixpanel, Hotjar, or any third-party analytics, tracking pixels, or advertising scripts.</p>
              <p>No cookies are set. No browser fingerprinting is performed. Server logs are ephemeral and do not record client IP addresses.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Server className="w-5 h-5 text-primary" />
          Security & Infrastructure
        </h2>

        <Card className="bg-card/40 backdrop-blur border-border">
          <CardContent className="pt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  Transport Security
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  All connections are encrypted via TLS. File uploads are transmitted over HTTPS and processed in memory. Rate limiting prevents abuse.
                </p>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  Platform Independence
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  VulnRap is not affiliated with any vulnerability platform. We do not share data with vendors, programs, or third parties. Comparison happens only within this platform.
                </p>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <FileText className="w-4 h-4 text-primary" />
                  File Handling
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Uploaded files are validated server-side (extension, size, content type). Files are processed in memory and never temporarily written to disk. Maximum file size is 20MB.
                </p>
              </div>
              <div className="space-y-3">
                <h3 className="text-sm font-bold flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-primary" />
                  Data Lifecycle
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Raw (pre-redaction) content is never written to disk or database. It exists only in process memory during analysis. Hashes and redacted content are stored indefinitely.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-primary" />
            Your Rights & Responsibilities
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">
          <div className="space-y-3">
            <h3 className="font-bold text-foreground">Auto-Redaction Is Not Perfect</h3>
            <p>
              Our redaction engine uses pattern matching and heuristics. It catches most common PII patterns (emails, IPs, API keys, passwords, company names, etc.), but it cannot guarantee 100% coverage. If your report contains highly sensitive or unusual identifiers, review the redacted output on your results page before sharing the link.
            </p>
          </div>
          <Separator />
          <div className="space-y-3">
            <h3 className="font-bold text-foreground">Report Results Are Linkable</h3>
            <p>
              Analysis results are accessible via a shareable link containing the report's numeric ID. Anyone with this link can view the analysis results (sloppiness score, similarity matches, section hashes, feedback, and redacted content in Full mode). Keep your result link private if you do not want others to see your analysis.
            </p>
          </div>
          <Separator />
          <div className="space-y-3">
            <h3 className="font-bold text-foreground">Open Source & Transparency</h3>
            <p>
              VulnRap's similarity engine uses deterministic, seeded algorithms (SHA-256 for hashing, MinHash with 128 permutations for fuzzy matching, Simhash for structural similarity, section-level SHA-256 for granular matching). The scoring is fully heuristic-based with no opaque ML models. What you see is what runs.
            </p>
          </div>
          <Separator />
          <div className="space-y-3">
            <h3 className="font-bold text-foreground">API Documentation</h3>
            <p>
              VulnRap exposes a fully documented REST API. You can browse the interactive API documentation at <code className="text-primary text-xs bg-muted px-1 py-0.5 rounded">/api/docs</code> to see all available endpoints, request formats, and response schemas.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="text-center py-4 text-xs text-muted-foreground space-y-2">
        <p>This policy was written to be honest, not to hide anything. If something is unclear, that is a bug we want to fix.</p>
        <p>
          <Link to="/" className="text-primary hover:underline">Back to Report Validation</Link>
        </p>
      </div>
    </div>
  );
}
