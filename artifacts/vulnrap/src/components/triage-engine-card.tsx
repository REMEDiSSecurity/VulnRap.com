import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export interface VulnrapEngineResultPanel {
  engine: string;
  score: number;
  verdict: "GREEN" | "YELLOW" | "RED" | "GREY";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  triggeredIndicators?: Array<{
    signal: string;
    explanation: string;
    strength?: "HIGH" | "MEDIUM" | "LOW";
  }>;
  signalBreakdown?: Record<string, unknown>;
  note?: string;
}

export const VULNRAP_VERDICT_COLOR: Record<string, string> = {
  RED: "bg-destructive",
  YELLOW: "bg-yellow-500",
  GREEN: "bg-green-500",
  GREY: "bg-muted",
};

export const MAX_TRIAGE_ENGINE_INDICATORS = 4;

// AVRI takes precedence over the legacy `softCitation` slot when both
// are present so the newer rubric drives the displayed citation.
function resolveSoftCitation(signalBreakdown: Record<string, unknown> | undefined): {
  name: string;
  inferredCwe: string;
  source: "avri" | "legacy";
} | null {
  const sb = (signalBreakdown ?? {}) as {
    softCitation?: { name?: string; inferredCwe?: string } | null;
    avri?: { softCitation?: { name?: string; inferredCwe?: string } | null } | null;
  };
  const avriSoft = sb.avri?.softCitation ?? null;
  const legacySoft = sb.softCitation ?? null;
  const soft = avriSoft ?? legacySoft;
  if (!soft || !soft.name || !soft.inferredCwe) return null;
  return {
    name: soft.name,
    inferredCwe: soft.inferredCwe,
    source: avriSoft ? "avri" : "legacy",
  };
}

export interface TriageEngineCardProps {
  engine: VulnrapEngineResultPanel;
}

export function TriageEngineCard({ engine: eng }: TriageEngineCardProps) {
  const softCitation = resolveSoftCitation(eng.signalBreakdown);
  return (
    <div className="glass-card rounded-lg p-3 space-y-2" data-testid={`triage-engine-card-${eng.engine}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold truncate">{eng.engine}</span>
          <Badge
            variant="outline"
            className={`text-[9px] px-1.5 py-0 h-4 font-mono ${
              eng.verdict === "RED"
                ? "text-red-400 border-red-500/40"
                : eng.verdict === "YELLOW"
                  ? "text-yellow-400 border-yellow-500/40"
                  : eng.verdict === "GREEN"
                    ? "text-green-400 border-green-500/40"
                    : "text-muted-foreground"
            }`}
            data-testid="triage-engine-verdict"
          >
            {eng.verdict}
          </Badge>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            conf: {eng.confidence}
          </span>
        </div>
        <span className="font-mono text-sm font-bold">{eng.score}</span>
      </div>
      <Progress
        value={eng.score}
        className="h-1.5"
        indicatorClassName={VULNRAP_VERDICT_COLOR[eng.verdict] || "bg-muted"}
      />
      {eng.note && (
        <p className="text-[11px] text-muted-foreground leading-relaxed" data-testid="triage-engine-note">
          {eng.note}
        </p>
      )}
      {softCitation && (
        <div
          className="flex items-center gap-2 text-[11px] rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1"
          data-testid={`badge-soft-citation-${softCitation.source}`}
        >
          <Badge
            variant="outline"
            className="text-[9px] px-1 py-0 h-3.5 font-mono shrink-0 text-cyan-300 border-cyan-500/40"
          >
            INFERRED CWE
          </Badge>
          <span className="text-cyan-200/90 leading-snug">
            Soft citation: <span className="font-semibold">{softCitation.name}</span> →{" "}
            <span className="font-mono">{softCitation.inferredCwe}</span>
          </span>
        </div>
      )}
      {eng.triggeredIndicators && eng.triggeredIndicators.length > 0 && (
        <div className="space-y-1 pt-1" data-testid="triage-engine-indicators">
          {eng.triggeredIndicators.slice(0, MAX_TRIAGE_ENGINE_INDICATORS).map((ind, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px]">
              <Badge
                variant="outline"
                className={`text-[9px] px-1 py-0 h-3.5 font-mono shrink-0 ${
                  ind.strength === "HIGH"
                    ? "text-red-400 border-red-500/40"
                    : ind.strength === "MEDIUM"
                      ? "text-yellow-400 border-yellow-500/40"
                      : "text-muted-foreground"
                }`}
              >
                {ind.signal}
              </Badge>
              <span className="text-muted-foreground leading-snug">{ind.explanation}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
