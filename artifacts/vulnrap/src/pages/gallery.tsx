// Task #647 — Curated sample-report gallery page.
//
// Shows the 12 curated samples returned by `GET /api/gallery` so new
// users have something to look at without submitting their own report
// first. Each card carries the curator-supplied display fields
// (title, snippet, score, top signals, label) and clicking through
// opens the existing `/results/:id` page for the full breakdown.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Library, Loader2, AlertCircle, ArrowRight, Sparkles, Flag, Zap, Scale, Leaf,
} from "lucide-react";
import {
  useListGallery,
  type GallerySample,
  GallerySampleLabel,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Label = GallerySample["label"];
type FilterValue = Label | "all";

interface LabelMeta {
  label: string;
  short: string;
  tone: string;
  scoreTone: string;
  icon: React.ReactNode;
}

const LABEL_META: Record<Label, LabelMeta> = {
  obvious_slop: {
    label: "Obvious slop",
    short: "Obvious",
    tone: "border-red-500/40 text-red-300/90 bg-red-500/5",
    scoreTone: "text-red-300",
    icon: <Flag className="w-3 h-3" />,
  },
  subtle_slop: {
    label: "Subtle slop",
    short: "Subtle",
    tone: "border-orange-500/40 text-orange-300/90 bg-orange-500/5",
    scoreTone: "text-orange-300",
    icon: <Zap className="w-3 h-3" />,
  },
  borderline: {
    label: "Borderline",
    short: "Borderline",
    tone: "border-yellow-500/40 text-yellow-300/90 bg-yellow-500/5",
    scoreTone: "text-yellow-300",
    icon: <Scale className="w-3 h-3" />,
  },
  clean: {
    label: "Clean human report",
    short: "Clean",
    tone: "border-green-500/40 text-green-300/90 bg-green-500/5",
    scoreTone: "text-green-300",
    icon: <Leaf className="w-3 h-3" />,
  },
};

const FILTER_ORDER: FilterValue[] = ["all", "obvious_slop", "subtle_slop", "borderline", "clean"];

function GalleryCard({ sample }: { sample: GallerySample }) {
  const meta = LABEL_META[sample.label];
  return (
    <Card className="glass-card rounded-xl flex flex-col h-full" data-testid={`gallery-card-${sample.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-tight">{sample.title}</CardTitle>
          <Badge variant="outline" className={cn("text-[9px] uppercase tracking-wider shrink-0 inline-flex items-center gap-1", meta.tone)}>
            {meta.icon}
            {meta.short}
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed line-clamp-3">
          {sample.snippet}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 flex-1 flex flex-col">
        <div className="flex items-center justify-between rounded-md bg-muted/20 border border-border/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80">
            Slop score
          </div>
          <div className={cn("font-mono text-lg font-bold", meta.scoreTone)}>
            {sample.score}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80">
            Top signals
          </div>
          <ul className="space-y-1">
            {sample.topSignals.map((sig, idx) => (
              <li key={`${sig}-${idx}`} className="text-[11px] text-foreground/85 flex items-start gap-1.5">
                <span className="text-primary/70 mt-0.5">›</span>
                <span className="leading-snug">{sig}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto pt-2">
          <Button asChild className="w-full glow-button" size="sm">
            <Link
              to={`/results/${sample.reportId}`}
              data-testid={`gallery-open-${sample.id}`}
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

export default function Gallery() {
  const { data, isLoading, isError, error, refetch } = useListGallery();
  const [filter, setFilter] = useState<FilterValue>("all");

  const counts = useMemo(() => {
    const out: Record<FilterValue, number> = {
      all: 0, obvious_slop: 0, subtle_slop: 0, borderline: 0, clean: 0,
    };
    if (!data) return out;
    out.all = data.samples.length;
    for (const s of data.samples) out[s.label] += 1;
    return out;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.samples;
    return data.samples.filter((s) => s.label === filter);
  }, [data, filter]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <Library className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Sample Report Gallery
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          A dozen pre-scored examples spanning obvious slop, subtle slop, borderline reports, and clean human submissions. Pick a card to see the full breakdown — no submission required.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card className="glass-card-accent rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-primary" />
            How the gallery works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs sm:text-sm text-muted-foreground leading-relaxed space-y-2">
          <p>
            Each card shows a curated sample with its final score and the top signals that fired. Clicking <span className="font-mono text-primary">Open full breakdown</span> takes you to the same results page you'd get after submitting your own report.
          </p>
          <p className="text-[11px] text-muted-foreground/70">
            Samples are curated by the VulnRap team — community-submitted samples are not accepted in v1.
          </p>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading gallery…
        </div>
      )}

      {isError && (
        <Card className="glass-card border-destructive/40">
          <CardContent className="py-6 flex flex-col sm:flex-row items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-destructive mb-1">Failed to load gallery</div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {data && data.samples.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-12">
          No gallery samples configured yet.
        </div>
      )}

      {data && data.samples.length > 0 && (
        <>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Filter gallery by label"
            data-testid="gallery-filters"
          >
            {FILTER_ORDER.map((value) => {
              const active = filter === value;
              const label = value === "all" ? "All" : LABEL_META[value as Label].label;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  aria-pressed={active}
                  data-testid={`gallery-filter-${value}`}
                  className={cn(
                    "text-xs font-medium px-3 py-1.5 rounded-full border transition-all inline-flex items-center gap-1.5",
                    active
                      ? "bg-primary/15 border-primary/50 text-primary glow-text-sm"
                      : "border-border/60 text-muted-foreground hover:text-primary hover:border-primary/40",
                  )}
                >
                  {value !== "all" && LABEL_META[value as Label].icon}
                  {label}
                  <span className={cn(
                    "text-[10px] font-mono px-1.5 py-0.5 rounded",
                    active ? "bg-primary/20" : "bg-muted/40",
                  )}>
                    {counts[value]}
                  </span>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">
              No samples match this filter.
            </div>
          ) : (
            <div
              className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="gallery-grid"
            >
              {filtered.map((s) => (
                <GalleryCard key={s.id} sample={s} />
              ))}
            </div>
          )}

          <div className="text-[10px] text-muted-foreground/60 font-mono text-right">
            gallery v{data.version}
          </div>
        </>
      )}
    </div>
  );
}

// Re-export GallerySampleLabel for convenience in tests / consumers.
export { GallerySampleLabel };
