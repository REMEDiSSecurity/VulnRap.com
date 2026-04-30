import { Pencil } from "lucide-react";
import type { HandwavyEditEntry } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Task #357 — single source of truth for the FLAT hand-wavy phrase panel's
// "Renamed N×" badge. Renames are recorded as `{ from, to }` entries on the
// per-marker edit log alongside category/rationale changes (Task #247). The
// audit panel previously surfaced category and rationale diffs but skipped
// renames entirely, so reviewers could only learn that a phrase used to be
// called something else by inspecting the JSON. This badge mirrors the
// `HandwavyCategoryFlipBadge` (Task #338) pattern so the active list and the
// removed-history list always agree on what counts as a rename and how it is
// rendered.

// Filter an edit-history list down to the entries that actually carry a
// rename (`phrase: { from, to }`). The audit log omits the `phrase` field
// when only category or rationale changed, so a missing `phrase` block is
// treated as "not a rename". Returns the entries (not a count) so callers can
// both render the transitions in a tooltip AND gate on `.length`.
export function getRenameEdits(
  edits: HandwavyEditEntry[] | undefined | null,
): HandwavyEditEntry[] {
  if (!edits || edits.length === 0) return [];
  return edits.filter((e) => e.phrase && e.phrase.from !== e.phrase.to);
}

export interface HandwavyRenameBadgeProps {
  // Already-filtered list (callers usually compute this once and reuse it for
  // gating logic). The badge re-checks emptiness internally so callers don't
  // have to repeat the guard.
  renames: HandwavyEditEntry[];
  // Test-id prefix so the active-list badge ("handwavy") and the removed-
  // history badge ("handwavy-history") can be selected independently from
  // their respective E2E specs, mirroring `HandwavyCategoryFlipBadge`.
  testIdPrefix: string;
  // Formatter for the per-rename timestamps in the tooltip body. Passed in so
  // the badge stays decoupled from the page-level audit-format helper.
  formatTimestamp?: (iso: string | undefined | null) => string | null;
}

export function HandwavyRenameBadge({
  renames,
  testIdPrefix,
  formatTimestamp,
}: HandwavyRenameBadgeProps) {
  if (renames.length === 0) return null;
  const label =
    renames.length === 1 ? "Renamed" : `Renamed ${renames.length}×`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          className="cursor-help inline-flex"
          data-testid={`${testIdPrefix}-rename-badge`}
          aria-label={
            renames.length === 1
              ? "Phrase has been renamed once"
              : `Phrase has been renamed ${renames.length} times`
          }
        >
          <Badge
            variant="outline"
            className="text-[10px] border-violet-500/40 text-violet-300"
          >
            <Pencil className="w-3 h-3 mr-1" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          collisionPadding={12}
          className="max-w-xs glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal"
          data-testid={`${testIdPrefix}-rename-tooltip`}
        >
          <div className="text-[11px] font-semibold mb-1">
            {renames.length === 1
              ? "Renamed once"
              : `Renamed ${renames.length} times`}
          </div>
          <ol className="space-y-1 text-[10px] leading-snug">
            {renames.map((e, i) => {
              const at = formatTimestamp ? formatTimestamp(e.editedAt) : null;
              return (
                <li key={`${e.editedAt}-${i}`} className="space-y-0.5">
                  <div>
                    <span className="text-muted-foreground">#{i + 1}:</span>{" "}
                    <span className="text-foreground/90 font-mono break-all">
                      &ldquo;{e.phrase!.from}&rdquo;
                    </span>
                    {" → "}
                    <span className="text-foreground/90 font-mono break-all">
                      &ldquo;{e.phrase!.to}&rdquo;
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
