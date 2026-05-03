import { useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { submitPhraseSuggestion, ApiError } from "@workspace/api-client-react";
import { MessageCircleQuestion, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// Task #634 — User-suggested phrase form. Lives at the bottom of
// /transparency. Lets anonymous end users propose new handwavy or
// ai-self-disclosure phrases for reviewer triage. Submissions are
// queued (status="pending"), never auto-applied. Server enforces a
// daily limit of 5 successful submissions per IP — when that 429 fires
// we render a friendly cooldown banner instead of a generic toast.

const MIN_LENGTH = 3;
const MAX_LENGTH = 240;
const MAX_CONTEXT = 1000;

type Category = "handwavy" | "ai-self-disclosure";

interface RateLimitState {
  message: string;
  dailyLimit: number | null;
  retryAfterHours: number | null;
}

export default function PhraseSuggestionForm() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<Category>("handwavy");
  const [context, setContext] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [rateLimited, setRateLimited] = useState<RateLimitState | null>(null);

  const trimmed = text.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_LENGTH;
  const tooLong = trimmed.length > MAX_LENGTH;
  const canSubmit =
    trimmed.length >= MIN_LENGTH &&
    trimmed.length <= MAX_LENGTH &&
    !isPending &&
    !rateLimited;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsPending(true);
    try {
      const result = await submitPhraseSuggestion({
        text: trimmed,
        category,
        context: context.trim() || undefined,
      });
      setSubmitted(true);
      toast({
        title: result.duplicate ? "Already in the queue" : "Suggestion received",
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
                : "Daily suggestion limit reached. Try again tomorrow.",
            dailyLimit: typeof body.dailyLimit === "number" ? body.dailyLimit : null,
            retryAfterHours:
              typeof body.retryAfterHours === "number" ? body.retryAfterHours : null,
          });
        } else if (err.status === 400) {
          const body = (err.data ?? {}) as Record<string, unknown>;
          toast({
            title: "Couldn't accept that suggestion",
            description: typeof body.error === "string" ? body.error : "Please check your input.",
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
  }, [canSubmit, trimmed, category, context, toast]);

  if (submitted) {
    return (
      <Card
        className="glass-card rounded-xl"
        style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}
        data-testid="phrase-suggestion-form-success"
      >
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <div className="p-4 rounded-full icon-glow-green mb-4">
            <CheckCircle2 className="w-10 h-10 text-green-400" />
          </div>
          <p className="font-medium text-foreground text-lg">Thanks for the suggestion!</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            A reviewer will look at your phrase soon. New suggestions are queued and never
            auto-applied to live scoring.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-6"
            onClick={() => {
              setSubmitted(false);
              setText("");
              setContext("");
            }}
          >
            Suggest another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card rounded-xl" data-testid="phrase-suggestion-form">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleQuestion className="w-5 h-5 text-primary" />
          Suggest a Phrase for Reviewer Triage
        </CardTitle>
        <CardDescription>
          Keep seeing a handwavy or AI-self-disclosure phrase in slop reports? Send it our
          way — reviewers triage every submission before anything reaches live scoring.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {rateLimited && (
          <div
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-3"
            data-testid="phrase-suggestion-cooldown"
          >
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-200">{rateLimited.message}</p>
              <p className="text-xs text-amber-200/70 mt-1">
                {rateLimited.dailyLimit != null && (
                  <>Limit is {rateLimited.dailyLimit} suggestions per day per visitor. </>
                )}
                {rateLimited.retryAfterHours != null && (
                  <>Try again in about {rateLimited.retryAfterHours} hours.</>
                )}
              </p>
            </div>
          </div>
        )}

        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Phrase
          </Label>
          <textarea
            data-testid="phrase-suggestion-text"
            className={cn(
              "w-full min-h-[80px] rounded-lg glass-card p-3 text-sm bg-transparent border focus:outline-none resize-none placeholder:text-muted-foreground/40 transition-colors",
              tooShort || tooLong
                ? "border-red-500/50 focus:border-red-500"
                : "border-border/50 focus:border-primary/50",
            )}
            placeholder='e.g. "this could potentially allow attackers to..."'
            maxLength={MAX_LENGTH + 50}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!!rateLimited}
          />
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground/60">
              {tooShort && `Phrase must be at least ${MIN_LENGTH} characters.`}
              {tooLong && `Phrase must be at most ${MAX_LENGTH} characters.`}
            </span>
            <span className="text-muted-foreground/60 tabular-nums">
              {trimmed.length}/{MAX_LENGTH}
            </span>
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Category
          </Label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                {
                  value: "handwavy",
                  label: "Handwavy",
                  hint: "vague filler / hedging / buzzwords in slop reports",
                },
                {
                  value: "ai-self-disclosure",
                  label: "AI Self-Disclosure",
                  hint: "phrases where the report admits an LLM wrote it",
                },
              ] as const
            ).map((opt) => {
              const selected = category === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`phrase-suggestion-category-${opt.value}`}
                  data-selected={selected ? "true" : "false"}
                  onClick={() => setCategory(opt.value)}
                  disabled={!!rateLimited}
                  className={cn(
                    "rounded-lg px-3 py-2 text-left text-sm border transition-colors glass-card",
                    selected
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-primary/30",
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-[11px] text-muted-foreground/70 mt-0.5 max-w-[280px]">
                    {opt.hint}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Context <span className="normal-case font-normal">(optional)</span>
          </Label>
          <textarea
            data-testid="phrase-suggestion-context"
            className="w-full min-h-[60px] rounded-lg glass-card p-3 text-sm bg-transparent border border-border/50 focus:border-primary/50 focus:outline-none resize-none placeholder:text-muted-foreground/40 transition-colors"
            placeholder="Where you've seen this, why it matters — anything that helps the reviewer."
            maxLength={MAX_CONTEXT}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            disabled={!!rateLimited}
          />
          {context.length > 0 && (
            <div className="text-xs text-muted-foreground text-right tabular-nums">
              {context.length}/{MAX_CONTEXT}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Badge variant="outline" className="text-[10px]">
            Queued for review · never auto-applied
          </Badge>
          <Button
            data-testid="phrase-suggestion-submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            <MessageCircleQuestion className="w-4 h-4" />
            {isPending ? "Sending..." : "Submit suggestion"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
