import { useMemo, useState } from "react";
import { Flame, AlertCircle, Leaf } from "lucide-react";
import { cn } from "@/lib/utils";

/** Optional structured marker (Task #435/#451) attached to evidence rows
 * such as `hallucination_structural_fabrication`. When the engine recorded
 * an authoritative byte range into the original report, we use it directly
 * instead of fuzzy substring search — the heatmap then tints exactly the
 * characters the engine flagged. */
interface EvidenceMarkerRange {
  start: number;
  end: number;
  line?: number;
}

interface EvidenceMarker {
  id: string;
  description: string;
  range?: EvidenceMarkerRange;
}

export interface HeatmapEvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
  context?: {
    markers?: EvidenceMarker[];
  } | null;
}

export interface HeatmapHumanIndicator {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

interface SignalHeatmapRendererProps {
  text: string;
  evidence: HeatmapEvidenceItem[];
  humanIndicators: HeatmapHumanIndicator[];
  typeLabels: Record<string, string>;
}

interface HeatSpan {
  start: number;
  end: number;
  type: string;
  label: string;
  description: string;
  weight: number;
  isHuman: boolean;
  /** Engine-reported range vs. derived-from-substring. We expose this on
   * the rendered span (`data-source`) so tests can assert that range-backed
   * evidence is preferred over the heuristic `matched`-text fallback. */
  source: "range" | "match";
  markerId?: string;
}

interface CharCell {
  signals: HeatSpan[];
}

// Stable, distinguishable hues per signal type. We hash the type string
// into an HSL hue so the same signal id keeps the same color across
// renders and reports — critical for the legend to be useful.
function hueForType(type: string): number {
  let h = 0;
  for (let i = 0; i < type.length; i++) {
    h = (h * 31 + type.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function colorForSpan(span: HeatSpan, opacity: number): string {
  if (span.isHuman) {
    // Human signals share a green family so reviewers can immediately
    // separate "good" from "bad" without consulting the legend.
    return `hsla(140, 70%, 55%, ${opacity})`;
  }
  return `hsla(${hueForType(span.type)}, 75%, 58%, ${opacity})`;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function SignalHeatmapRenderer({
  text,
  evidence,
  humanIndicators,
  typeLabels,
}: SignalHeatmapRendererProps) {
  const [hovered, setHovered] = useState<HeatSpan[] | null>(null);

  const spans = useMemo(() => {
    const out: HeatSpan[] = [];
    const N = text.length;
    const lowerText = text.toLowerCase();

    // Pass 1 — engine-authoritative ranges. Today only
    // `hallucination_structural_fabrication` populates `context.markers[].range`
    // (see results.tsx local type definition + Task #451), but any future
    // signal that records ranges will automatically heat-map correctly.
    // No 3-match cap: if the engine fired N ranges we render N spans.
    for (const item of evidence) {
      const markers = item.context?.markers;
      if (!markers) continue;
      for (const m of markers) {
        const r = m.range;
        if (!r) continue;
        const s = Math.max(0, Math.min(N, r.start));
        const e = Math.max(s, Math.min(N, r.end));
        if (e <= s) continue;
        out.push({
          start: s,
          end: e,
          type: item.type,
          label: typeLabels[item.type] || item.type,
          description: m.description || item.description,
          weight: item.weight,
          isHuman: false,
          source: "range",
          markerId: m.id,
        });
      }
    }

    // Pass 2 — fallback for evidence rows without engine-supplied ranges.
    // We reuse the same `matched`-string lookup the existing
    // EvidenceHighlighter uses so the two views stay consistent for
    // signals that have no structured range data. The fallback is gated
    // *per row* (not per `type`) so two evidence rows sharing the same
    // type — one with ranges, one with only `matched` — both render.
    const rowHasRange = (item: HeatmapEvidenceItem) =>
      Boolean(item.context?.markers?.some((m) => m.range));
    const addMatches = (
      item: HeatmapEvidenceItem | HeatmapHumanIndicator,
      isHuman: boolean,
    ) => {
      if (!item.matched) return;
      const needle = item.matched.toLowerCase();
      if (needle.length < 3) return;
      try {
        const re = new RegExp(escapeRegex(needle), "gi");
        let m: RegExpExecArray | null;
        let n = 0;
        // Cap match-based fallback at 3 occurrences (same as
        // EvidenceHighlighter) so a single common phrase doesn't tint the
        // whole report. Range-backed spans above are uncapped.
        while ((m = re.exec(lowerText)) !== null && n < 3) {
          out.push({
            start: m.index,
            end: m.index + m[0].length,
            type: item.type,
            label: typeLabels[item.type] || item.type,
            description: item.description,
            weight: item.weight,
            isHuman,
            source: "match",
          });
          n++;
        }
      } catch {
        // Defensive: if escapeRegex misses something exotic, skip.
      }
    };
    for (const item of evidence) {
      if (rowHasRange(item)) continue;
      addMatches(item, false);
    }
    for (const item of humanIndicators) addMatches(item, true);
    return out;
  }, [text, evidence, humanIndicators, typeLabels]);

  // Build a per-character signal stack. We then collapse adjacent chars
  // that share the same signal-stack into a single rendered cell, which
  // keeps DOM size manageable on long reports while still letting two
  // overlapping signals tint the same span.
  const cells = useMemo(() => {
    const N = text.length;
    if (N === 0 || spans.length === 0) {
      return [{ start: 0, end: N, signals: [] as HeatSpan[] }];
    }
    const charSignals: HeatSpan[][] = new Array(N);
    for (let i = 0; i < N; i++) charSignals[i] = [];
    for (const sp of spans) {
      const s = Math.max(0, sp.start);
      const e = Math.min(N, sp.end);
      for (let i = s; i < e; i++) charSignals[i].push(sp);
    }
    const out: { start: number; end: number; signals: HeatSpan[] }[] = [];
    let cur: CharCell = { signals: charSignals[0] };
    let curStart = 0;
    const sameStack = (a: HeatSpan[], b: HeatSpan[]) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    for (let i = 1; i < N; i++) {
      if (!sameStack(cur.signals, charSignals[i])) {
        out.push({ start: curStart, end: i, signals: cur.signals });
        cur = { signals: charSignals[i] };
        curStart = i;
      }
    }
    out.push({ start: curStart, end: N, signals: cur.signals });
    return out;
  }, [text, spans]);

  // Legend lists each unique fired signal once, in stable order, so the
  // colors in the report map back to a name + description.
  const legend = useMemo(() => {
    const seen = new Map<string, HeatSpan>();
    for (const sp of spans) {
      if (!seen.has(sp.type)) seen.set(sp.type, sp);
    }
    return Array.from(seen.values());
  }, [spans]);

  const slopCount = spans.filter((s) => !s.isHuman).length;
  const humanCount = spans.filter((s) => s.isHuman).length;
  const rangeCount = spans.filter((s) => s.source === "range").length;

  return (
    <div className="space-y-3" data-testid="signal-heatmap-renderer">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1">
          <Flame className="w-3.5 h-3.5 text-orange-400" />
          Heatmap view — characters tinted by which signals fired
        </span>
        {slopCount > 0 && (
          <span className="flex items-center gap-1 text-destructive/80">
            <AlertCircle className="w-3 h-3" />
            {slopCount} slop signal{slopCount !== 1 ? "s" : ""}
          </span>
        )}
        {humanCount > 0 && (
          <span className="flex items-center gap-1 text-green-400/80">
            <Leaf className="w-3 h-3" />
            {humanCount} human signal{humanCount !== 1 ? "s" : ""}
          </span>
        )}
        {rangeCount > 0 && (
          <span className="text-muted-foreground/70" data-testid="heatmap-range-count">
            {rangeCount} engine-range
          </span>
        )}
      </div>

      {hovered && hovered.length > 0 && (
        <div
          className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs space-y-1.5 animate-in fade-in duration-150"
          data-testid="heatmap-hover-card"
        >
          {hovered.map((sp, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className="mt-1 inline-block w-3 h-3 rounded-sm flex-shrink-0 border"
                style={{
                  background: colorForSpan(sp, 0.55),
                  borderColor: colorForSpan(sp, 0.9),
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={cn(
                      "font-mono text-[10px] uppercase tracking-wide",
                      sp.isHuman ? "text-green-400" : "text-destructive",
                    )}
                    data-testid={`heatmap-hover-type-${sp.type}`}
                  >
                    {sp.markerId ? `${sp.type}:${sp.markerId}` : sp.type}
                  </span>
                  <span className="font-medium">{sp.label}</span>
                  <span className="text-muted-foreground">w:{sp.weight}</span>
                  <span className="text-[10px] text-muted-foreground/60 italic">
                    via {sp.source}
                  </span>
                </div>
                <div className="text-muted-foreground leading-snug mt-0.5">{sp.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <pre
        className="glass-card rounded-xl p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto max-h-[32rem] overflow-y-auto leading-relaxed"
        data-testid="heatmap-pre"
      >
        {cells.map((cell, i) => {
          const segText = text.slice(cell.start, cell.end);
          if (cell.signals.length === 0) {
            return <span key={i}>{segText}</span>;
          }
          // Stack overlapping signal colors as a layered linear-gradient
          // so two firing signals at the same character produce a visibly
          // mixed band (top half = first signal, bottom = second, etc.)
          // — without this, the second signal would silently overwrite
          // the first.
          const n = cell.signals.length;
          const stops = cell.signals
            .map((sp, k) => {
              const a = colorForSpan(sp, 0.45);
              const from = (k * 100) / n;
              const to = ((k + 1) * 100) / n;
              return `${a} ${from}%, ${a} ${to}%`;
            })
            .join(", ");
          const borderColor = colorForSpan(cell.signals[cell.signals.length - 1], 0.9);
          const isHumanStack = cell.signals.every((s) => s.isHuman);
          const tooltip = cell.signals
            .map((s) => `${s.type}: ${s.label} (w:${s.weight})`)
            .join(" + ");
          return (
            <span
              key={i}
              className={cn(
                "rounded-sm cursor-help transition-all border-b-2",
                isHumanStack ? "border-green-400/70" : "",
              )}
              style={{
                background: `linear-gradient(to bottom, ${stops})`,
                borderBottomColor: borderColor,
              }}
              onMouseEnter={() => setHovered(cell.signals)}
              onMouseLeave={() => setHovered(null)}
              title={tooltip}
              data-signal-types={cell.signals.map((s) => s.type).join(",")}
              data-source={cell.signals.map((s) => s.source).join(",")}
              data-start={cell.start}
              data-end={cell.end}
            >
              {segText}
            </span>
          );
        })}
      </pre>

      {legend.length > 0 ? (
        <div className="rounded-lg border border-border/40 bg-muted/10 p-3" data-testid="heatmap-legend">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
            Legend — {legend.length} firing signal{legend.length !== 1 ? "s" : ""}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {legend.map((sp) => (
              <div
                key={sp.type}
                className="flex items-center gap-1.5 text-[11px]"
                data-testid={`heatmap-legend-${sp.type}`}
              >
                <span
                  className="inline-block w-3 h-3 rounded-sm border"
                  style={{
                    background: colorForSpan(sp, 0.55),
                    borderColor: colorForSpan(sp, 0.9),
                  }}
                />
                <span className={cn("font-mono text-[10px]", sp.isHuman ? "text-green-400/90" : "text-foreground/80")}>
                  {sp.type}
                </span>
                <span className="text-muted-foreground">{sp.label}</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-muted-foreground/70 mt-2 italic">
            Overlapping signals stack as horizontal bands. Hover a span for the
            firing signal id and description. Engine-supplied ranges are used
            when present; otherwise the matched-text fallback (capped at 3
            occurrences per signal) is used.
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground italic" data-testid="heatmap-no-signals">
          No signals fired with locatable evidence — nothing to tint.
        </div>
      )}
    </div>
  );
}
