import { useState, useMemo } from "react";
import { FileText, ChevronDown, ChevronUp, AlertCircle, Leaf } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EvidenceItem {
  type: string;
  description: string;
  weight: number;
  matched?: string | null;
}

interface HighlightedReportProps {
  text: string;
  evidence: EvidenceItem[];
  humanIndicators: EvidenceItem[];
  typeLabels: Record<string, string>;
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

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function HighlightedReport({ text, evidence, humanIndicators, typeLabels }: HighlightedReportProps) {
  const [expanded, setExpanded] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

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

  const rendered = useMemo(() => {
    if (highlights.length === 0) return [text];
    const parts: (string | { span: HighlightSpan; idx: number })[] = [];
    let lastEnd = 0;
    highlights.forEach((span, idx) => {
      if (span.start > lastEnd) {
        parts.push(text.slice(lastEnd, span.start));
      }
      parts.push({ span, idx });
      lastEnd = span.end;
    });
    if (lastEnd < text.length) parts.push(text.slice(lastEnd));
    return parts;
  }, [text, highlights]);

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
          <pre className="glass-card rounded-xl p-4 text-sm font-mono whitespace-pre-wrap overflow-x-auto max-h-[32rem] overflow-y-auto leading-relaxed">
            {rendered.map((part, i) => {
              if (typeof part === "string") return <span key={i}>{part}</span>;
              const { span, idx } = part;
              return (
                <span
                  key={i}
                  className={cn(
                    "rounded px-0.5 py-px cursor-help transition-all border-b-2",
                    span.isHuman
                      ? "bg-green-500/15 border-green-400/60 hover:bg-green-500/25"
                      : "bg-destructive/15 border-destructive/60 hover:bg-destructive/25",
                    hoveredIdx === idx && (span.isHuman ? "bg-green-500/30 ring-1 ring-green-400/40" : "bg-destructive/30 ring-1 ring-destructive/40")
                  )}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  title={`${span.label} (w:${span.weight})`}
                >
                  {span.matchedText}
                </span>
              );
            })}
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
