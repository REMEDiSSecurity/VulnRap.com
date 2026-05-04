# VulnRap VS Code Extension

Score the active selection (or the whole file) against [VulnRap.com](https://vulnrap.com)
without leaving your editor. Built for maintainers who triage incoming
GitHub Security Advisories and bug-bounty reports as Markdown drafts in VS Code.

This is a **reference extension**, not a Marketplace publication — you build the
`.vsix` locally and install it into VS Code (or Cursor / VSCodium / any
VS Code-compatible editor).

## What you get

- **Right-click → "VulnRap: Score selection"** — sends the highlighted text to
  the VulnRap `/reports/check` endpoint and opens a side-panel webview with the
  composite score, tier, recommended triage action, fired evidence signals, and
  any heuristic feedback.
- **Right-click → "VulnRap: Score current file"** — same thing, but for the whole
  active document. Handy when you've drafted the full report in a single
  Markdown file.
- **Inline diagnostics** — after scoring, evidence items that carry a text
  snippet are highlighted directly in your document as VS Code diagnostics
  (warning squiggles for high-severity signals, info squiggles for everything
  else). Hover over a squiggle to see the signal name, weight, and description.
  Diagnostics clear automatically when you re-run the score command or close the
  score panel. Disable this with `vulnrap.inlineDiagnostics: false`.
- All scoring goes through `POST /api/reports/check`, which is the
  **non-storing** endpoint — your draft is never persisted to VulnRap.

The score color shifts from green (likely a real, well-written report) through
amber to red (likely AI-generated slop), so you can eyeball severity at a
glance.

## Requirements

- VS Code 1.80 or newer (any VS Code-compatible editor with the same engine
  version works too).
- Node.js 18.17 or newer to build the extension (uses the built-in `fetch` and
  `FormData`).
- Network access to your VulnRap instance (`https://vulnrap.com` by default).

## Settings

| Setting                    | Default                   | Description                                                                                        |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `vulnrap.apiBaseUrl`       | `https://vulnrap.com/api` | Base URL of the VulnRap API. Override this when self-hosting or pointing at staging.               |
| `vulnrap.skipLlm`          | `false`                   | If `true`, scores using only local heuristic / statistical engines (no external LLM call).         |
| `vulnrap.inlineDiagnostics`| `true`                    | If `true`, evidence snippets are highlighted inline as diagnostics (squiggles) after scoring.      |

Open the settings UI (`Ctrl+,` / `Cmd+,`) and search for "VulnRap" to edit
any of these.

## Build the extension

```bash
cd sdks/vscode-extension
npm install
npm run build
```

This compiles `src/extension.ts` into `out/extension.js`.

## Package as a `.vsix`

```bash
npm run package
```

`@vscode/vsce` produces a file like `vulnrap-vscode-extension-0.1.0.vsix` in
the same directory.

## Install into VS Code

Two options:

1. **From the command line:**

   ```bash
   code --install-extension vulnrap-vscode-extension-0.1.0.vsix
   ```

2. **From the UI:** open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`),
   click the `…` menu in the top-right of the side bar, choose **Install from
   VSIX…**, and pick the `.vsix` file.

Reload the editor when prompted.

## Use

1. Open a Markdown / text file with your draft vulnerability report.
2. Either select the section you want to score, or skip the selection step to
   score the whole file.
3. Right-click and pick **"VulnRap: Score selection"** or
   **"VulnRap: Score current file"** — both also live under the
   command palette (`Ctrl+Shift+P` / `Cmd+Shift+P` → "VulnRap").
4. A panel opens to the side with the score, tier, recommended triage action,
   fired evidence signals, and any feedback.

## Troubleshooting

- **"need at least 20 characters of report text to score"** — the selection (or
  file) is too short. Reports under 20 characters are rejected client-side
  because the server can't produce meaningful signals from them.
- **"API error 429"** — you've hit the public VulnRap rate limit. Wait a minute
  and retry, or point `vulnrap.apiBaseUrl` at a self-hosted instance.
- **"API error 400: ..."** — usually a malformed body; check that the editor
  selection actually contains text (not, e.g., a binary buffer).

## License

Apache-2.0 — same as the rest of the VulnRap reference SDKs.
