import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listPhraseSuggestions,
  getListPhraseSuggestionsQueryKey,
  updatePhraseSuggestionStatus,
  addHandwavyPhrase,
  ApiError,
  type PhraseSuggestion,
} from "@workspace/api-client-react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  MessageCircleQuestion,
  Inbox,
  Clock,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

// Task #634 — Reviewer-only queue of user-suggested phrases. Mounted as a
// collapsible section inside the feedback-analytics page (not a new page).
// Approve = call the existing add-handwavy-phrase endpoint and then mark
// the suggestion approved. Reject = just mark it rejected.
//
// We only auto-add when the suggestion targets the handwavy list. The
// ai-self-disclosure add endpoint requires a regex `id` + `pattern`
// (Task #429), which is more than a one-line phrase suggestion can
// honestly carry, so for that category the reviewer copies the text into
// the existing AI self-disclosure admin UI and then marks the suggestion
// approved here.

export interface PhraseSuggestionsQueueProps {
  mutationsAllowed: boolean;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function PhraseSuggestionsQueue({
  mutationsAllowed,
}: PhraseSuggestionsQueueProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const queryKey = getListPhraseSuggestionsQueryKey({ status: "pending" });
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      listPhraseSuggestions({ status: "pending" }, { signal }),
    refetchInterval: 60_000,
  });

  const refetch = useCallback(() => {
    qc.invalidateQueries({ queryKey });
  }, [qc, queryKey]);

  const handleApprove = useCallback(
    async (s: PhraseSuggestion) => {
      if (!mutationsAllowed) return;
      setBusyId(s.id);
      try {
        if (s.category === "handwavy") {
          try {
            await addHandwavyPhrase({
              phrase: s.text,
              category: "absence",
              rationale: s.context ?? `Approved from user suggestion #${s.id}`,
            });
          } catch (err) {
            if (err instanceof ApiError && err.status === 400) {
              const body = (err.data ?? {}) as Record<string, unknown>;
              toast({
                title: "Couldn't add the phrase",
                description:
                  typeof body.error === "string"
                    ? body.error
                    : "Validation failed.",
                variant: "destructive",
              });
              return;
            }
            throw err;
          }
        }
        await updatePhraseSuggestionStatus(s.id, { status: "approved" });
        toast({
          title: "Suggestion approved",
          description:
            s.category === "handwavy"
              ? "Added to the curated handwavy list."
              : "Marked approved. Add the regex to the AI self-disclosure list manually.",
        });
        refetch();
      } catch (err) {
        const description =
          err instanceof ApiError && err.status === 401
            ? "Reviewer token rejected — see the calibration auth banner."
            : "Failed to approve. Try again.";
        toast({
          title: "Approval failed",
          description,
          variant: "destructive",
        });
      } finally {
        setBusyId(null);
      }
    },
    [mutationsAllowed, toast, refetch],
  );

  const handleReject = useCallback(
    async (s: PhraseSuggestion) => {
      if (!mutationsAllowed) return;
      setBusyId(s.id);
      try {
        await updatePhraseSuggestionStatus(s.id, { status: "rejected" });
        toast({
          title: "Suggestion rejected",
          description: "Removed from the queue.",
        });
        refetch();
      } catch (err) {
        const description =
          err instanceof ApiError && err.status === 401
            ? "Reviewer token rejected — see the calibration auth banner."
            : "Failed to reject. Try again.";
        toast({
          title: "Rejection failed",
          description,
          variant: "destructive",
        });
      } finally {
        setBusyId(null);
      }
    },
    [mutationsAllowed, toast, refetch],
  );

  const suggestions = data?.suggestions ?? [];
  const total = suggestions.length;

  return (
    <Card
      className="glass-card rounded-xl"
      data-testid="phrase-suggestions-queue"
    >
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2 text-left"
          data-testid="phrase-suggestions-queue-toggle"
          aria-expanded={open}
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
            <MessageCircleQuestion className="w-4 h-4 text-primary" />
            <CardTitle className="text-base">User-Suggested Phrases</CardTitle>
            {total > 0 && (
              <Badge variant="outline" className="ml-1 tabular-nums">
                {total} pending
              </Badge>
            )}
          </div>
          <CardDescription className="m-0 text-xs hidden sm:block">
            Submissions from the public transparency page · queued for triage
          </CardDescription>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : isError ? (
            <div className="text-sm text-muted-foreground">
              Failed to load the suggestion queue.
            </div>
          ) : suggestions.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-8 text-muted-foreground/70 text-sm"
              data-testid="phrase-suggestions-queue-empty"
            >
              <Inbox className="w-8 h-8 mb-2 opacity-50" />
              No pending suggestions right now.
            </div>
          ) : (
            <ul className="space-y-3">
              {suggestions.map((s) => (
                <li
                  key={s.id}
                  className="rounded-lg border border-border/40 p-3 space-y-2"
                  data-testid={`phrase-suggestion-row-${s.id}`}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm break-words">
                        "{s.text}"
                      </div>
                      {s.context && (
                        <div className="text-xs text-muted-foreground mt-1 italic border-l-2 border-primary/30 pl-2">
                          {s.context}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          s.category === "handwavy"
                            ? "border-blue-400/40 text-blue-300"
                            : "border-violet-400/40 text-violet-300",
                        )}
                      >
                        {s.category}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {timeAgo(s.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      data-testid={`phrase-suggestion-reject-${s.id}`}
                      onClick={() => handleReject(s)}
                      disabled={!mutationsAllowed || busyId === s.id}
                      title={
                        !mutationsAllowed
                          ? "Reviewer token missing/invalid — see the calibration auth banner."
                          : undefined
                      }
                    >
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1"
                      data-testid={`phrase-suggestion-approve-${s.id}`}
                      onClick={() => handleApprove(s)}
                      disabled={!mutationsAllowed || busyId === s.id}
                      title={
                        !mutationsAllowed
                          ? "Reviewer token missing/invalid — see the calibration auth banner."
                          : undefined
                      }
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {s.category === "handwavy"
                        ? "Approve & add"
                        : "Mark approved"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
