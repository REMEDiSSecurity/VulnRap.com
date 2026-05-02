import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Task #471 — single source of truth for the "N of M may overwrite recent
// edits" chip rendered on every batch surface. Originally added to the
// removal-batches picker rows (Task #242) and then duplicated onto the
// removal-history panel's batch group header (Task #339); the two render
// sites carried the same Badge JSX, the same AlertTriangle icon, the same
// amber styling, and very similar title / aria-label strings. Pulling them
// into this module mirrors the spirit of the `HandwavyCategoryFlipBadge`
// (Task #338) / `HandwavyRenameBadge` (Task #357) consolidations and keeps
// future tweaks (wording, threshold, colour) in lock-step across all
// surfaces — including the future confirm-dialog mention in Task #471.

export interface HandwavyRemovalBatchConflictChipBaseProps {
  // Number of conflicting phrases inside the batch (re-added to the active
  // list, or carrying a strictly-newer history entry than the batch).
  conflictCount: number;
  // Total number of phrases in the batch — denominator of the "N of M" copy.
  total: number;
  // Test-id the chip should expose. The picker row keeps
  // `handwavy-removal-batches-conflict-chip` and the history panel keeps
  // `handwavy-history-batch-conflict-chip`, so existing E2E selectors
  // (handwavy-removal-batches-panel.spec.ts) keep matching unmodified.
  testId: string;
  // Trailing sentence appended after the shared base title. The picker
  // version ends with "Click to see which." (the chip toggles inline conflict
  // detail); the history-panel version ends with "Use the per-phrase rows
  // below for a finer-grained decision." (the history panel already lists
  // each phrase below the header).
  titleSuffix: string;
}

export interface HandwavyRemovalBatchConflictChipToggleProps
  extends HandwavyRemovalBatchConflictChipBaseProps {
  // Render as a toggle button (picker row) instead of a static Badge.
  // Required when `onToggle` is supplied so reviewers get aria-expanded /
  // aria-controls / keyboard activation for the inline conflict detail panel
  // that lives below the row.
  onToggle: () => void;
  // Whether the inline conflict-detail panel controlled by this chip is
  // currently open. Bound to `aria-expanded` on the button.
  isExpanded: boolean;
  // Id of the inline detail panel — bound to `aria-controls`.
  controlsId: string;
  // Trailing fragment appended to the shared base aria-label after " — ",
  // e.g. "click to expand". Only applies in toggle mode; the static Badge
  // uses just the base aria-label.
  ariaLabelSuffix: string;
}

export type HandwavyRemovalBatchConflictChipProps =
  | HandwavyRemovalBatchConflictChipBaseProps
  | HandwavyRemovalBatchConflictChipToggleProps;

function isToggle(
  props: HandwavyRemovalBatchConflictChipProps,
): props is HandwavyRemovalBatchConflictChipToggleProps {
  return typeof (props as HandwavyRemovalBatchConflictChipToggleProps)
    .onToggle === "function";
}

export function HandwavyRemovalBatchConflictChip(
  props: HandwavyRemovalBatchConflictChipProps,
) {
  const { conflictCount, total, testId, titleSuffix } = props;
  // The original strings used `phrase${total === 1 ? "" : "s"}` for the
  // singular/plural in the title only. The aria-label always used the bare
  // plural "phrases" — preserved as-is so screen-reader output doesn't
  // change.
  const phraseWord = total === 1 ? "phrase" : "phrases";
  const verb = conflictCount === 1 ? "is" : "are";
  const baseTitle = `${conflictCount} of ${total} ${phraseWord} in this batch ${verb} either back on the active list or have a newer removal entry — reinstating this batch will overwrite that newer state.`;
  const baseAriaLabel = `${conflictCount} of ${total} phrases in this batch may overwrite recent edits`;
  const text = `${conflictCount} of ${total} may overwrite recent edits`;
  const title = `${baseTitle} ${titleSuffix}`;

  if (isToggle(props)) {
    return (
      <button
        type="button"
        onClick={props.onToggle}
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] text-amber-300 hover:border-amber-400/60 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70"
        data-testid={testId}
        data-conflict-count={conflictCount}
        data-conflict-total={total}
        aria-expanded={props.isExpanded}
        aria-controls={props.controlsId}
        title={title}
        aria-label={`${baseAriaLabel} — ${props.ariaLabelSuffix}`}
      >
        <AlertTriangle className="w-3 h-3" />
        {text}
      </button>
    );
  }

  return (
    <Badge
      variant="outline"
      className="text-[10px] border-amber-500/40 text-amber-300 gap-1"
      data-testid={testId}
      data-conflict-count={conflictCount}
      data-conflict-total={total}
      title={title}
      aria-label={baseAriaLabel}
    >
      <AlertTriangle className="w-3 h-3" />
      {text}
    </Badge>
  );
}
