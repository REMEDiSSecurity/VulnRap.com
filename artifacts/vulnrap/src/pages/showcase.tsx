// Task #694 — Curator-picked "interesting reports" showcase page.
//
// Surfaces the 6-10 hand-picked entries returned by `GET /api/showcase`:
// high-confidence catches, edge cases, and surprising engine
// agreements. Each card carries a redacted excerpt, the composite
// score + tier, a one-paragraph "why this is interesting" note, and
// a click-through to the existing `/results/:id` page for the full
// breakdown. Modelled closely on `/gallery` (Task #647) for visual
// and structural consistency.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Sparkles,
  Loader2,
  AlertCircle,
  ArrowRight,
  Trophy,
  Telescope,
  Handshake,
  Quote,
} from "lucide-react";
import {
  useListShowcase,
  type ShowcaseEntry,
  ShowcaseEntryCategory,
  ShowcaseEntryTier,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Category = ShowcaseEntry["category"];
type Tier = ShowcaseEntry["tier"];
type FilterValue = Category | "all";

interface CategoryMeta {
  label: string;
  short: string;
  tone: string;
  icon: React.ReactNode;
}

const CATEGORY_META: Record<Category, CategoryMeta> = {
  high_confidence: {
    label: "High-confidence catches",
    short: "High confidence",
    tone: "border-red-500/40 text-red-300/90 bg-red-500/5",
    icon: <Trophy className="w-3 h-3" />,
  },
  edge_case: {
    label: "Edge cases",
    short: "Edge case",
    tone: "border-orange-500/40 text-orange-300/90 bg-orange-500/5",
    icon: <Telescope className="w-3 h-3" />,
  },
  surprising_agreement: {
    label: "Surprising agreements",
    short: "Agreement",
    tone: "border-cyan-500/40 text-cyan-300/90 bg-cyan-500/5",
    icon: <Handshake className="w-3 h-3" />,
  },
};

const TIER_TONE: Record<Tier, string> = {
  clean: "text-green-300",
  borderline: "text-yellow-300",
  subtle_slop: "text-orange-300",
  obvious_slop: "text-red-300",
};

const TIER_LABEL: Record<Tier, string> = {
  clean: "Clean",
  borderline: "Borderline",
  subtle_slop: "Subtle slop",
  obvious_slop: "Obvious slop",
};

const FILTER_ORDER: FilterValue[] = [
  "all",
  "high_confidence",
  "edge_case",
  "surprising_agreement",
];

function ShowcaseCard({ entry }: { entry: ShowcaseEntry }) {
  const meta = CATEGORY_META[entry.category];
  const tierTone = TIER_TONE[entry.tier];
  return (
    <Card
      className="glass-card rounded-xl flex flex-col h-full"
      data-testid={`showcase-card-${entry.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-tight">
            {entry.title}
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] uppercase tracking-wider shrink-0 inline-flex items-center gap-1",
              meta.tone,
            )}
          >
            {meta.icon}
            {meta.short}
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          <span className="block rounded-md border border-border/40 bg-muted/15 px-3 py-2 italic text-foreground/85 relative">
            <Quote className="w-3 h-3 absolute top-1.5 left-1.5 text-muted-foreground/40" />
            <span className="block pl-4">{entry.excerpt}</span>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 flex-1 flex flex-col">
        <div className="flex items-center justify-between rounded-md bg-muted/20 border border-border/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80">
            Score / Tier
          </div>
          <div className="flex items-baseline gap-2">
            <div className={cn("font-mono text-lg font-bold", tierTone)}>
              {entry.score}
            </div>
            <div
              className={cn(
                "text-[10px] uppercase tracking-wider font-mono",
                tierTone,
              )}
            >
              {TIER_LABEL[entry.tier]}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80">
            Why it's interesting
          </div>
          <p className="text-[12px] leading-relaxed text-foreground/85">
            {entry.whyInteresting}
          </p>
        </div>

        <div className="mt-auto pt-2">
          <Button asChild className="w-full glow-button" size="sm">
            <Link
              to={`/results/${entry.reportId}`}
              data-testid={`showcase-open-${entry.id}`}
            >
              Open full breakdown
              <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Showcase() {
  const { data, isLoading, isError, error, refetch } = useListShowcase();
  const [filter, setFilter] = useState<FilterValue>("all");

  const counts = useMemo(() => {
    const out: Record<FilterValue, number> = {
      all: 0,
      high_confidence: 0,
      edge_case: 0,
      surprising_agreement: 0,
    };
    if (!data) return out;
    out.all = data.entries.length;
    for (const e of data.entries) out[e.category] += 1;
    return out;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.entries;
    return data.entries.filter((e) => e.category === filter);
  }, [data, filter]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Sparkles className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Showcase
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          Hand-picked reports the platform has scored — high-confidence catches,
          edge cases the engines disagreed on, and the rare cases where
          everything aligned. Public proof, not marketing.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" />
            How the showcase works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Each card carries a redacted excerpt, the final composite score, and
            a one-paragraph note from the curator about why the entry is worth a
            look.{" "}
            <span className="font-mono text-primary">Open full breakdown</span>{" "}
            jumps to the same results page you'd see after submitting your own
            report.
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Entries are picked manually from production submissions.
            Auto-curation and personalised showcases are explicitly out of scope
            for v1.
          </p>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading showcase…
        </div>
      )}

      {isError && (
        <Card className="glass-card border-destructive/40">
          <CardContent className="py-6 flex flex-col sm:flex-row items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-destructive mb-1">
                Failed to load showcase
              </div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {data && data.entries.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-12">
          No showcase entries configured yet.
        </div>
      )}

      {data && data.entries.length > 0 && (
        <>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Filter showcase by category"
            data-testid="showcase-filters"
          >
            {FILTER_ORDER.map((value) => {
              const active = filter === value;
              const label =
                value === "all"
                  ? "All"
                  : CATEGORY_META[value as Category].label;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  aria-pressed={active}
                  data-testid={`showcase-filter-${value}`}
                  className={cn(
                    "text-xs font-medium px-3 py-1.5 rounded-full border transition-all inline-flex items-center gap-1.5",
                    active
                      ? "bg-primary/15 border-primary/50 text-primary glow-text-sm"
                      : "border-border/60 text-muted-foreground hover:text-primary hover:border-primary/40",
                  )}
                >
                  {value !== "all" && CATEGORY_META[value as Category].icon}
                  {label}
                  <span
                    className={cn(
                      "text-[10px] font-mono px-1.5 py-0.5 rounded",
                      active ? "bg-primary/20" : "bg-muted/40",
                    )}
                  >
                    {counts[value]}
                  </span>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">
              No entries match this filter.
            </div>
          ) : (
            <div
              className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="showcase-grid"
            >
              {filtered.map((e) => (
                <ShowcaseCard key={e.id} entry={e} />
              ))}
            </div>
          )}

          <div className="text-[10px] text-muted-foreground/60 font-mono text-right">
            showcase v{data.version}
          </div>
        </>
      )}
    </div>
  );
}

export { ShowcaseEntryCategory, ShowcaseEntryTier };
