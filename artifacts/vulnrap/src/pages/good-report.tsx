// Task #637 — One-page "good-report" doc, linked from the
// QualityPreviewSidebar. Intentionally short and prescriptive.
import { Link } from "react-router-dom";
import {
  FileText,
  CheckCircle2,
  XCircle,
  Code2,
  Link2,
  ListOrdered,
  ArrowLeft,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function GoodReport() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <Link
          to="/check"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3 h-3" /> Back to Check
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <FileText className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          What makes a good report?
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          A short, opinionated checklist. The pre-submit quality preview on the
          submit and check pages grades against this guide.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            What we look for
          </CardTitle>
          <CardDescription>
            None of these are hard rules — they're the patterns that correlate
            with reproducible, valid reports in our corpus.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <Item
            icon={<FileText className="w-4 h-4 text-primary" />}
            title="≥150 words of substance"
          >
            Anything shorter usually skips either the impact statement or the
            reproduction. Prefer concrete sentences over filler.
          </Item>
          <Item
            icon={<Code2 className="w-4 h-4 text-primary" />}
            title="A fenced code block"
          >
            Show the request, the payload, the affected snippet, or the crash
            output — fenced in <code>```</code> so it survives copy-paste. Two
            or more inline <code>`snippets`</code> count, but a fence is
            stronger.
          </Item>
          <Item
            icon={<Link2 className="w-4 h-4 text-primary" />}
            title="At least one URL"
          >
            A CVE, a vendor advisory, a commit, or a documentation link. Two or
            more is better. Links anchor your claims to something verifiable.
          </Item>
          <Item
            icon={<ListOrdered className="w-4 h-4 text-primary" />}
            title="Numbered repro steps"
          >
            Three or more steps written as <code>1.</code> <code>2.</code>{" "}
            <code>3.</code> tells a triage analyst exactly how to confirm the
            bug. "Just go to the page and click it" does not.
          </Item>
        </CardContent>
      </Card>

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <XCircle className="w-4 h-4 text-destructive" />
            What hurts your score
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">All-caps prose.</strong> If more
            than 10% of letters are uppercase, the report reads like a marketing
            blurb, not a bug report.
          </p>
          <p>
            <strong className="text-foreground">No reproduction.</strong> A wall
            of impact claims with no steps is the single most common shape of
            low-quality submissions.
          </p>
          <p>
            <strong className="text-foreground">Stock AI phrasing.</strong> "It
            is important to note that…", "In conclusion…", and similar
            connective tissue is the most reliable AI tell our scoring engines
            see. Cut it.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        The pre-submit checklist runs entirely in your browser — nothing is sent
        to our servers until you actually submit. The estimated quality score is
        a rough approximation of our server-side substance engine, not the final
        score.
      </p>
    </div>
  );
}

function Item({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5">{icon}</div>
      <div className="space-y-1 min-w-0">
        <div className="font-medium text-sm">{title}</div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          {children}
        </p>
      </div>
    </div>
  );
}
