import { useRef, useCallback, useLayoutEffect, forwardRef, useImperativeHandle, useState, useEffect } from "react";
import type { MatchSpan } from "./custom-redaction-panel";

interface HighlightTextareaProps {
  value: string;
  onChange: (value: string) => void;
  matches: MatchSpan[];
  placeholder?: string;
  className?: string;
  spellCheck?: boolean;
  autoComplete?: string;
  "data-testid"?: string;
}

export const HighlightTextarea = forwardRef<
  HTMLTextAreaElement,
  HighlightTextareaProps
>(function HighlightTextarea(
  {
    value,
    onChange,
    matches,
    placeholder,
    className,
    spellCheck,
    autoComplete,
    "data-testid": testId,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useImperativeHandle(ref, () => textareaRef.current!, []);

  const syncScroll = useCallback(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
      backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setHeight(ta.offsetHeight);
      syncScroll();
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [syncScroll]);

  useLayoutEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  const hasMatches = matches.length > 0;
  const segments = hasMatches ? buildSegments(value, matches) : [];

  return (
    <div className="relative" data-testid="highlight-textarea-wrapper">
      {hasMatches && (
        <div
          ref={backdropRef}
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl p-4 text-sm font-mono whitespace-pre-wrap break-words"
          style={{
            color: "transparent",
            zIndex: 0,
            height: height ?? undefined,
            lineHeight: "inherit",
          }}
        >
          {segments.map((seg, i) =>
            seg.match ? (
              <mark
                key={i}
                className="bg-yellow-500/30 rounded-sm"
                style={{ color: "transparent" }}
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid={testId}
        className={`relative w-full h-48 rounded-xl glass-card p-4 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent ${className ?? ""}`}
        style={{
          zIndex: 1,
          background: hasMatches ? "transparent" : undefined,
          caretColor: "currentColor",
        }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={spellCheck}
        autoComplete={autoComplete}
      />
    </div>
  );
});

function buildSegments(
  text: string,
  matches: MatchSpan[],
): Array<{ text: string; match: boolean }> {
  if (matches.length === 0 || !text) return [{ text, match: false }];
  const out: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const span of matches) {
    if (span.start > cursor)
      out.push({ text: text.slice(cursor, span.start), match: false });
    out.push({ text: text.slice(span.start, span.end), match: true });
    cursor = span.end;
  }
  if (cursor < text.length)
    out.push({ text: text.slice(cursor), match: false });
  return out;
}
