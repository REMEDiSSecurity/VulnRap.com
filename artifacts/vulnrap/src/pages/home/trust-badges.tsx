import { Link } from "react-router-dom";
import {
  Github,
  ScrollText,
  FileSearch,
  BookOpen,
  BarChart3,
  ScaleIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Badge = {
  label: string;
  tooltip: string;
  to: string;
  external?: boolean;
  Icon: React.ComponentType<{ className?: string }>;
};

const BADGES: Badge[] = [
  {
    label: "Open source",
    tooltip:
      "All source code is publicly hosted on GitHub. Inspect, fork, or self-host.",
    to: "https://github.com/REMEDiSSecurity/VulnRap.Com",
    external: true,
    Icon: Github,
  },
  {
    label: "MIT licensed",
    tooltip:
      "Released under the permissive MIT license. View the LICENSE file.",
    to: "https://github.com/REMEDiSSecurity/VulnRap.Com/blob/main/LICENSE",
    external: true,
    Icon: ScaleIcon,
  },
  {
    label: "Public methodology",
    tooltip:
      "Scoring engines, signals, and thresholds are documented end-to-end.",
    to: "/whitepaper",
    Icon: BookOpen,
  },
  {
    label: "Transparency report",
    tooltip:
      "Live transparency page covering data handling, retention, and operations.",
    to: "/transparency",
    Icon: FileSearch,
  },
  {
    label: "Public stats",
    tooltip: "Real-time corpus and scoring stats — no cherry-picked numbers.",
    to: "/stats",
    Icon: BarChart3,
  },
  {
    label: "Built on RFC standards",
    tooltip:
      "Uses CWE, CVSS, and other public standards rather than proprietary scales.",
    to: "/architecture",
    Icon: ScrollText,
  },
];

export function TrustBadges() {
  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="trust-badges-strip pt-1"
        data-testid="trust-badges"
        aria-label="Trust and credibility badges"
      >
        <div className="flex gap-2 sm:gap-3 overflow-x-auto sm:overflow-visible sm:flex-wrap sm:justify-center px-2 sm:px-0 -mx-2 sm:mx-0 pb-2 sm:pb-0 snap-x snap-mandatory sm:snap-none [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [&>*]:basis-[calc((100%-1rem)/3)] sm:[&>*]:basis-auto">
          {BADGES.map(({ label, tooltip, to, external, Icon }) => {
            const inner = (
              <span className="flex w-full sm:w-auto items-center justify-center gap-1.5 px-3 py-1.5 rounded-full glass-card border border-border/40 text-[11px] sm:text-xs font-medium text-muted-foreground/80 grayscale hover:grayscale-0 hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-all snap-start overflow-hidden">
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{label}</span>
              </span>
            );
            return (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  {external ? (
                    <a
                      href={to}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`trust-badge-${label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {inner}
                    </a>
                  ) : (
                    <Link
                      to={to}
                      data-testid={`trust-badge-${label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      {inner}
                    </Link>
                  )}
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="max-w-[240px] text-center"
                >
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
