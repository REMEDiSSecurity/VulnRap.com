// Task #1328 — REMEDiS feedback.v2 review queue.
//
// Reviewer-only page that lists pending `corpus_unreviewed` rows and
// lets the reviewer promote / reject / defer each one. Auth piggybacks
// on the same CALIBRATION_TOKEN customFetch attaches to every request,
// so the page just needs the token to be set in localStorage (same as
// the rest of the admin surface).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { customFetch, ApiError } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

type Status = "pending" | "deferred" | "promoted" | "rejected";

interface QueueRow {
  id: number;
  submissionId: string;
  schemaVersion: string;
  verdict: string;
  receivedAt: string;
  status: Status;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

interface QueueResponse {
  rows: QueueRow[];
  status: Status;
  limit: number;
}

interface DetailResponse extends QueueRow {
  payload: unknown;
}

interface StatsResponse {
  counts: {
    pending: number;
    deferred: number;
    promoted: number;
    rejected: number;
    total: number;
  };
  promotions: {
    thisWeek: number;
    lastWeek: number;
    weekOverWeekDelta: number;
    weekOverWeekPct: number | null;
  };
}

function statusBadge(status: Status): { label: string; cls: string } {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        cls: "bg-amber-500/15 text-amber-300 border-amber-500/40",
      };
    case "deferred":
      return {
        label: "Deferred",
        cls: "bg-blue-500/15 text-blue-300 border-blue-500/40",
      };
    case "promoted":
      return {
        label: "Promoted",
        cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
      };
    case "rejected":
      return {
        label: "Rejected",
        cls: "bg-red-500/15 text-red-300 border-red-500/40",
      };
  }
}

