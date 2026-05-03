import { useState } from "react";
import { ShieldCheck, HelpCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type {
  VerificationCheck,
  VerificationSummary,
} from "@workspace/api-client-react";

type Source = "github" | "nvd" | "npm" | "pypi" | "other";

const SOURCE_LABEL: Record<Source, string> = {
  github: "GitHub",
  nvd: "NVD",
  npm: "npm",
  pypi: "PyPI",
  other: "Other",
};

function classifySource(checkType: string): Source {
  if (checkType.startsWith("github_")) return "github";
  if (
    checkType.startsWith("nvd_") ||
    checkType === "verified_cve" ||
    checkType === "invalid_cve_year"
  )
    return "nvd";
  if (checkType.startsWith("npm_")) return "npm";
  if (checkType.startsWith("pypi_")) return "pypi";
  return "other";
}

function isVerifiable(result: VerificationCheck["result"]): boolean {
  return result === "verified" || result === "not_found";
}

function TrustHint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="group relative inline-flex ml-1 cursor-help">
      <button
        type="button"
        className="inline-flex"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        aria-label="What does verified mean?"
      >
        <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
      </button>
      <span
        className={`pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 rounded-md glass-card px-3 py-2 text-xs text-popover-foreground transition-opacity z-50 glow-border text-left font-normal normal-case ${open ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      >
        {text}
      </span>
    </span>
  );
}

export function VerificationTrustPanel({
  checks,
  summary,
}: {
  checks: VerificationCheck[];
  summary?: VerificationSummary;
}) {
  const verifiable = checks.filter((c) => isVerifiable(c.result));
  if (verifiable.length === 0) return null;

  const verified =
    summary?.verified ??
    verifiable.filter((c) => c.result === "verified").length;
  const total = verifiable.length;
  const ratio = total > 0 ? verified / total : 0;
  const pct = Math.round(ratio * 100);

  const bySource = new Map<Source, { verified: number; total: number }>();
  for (const c of verifiable) {
    const src = classifySource(c.type);
    const entry = bySource.get(src) ?? { verified: 0, total: 0 };
    entry.total += 1;
    if (c.result === "verified") entry.verified += 1;
    bySource.set(src, entry);
  }
  const sourceOrder: Source[] = ["github", "nvd", "npm", "pypi", "other"];
  const sources = sourceOrder.filter((s) => bySource.has(s));

  const notFound = total - verified;
  const ratioTone =
    ratio >= 0.8
      ? "text-green-400"
      : ratio >= 0.5
        ? "text-yellow-400"
        : "text-orange-400";
  const barTone =
    ratio >= 0.8
      ? "bg-green-500"
      : ratio >= 0.5
        ? "bg-yellow-500"
        : "bg-orange-500";

  const summaryText =
    notFound === 0
      ? `${verified} of ${total} referenced resources verified`
      : `${verified} of ${total} referenced resources verified, ${notFound} not found`;

  return (
    <Card
      className="glass-card rounded-xl"
      data-testid="verification-trust-panel"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="w-4 h-4 text-primary" />
          Verification
          <span className={`ml-1 font-mono text-xs ${ratioTone}`}>
            {verified}/{total}
          </span>
          <TrustHint text="VulnRap probes referenced resources against live sources (GitHub for files/symbols, NVD for CVEs, npm/PyPI for packages). 'Verified' means the resource was confirmed to exist; 'not found' means the live API did not return it. Errors and skipped probes are excluded from this ratio." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{summaryText}</span>
            <span className={`font-mono font-bold ${ratioTone}`}>{pct}%</span>
          </div>
          <Progress
            value={pct}
            className="h-1.5"
            indicatorClassName={barTone}
          />
        </div>
        {sources.length > 0 && (
          <div
            className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono text-muted-foreground"
            data-testid="verification-trust-source-breakdown"
          >
            {sources.map((s) => {
              const entry = bySource.get(s)!;
              return (
                <span key={s} data-testid={`verification-trust-source-${s}`}>
                  <span className="uppercase tracking-wide">
                    {SOURCE_LABEL[s]}
                  </span>{" "}
                  <span
                    className={
                      entry.verified === entry.total
                        ? "text-green-400"
                        : entry.verified === 0
                          ? "text-orange-400"
                          : "text-yellow-400"
                    }
                  >
                    {entry.verified}/{entry.total}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
