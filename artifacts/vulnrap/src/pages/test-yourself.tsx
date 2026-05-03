// Task #633 — Bring-your-own fixture battery page.
//
// Power users (PSIRT teams, security platforms) upload a CSV / JSON
// of `{report_text, expected_label}` rows, run them through the live
// engines via `POST /api/test-yourself/run`, and see precision /
// recall / F1 against their own labels alongside a per-row table and
// a "download results CSV" button. Capped at 50 rows / 10 runs per
// IP per day.
import { useMemo, useRef, useState } from "react";
import {
  FlaskConical,
  UploadCloud,
  Play,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type Label = "valid" | "invalid";

interface ParsedRow {
  text: string;
  label: Label;
}

interface PerRow {
  index: number;
  textPreview: string;
  expectedLabel: Label;
  predictedLabel: Label;
  compositeScore: number;
  compositeLabel: string;
  correct: boolean;
}

interface RunResponse {
  aggregate: {
    total: number;
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    confusionMatrix: {
      truePositive: number;
      falsePositive: number;
      trueNegative: number;
      falseNegative: number;
    };
  };
  perRow: PerRow[];
  rateLimit: { limit: number; remaining: number };
}

const MAX_ROWS = 50;

function normalizeLabel(raw: unknown): Label | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (
    ["valid", "real", "true", "human", "1", "positive", "y", "yes"].includes(v)
  )
    return "valid";
  if (
    [
      "invalid",
      "slop",
      "fake",
      "false",
      "ai",
      "0",
      "negative",
      "n",
      "no",
    ].includes(v)
  )
    return "invalid";
  return null;
}

// Minimal RFC-4180-ish CSV parser (handles quoted fields with embedded
// commas / newlines / "" escapes). Sufficient for BYO test batteries
// without pulling in a dependency.
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.length > 0));
}

interface ParseResult {
  rows: ParsedRow[];
  headers: string[] | null;
  errors: string[];
  textColumn?: string;
  labelColumn?: string;
  availableColumns?: string[];
}

export function parseJsonInput(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], headers: null, errors: ["File is not valid JSON."] };
  }
  if (!Array.isArray(data)) {
    return {
      rows: [],
      headers: null,
      errors: ["JSON must be an array of objects."],
    };
  }
  const errors: string[] = [];
  const out: ParsedRow[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as Record<string, unknown>;
    if (!item || typeof item !== "object") {
      errors.push(`Row ${i + 1}: not an object`);
      continue;
    }
    const text = (item.report_text ?? item.text ?? item.body) as unknown;
    const labelRaw = (item.expected_label ?? item.label) as unknown;
    const label = normalizeLabel(labelRaw);
    if (typeof text !== "string" || !text.trim()) {
      errors.push(`Row ${i + 1}: missing text`);
      continue;
    }
    if (!label) {
      errors.push(`Row ${i + 1}: missing/unknown label "${String(labelRaw)}"`);
      continue;
    }
    out.push({ text, label });
  }
  return { rows: out, headers: null, errors };
}

