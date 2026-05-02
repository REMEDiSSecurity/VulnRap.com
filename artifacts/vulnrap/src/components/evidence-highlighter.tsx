import { useState, useMemo, useRef, useEffect } from "react";
import { FileText, ChevronDown, ChevronUp, AlertCircle, Leaf } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

/** Task #451: target line in the report for the diagnostics-panel
 * "structural fabrication" markers to scroll/flash. The `nonce` lets a
 * caller request the same `line` twice in a row (clicking the same marker
 * bullet) and still re-trigger the scroll+flash animation. */
export interface ReportScrollTarget {
  line: number;
  nonce: number;
}

interface HighlightedReportProps {
  text: string;
  evidence: EvidenceItem[];
  humanIndicators: EvidenceItem[];
  typeLabels: Record<string, string>;
  /** Task #451: when set, expand the panel, scroll the matching line into
   * view, and apply a brief flash highlight so the reviewer can see exactly
   * which line a structural-fabrication marker was pointing at. */
  scrollTarget?: ReportScrollTarget | null;
}

interface HighlightSpan {
  start: number;
  end: number;
  type: string;
  label: string;
  weight: number;
  isHuman: boolean;
  matchedText: string;
}

interface LineSegment {
  text: string;
  span?: HighlightSpan;
  spanIdx?: number;
}

