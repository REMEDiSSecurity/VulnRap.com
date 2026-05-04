import { execFile } from "node:child_process";
import path from "node:path";

const PAGES_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "vulnrap",
  "src",
  "pages",
);

export const ROUTE_TO_FILES: Record<string, string[]> = {
  "/": ["home/index.tsx"],
  "/blog": ["blog.tsx"],
  "/check": ["check.tsx"],
  "/developers": ["home/developers-and-agents-section.tsx"],
  "/reports": ["reports.tsx"],
  "/whitepaper": ["whitepaper.tsx"],
  "/architecture": ["architecture.tsx"],
  "/batch": ["batch.tsx"],
  "/changelog": ["changelog.tsx"],
  "/compare": ["compare.tsx"],
  "/compare-detectors": ["compare-detectors.tsx"],
  "/connect": ["connect.tsx"],
  "/corpus-stats": ["corpus-stats.tsx"],
  "/cwe": ["cwe.tsx"],
  "/docs/good-report": ["good-report.tsx"],
  "/engines": ["engines.tsx"],
  "/engines/ai-authorship": ["engines-authorship.tsx"],
  "/engines/avri": ["engines-avri.tsx"],
  "/engines/cwe-coherence": ["engines-cwe.tsx"],
  "/engines/substance": ["engines-substance.tsx"],
  "/engines/technical-substance": ["engines-substance.tsx"],
  "/gallery": ["gallery.tsx"],
  "/glossary": ["glossary.tsx"],
  "/how-it-works": ["how-it-works.tsx"],
  "/incidents": ["incidents.tsx"],
  "/playground": ["playground.tsx"],
  "/presets": ["presets.tsx"],
  "/press": ["press.tsx"],
  "/pricing": ["pricing.tsx"],
  "/quickstart": ["quickstart.tsx"],
  "/redaction-examples": ["redaction-examples.tsx"],
  "/roadmap": ["roadmap.tsx"],
  "/showcase": ["showcase.tsx"],
  "/signals": ["signals-index.tsx"],
  "/stats": ["stats.tsx"],
  "/test-yourself": ["test-yourself.tsx"],
  "/transparency": ["transparency.tsx"],
  "/use-cases": ["use-cases.tsx"],
  "/accessibility": ["accessibility.tsx"],
  "/badges": ["badges.tsx"],
  "/community": ["community.tsx"],
  "/history": ["history.tsx"],
  "/security": ["security.tsx"],
  "/status": ["status.tsx"],
  "/privacy": ["privacy.tsx"],
  "/terms": ["terms.tsx"],
};

function gitLog(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["log", "-1", "--format=%cI", "--", filePath],
      { cwd: PAGES_DIR, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export async function resolveLastmodForFile(
  relPath: string,
): Promise<string | null> {
  return gitLog(relPath);
}

export async function resolveRouteMtimes(
  fallback: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries = Object.entries(ROUTE_TO_FILES);

  const resolved = await Promise.all(
    entries.map(async ([route, files]) => {
      const dates: string[] = [];
      for (const file of files) {
        const d = await resolveLastmodForFile(file);
        if (d) dates.push(d);
      }
      let latest: string | null = null;
      if (dates.length > 0) {
        dates.sort();
        latest = dates[dates.length - 1];
      }
      return [route, latest] as const;
    }),
  );

  for (const [route, date] of resolved) {
    result.set(route, date ?? fallback);
  }
  return result;
}
