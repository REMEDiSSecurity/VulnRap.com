import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ShieldOff,
  AlertTriangle,
  FlaskConical,
  ExternalLink,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const STORAGE_KEY = "vulnrap.customRedactionRules.v1";
const STORAGE_PERSIST_KEY = "vulnrap.customRedactionRules.persist.v1";

export interface ParsedRule {
  source: string;
  regex: RegExp | null;
  error?: string;
}

export interface MatchSpan {
  start: number;
  end: number;
  ruleIndex: number;
}

export function parseRules(input: string): ParsedRule[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((source) => {
      try {
        return { source, regex: new RegExp(source, "g") };
      } catch (e) {
        return {
          source,
          regex: null,
          error: e instanceof Error ? e.message : "Invalid regex",
        };
      }
    });
}

export function findMatches(text: string, rules: ParsedRule[]): MatchSpan[] {
  const spans: MatchSpan[] = [];
  rules.forEach((rule, ruleIndex) => {
    if (!rule.regex) return;
    const re = new RegExp(
      rule.regex.source,
      rule.regex.flags.includes("g")
        ? rule.regex.flags
        : rule.regex.flags + "g",
    );
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, ruleIndex });
      if (++guard > 5000) break;
    }
  });
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: MatchSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

const STORAGE_APPLY_KEY = "vulnrap.customRedactionRules.apply.v1";
const DEFAULT_REDACTION_TOKEN = "[REDACTED]";

export function applyRedaction(
  text: string,
  rules: ParsedRule[],
  token: string = DEFAULT_REDACTION_TOKEN,
): { redacted: string; count: number } {
  const validRules = rules.filter((r) => r.regex);
  const matches = findMatches(text, validRules);
  if (matches.length === 0) return { redacted: text, count: 0 };
  let result = "";
  let cursor = 0;
  for (const span of matches) {
    if (span.start > cursor) result += text.slice(cursor, span.start);
    result += token;
    cursor = span.end;
  }
  if (cursor < text.length) result += text.slice(cursor);
  return { redacted: result, count: matches.length };
}

interface Props {
  text: string;
  redactionDisabled?: boolean;
  onApplyStateChange?: (apply: boolean, rules: ParsedRule[]) => void;
}

