// Task #637 — Pre-submit quality grader.
// Task #965 — Side-by-side draft comparison (sessionStorage baseline).
//
// Pure-client lightweight checklist that grades the report text *before*
// it ever reaches the server. The goal is to nudge the user into
// strengthening the obvious holes (no code, no repro steps, screaming
// caps) before they spend an engine call. The estimated-quality number
// is an approximation of the server-side Engine 2 (substance/quality)
// score — it is intentionally imperfect; the real scoring still happens
// on submit.
//
// Baseline lifecycle (Task #965):
// 1. On mount, load any existing baseline from sessionStorage.
// 2. On unmount (or before-unload), persist the current preview as the
//    baseline so the *next* editing session shows deltas from where the
//    user left off — this is the "since last edit" comparison.
// 3. "Reset baseline" explicitly snapshots the current state as the new
//    baseline, zeroing out deltas mid-session so the user can start
//    measuring improvement from "right now."
//
// All checks are O(n) over the input text and run synchronously on every
// keystroke. Anything heavier than a regex sweep should NOT live here.

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Gauge,
  ListChecks,
  ExternalLink,
  RotateCcw,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";

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

export const BASELINE_KEY = "vulnrap_quality_baseline";

export interface StoredBaseline {
  estimatedScore: number;
  checkStatuses: Record<string, CheckStatus>;
}

export function snapshotBaseline(preview: QualityPreview): StoredBaseline {
  return {
    estimatedScore: preview.estimatedScore,
    checkStatuses: Object.fromEntries(
      preview.checks.map((c) => [c.id, c.status]),
    ),
  };
}

export function loadBaseline(): StoredBaseline | null {
  try {
    const raw = sessionStorage.getItem(BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.estimatedScore === "number" &&
      typeof parsed.checkStatuses === "object" &&
      parsed.checkStatuses !== null &&
      !Array.isArray(parsed.checkStatuses) &&
      Object.values(parsed.checkStatuses).every(
        (v: unknown) => v === "pass" || v === "warn" || v === "fail",
      )
    ) {
      return parsed as StoredBaseline;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveBaseline(baseline: StoredBaseline): void {
  try {
    sessionStorage.setItem(BASELINE_KEY, JSON.stringify(baseline));
  } catch {}
}

const STATUS_RANK: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  pass: 2,
};

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass")
    return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (status === "warn")
    return <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />;
  return <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />;
}

export function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const positive = delta > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-mono font-semibold ${
        positive ? "text-green-400" : "text-destructive"
      }`}
      data-testid="quality-delta-score"
    >
      {positive ? (
        <TrendingUp className="w-3 h-3" />
      ) : (
        <TrendingDown className="w-3 h-3" />
      )}
      {positive ? "+" : ""}
      {delta}
    </span>
  );
}

export function CheckStatusDelta({
  current,
  previous,
}: {
  current: CheckStatus;
  previous: CheckStatus | undefined;
}) {
  if (!previous || current === previous) return null;
  const improved = STATUS_RANK[current] > STATUS_RANK[previous];
  return (
    <span
      className={`text-[10px] font-medium ${
        improved ? "text-green-400" : "text-destructive"
      }`}
      data-testid="quality-delta-check"
    >
      {improved ? (
        <TrendingUp className="w-3 h-3 inline" />
      ) : (
        <TrendingDown className="w-3 h-3 inline" />
      )}
    </span>
  );
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

  const [baseline, setBaseline] = useState<StoredBaseline | null>(() =>
    loadBaseline(),
  );

  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => {
    const persistOnUnload = () => {
      if (previewRef.current.wordCount > 0) {
        saveBaseline(snapshotBaseline(previewRef.current));
      }
    };
    window.addEventListener("beforeunload", persistOnUnload);
    return () => {
      window.removeEventListener("beforeunload", persistOnUnload);
      if (previewRef.current.wordCount > 0) {
        saveBaseline(snapshotBaseline(previewRef.current));
      }
    };
  }, []);

  const scoreDelta =
    baseline && !empty ? preview.estimatedScore - baseline.estimatedScore : 0;

  const hasBaseline = baseline !== null;

  const handleResetBaseline = useCallback(() => {
    const snap = snapshotBaseline(previewRef.current);
    saveBaseline(snap);
    setBaseline(snap);
  }, []);

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
              <span className="flex items-center gap-1.5">
                {scoreDelta !== 0 && <DeltaBadge delta={scoreDelta} />}
                <span
                  className={`font-mono font-bold text-base ${scoreColor(preview.estimatedScore)}`}
                  data-testid="quality-preview-score-value"
                >
                  {empty ? "—" : preview.estimatedScore}
                </span>
              </span>
            </div>
            <Progress
              value={empty ? 0 : preview.estimatedScore}
              className="h-1.5 mt-1"
              indicatorClassName={scoreBar(preview.estimatedScore)}
              aria-label="Estimated report quality score"
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
                <div className="font-medium leading-tight flex items-center gap-1.5">
                  {c.label}
                  {hasBaseline && (
                    <CheckStatusDelta
                      current={c.status}
                      previous={baseline.checkStatuses[c.id]}
                    />
                  )}
                </div>
                <div className="text-muted-foreground leading-tight">
                  {c.detail}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between">
          <Link
            to="/docs/good-report"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            data-testid="quality-preview-docs-link"
          >
            What makes a good report?
            <ExternalLink className="w-3 h-3" />
          </Link>

          {hasBaseline && !empty && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-primary"
              onClick={handleResetBaseline}
              data-testid="quality-reset-baseline"
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              Reset baseline
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
