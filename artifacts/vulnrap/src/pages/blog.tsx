import { BookOpen, Calendar, ArrowRight, Users, Zap, Shield, Bug, Heart } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";
import logoSrc from "@/assets/logo.png";

function FirstPost() {
  return (
    <article className="space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="border-primary/30 text-primary text-[10px]">Launch</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          We Built the Tool We Wished Existed
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Why we created VulnRap, what problem it actually solves, and why you should feel comfortable using it.
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-6 text-sm leading-relaxed text-muted-foreground">
        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Bug className="w-4 h-4 text-primary" />
            The Problem
          </h3>
          <p>
            If you work in PSIRT, run a VDP, or manage a vulnerability program, you already know the pain. Your inbox is a mix of legitimate vulnerability reports, near-identical duplicates, and an increasing volume of reports that read like someone asked an AI to "write a critical vulnerability report about SQL injection" and submitted whatever came out.
          </p>
          <p>
            The AI-generated reports are the worst part. They are just plausible enough to require reading, but they waste your time because the submitter never actually found a vulnerability — they described a theoretical one. You read three paragraphs of "It is important to note that SQL injection vulnerabilities can have devastating consequences" before you realize there are no reproduction steps, no version numbers, and no proof of concept.
          </p>
          <p>
            Duplicates are the second problem. Someone finds a real bug, writes a solid report, and submits it. Then four more people find the same bug and submit slightly different versions of the same report. Your team reads all five, realizes they are the same thing, and closes four of them. Everyone wasted time.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            What We Built
          </h3>
          <p>
            VulnRap does two things well:
          </p>
          <p>
            <strong className="text-foreground">1. AI Slop Detection.</strong> We run a two-layer scoring system on every report. First, a deterministic heuristic engine checks for common AI filler phrases, missing technical depth (no repro steps? no version info? no code blocks?), stylometric red flags (perfect sentence structure, low vocabulary diversity), and structural patterns that indicate a generated document. Second, when available, an LLM semantic analyzer evaluates PSIRT-specific dimensions like technical specificity, PoC validity, and target specificity. The final score blends both layers (40% heuristic, 60% LLM). If the LLM is unavailable, scoring falls back to heuristic-only. The result is a 0-100 slop score. Below 15, the report is probably human-written. Above 70, it is almost certainly generated.
          </p>
          <p>
            <strong className="text-foreground">2. Similarity Detection.</strong> We fingerprint every report using MinHash (Jaccard similarity estimation), SimHash (structural fingerprinting), and SHA-256 hashing at both the document and section level. When you submit a report, we compare it against everything in the database. If your "Steps to Reproduce" section is identical to someone else's, we flag it — even if the rest of the report is different.
          </p>
          <p>
            Before any of this happens, we auto-redact PII, secrets, API keys, credentials, and identifying information. The raw text never touches the database. Only the redacted version is stored and compared.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Why You Should Trust It
          </h3>
          <p>
            We get it — the security community should be skeptical of tools that ask you to upload vulnerability reports. Here is why VulnRap is different:
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li><strong className="text-foreground">No accounts.</strong> We do not know who you are. There are no user accounts, no email collection, no tracking cookies, no analytics. We literally could not identify you if we wanted to.</li>
            <li><strong className="text-foreground">Auto-redaction first.</strong> Before anything is stored, we strip emails, IPs, API keys, credentials, phone numbers, company names, and other identifying information. The redaction engine uses deterministic regex patterns — same input always produces the same output.</li>
            <li><strong className="text-foreground">Privacy modes.</strong> If you do not want even the redacted text stored, use "Keep it private" mode. We will only store mathematical fingerprints — enough for similarity comparison, but no text at all.</li>
            <li><strong className="text-foreground">Open source.</strong> The entire codebase is <a href="https://github.com/REMEDiSSecurity/VulnRapcom" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">public on GitHub</a>. You can read the redaction patterns, the hashing algorithms, the slop detection heuristics, and the database schema. There is nothing hidden.</li>
            <li><strong className="text-foreground">No business model.</strong> VulnRap is funded directly by REMEDiS Security and COMPLiTT because we use it ourselves. There are no investors, no ad revenue, no data monetization. If we can not keep funding it, the code is <a href="https://github.com/REMEDiSSecurity/VulnRapcom" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">open source</a> and someone else can run it.</li>
          </ul>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            Nothing Like This Exists Yet
          </h3>
          <p>
            We looked. There are plagiarism detectors (built for academic papers), AI content detectors (built for essays and blog posts), and code similarity tools (built for source code). None of them understand what a vulnerability report is supposed to look like.
          </p>
          <p>
            A plagiarism detector will tell you that two XSS reports are "similar" because they both mention <code className="text-primary font-mono text-xs">document.cookie</code>. That is not useful. VulnRap understands the structure of vulnerability reports — it knows that "Steps to Reproduce" sections should be unique, that "Impact" sections might reasonably overlap, and that technical terms are not plagiarism.
          </p>
          <p>
            An AI content detector trained on essays does not know that "The application fails to properly sanitize user input" is a perfectly normal thing for a human to write in a vulnerability report. VulnRap's slop detection is tuned specifically for vulnerability reports. It flags the filler, not the technical language.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-foreground font-bold text-base flex items-center gap-2">
            <Heart className="w-4 h-4 text-red-400" />
            How You Can Help
          </h3>
          <p>
            VulnRap only works if teams use it. The similarity detection gets better with every report in the database. If you run a PSIRT or triage team, use the Check page on incoming reports or integrate the API into your intake pipeline. Every report analyzed makes the system more useful for the entire community.
          </p>
          <p>
            If you are a developer, the <a href="https://github.com/REMEDiSSecurity/VulnRapcom" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">project is open source</a> and we welcome contributions. The slop detection heuristics can always be improved, the redaction patterns can always catch more edge cases, and the section parser can always handle more report formats.
          </p>
          <p>
            If you find a security vulnerability in VulnRap itself, please <Link to="/security" className="text-primary hover:underline">report it responsibly</Link>. We are security people — we will take it seriously and fix it quickly.
          </p>
        </div>
      </div>

      <Separator className="bg-border/50" />

      <div className="flex items-center gap-3">
        <img src={logoSrc} alt="" className="w-8 h-8 rounded-sm" />
        <div className="text-xs text-muted-foreground">
          <p className="text-foreground font-medium">The VulnRap Team</p>
          <p>Built by <a href="https://remedissecurity.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">REMEDiS Security</a> and <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">COMPLiTT</a></p>
        </div>
      </div>
    </article>
  );
}

export default function Blog() {
  return (
    <div className="max-w-3xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-primary" />
          Blog
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Updates, technical deep-dives, and the occasional rant about AI-generated vulnerability reports.
        </p>
      </div>

      <Card className="glass-card rounded-xl">
        <CardContent className="p-8">
          <FirstPost />
        </CardContent>
      </Card>

      <div className="text-center text-xs text-muted-foreground/50 pb-4">
        <p>More posts coming as we ship new features. <a href="https://github.com/REMEDiSSecurity/VulnRapcom" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Follow the project on GitHub</a> to stay updated.</p>
      </div>
    </div>
  );
}
