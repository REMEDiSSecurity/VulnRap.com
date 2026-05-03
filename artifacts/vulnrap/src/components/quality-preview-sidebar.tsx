// Task #637 — Pre-submit quality grader.
//
// Pure-client lightweight checklist that grades the report text *before*
// it ever reaches the server. The goal is to nudge the user into
// strengthening the obvious holes (no code, no repro steps, screaming
// caps) before they spend an engine call. The estimated-quality number
// is an approximation of the server-side Engine 2 (substance/quality)
// score — it is intentionally imperfect; the real scoring still happens
// on submit.
//
// All checks are O(n) over the input text and run synchronously on every
// keystroke. Anything heavier than a regex sweep should NOT live here.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Gauge,
  ListChecks,
  ExternalLink,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export type CheckStatus = "pass" | "warn" | "fail";

export interface QualityCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QualityPreview {
  wordCount: number;
  hasCodeBlock: boolean;
  urlCount: number;
  stepwiseCount: number;
  capsRatio: number;
  estimatedScore: number;
  checks: QualityCheck[];
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/gi;
const CODE_FENCE_RE = /```[\s\S]+?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const STEP_RE = /(^|\n)\s*\d+[.)]\s+\S/g;
const LETTER_RE = /[A-Za-z]/g;
const UPPER_LETTER_RE = /[A-Z]/g;

export function computeQualityPreview(input: string): QualityPreview {
  const text = (input ?? "").toString();
  const trimmed = text.trim();

  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;

  const hasFencedBlock = CODE_FENCE_RE.test(text);
  CODE_FENCE_RE.lastIndex = 0;
  const inlineMatches = text.match(INLINE_CODE_RE) ?? [];
  const hasCodeBlock = hasFencedBlock || inlineMatches.length >= 2;

  const urlMatches = text.match(URL_RE) ?? [];
  const urlCount = urlMatches.length;

  const stepwiseCount = (text.match(STEP_RE) ?? []).length;

  const letters = (text.match(LETTER_RE) ?? []).length;
  const uppers = (text.match(UPPER_LETTER_RE) ?? []).length;
  // Only consider all-caps abuse meaningful once there's enough text to
  // judge — otherwise a 5-letter title like "RCE" trips it.
  const capsRatio = letters >= 40 ? uppers / letters : 0;

  const checks: QualityCheck[] = [
    {
      id: "word-count",
      label: "≥150 words",
      status: wordCount >= 150 ? "pass" : wordCount >= 75 ? "warn" : "fail",
      detail: `${wordCount} word${wordCount === 1 ? "" : "s"}`,
    },
    {
      id: "code-block",
      label: "Includes code block",
      status: hasFencedBlock
        ? "pass"
        : inlineMatches.length >= 2
          ? "warn"
          : "fail",
      detail: hasFencedBlock
        ? "Fenced code block found"
        : inlineMatches.length >= 2
          ? `${inlineMatches.length} inline snippets — fence them in \`\`\` for clarity`
          : "No code or commands shown",
    },
    {
      id: "urls",
      label: "≥1 URL / reference",
      status: urlCount >= 2 ? "pass" : urlCount === 1 ? "warn" : "fail",
      detail:
        urlCount === 0
          ? "No links — add a CVE, advisory, or commit"
          : `${urlCount} link${urlCount === 1 ? "" : "s"} found`,
    },
    {
      id: "steps",
      label: "Stepwise repro (1., 2., …)",
      status:
        stepwiseCount >= 3 ? "pass" : stepwiseCount >= 1 ? "warn" : "fail",
      detail:
        stepwiseCount === 0
          ? "No numbered steps detected"
          : `${stepwiseCount} numbered step${stepwiseCount === 1 ? "" : "s"}`,
    },
    {
      id: "caps",
      label: "Not all caps",
      status: capsRatio > 0.1 ? "fail" : capsRatio > 0.05 ? "warn" : "pass",
      detail:
        letters < 40
          ? "Not enough text to judge"
          : `${Math.round(capsRatio * 100)}% uppercase`,
    },
  ];

  // Approximation of Engine 2 (substance/quality). Server-side quality
  // is computed from much richer signals (per-section coverage, factual
  // density, etc) — this is a deliberately rough proxy meant only to
  // tell the user "your draft looks roughly good / fair / poor".
  let score = 0;
  if (wordCount >= 150) score += 25;
  else if (wordCount >= 75) score += 12;
  else if (wordCount >= 25) score += 4;

  if (hasFencedBlock) score += 20;
  else if (inlineMatches.length >= 2) score += 8;

  if (urlCount >= 2) score += 20;
  else if (urlCount === 1) score += 10;

  if (stepwiseCount >= 3) score += 25;
  else if (stepwiseCount >= 1) score += 12;

  if (capsRatio > 0.1) score -= 15;
  else if (capsRatio > 0.05) score -= 5;
  else score += 10;

  const estimatedScore = Math.max(0, Math.min(100, score));

  return {
    wordCount,
    hasCodeBlock,
    urlCount,
    stepwiseCount,
    capsRatio,
    estimatedScore,
    checks,
  };
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass")
    return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (status === "warn")
    return <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />;
  return <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />;
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-400";
  if (score >= 40) return "text-yellow-500";
  return "text-destructive";
}

function scoreBar(score: number): string {
  if (score >= 70) return "bg-green-500";
  if (score >= 40) return "bg-yellow-500";
  return "bg-destructive";
}

function scoreLabel(score: number): string {
  if (score >= 70) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

interface Props {
  text: string;
  className?: string;
  compact?: boolean;
}

export function QualityPreviewSidebar({ text, className, compact }: Props) {
  const preview = useMemo(() => computeQualityPreview(text), [text]);
  const empty = preview.wordCount === 0;

  return (
    <Card
      className={`glass-card rounded-xl ${className ?? ""}`}
      data-testid="quality-preview-sidebar"
    >
      <CardHeader className={compact ? "pb-2" : undefined}>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ListChecks className="w-4 h-4 text-primary" />
          Quality preview
        </CardTitle>
        <CardDescription className="text-xs">
          Live local checks — runs as you type. Fix the obvious gaps before
          spending an engine call.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex items-center gap-3"
          data-testid="quality-preview-score"
        >
          <Gauge className={`w-5 h-5 ${scoreColor(preview.estimatedScore)}`} />
          <div className="flex-1">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground uppercase tracking-wide">
                Estimated quality
              </span>
              <span
                className={`font-mono font-bold text-base ${scoreColor(preview.estimatedScore)}`}
                data-testid="quality-preview-score-value"
              >
                {empty ? "—" : preview.estimatedScore}
              </span>
            </div>
            <Progress
              value={empty ? 0 : preview.estimatedScore}
              className="h-1.5 mt-1"
              indicatorClassName={scoreBar(preview.estimatedScore)}
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              {empty
                ? "Start typing to see a draft score."
                : `${scoreLabel(preview.estimatedScore)} — approximation of Engine 2 only.`}
            </div>
          </div>
        </div>

        <ul className="space-y-1.5" data-testid="quality-preview-checks">
          {preview.checks.map((c) => (
            <li
              key={c.id}
              className="flex items-start gap-2 text-xs"
              data-testid={`quality-check-${c.id}`}
              data-status={c.status}
            >
              <StatusIcon status={c.status} />
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-tight">{c.label}</div>
                <div className="text-muted-foreground leading-tight">
                  {c.detail}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <Link
          to="/docs/good-report"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          data-testid="quality-preview-docs-link"
        >
          What makes a good report?
          <ExternalLink className="w-3 h-3" />
        </Link>
      </CardContent>
    </Card>
  );
}
