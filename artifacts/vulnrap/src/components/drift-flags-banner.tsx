// Task #195 — Reviewer-only in-product banner that surfaces currently-firing
// AVRI calibration drift flags on the home and results pages. Task #83
// already pushes these flags out via the configured webhook
// (Slack/PagerDuty); this banner closes the loop for reviewers who don't
// subscribe to that webhook but happen to land on the site.
//
// Gating
//   The banner is rendered only when `getCalibrationToken()` returns a
//   non-empty string. Public visitors don't have a reviewer token in the
//   build (`VITE_CALIBRATION_TOKEN` unset → `setCalibrationToken(undefined)`
//   in main.tsx), so the banner stays hidden for them and the calibration
//   drift report endpoint isn't even fetched.
//
// Dismissal
//   The dismiss button stores a fingerprint of the currently-firing flag
//   set in localStorage. The banner re-arms automatically when a new flag
//   appears (or the set otherwise changes) so reviewers don't have to keep
//   re-opening the page to see fresh drift.

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import {
  useGetAvriDriftReport,
  getGetAvriDriftReportQueryKey,
  getCalibrationToken,
  type AvriDriftFlag,
} from "@workspace/api-client-react";

const DISMISSED_KEY = "vulnrap-drift-banner-dismissed";

// Mirrors feedback-analytics.tsx so reviewers land on the same rendered
// runbook regardless of which surface launched them at it.
const AVRI_DRIFT_RUNBOOK_REPO_BASE =
  "https://github.com/REMEDiSSecurity/VulnRap.Com/blob/main/";

function runbookUrl(runbookPath: string): string {
  if (/^https?:\/\//i.test(runbookPath)) return runbookPath;
  const cleaned = runbookPath.replace(/^\.?\/+/, "");
  return AVRI_DRIFT_RUNBOOK_REPO_BASE + cleaned;
}

// Stable fingerprint: ordered + delimited so two flag sets only collide when
// every (weekStart, kind, detail) tuple matches. Detail is included because
// the FAMILY_MEAN_SHIFT detail string carries the family + delta that the
// reviewer is being asked to look at — a new family flagging on the same
// week is a genuinely new alert.
function fingerprintFlags(flags: AvriDriftFlag[]): string {
  return flags
    .map(f => `${f.weekStart}|${f.kind}|${f.detail}`)
    .sort()
    .join("\n");
}

function readDismissedFingerprint(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissedFingerprint(fp: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, fp);
  } catch {
    /* storage unavailable (private mode, quota) — banner just won't persist dismissal */
  }
}

export function DriftFlagsBanner() {
  const isReviewer = Boolean(getCalibrationToken());
  const [dismissedFingerprint, setDismissedFingerprint] = useState<string | null>(
    () => readDismissedFingerprint(),
  );

  // `enabled` keeps the public site from making an authenticated GET it has
  // no use for. The endpoint itself is public-readable (no auth required)
  // but skipping it keeps the network panel clean for non-reviewers.
  const { data } = useGetAvriDriftReport(undefined, {
    query: {
      queryKey: getGetAvriDriftReportQueryKey(),
      enabled: isReviewer,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  });

  const flags = data?.flags ?? [];
  const fingerprint = useMemo(() => fingerprintFlags(flags), [flags]);

  if (!isReviewer) return null;
  if (flags.length === 0) return null;
  if (dismissedFingerprint && dismissedFingerprint === fingerprint) return null;

  const gapFlags = flags.filter(f => f.kind === "GAP_BELOW_45").length;
  const familyFlags = flags.filter(f => f.kind === "FAMILY_MEAN_SHIFT").length;
  const summary: string[] = [];
  if (gapFlags > 0) summary.push(`${gapFlags} rubric-collapse`);
  if (familyFlags > 0) summary.push(`${familyFlags} per-family weight drift`);

  const handleDismiss = () => {
    setDismissedFingerprint(fingerprint);
    writeDismissedFingerprint(fingerprint);
  };

  return (
    <div
      data-testid="drift-flags-banner"
      className="relative mt-2 sm:mt-4 mx-auto max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/5 backdrop-blur-sm px-3 sm:px-4 py-3 flex items-start gap-2.5 sm:gap-3 text-sm"
    >
      <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <div className="flex-1 text-muted-foreground leading-relaxed text-xs sm:text-sm space-y-1">
        <div>
          <span className="text-amber-300 font-semibold">AVRI calibration drift:</span>{" "}
          {flags.length} flag{flags.length === 1 ? "" : "s"} firing
          {summary.length > 0 ? ` (${summary.join(", ")})` : ""}. The rubric may
          be collapsing or a family weight may have shifted — check the
          calibration dashboard before triaging.
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Link
            to="/feedback-analytics"
            data-testid="link-drift-banner-dashboard"
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200 transition-colors font-medium"
          >
            Open calibration dashboard
          </Link>
          <a
            href={runbookUrl(data?.runbookPath ?? "docs/avri-drift-runbook.md")}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-drift-banner-runbook"
            className="inline-flex items-center gap-1 text-amber-300/90 underline underline-offset-2 hover:text-amber-200 transition-colors"
          >
            Drift runbook <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
      <button
        onClick={handleDismiss}
        data-testid="button-drift-banner-dismiss"
        className="shrink-0 text-muted-foreground/60 hover:text-amber-300 transition-colors p-0.5 rounded"
        aria-label="Dismiss drift banner"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
