import {
  Accessibility,
  CheckCircle2,
  AlertTriangle,
  Mail,
  FileText,
  Wrench,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LAST_REVIEWED = "April 2026";

export default function AccessibilityPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Accessibility className="w-8 h-8 text-primary" />
          Accessibility Statement
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          VulnRap is committed to making vulnerability triage tooling usable by
          everyone, including security practitioners who rely on assistive
          technology. This statement describes our current conformance status,
          the gaps we know about, and how to reach us if something gets in your
          way.
        </p>
        <p className="text-xs text-muted-foreground/60 mt-3 font-mono">
          Last reviewed: {LAST_REVIEWED}
        </p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <CheckCircle2 className="w-5 h-5" />
            Conformance Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            VulnRap targets{" "}
            <strong className="text-foreground">WCAG 2.1 Level AA</strong>{" "}
            conformance. We consider the application{" "}
            <strong className="text-foreground">partially conformant</strong>:
            most of the site meets Level AA, but some areas — listed below — do
            not yet fully meet the standard.
          </p>
          <p>
            We self-assess against WCAG 2.1 AA using a combination of automated
            tooling (axe-core, Lighthouse) and manual review with a screen
            reader and keyboard-only navigation. We do not currently engage a
            third-party auditor; this is a free community tool funded by its
            maintainers.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Measures We Take
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <ul className="space-y-2 list-disc pl-5">
            <li>
              Semantic HTML for headings, landmarks, lists, and form controls.
            </li>
            <li>
              Keyboard-operable navigation, including dropdown menus that close
              on <code className="font-mono text-xs">Escape</code> and trap
              focus appropriately.
            </li>
            <li>Visible focus indicators on interactive elements.</li>
            <li>
              Text contrast against the dark theme designed to meet 4.5:1 for
              body copy and 3:1 for large text.
            </li>
            <li>
              ARIA roles and labels on menus, dialogs, and icon-only buttons.
            </li>
            <li>
              Responsive layouts that reflow at 320px width and tolerate 200%
              zoom.
            </li>
            <li>
              Reduced-motion preferences respected for non-essential animations
              where feasible.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            Known Gaps
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            We try to be honest about where we fall short. The following areas
            are known not to fully meet WCAG 2.1 AA today:
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li>
              <strong className="text-foreground">Decorative motion.</strong>{" "}
              The cursor-tracking insects and laser background effects are
              decorative and may be distracting; they are not yet fully
              suppressed under{" "}
              <code className="font-mono text-xs">prefers-reduced-motion</code>.
            </li>
            <li>
              <strong className="text-foreground">Data visualizations.</strong>{" "}
              Some charts on the Stats, Corpus Stats, and Transparency pages do
              not yet expose a tabular text equivalent for screen reader users.
            </li>
            <li>
              <strong className="text-foreground">
                Color-only signalling.
              </strong>{" "}
              A handful of badges and score chips rely primarily on color to
              communicate severity; we are migrating these to also carry a
              textual label or icon.
            </li>
            <li>
              <strong className="text-foreground">
                Long-form report viewers.
              </strong>{" "}
              The diff and compare views are dense and have not been fully
              validated with screen readers.
            </li>
            <li>
              <strong className="text-foreground">
                PDF and exported artifacts.
              </strong>{" "}
              Generated PDF reports are not tagged for accessibility.
            </li>
            <li>
              <strong className="text-foreground">Third-party embeds.</strong>{" "}
              External content (e.g. GitHub links) inherits the accessibility of
              those upstream services.
            </li>
          </ul>
          <p>
            Remediation of these gaps is tracked separately from this statement.
            This page documents the current state; it does not constitute a
            commitment to a specific fix date.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-primary" />
            Compatibility
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            VulnRap is designed to be compatible with current versions of major
            browsers (Chrome, Firefox, Safari, Edge) and the screen readers
            commonly paired with them (NVDA, JAWS, VoiceOver, TalkBack).
            JavaScript is required; the application will not function with
            scripting disabled.
          </p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 backdrop-blur border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Mail className="w-5 h-5" />
            Reporting Issues &amp; Requesting Accommodations
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            If you encounter a barrier using VulnRap, or you need information
            presented in an alternative format, please contact us. We aim to
            respond within five business days.
          </p>
          <ul className="space-y-2 list-disc pl-5">
            <li>
              Email:{" "}
              <a
                href="mailto:remedisllc@gmail.com?subject=VulnRap%20Accessibility"
                className="text-primary hover:underline font-mono text-xs"
              >
                remedisllc@gmail.com
              </a>{" "}
              (subject line: <em>VulnRap Accessibility</em>)
            </li>
            <li>
              File an issue on{" "}
              <a
                href="https://github.com/REMEDiSSecurity/VulnRap.Com/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                GitHub
              </a>{" "}
              with the <code className="font-mono text-xs">accessibility</code>{" "}
              label.
            </li>
          </ul>
          <p>
            When reporting, it helps to include the page URL, the assistive
            technology and browser you are using, and a short description of
            what went wrong.
          </p>
        </CardContent>
      </Card>

      <div className="text-center text-xs text-muted-foreground/50 pb-4 space-y-1">
        <p>
          See also:{" "}
          <Link to="/privacy" className="text-primary/60 hover:text-primary">
            Privacy Policy
          </Link>
          {" · "}
          <Link to="/terms" className="text-primary/60 hover:text-primary">
            Terms
          </Link>
          {" · "}
          <Link to="/security" className="text-primary/60 hover:text-primary">
            Security
          </Link>
        </p>
      </div>
    </div>
  );
}
