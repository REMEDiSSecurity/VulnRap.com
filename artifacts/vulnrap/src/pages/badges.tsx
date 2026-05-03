import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, BadgeCheck, Copy, Check } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const EXAMPLE_ID = 12345;
const EXAMPLE_TIER = "Likely Slop";
const EXAMPLE_SCORE = 72;
const EXAMPLE_COLOR = "#f0883e";
const LABEL = "vulnrap";
const VALUE = `${EXAMPLE_TIER} (${EXAMPLE_SCORE})`;

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[A-Z0-9]/.test(ch)) w += 8;
    else if (/[a-z]/.test(ch)) w += 7;
    else if (ch === " ") w += 4;
    else w += 6;
  }
  return w;
}

const PADDING = 12;
const LABEL_W = textWidth(LABEL) + PADDING;
const VALUE_W = textWidth(VALUE) + PADDING;
const TOTAL = LABEL_W + VALUE_W;
const LABEL_BG = "#555";

function DefaultBadge() {
  const h = 20;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={TOTAL}
      height={h}
      role="img"
      aria-label={`${LABEL}: ${VALUE}`}
    >
      <linearGradient id="bg-default" x2="0" y2="100%">
        <stop offset="0" stopColor="#bbb" stopOpacity=".1" />
        <stop offset="1" stopOpacity=".1" />
      </linearGradient>
      <clipPath id="cp-default">
        <rect width={TOTAL} height={h} rx="3" fill="#fff" />
      </clipPath>
      <g clipPath="url(#cp-default)">
        <rect width={LABEL_W} height={h} fill={LABEL_BG} />
        <rect x={LABEL_W} width={VALUE_W} height={h} fill={EXAMPLE_COLOR} />
        <rect width={TOTAL} height={h} fill="url(#bg-default)" />
      </g>
      <g
        fill="#fff"
        textAnchor="middle"
        fontFamily="Verdana,Geneva,DejaVu Sans,sans-serif"
        fontSize="11"
      >
        <text x={LABEL_W / 2} y="15" fill="#010101" fillOpacity=".3">
          {LABEL}
        </text>
        <text x={LABEL_W / 2} y="14">
          {LABEL}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="15" fill="#010101" fillOpacity=".3">
          {VALUE}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="14">
          {VALUE}
        </text>
      </g>
    </svg>
  );
}

function FlatBadge() {
  const h = 20;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={TOTAL}
      height={h}
      role="img"
      aria-label={`${LABEL}: ${VALUE}`}
    >
      <clipPath id="cp-flat">
        <rect width={TOTAL} height={h} rx="3" fill="#fff" />
      </clipPath>
      <g clipPath="url(#cp-flat)">
        <rect width={LABEL_W} height={h} fill={LABEL_BG} />
        <rect x={LABEL_W} width={VALUE_W} height={h} fill={EXAMPLE_COLOR} />
      </g>
      <g
        fill="#fff"
        textAnchor="middle"
        fontFamily="Verdana,Geneva,DejaVu Sans,sans-serif"
        fontSize="11"
      >
        <text x={LABEL_W / 2} y="14">
          {LABEL}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="14">
          {VALUE}
        </text>
      </g>
    </svg>
  );
}

function PlasticBadge() {
  const h = 18;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={TOTAL}
      height={h}
      role="img"
      aria-label={`${LABEL}: ${VALUE}`}
    >
      <linearGradient id="bg-plastic" x2="0" y2="100%">
        <stop offset="0" stopColor="#fff" stopOpacity=".7" />
        <stop offset=".1" stopColor="#aaa" stopOpacity=".1" />
        <stop offset=".9" stopColor="#000" stopOpacity=".3" />
        <stop offset="1" stopColor="#000" stopOpacity=".5" />
      </linearGradient>
      <clipPath id="cp-plastic">
        <rect width={TOTAL} height={h} rx="4" fill="#fff" />
      </clipPath>
      <g clipPath="url(#cp-plastic)">
        <rect width={LABEL_W} height={h} fill={LABEL_BG} />
        <rect x={LABEL_W} width={VALUE_W} height={h} fill={EXAMPLE_COLOR} />
        <rect width={TOTAL} height={h} fill="url(#bg-plastic)" />
      </g>
      <g
        fill="#fff"
        textAnchor="middle"
        fontFamily="Verdana,Geneva,DejaVu Sans,sans-serif"
        fontSize="11"
      >
        <text x={LABEL_W / 2} y="13" fill="#010101" fillOpacity=".3">
          {LABEL}
        </text>
        <text x={LABEL_W / 2} y="12">
          {LABEL}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="13" fill="#010101" fillOpacity=".3">
          {VALUE}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="12">
          {VALUE}
        </text>
      </g>
    </svg>
  );
}

function SocialBadge() {
  const h = 20;
  const w = TOTAL + 6;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={w}
      height={h}
      role="img"
      aria-label={`${LABEL}: ${VALUE}`}
    >
      <linearGradient id="bg-social" x2="0" y2="100%">
        <stop offset="0" stopColor="#fcfcfc" stopOpacity=".7" />
        <stop offset="1" stopColor="#ccc" stopOpacity=".7" />
      </linearGradient>
      <rect
        rx="3"
        width={w - 1}
        height={h - 1}
        fill="#fafafa"
        stroke="#d5d5d5"
      />
      <rect x={LABEL_W - 1} y="0" width="1" height={h} fill="#d5d5d5" />
      <rect rx="3" width={w - 1} height={h - 1} fill="url(#bg-social)" />
      <g
        fill="#333"
        textAnchor="middle"
        fontFamily="Helvetica,Arial,sans-serif"
        fontWeight="700"
        fontSize="11"
      >
        <text x={LABEL_W / 2} y="14">
          {LABEL}
        </text>
        <text x={LABEL_W + VALUE_W / 2 + 3} y="14" fontWeight="400">
          {VALUE}
        </text>
      </g>
    </svg>
  );
}

