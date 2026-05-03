import * as vscode from "vscode";

type CheckResult = {
  slopScore?: number;
  slopTier?: string;
  qualityScore?: number;
  confidence?: number;
  authenticityScore?: number;
  validityScore?: number;
  quadrant?: string;
  archetype?: string;
  analysisMode?: string;
  evidence?: Array<{
    label?: string;
    description?: string;
    severity?: string;
    weight?: number;
    snippet?: string;
  }>;
  feedback?: string[];
  llmFeedback?: string[] | null;
  similarityMatches?: Array<{ id?: number; similarity?: number }>;
};

const PANEL_VIEW_TYPE = "vulnrap.scorePanel";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vulnrap.scoreSelection", () =>
      runScore(context, "selection"),
    ),
    vscode.commands.registerCommand("vulnrap.scoreFile", () =>
      runScore(context, "file"),
    ),
  );
}

export function deactivate(): void {
  /* no-op */
}

async function runScore(
  context: vscode.ExtensionContext,
  mode: "selection" | "file",
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("VulnRap: open a file first.");
    return;
  }

  let text: string;
  if (mode === "selection") {
    const sel = editor.selection;
    if (sel.isEmpty) {
      vscode.window.showWarningMessage(
        "VulnRap: select some text to score, or use 'Score current file'.",
      );
      return;
    }
    text = editor.document.getText(sel);
  } else {
    text = editor.document.getText();
  }

  const trimmed = text.trim();
  if (trimmed.length < 20) {
    vscode.window.showWarningMessage(
      "VulnRap: need at least 20 characters of report text to score.",
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("vulnrap");
  const baseUrl = String(
    config.get("apiBaseUrl") ?? "https://vulnrap.com/api",
  ).replace(/\/+$/, "");
  const skipLlm = Boolean(config.get("skipLlm") ?? false);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "VulnRap: scoring report…",
      cancellable: false,
    },
    async () => {
      try {
        const result = await scoreText(baseUrl, trimmed, skipLlm);
        showResultPanel(context, result, baseUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`VulnRap: ${msg}`);
      }
    },
  );
}

async function scoreText(
  baseUrl: string,
  rawText: string,
  skipLlm: boolean,
): Promise<CheckResult> {
  const form = new FormData();
  form.append("rawText", rawText);
  form.append("skipLlm", skipLlm ? "true" : "false");
  form.append("skipRedaction", "false");

  const res = await fetch(`${baseUrl}/reports/check`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.error ?? body.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(
      `API error ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  return (await res.json()) as CheckResult;
}

function showResultPanel(
  context: vscode.ExtensionContext,
  result: CheckResult,
  baseUrl: string,
): void {
  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    "VulnRap Score",
    vscode.ViewColumn.Beside,
    { enableScripts: false, retainContextWhenHidden: false },
  );
  panel.webview.html = renderHtml(result, baseUrl);
  context.subscriptions.push(panel);
}

function renderHtml(r: CheckResult, baseUrl: string): string {
  const score = typeof r.slopScore === "number" ? r.slopScore : 0;
  const tier = escapeHtml(r.slopTier ?? "unknown");
  const tierColor = colorForScore(score);
  const confidencePct =
    typeof r.confidence === "number"
      ? `${Math.round(r.confidence * 100)}%`
      : "—";

  const evidenceRows = (r.evidence ?? [])
    .slice(0, 12)
    .map((ev) => {
      const label = escapeHtml(ev.label ?? "signal");
      const desc = escapeHtml(ev.description ?? "");
      const sev = escapeHtml(ev.severity ?? "");
      const weight =
        typeof ev.weight === "number" ? `+${ev.weight.toFixed(1)}` : "";
      return `<tr>
          <td><span class="sev sev-${sev}">${sev || "?"}</span></td>
          <td><strong>${label}</strong><div class="desc">${desc}</div></td>
          <td class="weight">${escapeHtml(weight)}</td>
        </tr>`;
    })
    .join("");

  const feedback = (r.feedback ?? []).slice(0, 8);
  const llmFeedback = (r.llmFeedback ?? []) as string[];
  const allFeedback = [...feedback, ...llmFeedback].slice(0, 10);
  const feedbackHtml = allFeedback.length
    ? `<ul>${allFeedback
        .map((f) => `<li>${escapeHtml(f)}</li>`)
        .join("")}</ul>`
    : "<p class=\"muted\">No heuristic feedback returned.</p>";

  const matches = r.similarityMatches?.length ?? 0;
  const quadrant = escapeHtml(r.quadrant ?? "—");
  const archetype = escapeHtml(r.archetype ?? "—");
  const mode = escapeHtml(r.analysisMode ?? "—");
  const authenticity =
    typeof r.authenticityScore === "number" ? r.authenticityScore : "—";
  const validity =
    typeof r.validityScore === "number" ? r.validityScore : "—";
  const quality =
    typeof r.qualityScore === "number" ? r.qualityScore : "—";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline';" />
<title>VulnRap Score</title>
<style>
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--vscode-foreground);
    padding: 16px;
    line-height: 1.45;
  }
  .score-card {
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .score {
    font-size: 48px;
    font-weight: 700;
    color: ${tierColor};
    line-height: 1;
  }
  .tier {
    display: inline-block;
    margin-top: 8px;
    padding: 4px 10px;
    border-radius: 999px;
    background: ${tierColor};
    color: #000;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 16px;
    margin-top: 16px;
    font-size: 13px;
  }
  .meta div span {
    color: var(--vscode-descriptionForeground);
    margin-right: 6px;
  }
  h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 24px 0 8px;
    color: var(--vscode-descriptionForeground);
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 6px 8px; vertical-align: top;
       border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); }
  td.weight { text-align: right; font-variant-numeric: tabular-nums; }
  .desc { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .sev { display: inline-block; padding: 2px 6px; border-radius: 4px;
         font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .sev-high { background: #c0392b; color: #fff; }
  .sev-medium { background: #d4a017; color: #000; }
  .sev-low { background: #4a6fa5; color: #fff; }
  .sev-info { background: #555; color: #fff; }
  ul { padding-left: 20px; margin: 8px 0; }
  li { margin: 4px 0; font-size: 13px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .footer { margin-top: 24px; font-size: 11px;
            color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="score-card">
    <div class="score">${score}</div>
    <div class="tier">${tier}</div>
    <div class="meta">
      <div><span>Confidence</span>${confidencePct}</div>
      <div><span>Mode</span>${mode}</div>
      <div><span>Authenticity</span>${authenticity}</div>
      <div><span>Validity</span>${validity}</div>
      <div><span>Quality</span>${quality}</div>
      <div><span>Similarity matches</span>${matches}</div>
      <div><span>Quadrant</span>${quadrant}</div>
      <div><span>Recommended action</span>${archetype}</div>
    </div>
  </div>

  <h2>Top evidence signals</h2>
  ${evidenceRows
    ? `<table>${evidenceRows}</table>`
    : "<p class=\"muted\">No fired evidence signals.</p>"}

  <h2>Feedback</h2>
  ${feedbackHtml}

  <p class="footer">
    Scored via <code>${escapeHtml(baseUrl)}/reports/check</code>.
    This request was not stored on the VulnRap server.
  </p>
</body>
</html>`;
}

function colorForScore(score: number): string {
  if (score >= 70) return "#e74c3c";
  if (score >= 40) return "#e67e22";
  if (score >= 20) return "#d4a017";
  return "#27ae60";
}

function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
