import { ArrowLeftRight } from "lucide-react";
import type { HandwavyEditEntry } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Task #338 — single source of truth for the FLAT hand-wavy phrase panel's
// "N category flips" badge. Both the active-phrase rows (Task #149) and the
// removed-history rows (Task #234) used to render near-identical JSX +
// filter/threshold logic; pulling them into this module keeps future
// tweaks (threshold, tooltip layout, what counts as a "flip") in one place.

// Threshold below which the badge is suppressed. Tuned to keep one-off
// re-categorizations from generating noise — only phrases that have actually
// bounced between categories surface a badge.
export const HANDWAVY_CATEGORY_FLIP_MIN = 2;

// Filter an edit-history list down to the transition entries that actually
// changed the category. The audit log omits the `category` field when only
// the rationale changed, so a missing `category` block is treated as "not a
// flip". Returns the entries (not a count) so callers can both render the
// transitions in a tooltip AND gate on `.length` against
// HANDWAVY_CATEGORY_FLIP_MIN.
export function getCategoryFlips(
  edits: HandwavyEditEntry[] | undefined | null,
): HandwavyEditEntry[] {
  if (!edits || edits.length === 0) return [];
  return edits.filter((e) => e.category && e.category.from !== e.category.to);
}

export interface HandwavyCategoryFlipBadgeProps {
  // Already-filtered list (callers usually compute this once and reuse it for
  // gating logic). The badge re-checks the threshold internally so callers
  // don't have to repeat the `>= HANDWAVY_CATEGORY_FLIP_MIN` guard.
  flips: HandwavyEditEntry[];
  // Test-id prefix so the active-list badge ("handwavy") and the removed-
  // history badge ("handwavy-history") keep their existing selectors. This
  // is what the existing E2E specs latch onto.
  testIdPrefix: string;
  // Formatter for the per-transition timestamps in the tooltip body. Passed
  // in so the badge stays decoupled from the page-level audit-format helper.
  formatTimestamp?: (iso: string | undefined | null) => string | null;
}

export function HandwavyCategoryFlipBadge({
  flips,
  testIdPrefix,
  formatTimestamp,
}: HandwavyCategoryFlipBadgeProps) {
  if (flips.length < HANDWAVY_CATEGORY_FLIP_MIN) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          className="cursor-help inline-flex"
          data-testid={`${testIdPrefix}-category-flip-badge`}
          aria-label={`Category changed ${flips.length} times across edit history`}
        >
          <Badge
            variant="outline"
            className="text-[10px] border-sky-500/40 text-sky-300"
          >
            <ArrowLeftRight className="w-3 h-3 mr-1" />
            {flips.length} category flips
          </Badge>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          collisionPadding={12}
          className="max-w-xs glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal"
          data-testid={`${testIdPrefix}-category-flip-tooltip`}
        >
          <div className="text-[11px] font-semibold mb-1">
            Category changed {flips.length} times
          </div>
          <ol className="space-y-1 text-[10px] leading-snug">
            {flips.map((e, i) => {
              const at = formatTimestamp ? formatTimestamp(e.editedAt) : null;
              return (
                <li key={`${e.editedAt}-${i}`} className="space-y-0.5">
                  <div>
                    <span className="text-muted-foreground">#{i + 1}:</span>{" "}
                    <span className="text-foreground/90 capitalize">
                      {e.category!.from}
                    </span>
                    {" → "}
                    <span className="text-foreground/90 capitalize">
                      {e.category!.to}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    by{" "}
                    <span className="text-foreground/80">
                      {e.editedBy || "anonymous"}
                    </span>
                    {at && <> • {at}</>}
                  </div>
                </li>
              );
            })}
          </ol>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
