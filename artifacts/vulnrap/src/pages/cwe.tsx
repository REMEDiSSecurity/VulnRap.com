// Task #663 — CWE reference page.
//
// Lists every CWE family the engine recognizes (sourced from the
// fingerprint library + AVRI rubric), grouped by family in collapsible
// accordions. Each entry shows: CWE id, name, family, MITRE link,
// what a high-quality report for that CWE looks like, the engine's
// expected vocabulary, the historical rejection-rate multiplier, and
// per-CWE corpus usage stats. Each family also deep-links into the
// `/reports?avriFamily=...` feed (the closest thing to a per-family
// gallery today; the dedicated sample-report gallery is a separate
// upcoming task and intentionally not built here).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useGetCweCatalog,
  getGetCweCatalogQueryKey,
  type CweCatalogEntry,
  type CweCatalogFamily,
} from "@workspace/api-client-react";
import {
  BookOpen,
  ExternalLink,
  Search,
  Layers,
  Sparkles,
  AlertCircle,
  Database,
  ArrowRight,
  ChevronDown,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const FAMILY_TONE: Record<string, string> = {
  MEMORY_CORRUPTION: "border-red-500/40 text-red-300/90 bg-red-500/5",
  INJECTION: "border-orange-500/40 text-orange-300/90 bg-orange-500/5",
  WEB_CLIENT: "border-amber-500/40 text-amber-300/90 bg-amber-500/5",
  AUTHN_AUTHZ: "border-blue-500/40 text-blue-300/90 bg-blue-500/5",
  CRYPTO: "border-violet-500/40 text-violet-300/90 bg-violet-500/5",
  DESERIALIZATION: "border-pink-500/40 text-pink-300/90 bg-pink-500/5",
  RACE_CONCURRENCY: "border-cyan-500/40 text-cyan-300/90 bg-cyan-500/5",
  REQUEST_SMUGGLING: "border-teal-500/40 text-teal-300/90 bg-teal-500/5",
  FLAT: "border-muted text-muted-foreground bg-muted/10",
};

function familyTone(id: string): string {
  return FAMILY_TONE[id] ?? "border-primary/40 text-primary bg-primary/5";
}

function CweEntryRow({ entry }: { entry: CweCatalogEntry }) {
  const avg = entry.avgCompositeScore;
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2 min-w-0">
          <span className="font-mono text-sm font-bold text-primary">
            {entry.cweId}
          </span>
          <span className="text-sm font-medium text-foreground/90 truncate">
            {entry.name}
          </span>
        </div>
        <a
          href={entry.mitreUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground hover:text-primary transition-colors"
          title="Open canonical MITRE definition in a new tab"
        >
          MITRE
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {entry.highQualityReport}
      </p>

      {entry.aliases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.aliases.map((a) => (
            <Badge
              key={a}
              variant="outline"
              className="text-[10px] font-mono border-border/40 text-muted-foreground"
            >
              {a}
            </Badge>
          ))}
        </div>
      )}

      {entry.expectedTerms.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">
            Expected vocabulary
          </div>
          <div className="flex flex-wrap gap-1">
            {entry.expectedTerms.slice(0, 12).map((t) => (
              <span
                key={t}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/5 text-primary/80 border border-primary/15"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] font-mono text-muted-foreground">
        <span title="Historical rejection-rate multiplier from the fingerprint library">
          rejection&times;{" "}
          <span className="text-foreground/85 tabular-nums">
            {entry.rejectionRate.toFixed(2)}
          </span>
        </span>
        <span className="text-border">·</span>
        <span title="Reports in the public corpus where the engine inferred this CWE via soft-citation">
          reports{" "}
          <span className="text-foreground/85 tabular-nums">
            {entry.reportCount.toLocaleString()}
          </span>
        </span>
        {avg !== null && (
          <>
            <span className="text-border">·</span>
            <span title="Average vulnrap_composite_score across reports where this CWE was inferred">
              avg score{" "}
              <span className="text-foreground/85 tabular-nums">
                {avg.toFixed(1)}
              </span>
            </span>
          </>
        )}
        <Link
          to={entry.reportsLink}
          className="ml-auto inline-flex items-center gap-1 text-primary/80 hover:text-primary transition-colors"
          title="Browse public reports filtered to this family"
        >
          View family reports
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}

function FamilyAccordion({
  family,
  open,
  onToggle,
}: {
  family: CweCatalogFamily;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = familyTone(family.family);
  const totalReports = family.entries.reduce((s, e) => s + e.reportCount, 0);
  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-3 py-4 px-1 text-left hover:bg-primary/5 transition-colors"
        data-testid={`cwe-family-toggle-${family.family}`}
      >
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform shrink-0",
            open && "rotate-180",
          )}
        />
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] uppercase tracking-wider font-mono shrink-0",
            tone,
          )}
        >
          {family.family}
        </Badge>
        <span className="font-medium text-sm text-foreground/90">
          {family.familyName}
        </span>
        <span className="text-[11px] font-mono text-muted-foreground ml-auto">
          {family.entries.length} CWE{family.entries.length === 1 ? "" : "s"}
          {totalReports > 0 && (
            <span className="ml-2">
              · {totalReports.toLocaleString()} report
              {totalReports === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="pt-2 pb-4 px-1">
          <div className="text-xs text-muted-foreground italic mb-3">
            {family.reproductionExpectation}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {family.entries.map((e) => (
              <CweEntryRow key={e.cweId} entry={e} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CwePage() {
  const { data, isLoading, isError } = useGetCweCatalog({
    query: { queryKey: getGetCweCatalogQueryKey() },
  });
  const [search, setSearch] = useState("");

  const filteredFamilies = useMemo<CweCatalogFamily[]>(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.families;
    return data.families
      .map((fam) => ({
        ...fam,
        entries: fam.entries.filter((e) => {
          const haystack = [
            e.cweId,
            e.name,
            e.familyName,
            ...e.aliases,
            ...e.expectedTerms,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(q);
        }),
      }))
      .filter((fam) => fam.entries.length > 0);
  }, [data, search]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleFamily = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
          <BookOpen className="w-8 h-8 text-primary" />
          CWE Reference
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl">
          Every CWE family the VulnRap scoring engine has a fingerprint for,
          grouped by AVRI rubric class. Each entry shows what the engine expects
          in a high-quality report for that CWE, plus how often it has fired
          across the public corpus. Click any family to expand.
        </p>
        <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent mt-6" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Database className="w-3.5 h-3.5" /> Total CWEs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tabular-nums">
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                (data?.totalCwes ?? 0)
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" /> Families
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono tabular-nums">
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                (data?.families.length ?? 0)
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="glass-card rounded-xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" /> Generated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xs font-mono text-muted-foreground">
              {isLoading || !data ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                new Date(data.generatedAt).toLocaleString()
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="glass-card rounded-xl">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="w-4 h-4 text-primary" />
            CWE Catalog
          </CardTitle>
          <CardDescription className="text-xs">
            Filter by CWE id, name, alias, or any term the engine looks for.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search CWEs (e.g. xss, sql, 416, deserialization)…"
            className="max-w-md w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60"
            data-testid="cwe-catalog-search"
          />

          {isError && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4" />
              Failed to load the CWE catalog.
            </div>
          )}

          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}

          {!isLoading && !isError && filteredFamilies.length === 0 && (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No CWEs match &ldquo;{search}&rdquo;.
            </div>
          )}

          {!isLoading && !isError && filteredFamilies.length > 0 && (
            <div className="w-full border-t border-border/40">
              {filteredFamilies.map((fam) => (
                <FamilyAccordion
                  key={fam.family}
                  family={fam}
                  open={!collapsed.has(fam.family)}
                  onToggle={() => toggleFamily(fam.family)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
