// Task #693 — Public roadmap page.
//
// Renders three columns (Now / Next / Later) of roadmap items pulled
// from `GET /api/roadmap`. Items are curator-edited in
// `artifacts/api-server/data/roadmap.json` so updates ship without a
// redeploy. Each card carries a status badge and an optional fuzzy
// ETA. The page header reminds visitors that the roadmap is
// illustrative — not a contractual commitment.
import { useMemo } from "react";
import {
  Map as MapIcon, Loader2, AlertCircle, Info, Rocket, Hourglass, Telescope,
  CircleDot, Sparkles, ListChecks, FlaskConical,
} from "lucide-react";
import {
  useListRoadmap,
  type RoadmapItem,
  type RoadmapItemColumn,
  type RoadmapItemStatus,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ColumnMeta {
  label: string;
  blurb: string;
  tone: string;
  icon: React.ReactNode;
}

const COLUMN_META: Record<RoadmapItemColumn, ColumnMeta> = {
  now: {
    label: "Now",
    blurb: "Actively being built — expect to see these land soon.",
    tone: "border-primary/40 text-primary",
    icon: <Rocket className="w-4 h-4" />,
  },
  next: {
    label: "Next",
    blurb: "Queued up after the current wave clears.",
    tone: "border-yellow-500/40 text-yellow-300",
    icon: <Hourglass className="w-4 h-4" />,
  },
  later: {
    label: "Later",
    blurb: "On the radar — timing not committed yet.",
    tone: "border-muted-foreground/40 text-muted-foreground",
    icon: <Telescope className="w-4 h-4" />,
  },
};

const COLUMN_ORDER: RoadmapItemColumn[] = ["now", "next", "later"];

interface StatusMeta {
  label: string;
  tone: string;
  icon: React.ReactNode;
}

const STATUS_META: Record<RoadmapItemStatus, StatusMeta> = {
  in_progress: {
    label: "In progress",
    tone: "border-primary/40 text-primary bg-primary/5",
    icon: <CircleDot className="w-3 h-3" />,
  },
  shipping_soon: {
    label: "Shipping soon",
    tone: "border-green-500/40 text-green-300 bg-green-500/5",
    icon: <Sparkles className="w-3 h-3" />,
  },
  planned: {
    label: "Planned",
    tone: "border-yellow-500/40 text-yellow-300 bg-yellow-500/5",
    icon: <ListChecks className="w-3 h-3" />,
  },
  research: {
    label: "Research",
    tone: "border-muted-foreground/40 text-muted-foreground bg-muted/20",
    icon: <FlaskConical className="w-3 h-3" />,
  },
};

function RoadmapCard({ item }: { item: RoadmapItem }) {
  const meta = STATUS_META[item.status];
  return (
    <Card
      className="glass-card rounded-xl flex flex-col h-full"
      data-testid={`roadmap-card-${item.id}`}
    >
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm sm:text-base leading-tight">
            {item.title}
          </CardTitle>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] uppercase tracking-wider shrink-0 inline-flex items-center gap-1",
              meta.tone,
            )}
            data-testid={`roadmap-status-${item.id}`}
          >
            {meta.icon}
            {meta.label}
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {item.description}
        </CardDescription>
      </CardHeader>
      {item.eta && (
        <CardContent className="pt-0 mt-auto">
          <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground/80 inline-flex items-center gap-1.5">
            <Hourglass className="w-3 h-3" />
            ETA <span className="text-foreground/85">{item.eta}</span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function RoadmapColumn({
  column,
  items,
}: {
  column: RoadmapItemColumn;
  items: RoadmapItem[];
}) {
  const meta = COLUMN_META[column];
  return (
    <div
      className="flex flex-col gap-3 sm:gap-4"
      data-testid={`roadmap-column-${column}`}
    >
      <div
        className={cn(
          "rounded-xl border bg-muted/10 px-3 py-2.5 flex items-center justify-between gap-2",
          meta.tone,
        )}
      >
        <div className="flex items-center gap-2">
          {meta.icon}
          <span className="text-xs font-bold uppercase tracking-wider">
            {meta.label}
          </span>
        </div>
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-background/60"
          data-testid={`roadmap-count-${column}`}
        >
          {items.length}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground/80 leading-snug px-1">
        {meta.blurb}
      </p>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground/60 italic text-center py-6">
          Nothing here yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <RoadmapCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Roadmap() {
  const { data, isLoading, isError, error, refetch } = useListRoadmap();

  const grouped = useMemo(() => {
    const out: Record<RoadmapItemColumn, RoadmapItem[]> = {
      now: [],
      next: [],
      later: [],
    };
    if (!data) return out;
    for (const item of data.items) out[item.column].push(item);
    return out;
  }, [data]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8">
      <div className="space-y-2 pt-2 sm:pt-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-primary uppercase flex items-center gap-2 sm:gap-3 glow-text">
          <MapIcon className="w-6 h-6 sm:w-8 sm:h-8 shrink-0" />
          Roadmap
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground max-w-2xl leading-relaxed">
          What we're building now, what's queued up next, and what's on
          the longer-term radar.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-4" />
      </div>

      <Card
        className="glass-card-accent rounded-xl border-yellow-500/30"
        data-testid="roadmap-disclaimer"
      >
        <CardContent className="py-4 flex items-start gap-3">
          <Info className="w-4 h-4 text-yellow-300 shrink-0 mt-0.5" />
          <div className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground/90">
              This roadmap is illustrative, not a commitment.
            </span>{" "}
            Priorities shift as we learn from new reports and user
            feedback. Items can move between columns, get reshaped, or
            be retired entirely. Use it to get a sense of direction —
            not as a delivery schedule.
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading roadmap…
        </div>
      )}

      {isError && (
        <Card className="glass-card border-destructive/40">
          <CardContent className="py-6 flex flex-col sm:flex-row items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-destructive mb-1">
                Failed to load roadmap
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

      {data && data.items.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-12">
          No roadmap items configured yet.
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div
            className="grid gap-4 sm:gap-5 grid-cols-1 lg:grid-cols-3 items-start"
            data-testid="roadmap-grid"
          >
            {COLUMN_ORDER.map((col) => (
              <RoadmapColumn key={col} column={col} items={grouped[col]} />
            ))}
          </div>

          <div className="text-[10px] text-muted-foreground/60 font-mono text-right">
            roadmap v{data.version}
            {data.updatedAt ? ` · updated ${data.updatedAt}` : ""}
          </div>
        </>
      )}
    </div>
  );
}