export function CustomRedactionPanel({
  text,
  redactionDisabled,
  onApplyStateChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [rulesInput, setRulesInput] = useState("");
  const [persist, setPersist] = useState(false);
  const [tested, setTested] = useState(false);
  const [applyBeforeSending, setApplyBeforeSending] = useState(false);

  useEffect(() => {
    try {
      const persisted = localStorage.getItem(STORAGE_PERSIST_KEY) === "1";
      setPersist(persisted);
      if (persisted) {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setRulesInput(saved);
        const savedApply = localStorage.getItem(STORAGE_APPLY_KEY) === "1";
        setApplyBeforeSending(savedApply);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      if (persist) {
        localStorage.setItem(STORAGE_KEY, rulesInput);
        localStorage.setItem(STORAGE_PERSIST_KEY, "1");
        localStorage.setItem(STORAGE_APPLY_KEY, applyBeforeSending ? "1" : "0");
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_APPLY_KEY);
        localStorage.setItem(STORAGE_PERSIST_KEY, "0");
      }
    } catch {
      // ignore
    }
  }, [persist, rulesInput, applyBeforeSending]);

  const rules = useMemo(() => parseRules(rulesInput), [rulesInput]);

  const validRules = rules.filter((r) => r.regex);
  const invalidRules = rules.filter((r) => !r.regex);

  useEffect(() => {
    onApplyStateChange?.(
      applyBeforeSending && validRules.length > 0,
      rules,
    );
  }, [applyBeforeSending, rules, validRules.length, onApplyStateChange]);

  const matches = useMemo(() => {
    if (!tested) return [];
    return findMatches(text, validRules);
  }, [text, validRules, tested]);

  const highlighted = useMemo(() => {
    if (!tested || matches.length === 0 || !text) return null;
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
  }, [matches, text, tested]);

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
        data-testid="custom-redaction-toggle"
      >
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldOff className="w-4 h-4 text-primary" />
          Custom redaction rules
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 h-4 normal-case"
          >
            Advanced
          </Badge>
          {validRules.length > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 h-4 normal-case border-primary/40 text-primary"
            >
              {validRules.length} rule{validRules.length === 1 ? "" : "s"}
            </Badge>
          )}
          <span className="ml-auto">
            {open ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          Add your own regex patterns (one per line) to highlight before
          submission. Runs entirely in your browser.
        </CardDescription>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <textarea
            className="w-full h-32 rounded-lg glass-card p-3 text-xs font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/30 placeholder:text-muted-foreground/40 bg-transparent"
            placeholder={
              "# One regex per line. Lines starting with # are comments.\nacme-internal-[a-z0-9-]+\\.corp\nPROJECT-[A-Z]{4,}\n\\bcodename-\\w+\\b"
            }
            value={rulesInput}
            onChange={(e) => {
              setRulesInput(e.target.value);
              setTested(false);
            }}
            spellCheck={false}
            autoComplete="off"
            data-testid="custom-redaction-input"
          />

          {invalidRules.length > 0 && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-[11px] space-y-1">
              <div className="flex items-center gap-1.5 text-destructive font-medium">
                <AlertTriangle className="w-3.5 h-3.5" />
                {invalidRules.length} invalid pattern
                {invalidRules.length === 1 ? "" : "s"}
              </div>
              <ul className="space-y-0.5 font-mono text-destructive/90">
                {invalidRules.slice(0, 3).map((r, i) => (
                  <li key={i} className="truncate">
                    <span className="opacity-70">{r.source}</span> — {r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs gap-1.5"
              onClick={() => setTested(true)}
              disabled={validRules.length === 0 || text.trim().length === 0}
              data-testid="custom-redaction-test"
            >
              <FlaskConical className="w-3.5 h-3.5" />
              Test
            </Button>
            {rulesInput.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs gap-1.5 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  setRulesInput("");
                  setTested(false);
                }}
                data-testid="custom-redaction-clear"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </Button>
            )}
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer ml-auto">
              <input
                type="checkbox"
                checked={persist}
                onChange={(e) => setPersist(e.target.checked)}
                className="rounded border-border accent-primary w-3.5 h-3.5"
                data-testid="custom-redaction-persist"
              />
              Remember in this browser (localStorage only)
            </label>
          </div>

          {validRules.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyBeforeSending}
                  onChange={(e) => setApplyBeforeSending(e.target.checked)}
                  className="rounded border-border accent-primary w-3.5 h-3.5"
                  data-testid="custom-redaction-apply-toggle"
                />
                <span className={applyBeforeSending ? "text-primary font-medium" : "text-muted-foreground"}>
                  Apply patterns before sending
                </span>
              </label>
              {applyBeforeSending && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 normal-case border-primary/40 text-primary"
                >
                  Active
                </Badge>
              )}
            </div>
          )}

          <div className="text-[11px] text-muted-foreground">
            <Link
              to="/redaction-examples"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              Redaction pattern examples <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          {tested && (
            <div className="space-y-2" data-testid="custom-redaction-results">
              {text.trim().length === 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  Paste report text above to test patterns against it.
                </div>
              ) : matches.length === 0 ? (
                <div className="rounded-lg bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                  No matches found in the current text.
                </div>
              ) : (
                <>
                  <div className="text-[11px] text-muted-foreground">
                    {matches.length} match{matches.length === 1 ? "" : "es"}{" "}
                    highlighted below:
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-lg glass-card p-3 text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed">
                    {highlighted?.map((seg, i) =>
                      seg.match ? (
                        <mark
                          key={i}
                          className="bg-yellow-500/30 text-yellow-100 rounded px-0.5"
                        >
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={i}>{seg.text}</span>
                      ),
                    )}
                  </pre>
                </>
              )}
            </div>
          )}

          <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <span>
              Custom patterns run <strong>client-side only</strong> and are
              never sent to the server.
              {applyBeforeSending ? (
                <span className="block mt-1">
                  <strong className="text-primary">Apply mode is on</strong> —
                  matches will be replaced with <code className="text-[10px] bg-muted/30 px-1 rounded">[REDACTED]</code> in
                  the request body. Your textarea text stays unchanged.
                </span>
              ) : (
                <span className="block mt-1">
                  Enable "Apply patterns before sending" to replace matches
                  with a redaction token in the request body before it leaves
                  your browser.
                </span>
              )}
              {redactionDisabled && !applyBeforeSending && (
                <span className="block mt-1 text-orange-300">
                  PII redaction is currently <strong>disabled</strong> and
                  custom apply mode is off. Redact matches manually before
                  submitting.
                </span>
              )}
            </span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