interface RenderedLine {
  /** 1-based line number in the original `text`, used as the
   * `data-report-line` attribute so the scroll target can find this row. */
  lineNumber: number;
  segments: LineSegment[];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function HighlightedReport({
  text,
  evidence,
  humanIndicators,
  typeLabels,
  scrollTarget,
}: HighlightedReportProps) {
  const [expanded, setExpanded] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const highlights = useMemo(() => {
    const spans: HighlightSpan[] = [];
    const lowerText = text.toLowerCase();

    const addMatches = (items: EvidenceItem[], isHuman: boolean) => {
      items.forEach((item) => {
        if (!item.matched) return;
        const needle = item.matched.toLowerCase();
        if (needle.length < 3) return;
        let searchFrom = 0;
        const escaped = escapeRegex(needle);
        try {
          const re = new RegExp(escaped, "gi");
          let match: RegExpExecArray | null;
          let count = 0;
          while ((match = re.exec(lowerText)) !== null && count < 3) {
            const s = match.index;
            const e = s + match[0].length;
            const overlaps = spans.some(
              (sp) => (s >= sp.start && s < sp.end) || (e > sp.start && e <= sp.end)
            );
            if (!overlaps) {
              spans.push({
                start: s,
                end: e,
                type: item.type,
                label: typeLabels[item.type] || item.type,
                weight: item.weight,
                isHuman,
                matchedText: text.slice(s, e),
              });
            }
            count++;
          }
        } catch {
          const idx = lowerText.indexOf(needle, searchFrom);
          if (idx >= 0) {
            const overlaps = spans.some(
              (sp) => (idx >= sp.start && idx < sp.end) || (idx + needle.length > sp.start && idx + needle.length <= sp.end)
            );
            if (!overlaps) {
              spans.push({
                start: idx,
                end: idx + needle.length,
                type: item.type,
                label: typeLabels[item.type] || item.type,
                weight: item.weight,
                isHuman,
                matchedText: text.slice(idx, idx + needle.length),
              });
            }
          }
        }
      });
    };

    addMatches(evidence, false);
    addMatches(humanIndicators, true);
    spans.sort((a, b) => a.start - b.start);
    return spans;
  }, [text, evidence, humanIndicators, typeLabels]);

  const totalHighlights = highlights.length;
  const slopHighlights = highlights.filter((h) => !h.isHuman).length;
  const humanHighlights = highlights.filter((h) => h.isHuman).length;

  // Task #451: split the text into per-line rows so each line gets a
  // `data-report-line` anchor and the structural-fabrication markers can
  // scroll the correct row into view. Highlights are intersected with each
  // line's character range so a span that crosses a newline (rare but
  // possible) still renders correctly on each line it visits.
  const lines = useMemo<RenderedLine[]>(() => {
    const lineTexts = text.split("\n");
    const result: RenderedLine[] = [];
    let lineStart = 0;
    let highlightCursor = 0;
    for (let li = 0; li < lineTexts.length; li++) {
      const lineText = lineTexts[li];
      const lineEnd = lineStart + lineText.length;
      const segments: LineSegment[] = [];
      let cursor = lineStart;
      // Walk the (sorted) highlights starting from the first one that may
      // intersect this line. Earlier highlights are guaranteed to end on or
      // before lineStart, so `highlightCursor` only ever advances.
      for (let hi = highlightCursor; hi < highlights.length; hi++) {
        const span = highlights[hi];
        if (span.end <= lineStart) {
          highlightCursor = hi + 1;
          continue;
        }
        if (span.start >= lineEnd) break;
        const segStart = Math.max(span.start, lineStart);
        const segEnd = Math.min(span.end, lineEnd);
        if (cursor < segStart) {
          segments.push({ text: text.slice(cursor, segStart) });
        }
        segments.push({
          text: text.slice(segStart, segEnd),
          span,
          spanIdx: hi,
        });
        cursor = segEnd;
      }
      if (cursor < lineEnd) {
        segments.push({ text: text.slice(cursor, lineEnd) });
      }
      // Empty lines should still render so blank rows don't visually
      // collapse — a single zero-length segment keeps the row's height.
      if (segments.length === 0) segments.push({ text: "" });
      result.push({ lineNumber: li + 1, segments });
      // +1 for the `\n` we consumed in `split` (the last line has no
      // trailing newline; the +1 doesn't matter past the loop end).
      lineStart = lineEnd + 1;
    }
    return result;
  }, [text, highlights]);

  // Task #451: when a structural-fabrication marker is clicked, expand the
  // panel (so the row exists in the DOM), scroll to the row, and flash it
  // for ~1.5s so the reviewer's eye lands on it. The `nonce` lets the
  // caller re-request the same line and still re-trigger the animation.
  useEffect(() => {
    if (!scrollTarget) return;
    setExpanded(true);
  }, [scrollTarget]);

  useEffect(() => {
    if (!scrollTarget || !expanded) return;
    // Defer to a microtask so the `expanded` state has flushed and the
    // `<pre>` content is mounted before we query for the target row.
    const id = requestAnimationFrame(() => {
      const pre = preRef.current;
      if (!pre) return;
      const row = pre.querySelector<HTMLElement>(
        `[data-report-line="${scrollTarget.line}"]`,
      );
      if (!row) return;
      // Use scrollTo on the pre rather than `scrollIntoView({block:
      // 'center'})` so we don't also scroll the surrounding page when the
      // line is already on-screen — only the report container moves.
      const rowOffset = row.offsetTop - pre.offsetTop;
      const desired = rowOffset - pre.clientHeight / 2 + row.clientHeight / 2;
      pre.scrollTo({
        top: Math.max(0, desired),
        behavior: "smooth",
      });
      setFlashLine(scrollTarget.line);
    });
    return () => cancelAnimationFrame(id);
  }, [scrollTarget, expanded]);

  // Clear the flash class after ~1.5s so the highlight pulse fades and
  // doesn't stay stuck on the row forever. Re-keyed on `scrollTarget.nonce`
  // so a second click on the same marker resets the timer.
  useEffect(() => {
    if (flashLine === null) return;
    const t = window.setTimeout(() => setFlashLine(null), 1600);
    return () => window.clearTimeout(t);
    // We deliberately depend on `scrollTarget?.nonce` (not `flashLine`) so
    // re-clicking the same marker resets the timer. `flashLine` is in the
    // dep list so the effect runs when it transitions from null to a line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashLine, scrollTarget?.nonce]);

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader className="cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <CardTitle className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          Report Text
          {totalHighlights > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
              {totalHighlights} citation{totalHighlights !== 1 ? "s" : ""}
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-2">
            {slopHighlights > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-destructive/70">
                <AlertCircle className="w-3 h-3" />{slopHighlights} flag{slopHighlights !== 1 ? "s" : ""}
              </span>
            )}
            {humanHighlights > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-green-400/70">
                <Leaf className="w-3 h-3" />{humanHighlights} human
              </span>
            )}
            {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </span>
        </CardTitle>
        <CardDescription>
          {expanded ? "Redacted report with evidence highlighted inline" : "Click to view report text with evidence citations"}
        </CardDescription>
      </CardHeader>
      {expanded && (
        <CardContent>
          {hoveredIdx !== null && highlights[hoveredIdx] && (
            <div className={cn(
              "mb-3 rounded-lg border p-2.5 text-xs flex items-center gap-2 animate-in fade-in duration-150",
              highlights[hoveredIdx].isHuman
                ? "bg-green-500/10 border-green-500/20 text-green-400"
                : "bg-destructive/10 border-destructive/20 text-destructive"
            )}>
              {highlights[hoveredIdx].isHuman ? <Leaf className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
              <span className="font-medium">{highlights[hoveredIdx].label}</span>
              <span className="text-muted-foreground">weight: {highlights[hoveredIdx].weight}</span>
            </div>
          )}
          <pre
            ref={preRef}
            className="glass-card rounded-xl p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto max-h-[32rem] overflow-y-auto leading-relaxed"
          >
            {lines.map((row) => (
              <div
                key={row.lineNumber}
                data-report-line={row.lineNumber}
                data-testid={`report-line-${row.lineNumber}`}
                className={cn(
                  "rounded-sm transition-colors duration-300",
                  flashLine === row.lineNumber &&
                    "bg-yellow-400/30 ring-1 ring-yellow-400/60 -mx-1 px-1",
                )}
              >
                {row.segments.map((seg, si) => {
                  if (!seg.span) {
                    // `\u200B` keeps an empty line from collapsing to zero
                    // visual height inside the surrounding `<pre>`.
                    return <span key={si}>{seg.text === "" ? "\u200B" : seg.text}</span>;
                  }
                  const span = seg.span;
                  const idx = seg.spanIdx ?? -1;
                  return (
                    <span
                      key={si}
                      className={cn(
                        "rounded px-0.5 py-px cursor-help transition-all border-b-2",
                        span.isHuman
                          ? "bg-green-500/15 border-green-400/60 hover:bg-green-500/25"
                          : "bg-destructive/15 border-destructive/60 hover:bg-destructive/25",
                        hoveredIdx === idx && (span.isHuman ? "bg-green-500/30 ring-1 ring-green-400/40" : "bg-destructive/30 ring-1 ring-destructive/40"),
                      )}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                      title={`${span.label} (w:${span.weight})`}
                    >
                      {seg.text}
                    </span>
                  );
                })}
              </div>
            ))}
          </pre>
          {totalHighlights > 0 && (
            <div className="mt-3 flex items-center gap-4 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="w-3 h-1.5 rounded-sm bg-destructive/40 border-b border-destructive/60" />
                AI/slop signal
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-1.5 rounded-sm bg-green-500/40 border-b border-green-400/60" />
                Human signal
              </span>
              <span className="italic">Hover to see details</span>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
