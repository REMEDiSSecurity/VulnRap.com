import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useSubmitFeedback } from "@workspace/api-client-react";
import { MessageSquare, Star, ThumbsUp, ThumbsDown, CheckCircle } from "lucide-react";

export default function FeedbackForm({ reportId }: { reportId?: number }) {
  const { toast } = useToast();
  const [rating, setRating] = useState<number>(0);
  const [helpful, setHelpful] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [hoveredStar, setHoveredStar] = useState(0);

  const { mutate, isPending } = useSubmitFeedback({
    mutation: {
      onSuccess: () => {
        setSubmitted(true);
        toast({ title: "Feedback received", description: "Thanks for helping us improve!" });
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to submit feedback. Please try again.", variant: "destructive" });
      },
    },
  });

  const handleSubmit = () => {
    if (rating === 0 || helpful === null) return;

    mutate({
      data: {
        reportId,
        rating,
        helpful,
        comment: comment.trim() || undefined,
      },
    });
  };

  if (submitted) {
    return (
      <Card className="glass-card rounded-xl" style={{ borderColor: "rgba(34, 197, 94, 0.15)" }}>
        <CardContent className="flex flex-col items-center justify-center py-10 text-center">
          <div className="p-4 rounded-full icon-glow-green mb-4">
            <CheckCircle className="w-10 h-10 text-green-400" />
          </div>
          <p className="font-medium text-foreground text-lg">Thanks for your feedback!</p>
          <p className="text-sm text-muted-foreground mt-1">Your input helps us sharpen the analysis for the whole community.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass-card rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" />
          How Did We Do on This One?
        </CardTitle>
        <CardDescription>Quick feedback — did the slop detection and similarity matching help your triage?</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Did this analysis help you triage this report?
          </Label>
          <div className="flex gap-3">
            <Button
              type="button"
              variant={helpful === true ? "default" : "outline"}
              size="sm"
              className={`gap-2 glass-card ${helpful === true ? "border-green-500/50 bg-green-500/10 text-green-400 hover:bg-green-500/20" : "hover:border-green-500/30"}`}
              onClick={() => setHelpful(true)}
            >
              <ThumbsUp className="w-4 h-4" />
              Yes, useful for triage
            </Button>
            <Button
              type="button"
              variant={helpful === false ? "default" : "outline"}
              size="sm"
              className={`gap-2 glass-card ${helpful === false ? "border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20" : "hover:border-red-500/30"}`}
              onClick={() => setHelpful(false)}
            >
              <ThumbsDown className="w-4 h-4" />
              Missed the mark
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Rate the analysis accuracy
          </Label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                className="p-1 transition-transform hover:scale-110 focus:outline-none"
                onMouseEnter={() => setHoveredStar(star)}
                onMouseLeave={() => setHoveredStar(0)}
                onClick={() => setRating(star)}
              >
                <Star
                  className={`w-7 h-7 transition-colors ${
                    star <= (hoveredStar || rating)
                      ? "text-yellow-400 fill-yellow-400"
                      : "text-muted-foreground/30"
                  }`}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="ml-2 text-sm text-muted-foreground self-center">
                {rating === 1 && "Way off"}
                {rating === 2 && "Needs work"}
                {rating === 3 && "Decent"}
                {rating === 4 && "Solid analysis"}
                {rating === 5 && "Nailed it"}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Suggestions <span className="normal-case font-normal">(optional)</span>
          </Label>
          <textarea
            className="w-full min-h-[80px] rounded-lg glass-card p-3 text-sm bg-transparent border border-border/50 focus:border-primary/50 focus:outline-none resize-none placeholder:text-muted-foreground/40 transition-colors"
            placeholder="False positive? Missed obvious slop? What would help your triage workflow?"
            maxLength={1000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {comment.length > 0 && (
            <div className="text-xs text-muted-foreground text-right">{comment.length}/1000</div>
          )}
        </div>

        <Button
          onClick={handleSubmit}
          disabled={rating === 0 || helpful === null || isPending}
          className="w-full gap-2"
        >
          <MessageSquare className="w-4 h-4" />
          {isPending ? "Sending..." : "Send Feedback"}
        </Button>
      </CardContent>
    </Card>
  );
}
