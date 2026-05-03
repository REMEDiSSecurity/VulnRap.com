// Task #645 — Reviewer audit log page.
//
// Reviewer-only paginated view of the `audit_log` table. Filters by
// actor (exact), endpoint (substring), method (POST/PUT/PATCH/DELETE),
// and date range. Each entry shows the redacted request payload and
// final response status; entries whose endpoint has a known reverse
// operation surface a "Revert" link that pre-fills the next mutation.

import { useMemo, useState, type FormEvent, type InputHTMLAttributes } from "react";
import {
  useGetAuditLog,
  getGetAuditLogQueryKey,
  type AuditLogEntry,
  type GetAuditLogMethod,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, Filter, RotateCcw, Shield } from "lucide-react";
import { formatAuditTimestamp } from "@/lib/audit-format";
import { cn } from "@/lib/utils";

function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}

const PAGE_SIZE = 50;

interface FiltersState {
  actor: string;
  method: string;
  endpoint: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: FiltersState = {
  actor: "",
  method: "",
  endpoint: "",
  from: "",
  to: "",
};

function methodBadgeClass(method: string): string {
  switch (method.toUpperCase()) {
    case "POST":
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
    case "PUT":
      return "bg-blue-500/15 text-blue-300 border-blue-500/40";
    case "PATCH":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    case "DELETE":
      return "bg-red-500/15 text-red-300 border-red-500/40";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function statusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  if (status >= 300 && status < 400) return "bg-blue-500/15 text-blue-300 border-blue-500/40";
  if (status === 401 || status === 403) return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  if (status >= 400 && status < 500) return "bg-orange-500/15 text-orange-300 border-orange-500/40";
  return "bg-red-500/15 text-red-300 border-red-500/40";
}

function PayloadView({ value }: { value: unknown }) {
  if (value == null) {
    return <span className="text-xs text-muted-foreground italic">(empty)</span>;
  }
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="text-xs bg-muted/40 border border-border rounded p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}

function AuditEntryRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border rounded-lg p-3 bg-card/50">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className={methodBadgeClass(entry.method)}>
          {entry.method}
        </Badge>
        <Badge variant="outline" className={statusBadgeClass(entry.responseStatus)}>
          {entry.responseStatus}
        </Badge>
        <code className="text-xs text-foreground/90 break-all flex-1 min-w-0">
          {entry.endpoint}
        </code>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatAuditTimestamp(entry.createdAt) ?? entry.createdAt}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
        <span>
          actor: <span className="text-foreground/80">{entry.actor}</span>
        </span>
        {entry.ip && (
          <span>
            ip: <span className="text-foreground/80">{entry.ip}</span>
          </span>
        )}
        <span>id: #{entry.id}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Hide payload" : "Show payload"}
        </Button>
        {entry.revertHint && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            asChild
            className="text-amber-300 border-amber-500/40 hover:bg-amber-500/10"
          >
            <a
              href={`${entry.revertHint.endpoint}`}
              title={entry.revertHint.description}
              target="_blank"
              rel="noopener noreferrer"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Revert ({entry.revertHint.method} {entry.revertHint.endpoint.replace(/^\/api/, "")})
            </a>
          </Button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 grid gap-2">
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1">Request payload</div>
            <PayloadView value={entry.requestPayload} />
          </div>
          {entry.queryParams != null && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">Query parameters</div>
              <PayloadView value={entry.queryParams} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AuditLogPage() {
  const [draft, setDraft] = useState<FiltersState>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<FiltersState>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);

  const params = useMemo(() => {
    const out: Record<string, unknown> = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (applied.actor.trim()) out.actor = applied.actor.trim();
    if (applied.method) out.method = applied.method as GetAuditLogMethod;
    if (applied.endpoint.trim()) out.endpoint = applied.endpoint.trim();
    if (applied.from) {
      const d = new Date(applied.from);
      if (!Number.isNaN(d.getTime())) out.from = d.toISOString();
    }
    if (applied.to) {
      const d = new Date(applied.to);
      if (!Number.isNaN(d.getTime())) out.to = d.toISOString();
    }
    return out;
  }, [applied, page]);

  const query = useGetAuditLog(params, {
    query: {
      queryKey: getGetAuditLogQueryKey(params),
      refetchOnWindowFocus: false,
    },
  });

  const total = query.data?.total ?? 0;
  const entries = query.data?.entries ?? [];
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setApplied(draft);
    setPage(0);
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(0);
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-2">
        <Shield className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold">Reviewer Audit Log</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Every reviewer-gated mutation (config changes, hand-wavy phrase add/remove,
        threshold tweaks, fixture compaction settings) is recorded here with actor,
        endpoint, redacted payload, and final response status. This page is gated
        by the same reviewer token as the rest of the calibration surface.
      </p>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="w-4 h-4" />
            Filters
          </CardTitle>
          <CardDescription>
            Narrow the log by reviewer, method, endpoint substring, or date range.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={applyFilters} className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="audit-actor">Actor</Label>
              <Input
                id="audit-actor"
                value={draft.actor}
                onChange={(e) => setDraft((d) => ({ ...d, actor: e.target.value }))}
                placeholder="alice@example.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-method">Method</Label>
              <select
                id="audit-method"
                value={draft.method}
                onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              >
                <option value="">(any)</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-endpoint">Endpoint contains</Label>
              <Input
                id="audit-endpoint"
                value={draft.endpoint}
                onChange={(e) => setDraft((d) => ({ ...d, endpoint: e.target.value }))}
                placeholder="handwavy"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from">From</Label>
              <Input
                id="audit-from"
                type="datetime-local"
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to">To</Label>
              <Input
                id="audit-to"
                type="datetime-local"
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" className="flex-1">Apply</Button>
              <Button type="button" variant="outline" onClick={resetFilters}>
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Recorded mutations</CardTitle>
            <CardDescription>
              {query.isLoading
                ? "Loading…"
                : `${total.toLocaleString()} total · showing page ${page + 1} of ${maxPage + 1}`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= maxPage}
              onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {query.error && (
            <div className="text-sm text-red-400 mb-3">
              Failed to load audit log. The reviewer token may be missing or invalid —
              calibration mutations and this page share the same gate.
            </div>
          )}
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-12">
              No audit log entries match the current filters.
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map((entry) => (
                <AuditEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