export function buildResultsCsv(rows: PerRow[]): string {
  const escape = (v: string | number | boolean) => {
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    "index,expected_label,predicted_label,composite_score,composite_label,correct,text_preview",
  ];
  for (const r of rows) {
    lines.push(
      [
        r.index,
        r.expectedLabel,
        r.predictedLabel,
        r.compositeScore,
        r.compositeLabel,
        r.correct,
        r.textPreview,
      ]
        .map(escape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function TestYourself() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[] | null>(null);
  const [textColumn, setTextColumn] = useState<string>("");
  const [labelColumn, setLabelColumn] = useState<string>("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [rateError, setRateError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<
    "index" | "expectedLabel" | "predictedLabel" | "compositeScore" | "correct"
  >("index");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const columnsLooksLikeText = (h: string) =>
    /text|report|body|content/i.test(h);
  const columnsLooksLikeLabel = (h: string) =>
    /label|expected|class|verdict/i.test(h);

  const onFile = async (file: File) => {
    setResult(null);
    setRateError(null);
    setParsedRows([]);
    setParseErrors([]);
    setCsvRows(null);
    setCsvHeaders(null);
    setTextColumn("");
    setLabelColumn("");

    const text = await file.text();
    const isJson = /\.json$/i.test(file.name) || text.trim().startsWith("[");
    if (isJson) {
      const r = parseJsonInput(text);
      setParsedRows(r.rows);
      setParseErrors(r.errors);
      return;
    }

    const grid = parseCsv(text);
    if (grid.length === 0) {
      setParseErrors(["File is empty."]);
      return;
    }
    const headers = grid[0];
    setCsvRows(grid.slice(1));
    setCsvHeaders(headers);
    const guessedText = headers.find(columnsLooksLikeText) ?? headers[0];
    const guessedLabel =
      headers.find(columnsLooksLikeLabel) ?? headers[1] ?? headers[0];
    setTextColumn(guessedText);
    setLabelColumn(guessedLabel);
  };

  // Re-parse CSV grid whenever the user changes the column picker.
  useMemoEffect(() => {
    if (!csvRows || !csvHeaders || !textColumn || !labelColumn) {
      if (!csvRows) return;
      setParsedRows([]);
      return;
    }
    const ti = csvHeaders.indexOf(textColumn);
    const li = csvHeaders.indexOf(labelColumn);
    if (ti < 0 || li < 0) return;
    const errors: string[] = [];
    const out: ParsedRow[] = [];
    for (let i = 0; i < csvRows.length; i++) {
      const r = csvRows[i];
      const t = (r[ti] ?? "").trim();
      const lab = normalizeLabel(r[li]);
      if (!t) {
        errors.push(`Row ${i + 1}: empty text`);
        continue;
      }
      if (!lab) {
        errors.push(`Row ${i + 1}: unknown label "${r[li] ?? ""}"`);
        continue;
      }
      out.push({ text: t, label: lab });
    }
    setParsedRows(out);
    setParseErrors(errors);
  }, [csvRows, csvHeaders, textColumn, labelColumn]);

  const trimmedRows = useMemo(
    () => parsedRows.slice(0, MAX_ROWS),
    [parsedRows],
  );
  const truncated = parsedRows.length > MAX_ROWS;

  const run = async () => {
    if (trimmedRows.length === 0) {
      toast({
        title: "No rows to run",
        description: "Upload a CSV or JSON with at least one labeled row.",
      });
      return;
    }
    setRunning(true);
    setResult(null);
    setRateError(null);
    try {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/test-yourself/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: trimmedRows }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      } & Partial<RunResponse>;
      if (res.status === 429) {
        setRateError(body.error ?? "Daily rate limit exceeded.");
        return;
      }
      if (!res.ok) {
        toast({
          title: "Run failed",
          description: body.error ?? `HTTP ${res.status}`,
          variant: "destructive",
        });
        return;
      }
      setResult(body as RunResponse);
    } catch (err) {
      toast({
        title: "Network error",
        description:
          err instanceof Error ? err.message : "Could not reach the engine.",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  const sortedPerRow = useMemo(() => {
    if (!result) return [];
    const arr = [...result.perRow];
    arr.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [result, sortKey, sortDir]);

  const onSort = (key: typeof sortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const downloadCsv = () => {
    if (!result) return;
    const csv = buildResultsCsv(result.perRow);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vulnrap-byo-results-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <FlaskConical className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Test Yourself
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-3xl leading-relaxed">
          Bring your own labeled corpus. Upload up to 50 rows of{" "}
          <code className="font-mono text-xs">{`{report_text, expected_label}`}</code>{" "}
          and we'll run them through the live engine and report precision,
          recall, and F1 against your labels. Nothing is persisted; the page is
          rate-limited to 10 runs per IP per day.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <UploadCloud className="w-5 h-5" /> 1. Upload your battery
          </CardTitle>
          <CardDescription>
            CSV with a header row, or a JSON array of objects. Recognised label
            values:{" "}
            <code className="font-mono text-[11px]">
              valid / invalid / real / slop / true / false / 1 / 0
            </code>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,.tsv,text/csv,application/json,text/plain"
              className="hidden"
              data-testid="byo-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
            >
              <UploadCloud className="w-4 h-4 mr-2" /> Choose file
            </Button>
          </div>

          {csvHeaders && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="byo-text-col">Text column</Label>
                <select
                  id="byo-text-col"
                  data-testid="byo-text-col"
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
                  value={textColumn}
                  onChange={(e) => setTextColumn(e.target.value)}
                >
                  {csvHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="byo-label-col">Label column</Label>
                <select
                  id="byo-label-col"
                  data-testid="byo-label-col"
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm"
                  value={labelColumn}
                  onChange={(e) => setLabelColumn(e.target.value)}
                >
                  {csvHeaders.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {parsedRows.length > 0 && (
            <div className="text-sm text-muted-foreground">
              Parsed{" "}
              <span className="text-foreground font-mono">
                {parsedRows.length}
              </span>{" "}
              labeled rows
              {truncated && (
                <span className="text-amber-500">
                  {" "}
                  — only the first {MAX_ROWS} will be scored.
                </span>
              )}
            </div>
          )}

          {parseErrors.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5" /> {parseErrors.length}{" "}
                row(s) skipped
              </div>
              <ul className="list-disc list-inside space-y-0.5 max-h-32 overflow-y-auto">
                {parseErrors.slice(0, 10).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {parseErrors.length > 10 && (
                  <li>… and {parseErrors.length - 10} more</li>
                )}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Play className="w-5 h-5" /> 2. Run the battery
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            onClick={run}
            disabled={running || trimmedRows.length === 0}
            data-testid="byo-run"
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Scoring…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" /> Run {trimmedRows.length}{" "}
                row(s)
              </>
            )}
          </Button>

          {rateError && (
            <div
              role="alert"
              data-testid="byo-rate-error"
              className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-4 h-4" /> Cooldown active
              </div>
              <p className="mt-1 text-xs">{rateError}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card
          className="glass-card-accent rounded-xl"
          data-testid="byo-results"
        >
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-lg">3. Results</CardTitle>
                <CardDescription>
                  Scored {result.aggregate.total} row(s).{" "}
                  {result.rateLimit.remaining} run(s) left today.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadCsv}
                data-testid="byo-download"
              >
                <Download className="w-4 h-4 mr-2" /> Download results CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Metric
                label="Accuracy"
                value={formatPct(result.aggregate.accuracy)}
                testid="byo-metric-accuracy"
              />
              <Metric
                label="Precision"
                value={formatPct(result.aggregate.precision)}
                testid="byo-metric-precision"
              />
              <Metric
                label="Recall"
                value={formatPct(result.aggregate.recall)}
                testid="byo-metric-recall"
              />
              <Metric
                label="F1"
                value={formatPct(result.aggregate.f1)}
                testid="byo-metric-f1"
              />
            </div>

            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Confusion matrix
              </div>
              <div
                className="grid grid-cols-3 gap-px bg-border rounded-md overflow-hidden text-sm"
                data-testid="byo-confusion"
              >
                <div className="bg-background p-2" />
                <div className="bg-muted p-2 font-semibold text-center">
                  Predicted valid
                </div>
                <div className="bg-muted p-2 font-semibold text-center">
                  Predicted invalid
                </div>

                <div className="bg-muted p-2 font-semibold">Actual valid</div>
                <div className="bg-emerald-500/10 p-2 text-center font-mono">
                  {result.aggregate.confusionMatrix.truePositive}
                </div>
                <div className="bg-amber-500/10 p-2 text-center font-mono">
                  {result.aggregate.confusionMatrix.falseNegative}
                </div>

                <div className="bg-muted p-2 font-semibold">Actual invalid</div>
                <div className="bg-amber-500/10 p-2 text-center font-mono">
                  {result.aggregate.confusionMatrix.falsePositive}
                </div>
                <div className="bg-emerald-500/10 p-2 text-center font-mono">
                  {result.aggregate.confusionMatrix.trueNegative}
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Per-row results
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-xs uppercase">
                    <tr>
                      <Th
                        onClick={() => onSort("index")}
                        active={sortKey === "index"}
                        dir={sortDir}
                      >
                        #
                      </Th>
                      <Th
                        onClick={() => onSort("expectedLabel")}
                        active={sortKey === "expectedLabel"}
                        dir={sortDir}
                      >
                        Actual
                      </Th>
                      <Th
                        onClick={() => onSort("predictedLabel")}
                        active={sortKey === "predictedLabel"}
                        dir={sortDir}
                      >
                        Predicted
                      </Th>
                      <Th
                        onClick={() => onSort("compositeScore")}
                        active={sortKey === "compositeScore"}
                        dir={sortDir}
                      >
                        Composite
                      </Th>
                      <Th
                        onClick={() => onSort("correct")}
                        active={sortKey === "correct"}
                        dir={sortDir}
                      >
                        OK?
                      </Th>
                      <th className="text-left px-3 py-2">Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPerRow.map((r) => (
                      <tr
                        key={r.index}
                        className="border-t border-border"
                        data-testid={`byo-row-${r.index}`}
                      >
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                          {r.index + 1}
                        </td>
                        <td className="px-3 py-2">
                          <LabelBadge label={r.expectedLabel} />
                        </td>
                        <td className="px-3 py-2">
                          <LabelBadge label={r.predictedLabel} />
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {r.compositeScore}{" "}
                          <span className="text-[10px] text-muted-foreground">
                            ({r.compositeLabel})
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.correct ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          ) : (
                            <XCircle className="w-4 h-4 text-destructive" />
                          )}
                        </td>
                        <td
                          className="px-3 py-2 text-xs text-muted-foreground max-w-md truncate"
                          title={r.textPreview}
                        >
                          {r.textPreview}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid?: string;
}) {
  return (
    <div
      className="rounded-md border border-border bg-background/50 p-3"
      data-testid={testid}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-2xl font-mono font-bold text-primary">{value}</div>
    </div>
  );
}

function LabelBadge({ label }: { label: Label }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[10px] uppercase",
        label === "valid"
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/40 text-amber-600 dark:text-amber-400",
      )}
    >
      {label}
    </Badge>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
}) {
  return (
    <th
      className={cn(
        "text-left px-3 py-2 cursor-pointer select-none",
        active && "text-primary",
      )}
      onClick={onClick}
    >
      {children}
      {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}

// Tiny helper that runs an effect immediately during render when its
// deps change (mirroring useEffect semantics for simple synchronous
// state derivation, without delaying state into a follow-up render).
import { useEffect } from "react";
function useMemoEffect(effect: () => void, deps: React.DependencyList) {
  useEffect(effect, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
