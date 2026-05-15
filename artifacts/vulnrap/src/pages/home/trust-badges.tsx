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
        className="trust-badges-strip"
        data-testid="trust-badges"
        aria-label="Trust and credibility badges"
      >
        <div className="inline-flex items-center gap-0 rounded-full glass-card border border-border/40 px-1 py-0.5 mx-auto">
          {BADGES.map(({ label, tooltip, to, external, Icon }, i) => {
            const inner = (
              <span
                aria-label={label}
                className="flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-full text-muted-foreground/70 grayscale hover:grayscale-0 hover:text-primary hover:bg-primary/10 transition-all"
              >
                <Icon className="w-3.5 h-3.5" />
              </span>
            );
            return (
              <div key={label} className="flex items-center">
                {i > 0 && (
                  <span
                    aria-hidden
                    className="w-px h-3 bg-border/50 mx-0.5"
                  />
                )}
                <Tooltip>
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
                    <div className="font-semibold text-[11px] mb-0.5">{label}</div>
                    <div className="text-[11px] text-primary-foreground/80">{tooltip}</div>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
