import { useState, useCallback } from "react";
import { submitShowcaseNomination, ApiError } from "@workspace/api-client-react";
import {
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Send,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const MIN_REASON = 10;
const MAX_REASON = 1000;
const MAX_EMAIL = 320;

interface RateLimitState {
  message: string;
  dailyLimit: number | null;
  retryAfterHours: number | null;
}

interface ShowcaseNominationFormProps {
  reportId?: number;
}

export default function ShowcaseNominationForm({
  reportId: prefillReportId,
}: ShowcaseNominationFormProps) {
  const { toast } = useToast();
  const [reportId, setReportId] = useState(
    prefillReportId != null ? String(prefillReportId) : "",
  );
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [rateLimited, setRateLimited] = useState<RateLimitState | null>(null);

  const trimmedReason = reason.trim();
  const reasonTooShort =
    trimmedReason.length > 0 && trimmedReason.length < MIN_REASON;
  const reasonTooLong = trimmedReason.length > MAX_REASON;
  const parsedReportId = Number(reportId);
  const reportIdValid =
    reportId.length > 0 &&
    Number.isInteger(parsedReportId) &&
    parsedReportId > 0;
  const canSubmit =
    reportIdValid &&
    trimmedReason.length >= MIN_REASON &&
    trimmedReason.length <= MAX_REASON &&
    !isPending &&
    !rateLimited;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsPending(true);
    try {
      const result = await submitShowcaseNomination({
        reportId: parsedReportId,
        reason: trimmedReason,
        email: email.trim() || undefined,
      });
      setSubmitted(true);
      toast({
        title: result.duplicate
          ? "Already nominated"
          : "Nomination received",
        description: result.message,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const body = (err.data ?? {}) as Record<string, unknown>;
          setRateLimited({
            message:
              typeof body.error === "string"
                ? body.error
                : "Daily nomination limit reached. Try again tomorrow.",
            dailyLimit:
              typeof body.dailyLimit === "number" ? body.dailyLimit : null,
            retryAfterHours:
              typeof body.retryAfterHours === "number"
                ? body.retryAfterHours
                : null,
          });
        } else if (err.status === 400) {
          const body = (err.data ?? {}) as Record<string, unknown>;
          toast({
            title: "Couldn't accept that nomination",
            description:
              typeof body.error === "string"
                ? body.error
                : "Please check your input.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Something went wrong",
            description: "Please try again in a moment.",
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "Something went wrong",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
      }
    } finally {
      setIsPending(false);
    }
  }, [canSubmit, parsedReportId, trimmedReason, email, toast]);

  if (submitted) {
    return (
      <Card
        className="glass-card rounded-xl"
        style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}
        data-testid="showcase-nomination-form-success"
      >
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <div className="p-4 rounded-full icon-glow-green mb-4">
            <CheckCircle2 className="w-10 h-10 text-green-400" />
          </div>
          <p className="font-medium text-foreground text-lg">
            Thanks for the nomination!
          </p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            A reviewer will look at your nomination soon. Reports are never
            auto-published to the showcase.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-6"
            onClick={() => {
              setSubmitted(false);
              setReason("");
              setEmail("");
              if (!prefillReportId) setReportId("");
            }}
          >
            Nominate another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="glass-card rounded-xl"
      data-testid="showcase-nomination-form"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-primary" />
          Nominate for Showcase
        </CardTitle>
        <CardDescription>
          Spotted an interesting report? Nominate it for the curated showcase —
          reviewers triage every submission before anything is published.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {rateLimited && (
          <div
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-3"
            data-testid="showcase-nomination-cooldown"
          >
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-200">
                {rateLimited.message}
              </p>
              <p className="text-xs text-amber-200/70 mt-1">
                {rateLimited.dailyLimit != null && (
                  <>
                    Limit is {rateLimited.dailyLimit} nominations per day per
                    visitor.{" "}
                  </>
                )}
                {rateLimited.retryAfterHours != null && (
                  <>Try again in about {rateLimited.retryAfterHours} hours.</>
                )}
              </p>
            </div>
          </div>
        )}

        {!prefillReportId && (
          <div className="space-y-2">
            <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Report ID
            </Label>
            <input
              data-testid="showcase-nomination-report-id"
              type="number"
              min="1"
              step="1"
              className={cn(
                "w-full rounded-lg glass-card p-3 text-sm bg-transparent border focus:outline-none placeholder:text-muted-foreground/40 transition-colors",
                reportId.length > 0 && !reportIdValid
                  ? "border-red-500/50 focus:border-red-500"
                  : "border-border/50 focus:border-primary/50",
              )}
              placeholder="e.g. 42"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              disabled={!!rateLimited}
            />
            {reportId.length > 0 && !reportIdValid && (
              <p className="text-xs text-red-400">
                Report ID must be a positive integer.
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Why is this report interesting?
          </Label>
          <textarea
            data-testid="showcase-nomination-reason"
            className={cn(
              "w-full min-h-[100px] rounded-lg glass-card p-3 text-sm bg-transparent border focus:outline-none resize-none placeholder:text-muted-foreground/40 transition-colors",
              reasonTooShort || reasonTooLong
                ? "border-red-500/50 focus:border-red-500"
                : "border-border/50 focus:border-primary/50",
            )}
            placeholder="Explain what makes this report worth showcasing — is it a great catch, a surprising edge case, or an interesting scoring pattern?"
            maxLength={MAX_REASON + 50}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={!!rateLimited}
          />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground/60">
              {reasonTooShort &&
                `Reason must be at least ${MIN_REASON} characters.`}
              {reasonTooLong &&
                `Reason must be at most ${MAX_REASON} characters.`}
            </span>
            <span className="text-muted-foreground/60 tabular-nums">
              {trimmedReason.length}/{MAX_REASON}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Email <span className="normal-case font-normal">(optional)</span>
          </Label>
          <input
            data-testid="showcase-nomination-email"
            type="email"
            className="w-full rounded-lg glass-card p-3 text-sm bg-transparent border border-border/50 focus:border-primary/50 focus:outline-none placeholder:text-muted-foreground/40 transition-colors"
            placeholder="your@email.com — only used if we have a question"
            maxLength={MAX_EMAIL}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!!rateLimited}
          />
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Badge variant="outline" className="text-[10px]">
            Queued for review · never auto-published
          </Badge>
          <Button
            data-testid="showcase-nomination-submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            <Send className="w-4 h-4" />
            {isPending ? "Sending..." : "Submit nomination"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