function SquareBadge() {
  const h = 24;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={TOTAL}
      height={h}
      role="img"
      aria-label={`${LABEL}: ${VALUE}`}
    >
      <rect width={LABEL_W} height={h} fill={LABEL_BG} />
      <rect x={LABEL_W} width={VALUE_W} height={h} fill={EXAMPLE_COLOR} />
      <g
        fill="#fff"
        textAnchor="middle"
        fontFamily="Verdana,Geneva,DejaVu Sans,sans-serif"
        fontSize="11"
        fontWeight="600"
      >
        <text x={LABEL_W / 2} y="16">
          {LABEL}
        </text>
        <text x={LABEL_W + VALUE_W / 2} y="16">
          {VALUE}
        </text>
      </g>
    </svg>
  );
}

interface Variant {
  style: string;
  name: string;
  description: string;
  preview: React.ReactNode;
}

const VARIANTS: Variant[] = [
  {
    style: "default",
    name: "Default (Shields-style)",
    description:
      "Subtle vertical gradient and rounded corners — matches the look-and-feel of badges from shields.io.",
    preview: <DefaultBadge />,
  },
  {
    style: "flat",
    name: "Flat",
    description:
      "Crisp solid colors, no gradient, no shadow. The most readable option on dark or light backgrounds.",
    preview: <FlatBadge />,
  },
  {
    style: "plastic",
    name: "Plastic",
    description:
      "Glossy retro look with a top highlight and bottom shadow — for nostalgia and high-contrast page headers.",
    preview: <PlasticBadge />,
  },
  {
    style: "social",
    name: "Social",
    description:
      "Light background with a thin border, similar to GitHub social-count badges. Best near sign-in / share rows.",
    preview: <SocialBadge />,
  },
  {
    style: "square",
    name: "Square",
    description:
      "Sharp 90° corners and bold text — embeds cleanly into grid layouts and dashboards.",
    preview: <SquareBadge />,
  },
];

function CopyButton({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="h-7 px-2 text-[10px] gap-1.5 shrink-0"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export default function Badges() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <Link
          to="/developers"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to API
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <BadgeCheck className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Badge Style Gallery
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Embed the slop tier and score for any public report straight into your
          README, advisory, or status page. Pick a visual style that matches
          your project — the URL pattern is the same, only the{" "}
          <code className="text-xs px-1 py-0.5 rounded bg-muted/50">style</code>{" "}
          query parameter changes.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <div className="rounded-lg bg-primary/5 border border-primary/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
        Previews below use the example report id{" "}
        <code className="text-xs px-1 py-0.5 rounded bg-muted/50">
          {EXAMPLE_ID}
        </code>{" "}
        with tier <strong className="text-foreground">{EXAMPLE_TIER}</strong>{" "}
        and score <strong className="text-foreground">{EXAMPLE_SCORE}</strong>.
        Replace{" "}
        <code className="text-xs px-1 py-0.5 rounded bg-muted/50">id=…</code>{" "}
        with your own report id when you embed.
      </div>

      <div className="grid grid-cols-1 gap-4">
        {VARIANTS.map((v) => {
          const url = `${origin}/api/embed/badge.svg?id=${EXAMPLE_ID}${v.style === "default" ? "" : `&style=${v.style}`}`;
          const markdown = `[![VulnRap](${url})](${origin}/results/${EXAMPLE_ID})`;
          return (
            <Card
              key={v.style}
              className="glass-card rounded-xl"
              data-testid={`badge-variant-${v.style}`}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  {v.name}
                  <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 font-mono text-muted-foreground">
                    style={v.style}
                  </code>
                </CardTitle>
                <CardDescription className="text-xs">
                  {v.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-md bg-white/95 px-4 py-3 inline-flex items-center justify-center min-h-[60px]">
                  {v.preview}
                </div>

                <div className="space-y-1.5">
                  <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
                    URL
                  </div>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 text-[11px] font-mono rounded-md bg-muted/30 px-3 py-2 overflow-x-auto break-all whitespace-pre-wrap">
                      {url}
                    </pre>
                    <CopyButton text={url} testId={`copy-url-${v.style}`} />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
                    Markdown
                  </div>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 text-[11px] font-mono rounded-md bg-muted/30 px-3 py-2 overflow-x-auto break-all whitespace-pre-wrap">
                      {markdown}
                    </pre>
                    <CopyButton text={markdown} testId={`copy-md-${v.style}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="glass-card rounded-xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">URL pattern</CardTitle>
          <CardDescription className="text-xs">
            All variants share one endpoint. Omit{" "}
            <code className="text-xs px-1 py-0.5 rounded bg-muted/50">
              style
            </code>{" "}
            to get the default Shields-style badge.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs font-mono rounded-md bg-muted/30 px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
            {`${origin}/api/embed/badge.svg?id=<reportId>&style=<default|flat|plastic|social|square>`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