export default function FeedbackV2Review(): ReactElement {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Status>("pending");
  const [queue, setQueue] = useState<QueueRow[] | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [decisionReason, setDecisionReason] = useState("");

  const fetchQueue = useCallback(
    async (status: Status) => {
      try {
        const res = await customFetch<QueueResponse>(
          `/api/feedback/v2/pending?status=${encodeURIComponent(status)}`,
        );
        setQueue(res.rows);
        setError(null);
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `HTTP ${err.status}: ${err.message}`
            : (err as Error).message;
        setError(msg);
        setQueue([]);
      }
    },
    [],
  );

  const fetchStats = useCallback(async () => {
    try {
      const res = await customFetch<StatsResponse>("/api/feedback/v2/stats");
      setStats(res);
    } catch {
      // Stats are advisory; failure is non-fatal.
    }
  }, []);

  useEffect(() => {
    fetchQueue(filter);
    fetchStats();
  }, [filter, fetchQueue, fetchStats]);

  const expand = useCallback(async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDecisionReason("");
    try {
      const res = await customFetch<DetailResponse>(`/api/feedback/v2/${id}`);
      setDetail(res);
    } catch (err) {
      toast({
        title: "Failed to load payload",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }, [expandedId, toast]);

  const decide = useCallback(
    async (id: number, action: "promote" | "reject" | "defer") => {
      // Task #1328 — every decision carries a reason. Promotion is the
      // one that lands a row in corpus_labelled (append-only), so the
      // "why" matters most there; reject/defer also need a rationale.
      if (decisionReason.trim().length === 0) {
        toast({
          title: "Reason required",
          description: `Provide a non-empty reason before you ${action}.`,
          variant: "destructive",
        });
        return;
      }
      setBusy(true);
      try {
        const body =
          action === "promote"
            ? { note: decisionReason.trim() }
            : { reason: decisionReason.trim() };
        await customFetch(`/api/feedback/v2/${id}/${action}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        });
        toast({
          title: `Feedback ${action}d`,
          description: `Row #${id} → ${action}d.`,
        });
        setExpandedId(null);
        setDetail(null);
        setDecisionReason("");
        await Promise.all([fetchQueue(filter), fetchStats()]);
      } catch (err) {
        toast({
          title: `Failed to ${action}`,
          description: (err as Error).message,
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [decisionReason, fetchQueue, fetchStats, filter, toast],
  );

  const pretty = useMemo(() => {
    if (!detail) return "";
    try {
      return JSON.stringify(detail.payload, null, 2);
    } catch {
      return String(detail.payload);
    }
  }, [detail]);

  return (
    <div className="container max-w-6xl py-8 space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">REMEDiS feedback review</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Structured `remedis.feedback.v2` payloads from the REMEDiS
          integration. Each row is one trusted customer&apos;s view of how
          we scored a single report — never authoritative on its own.
          Promote to seed the labelled corpus, reject with a reason if
          the signal is wrong, or defer if you need more context.
        </p>
      </div>

      <FeedbackV2Tile stats={stats} />

      <div className="flex gap-2">
        {(["pending", "deferred", "rejected", "promoted"] as const).map(
          (s) => (
            <Button
              key={s}
              variant={filter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
              {stats ? ` (${stats.counts[s]})` : ""}
            </Button>
          ),
        )}
      </div>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-red-300">
            {error}
          </CardContent>
        </Card>
      ) : null}

      {queue === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : queue.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No rows in the {filter} bucket.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {queue.map((row) => {
            const badge = statusBadge(row.status);
            const isOpen = expandedId === row.id;
            return (
              <Card key={row.id}>
                <CardHeader className="cursor-pointer" onClick={() => expand(row.id)}>
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="space-y-1">
                      <CardTitle className="text-base font-mono">
                        #{row.id} · {row.submissionId}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        {row.schemaVersion} · received{" "}
                        {new Date(row.receivedAt).toLocaleString()}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] uppercase"
                      >
                        {row.verdict}
                      </Badge>
                      <Badge variant="outline" className={badge.cls}>
                        {badge.label}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                {isOpen ? (
                  <CardContent className="space-y-3 border-t border-border pt-4">
                    {row.status !== "pending" && row.status !== "deferred" ? (
                      <div className="text-xs text-muted-foreground">
                        {row.status === "promoted" ? "Promoted" : "Rejected"}{" "}
                        by {row.decidedBy ?? "unknown"} on{" "}
                        {row.decidedAt
                          ? new Date(row.decidedAt).toLocaleString()
                          : "unknown date"}
                        {row.decisionReason
                          ? ` · ${row.decisionReason}`
                          : ""}
                      </div>
                    ) : null}

                    {detail ? (
                      <pre className="text-xs bg-muted/40 border border-border rounded p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                        {pretty}
                      </pre>
                    ) : (
                      <Skeleton className="h-32 w-full" />
                    )}

                    {row.status === "pending" || row.status === "deferred" ? (
                      <div className="space-y-2">
                        <label
                          className="text-xs text-muted-foreground block"
                          htmlFor={`reason-${row.id}`}
                        >
                          Reason / note (required — every decision is logged)
                        </label>
                        <textarea
                          id={`reason-${row.id}`}
                          rows={3}
                          value={decisionReason}
                          onChange={(e) => setDecisionReason(e.target.value)}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          placeholder="e.g. Ground truth confirms our verdict; promoting as seed corpus."
                        />
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => decide(row.id, "promote")}
                          >
                            Promote → labelled corpus
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => decide(row.id, "reject")}
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => decide(row.id, "defer")}
                          >
                            Defer
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </CardContent>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Task #1328 — Small admin tile, exported separately so the existing
// admin surface (feedback-analytics page) can mount it inline without
// importing the whole review experience. Re-renders on every parent
// remount; an embedding page that wants live counts should pass the
// already-fetched stats through `stats`, or set `fetchOnMount` to let
// the tile self-fetch.
export function FeedbackV2Tile({
  stats,
  fetchOnMount,
}: {
  stats?: StatsResponse | null;
  fetchOnMount?: boolean;
}): ReactElement {
  const [local, setLocal] = useState<StatsResponse | null>(stats ?? null);

  useEffect(() => {
    if (stats !== undefined) {
      setLocal(stats);
      return;
    }
    if (!fetchOnMount) return;
    let cancelled = false;
    customFetch<StatsResponse>("/api/feedback/v2/stats")
      .then((res) => {
        if (!cancelled) setLocal(res);
      })
      .catch(() => {
        // Tile is best-effort; swallow errors.
      });
    return () => {
      cancelled = true;
    };
  }, [stats, fetchOnMount]);

  const pending = local?.counts.pending ?? null;
  const thisWeek = local?.promotions.thisWeek ?? null;
  const lastWeek = local?.promotions.lastWeek ?? null;
  const pct = local?.promotions.weekOverWeekPct ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">REMEDiS feedback queue</CardTitle>
        <CardDescription className="text-xs">
          Pending review and week-over-week promotion rate.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <Stat label="Pending" value={pending} highlight={pending !== null && pending > 0} />
        <Stat label="Promoted (7d)" value={thisWeek} />
        <Stat label="Promoted (prev 7d)" value={lastWeek} />
        <Stat
          label="WoW change"
          value={
            pct === null || pct === undefined
              ? "n/a"
              : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`
          }
        />
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number | string | null;
  highlight?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          "text-lg font-semibold tabular-nums " +
          (highlight ? "text-amber-300" : "")
        }
      >
        {value === null ? "—" : value}
      </div>
    </div>
  );
}
