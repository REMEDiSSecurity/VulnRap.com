import { Link } from "react-router-dom";
import { Newspaper, Download, Mail, Image as ImageIcon, FileText, Users, ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const PRESS_EMAIL = "remedisllc@gmail.com";
const PRESS_SUBJECT = "VulnRap Press";
const LAST_UPDATED = "May 2026";

interface LogoVariant {
  id: string;
  label: string;
  background: "dark" | "light";
  preview: string;
  svg: string;
  png: string;
}

const LOGOS: LogoVariant[] = [
  {
    id: "logo-dark",
    label: "Wordmark — for dark backgrounds",
    background: "dark",
    preview: "/press/vulnrap-logo-dark.svg",
    svg: "/press/vulnrap-logo-dark.svg",
    png: "/press/vulnrap-logo-dark.png",
  },
  {
    id: "logo-light",
    label: "Wordmark — for light backgrounds",
    background: "light",
    preview: "/press/vulnrap-logo-light.svg",
    svg: "/press/vulnrap-logo-light.svg",
    png: "/press/vulnrap-logo-light.png",
  },
  {
    id: "mark-dark",
    label: "Icon mark — dark",
    background: "dark",
    preview: "/press/vulnrap-mark-dark.svg",
    svg: "/press/vulnrap-mark-dark.svg",
    png: "/press/vulnrap-mark-dark.png",
  },
  {
    id: "mark-light",
    label: "Icon mark — light",
    background: "light",
    preview: "/press/vulnrap-mark-light.svg",
    svg: "/press/vulnrap-mark-light.svg",
    png: "/press/vulnrap-mark-light.png",
  },
];

interface Screenshot {
  id: string;
  caption: string;
  preview: string;
  svg: string;
  png: string;
}

const SCREENSHOTS: Screenshot[] = [
  { id: "home", caption: "Home — submit a report for scoring",
    preview: "/press/screenshot-home.svg", svg: "/press/screenshot-home.svg", png: "/press/screenshot-home.png" },
  { id: "results", caption: "Results page — score, verdict, and per-signal breakdown",
    preview: "/press/screenshot-results.svg", svg: "/press/screenshot-results.svg", png: "/press/screenshot-results.png" },
  { id: "stats", caption: "Public Stats — 90-day volume, top CWE families, signal fire-rates",
    preview: "/press/screenshot-stats.svg", svg: "/press/screenshot-stats.svg", png: "/press/screenshot-stats.png" },
  { id: "architecture", caption: "Architecture — five engines, calibrated combiner",
    preview: "/press/screenshot-architecture.svg", svg: "/press/screenshot-architecture.svg", png: "/press/screenshot-architecture.png" },
  { id: "signals", caption: "Signal Reference — every detector documented with citations",
    preview: "/press/screenshot-signals.svg", svg: "/press/screenshot-signals.svg", png: "/press/screenshot-signals.png" },
];

interface FactRow {
  label: string;
  value: string;
}

const FACTS: FactRow[] = [
  { label: "What it is", value: "A free public scoring service that detects AI-generated slop in vulnerability reports." },
  { label: "Who it's for", value: "Bug-bounty triagers, OSS maintainers, CSIRTs/PSIRTs, and disclosure researchers." },
  { label: "How it scores", value: "Five independent engines (Linguistic, Substance, CWE Coherence, AVRI, Reputation) combined with isotonic calibration and per-CWE weights." },
  { label: "Detectable signals", value: "63 detectors, each with a published fingerprint, weight, and citation list." },
  { label: "Held-out accuracy", value: "93.7% (precision 0.91 / recall 0.94)." },
  { label: "Latency", value: "P50 142 ms · P95 410 ms · P99 720 ms — fully synchronous." },
  { label: "Pricing", value: "Free public tier, rate-limited. Source-available signal definitions." },
  { label: "Org", value: "Built and funded by the makers of COMPLiTT.com with REMEDiS Security LLC." },
];

function pressMailto(suffix?: string) {
  const subject = encodeURIComponent(suffix ? `${PRESS_SUBJECT} — ${suffix}` : PRESS_SUBJECT);
  return `mailto:${PRESS_EMAIL}?subject=${subject}`;
}

function DownloadLinks({ svg, png, label }: { svg: string; png: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <a
        href={svg}
        download
        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
        aria-label={`Download ${label} as SVG`}
      >
        <Download className="w-3 h-3" /> SVG
      </a>
      <a
        href={png}
        download
        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
        aria-label={`Download ${label} as PNG`}
      >
        <Download className="w-3 h-3" /> PNG
      </a>
    </div>
  );
}

export default function Press() {
  return (
    <div className="max-w-5xl mx-auto space-y-12">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Newspaper className="w-8 h-8 text-primary" />
          Press Kit
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          Logos, screenshots, fact sheet, and contact details for journalists, integrators, and partners
          covering VulnRap. Everything on this page is licensed for editorial use without prior written
          permission, provided marks are not modified and colours are preserved.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-3 font-mono">Last updated: {LAST_UPDATED}</p>
      </div>

      <section aria-labelledby="about-heading" className="space-y-3">
        <h2 id="about-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" /> About
        </h2>
        <Card className="bg-card/40 backdrop-blur">
          <CardContent className="pt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">VulnRap</strong> is a free, public scoring service that
              detects AI-generated &ldquo;slop&rdquo; submissions in vulnerability reports before they reach
              human triage. It exposes a 0–100 score, a verdict, and the full list of signals that fired —
              with their weights and citations — so a triager can decide in seconds rather than minutes.
            </p>
            <p>
              The service runs five independent engines in parallel and combines them with an
              isotonic-calibrated, per-CWE-weighted combiner. Every detector is documented; the corpus
              statistics, held-out metrics, and benchmark fixtures are all public.
            </p>
            <p>
              VulnRap is built and funded by the makers of{" "}
              <a href="https://complitt.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">COMPLiTT.com</a>{" "}
              with engineering support from REMEDiS Security LLC.
            </p>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="logos-heading" className="space-y-4">
        <h2 id="logos-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-primary" /> Logo
        </h2>
        <p className="text-sm text-muted-foreground max-w-3xl">
          SVG is preferred for print and web. PNGs are 1024px wide on a transparent or theme background.
          Brand colours are <span className="font-mono text-primary">#00FFD1</span> (cyan) and{" "}
          <span className="font-mono" style={{ color: "#C832FF" }}>#C832FF</span> (accent) on{" "}
          <span className="font-mono">#0D1117</span> (background).
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {LOGOS.map(logo => (
            <Card key={logo.id} className="bg-card/40 backdrop-blur overflow-hidden">
              <div
                className="flex items-center justify-center p-6 border-b border-border"
                style={{ backgroundColor: logo.background === "dark" ? "#0D1117" : "#FFFFFF" }}
              >
                <img
                  src={logo.preview}
                  alt={logo.label}
                  className="max-h-24 w-auto"
                  loading="lazy"
                />
              </div>
              <CardContent className="pt-4 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground leading-snug">{logo.label}</span>
                <DownloadLinks svg={logo.svg} png={logo.png} label={logo.label} />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="screenshots-heading" className="space-y-4">
        <h2 id="screenshots-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-primary" /> Screenshots
        </h2>
        <p className="text-sm text-muted-foreground max-w-3xl">
          High-resolution product screenshots (1600&times;1000). Cleared for editorial reuse.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {SCREENSHOTS.map(shot => (
            <Card key={shot.id} className="bg-card/40 backdrop-blur overflow-hidden">
              <a href={shot.png} target="_blank" rel="noopener noreferrer" className="block group">
                <img
                  src={shot.preview}
                  alt={shot.caption}
                  className="w-full h-auto block border-b border-border group-hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
              </a>
              <CardContent className="pt-4 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground leading-snug flex-1">{shot.caption}</span>
                <DownloadLinks svg={shot.svg} png={shot.png} label={shot.caption} />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="fact-heading" className="space-y-4">
        <h2 id="fact-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" /> Fact Sheet
        </h2>
        <Card className="bg-card/40 backdrop-blur">
          <CardContent className="pt-6">
            <dl className="divide-y divide-border">
              {FACTS.map(row => (
                <div key={row.label} className="grid sm:grid-cols-[180px_1fr] gap-2 py-3">
                  <dt className="text-xs font-mono uppercase tracking-wider text-primary/80">{row.label}</dt>
                  <dd className="text-sm text-muted-foreground leading-relaxed">{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <a href="/press/vulnrap-fact-sheet.txt" download>
                <Button variant="outline" size="sm" className="gap-2">
                  <Download className="w-3.5 h-3.5" /> Methodology one-pager (.txt)
                </Button>
              </a>
              <Link to="/whitepaper">
                <Button variant="outline" size="sm" className="gap-2">
                  <FileText className="w-3.5 h-3.5" /> Full whitepaper
                </Button>
              </Link>
              <Link to="/architecture">
                <Button variant="outline" size="sm" className="gap-2">
                  <FileText className="w-3.5 h-3.5" /> Architecture diagram
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="contact-heading" className="space-y-4">
        <h2 id="contact-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Mail className="w-5 h-5 text-primary" /> Press Contact
        </h2>
        <Card className="bg-card/40 backdrop-blur border-primary/20">
          <CardContent className="pt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              For interviews, embargoed background, or integration enquiries:
            </p>
            <p>
              Email{" "}
              <a href={pressMailto()} className="text-primary hover:underline font-mono">
                {PRESS_EMAIL}
              </a>{" "}
              with the subject line <em className="text-foreground">VulnRap Press</em>. We aim to respond
              within two business days.
            </p>
            <p className="text-xs text-muted-foreground/70">
              For security disclosures about VulnRap itself, see the{" "}
              <Link to="/security" className="text-primary hover:underline">Security</Link> page —
              do not use the press address for vulnerability reports.
            </p>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="bios-heading" className="space-y-4">
        <h2 id="bios-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" /> Team
        </h2>
        <Card className="bg-card/40 backdrop-blur">
          <CardContent className="pt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              VulnRap is a small team operating under REMEDiS Security LLC, with the same engineering group
              that builds COMPLiTT.com. Detailed exec bios are available on request from the press address
              above; we keep them off the public site so we can update them with each interview.
            </p>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="coverage-heading" className="space-y-4">
        <h2 id="coverage-heading" className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
          <ExternalLink className="w-5 h-5 text-primary" /> Past Coverage
        </h2>
        <Card className="bg-card/40 backdrop-blur">
          <CardContent className="pt-6 text-sm text-muted-foreground leading-relaxed">
            <p className="italic">
              No published coverage yet. If you write about VulnRap, please drop us a line — we&rsquo;ll
              link your piece here.
            </p>
          </CardContent>
        </Card>
      </section>

      <div className="text-center text-xs text-muted-foreground/50 pb-4">
        See also:{" "}
        <Link to="/security" className="text-primary/60 hover:text-primary">Security</Link>
        {" · "}
        <Link to="/whitepaper" className="text-primary/60 hover:text-primary">Whitepaper</Link>
        {" · "}
        <Link to="/transparency" className="text-primary/60 hover:text-primary">Impact</Link>
      </div>
    </div>
  );
}
